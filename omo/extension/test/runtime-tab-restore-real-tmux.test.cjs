const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { RuntimeConsoleController } = require('../src/browser/runtime-console-controller.ts');

const PYTHON = '/usr/bin/python3';
const TMUX = '/home/harry/.local/share/omo/bin/tmux';

function makeHarness() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-tab-restore-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  const socket = `omo-tab-restore-${process.pid}-${path.basename(root).slice(-6)}`;
  for (const dir of [home, data, bin, project]) fs.mkdirSync(dir, { recursive: true });
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    OMO_DATA: data,
    OMO_TMUX_SOCKET: socket,
    OMO_TMUX: TMUX,
    OMO_SPATIAL_REMEMBER_EVERY: '1',
  };
  let child;
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  function request(op, args = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${op}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }
  async function start() {
    child = cp.spawn(PYTHON, ['-I', '-B', '-u', path.resolve(__dirname, '../../runtime/omo_spatial_host.py')], {
      cwd: data, env, stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stderr.on('data', b => { stderr += b.toString(); });
    await new Promise((resolve, reject) => {
      const end = setTimeout(() => reject(new Error(`host did not start: ${stderr}`)), 10000);
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', line => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id === 0) { clearTimeout(end); resolve(); return; }
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'host error'));
      });
      child.once('exit', code => { clearTimeout(end); reject(new Error(`host exit ${code}: ${stderr}`)); });
    });
  }
  async function stop() {
    try {
      if (child && !child.killed) {
        child.stdin.write(JSON.stringify({ id: -1, op: 'shutdown', args: {} }) + '\n');
        await new Promise(resolve => setTimeout(resolve, 300));
        child.kill('SIGTERM');
      }
    } catch { /* cleanup */ }
    cp.spawnSync(TMUX, ['-L', socket, 'kill-server'], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
    fs.rmSync(root, { recursive: true, force: true });
  }
  function tmux(...args) {
    return cp.spawnSync(TMUX, ['-L', socket, ...args], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  }
  return { data, project, start, stop, request, tmux, get stderr() { return stderr; } };
}

async function poll(h, viewId, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  let sequence = 0;
  let last;
  while (Date.now() < end) {
    last = await h.request('poll', { viewId, afterSequence: sequence, waitMs: 250 });
    if (last.frame) {
      sequence = last.frame.sequence;
      if (predicate(last.frame)) return last.frame;
    }
  }
  throw new Error(`poll timeout: ${JSON.stringify(last)}\nstderr=${h.stderr}`);
}

function frameText(frame) { return frame.lines.join('\n'); }

async function waitUntil(predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('waitUntil timed out');
}

async function typeChars(controller, text) {
  for (const ch of text) await controller.sendInput(ch);
}

function paneEvidence(h) {
  const panes = h.tmux('list-panes', '-a', '-F', '#{session_name} #{window_index} #{pane_id} #{pane_width}x#{pane_height}').stdout.trim();
  const captures = h.tmux('capture-pane', '-a', '-p', '-J').stdout;
  return { panes, captures };
}

test('real tmux tab restore keeps first marker visible and preserves the original shell', { timeout: 90000 }, async () => {
  const h = makeHarness();
  await h.start();
  try {
    const ws = await h.request('open', { stationId: 'restore-desk', projectUri: pathToFileURL(h.project).href, projectDir: h.project, name: 'Restore' });
    const firstTab = ws.tabs[0];
    const firstView = await h.request('attach', { workspaceId: ws.id, tabId: firstTab.id, cols: 80, rows: 22, stationId: 'restore-station' });
    const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const token = `RUNTIME_LIVE_${run}`;
    const firstFile = path.join(h.project, `.omo-runtime-${run}-first`);
    const secondFile = path.join(h.project, `.omo-runtime-${run}-second`);
    const firstCommand = `export OMO_E2E_MARK=${token}; printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(firstFile)}; printf '\\n%s\\n' "$OMO_E2E_MARK"`;
    await h.request('input', { viewId: firstView.viewId, data: firstCommand + '\r' });
    const initial = await poll(h, firstView.viewId, frame => frameText(frame).split('\n').some(line => line.trim() === token));
    const mirrorView = await h.request('attach', { workspaceId: ws.id, tabId: firstTab.id, cols: 120, rows: 40, stationId: 'restore-station' });
    await poll(h, mirrorView.viewId, frame => frameText(frame).split('\n').some(line => line.trim() === token));
    const initialProof = fs.readFileSync(firstFile, 'utf8').trim();

    const bad = path.join(h.project, `.omo-runtime-${run}-paste-bad`);
    await h.request('paste', { viewId: firstView.viewId, text: `touch ${path.basename(bad)}\necho UNEXPECTED_PASTE_EXECUTION` });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(bad), false, 'multiline paste must not execute before Enter');
    await h.request('input', { viewId: firstView.viewId, data: '\x03' });
    const good = path.join(h.project, `.omo-runtime-${run}-paste-good`);
    await h.request('paste', { viewId: firstView.viewId, text: `printf SAFE_PASTE > ${path.basename(good)}` });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(good), false, 'single-line paste must wait for Enter');
    await h.request('input', { viewId: firstView.viewId, data: '\r' });
    await poll(h, firstView.viewId, () => fs.existsSync(good));
    assert.equal(fs.readFileSync(good, 'utf8'), 'SAFE_PASTE');

    const secondWs = await h.request('tab_new', { workspaceId: ws.id, kind: 'shell', confirmedStart: false });
    const secondTab = secondWs.tabs.at(-1);
    // This is the controller's releaseView + attachActive order: detach is queued,
    // attach is submitted immediately with the station id and may race in the host.
    const firstDetach = h.request('detach', { viewId: firstView.viewId });
    const mirrorDetach = h.request('detach', { viewId: mirrorView.viewId });
    const secondViewPromise = h.request('attach', { workspaceId: ws.id, tabId: secondTab.id, cols: 80, rows: 22, stationId: 'restore-station' });
    const secondView = await secondViewPromise;
    await firstDetach;
    await mirrorDetach;
    const secondCommand = `export OMO_E2E_MARK=SECOND_${run}; printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(secondFile)}; printf '\\n%s\\n' "$OMO_E2E_MARK"`;
    await h.request('input', { viewId: secondView.viewId, data: secondCommand + '\r' });
    await poll(h, secondView.viewId, frame => frameText(frame).split('\n').some(line => line.trim() === `SECOND_${run}`));
    const secondProof = fs.readFileSync(secondFile, 'utf8').trim();
    assert.notEqual(secondProof.split(':')[0], initialProof.split(':')[0], 'second tab must have a distinct shell PID');

    const secondDetach = h.request('detach', { viewId: secondView.viewId });
    const firstAgain = await h.request('attach', { workspaceId: ws.id, tabId: firstTab.id, cols: 80, rows: 22, stationId: 'restore-station' });
    await secondDetach;
    const restored = await poll(h, firstAgain.viewId, frame => frameText(frame).split('\n').some(line => line.trim() === token), 12000);
    const restoredProofPath = path.join(h.project, 'restored-proof');
    await h.request('input', { viewId: firstAgain.viewId, data: `printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(restoredProofPath)}\r` });
    await poll(h, firstAgain.viewId, () => fs.existsSync(restoredProofPath));
    const restoredProof = fs.readFileSync(restoredProofPath, 'utf8').trim();

    assert.ok(frameText(restored).split('\n').some(line => line.trim() === token), `restored frame lost marker; frame=${JSON.stringify(restored)}; pane=${JSON.stringify(paneEvidence(h))}`);
    assert.equal(restoredProof, initialProof, `restored shell identity changed; frame=${JSON.stringify(restored)}; pane=${JSON.stringify(paneEvidence(h))}`);
    assert.equal(restored.history >= 0, true);
    assert.equal(restored.scrollOffset, 0, `restored view must be live, not scrolled; frame=${JSON.stringify(restored)}`);
  } finally {
    await h.stop();
  }
});

test('source controller restores the first real tmux tab after the exact browser sequence', { timeout: 90000 }, async () => {
  const h = makeHarness();
  await h.start();
  const service = {
    status: () => h.request('status'),
    openWorkspace: input => h.request('open', { ...input, projectDir: h.project }),
    attach: input => h.request('attach', input),
    poll: input => h.request('poll', input),
    detach: async viewId => { await new Promise(resolve => setTimeout(resolve, 100)); return h.request('detach', { viewId }); },
    input: input => h.request('input', input),
    paste: input => h.request('paste', input),
    newTab: input => h.request('tab_new', input),
    renameTab: input => h.request('tab_rename', input),
  };
  const states = [];
  const controller = new RuntimeConsoleController({
    service,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => clearTimeout(handle),
    onChange: state => states.push(state),
    onMirrorFrame: () => {},
    onMirrorError: () => {},
    pollMs: 50,
    retryMs: 100,
  });
  try {
    const binding = { stationId: 'restore-station', projectUri: pathToFileURL(h.project).href, name: 'Restore' };
    await controller.bind(binding);
    await waitUntil(() => controller.state.phase === 'live' && controller.state.activeTabId);
    const firstTabId = controller.state.activeTabId;
    assert.equal(await controller.attachMirror(binding.stationId, 120, 40), true);
    const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const token = `RUNTIME_LIVE_${run}`;
    const firstFile = path.join(h.project, `.omo-runtime-${run}-first`);
    const secondFile = path.join(h.project, `.omo-runtime-${run}-second`);
    const firstCommand = `export OMO_E2E_MARK=${token}; printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(firstFile)}; printf '\\n%s\\n' "$OMO_E2E_MARK"`;
    await typeChars(controller, firstCommand);
    await controller.sendInput('\r');
    await waitUntil(() => controller.state.lines.some(line => line.trim() === token));
    const initialProof = fs.readFileSync(firstFile, 'utf8').trim();
    const bad = path.join(h.project, `.omo-runtime-${run}-paste-bad`);
    await controller.paste([`touch ${path.basename(bad)}`, 'echo UNEXPECTED_PASTE_EXECUTION'].join('\n'));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(bad), false);
    await controller.sendInput('\x03');
    const good = path.join(h.project, `.omo-runtime-${run}-paste-good`);
    await controller.paste(`printf SAFE_PASTE > ${path.basename(good)}`);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(good), false);
    await controller.sendInput('\r');
    await waitUntil(() => fs.existsSync(good));
    assert.equal(fs.readFileSync(good, 'utf8'), 'SAFE_PASTE');
    assert.equal(await controller.renameTab(firstTabId, `Primary ${run}`), true);
    await controller.requestNewTab('shell');
    const secondTabId = controller.state.activeTabId;
    assert.notEqual(secondTabId, firstTabId);
    const token2 = `SECOND_${run}`;
    const secondCommand = `export OMO_E2E_MARK=${token2}; printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(secondFile)}; printf '\\n%s\\n' "$OMO_E2E_MARK"`;
    await typeChars(controller, secondCommand);
    await controller.sendInput('\r');
    await waitUntil(() => fs.existsSync(secondFile) && controller.state.lines.some(line => line.trim() === token2));
    const secondProof = fs.readFileSync(secondFile, 'utf8').trim();
    assert.notEqual(secondProof.split(':')[0], initialProof.split(':')[0]);
    await controller.selectTab(firstTabId);
    await waitUntil(() => controller.state.phase === 'live' && controller.state.lines.some(line => line.trim() === token));
    const restoredFrame = { lines: controller.state.lines, history: controller.state.history, scrollOffset: controller.state.scrollOffset };
    const restoredProofPath = path.join(h.project, 'restored-proof');
    const restoredCommand = `printf '%s:%s:%s\\n' "$$" "$OMO_E2E_MARK" "$PWD" > ${path.basename(restoredProofPath)}`;
    await typeChars(controller, restoredCommand);
    await controller.sendInput('\r');
    await waitUntil(() => fs.existsSync(restoredProofPath));
    assert.equal(fs.readFileSync(restoredProofPath, 'utf8').trim(), initialProof, `shell changed; ${JSON.stringify(restoredFrame)}; ${JSON.stringify(paneEvidence(h))}`);
    assert.ok(restoredFrame.lines.some(line => line.trim() === token), `marker lost; ${JSON.stringify(restoredFrame)}; ${JSON.stringify(paneEvidence(h))}`);
    assert.equal(restoredFrame.scrollOffset, 0, `restored view was not live; ${JSON.stringify(restoredFrame)}`);
    assert.ok(states.length > 0);
  } finally {
    controller.dispose();
    await h.stop();
  }
});

test('real controller mirror auto-attach stays single-shot while the primary view polls', { timeout: 90000 }, async () => {
  const h = makeHarness();
  await h.start();
  let controller;
  let mirrorAttached = false;
  let mirrorAttaches = 0;
  const binding = { stationId: 'mirror-station', projectUri: pathToFileURL(h.project).href, name: 'Mirror' };
  const service = {
    status: () => h.request('status'),
    openWorkspace: input => h.request('open', { ...input, projectDir: h.project }),
    attach: input => { if (input.cols === 120 && input.rows === 40) mirrorAttaches++; return h.request('attach', input); },
    poll: input => h.request('poll', input),
    detach: viewId => h.request('detach', { viewId }),
  };
  try {
    controller = new RuntimeConsoleController({
      service,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: handle => clearTimeout(handle),
      onChange: state => {
        if (state.phase === 'live' && !mirrorAttached) {
          mirrorAttached = true;
          void controller.attachMirror(binding.stationId, 120, 40);
        }
      },
      onMirrorFrame: frame => { if (!frame) mirrorAttached = false; },
      pollMs: 50,
      retryMs: 100,
    });
    await controller.bind(binding);
    await waitUntil(() => controller.state.phase === 'live' && mirrorAttaches >= 1);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(mirrorAttaches, 1, 'the live primary poll must not restart the mirror after its initial attach');
  } finally {
    controller?.dispose();
    await h.stop();
  }
});

test('concurrent mirror requests coalesce before the first real view is ready', { timeout: 90000 }, async () => {
  const h = makeHarness();
  await h.start();
  let controller;
  let mirrorAttaches = 0;
  const binding = { stationId: 'concurrent-mirror-station', projectUri: pathToFileURL(h.project).href, name: 'Mirror' };
  const service = {
    status: () => h.request('status'),
    openWorkspace: input => h.request('open', { ...input, projectDir: h.project }),
    attach: async input => {
      if (input.cols === 120 || input.cols === 140) {
        mirrorAttaches++;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return h.request('attach', input);
    },
    poll: input => h.request('poll', input),
    detach: viewId => h.request('detach', { viewId }),
  };
  try {
    controller = new RuntimeConsoleController({
      service,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: handle => clearTimeout(handle),
      onChange: () => {},
      onMirrorFrame: () => {},
      onMirrorError: () => {},
      pollMs: 50,
      retryMs: 100,
    });
    await controller.bind(binding);
    const results = await Promise.all([
      controller.attachMirror(binding.stationId, 120, 40),
      controller.attachMirror(binding.stationId, 140, 40),
    ]);
    assert.deepEqual(results, [true, true]);
    assert.equal(mirrorAttaches, 1, 'a second request must not leak a second in-flight mirror');
  } finally {
    controller?.dispose();
    await h.stop();
  }
});

test('replacing a real mirror keeps the widget latch set while the primary polls', { timeout: 90000 }, async () => {
  const h = makeHarness();
  await h.start();
  let controller;
  let mirrorAttached = false;
  let mirrorAttaches = 0;
  const binding = { stationId: 'replace-mirror-station', projectUri: pathToFileURL(h.project).href, name: 'Mirror' };
  const service = {
    status: () => h.request('status'),
    openWorkspace: input => h.request('open', { ...input, projectDir: h.project }),
    attach: input => { if (input.cols === 120 || input.cols === 140) mirrorAttaches++; return h.request('attach', input); },
    poll: input => h.request('poll', input),
    detach: viewId => h.request('detach', { viewId }),
  };
  try {
    controller = new RuntimeConsoleController({
      service,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: handle => clearTimeout(handle),
      onChange: state => {
        if (state.phase === 'live' && !mirrorAttached) {
          mirrorAttached = true;
          void controller.attachMirror(binding.stationId, 120, 40);
        }
      },
      onMirrorFrame: frame => { if (!frame) mirrorAttached = false; },
      pollMs: 50,
      retryMs: 100,
    });
    await controller.bind(binding);
    await waitUntil(() => controller.state.phase === 'live' && mirrorAttaches === 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await controller.attachMirror(binding.stationId, 140, 40), true);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(mirrorAttaches, 2, 'replacement must not clear the widget latch and start a mirror loop');
  } finally {
    controller?.dispose();
    await h.stop();
  }
});

test('concurrent mirror failure is shared and allows a later retry', { timeout: 90000 }, async () => {
  const h = makeHarness();
  await h.start();
  let controller;
  let failMirror = true;
  let mirrorAttempts = 0;
  const binding = { stationId: 'failed-mirror-station', projectUri: pathToFileURL(h.project).href, name: 'Mirror' };
  const service = {
    status: () => h.request('status'),
    openWorkspace: input => h.request('open', { ...input, projectDir: h.project }),
    attach: input => {
      if (input.cols === 120 && input.rows === 40) {
        mirrorAttempts++;
        if (failMirror) return Promise.reject(new Error('mirror unavailable'));
      }
      return h.request('attach', input);
    },
    poll: input => h.request('poll', input),
    detach: viewId => h.request('detach', { viewId }),
  };
  try {
    controller = new RuntimeConsoleController({
      service,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: handle => clearTimeout(handle),
      onChange: () => {},
      onMirrorFrame: () => {},
      onMirrorError: () => {},
      pollMs: 50,
      retryMs: 100,
    });
    await controller.bind(binding);
    const first = await Promise.all([
      controller.attachMirror(binding.stationId, 120, 40),
      controller.attachMirror(binding.stationId, 120, 40),
    ]);
    assert.deepEqual(first, [false, false]);
    assert.equal(mirrorAttempts, 1);
    failMirror = false;
    assert.equal(await controller.attachMirror(binding.stationId, 120, 40), true);
    assert.equal(mirrorAttempts, 2);
  } finally {
    controller?.dispose();
    await h.stop();
  }
});

test('late mirror attach is rejected after release and same-binding rebind', { timeout: 90000 }, async () => {
  const h = makeHarness();
  await h.start();
  let controller;
  let releaseMirror;
  let mirrorStarted = false;
  const mirrorReady = new Promise(resolve => { releaseMirror = resolve; });
  const binding = { stationId: 'late-mirror-station', projectUri: pathToFileURL(h.project).href, name: 'Mirror' };
  const service = {
    status: () => h.request('status'),
    openWorkspace: input => h.request('open', { ...input, projectDir: h.project }),
    attach: async input => {
      if (input.cols === 120 && input.rows === 40) {
        mirrorStarted = true;
        await mirrorReady;
      }
      return h.request('attach', input);
    },
    poll: input => h.request('poll', input),
    detach: viewId => h.request('detach', { viewId }),
  };
  try {
    controller = new RuntimeConsoleController({
      service,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: handle => clearTimeout(handle),
      onChange: () => {},
      onMirrorFrame: () => {},
      onMirrorError: () => {},
      pollMs: 50,
      retryMs: 100,
    });
    await controller.bind(binding);
    const late = controller.attachMirror(binding.stationId, 120, 40);
    await waitUntil(() => mirrorStarted);
    controller.release();
    await controller.bind(binding);
    releaseMirror();
    assert.equal(await late, false, 'a mirror from the released epoch must be detached, not adopted by the rebind');
  } finally {
    controller?.dispose();
    await h.stop();
  }
});
