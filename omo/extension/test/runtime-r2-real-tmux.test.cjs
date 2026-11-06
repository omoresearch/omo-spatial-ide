const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

const PYTHON = '/usr/bin/python3';
// CI provides a checksum-pinned tmux via OMO_SPATIAL_TEST_TMUX; locally fall back to the private Omo tmux, then PATH.
const TMUX = process.env.OMO_SPATIAL_TEST_TMUX || process.env.OMO_SPATIAL_TMUX || (require('node:fs').existsSync('/home/harry/.local/share/omo/bin/tmux') ? '/home/harry/.local/share/omo/bin/tmux' : (require('node:child_process').spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim() || 'tmux'));
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-r2-real-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
const bin = path.join(root, 'bin');
const project = path.join(root, 'project');
const nested = path.join(project, 'nested');
const hermes = path.join(root, 'hermes');
const log = path.join(root, 'agents.log');
const socket = `omo-r2-real-${process.pid}`;
for (const dir of [home, data, bin, nested, path.join(hermes, 'profiles', 'alpha')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(log, '');
fs.writeFileSync(path.join(bin, 'hermes'), '#!/bin/sh\nwhile read line; do :; done\n', { mode: 0o755 });
const env = {
  HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: process.env.TMPDIR || os.tmpdir(),
  OMO_DATA: data, OMO_TMUX_SOCKET: socket, OMO_TMUX: TMUX, OMO_HERMES_ROOT: hermes,
  OMO_SPATIAL_REMEMBER_EVERY: '1', FIXTURE_AGENT_LOG: log
};
let child;
let nextId = 1;
const pending = new Map();
let stderr = '';

function request(op, args = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${op}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
  });
}

function startHost() {
  child = cp.spawn(PYTHON, ['-I', '-B', '-u', path.resolve(__dirname, '../../runtime/omo_spatial_host.py')], {
    cwd: data, env, stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stderr.on('data', b => { stderr += b.toString(); });
  return new Promise((resolve, reject) => {
    const end = setTimeout(() => reject(new Error(`host did not start: ${stderr}`)), 10000);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 0) {
        clearTimeout(end);
        resolve();
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'host error'));
    });
    child.once('exit', code => { clearTimeout(end); reject(new Error(`host exit ${code}: ${stderr}`)); });
  });
}

async function poll(viewId, predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  let sequence = 0;
  let last;
  let currentFrame;
  while (Date.now() < end) {
    last = await request('poll', { viewId, afterSequence: sequence, waitMs: 250 });
    if (last.frame) {
      currentFrame = last.frame;
      sequence = last.frame.sequence;
      if (predicate(last.frame)) return last.frame;
    }
  }
  throw new Error(`poll timeout: ${JSON.stringify(last)}\nlastFrame=${JSON.stringify(currentFrame)}\nstderr=${stderr}`);
}

before(async () => {
  await startHost();
});

after(async () => {
  try { if (child && !child.killed) { child.stdin.write(JSON.stringify({ id: -1, op: 'shutdown', args: {} }) + '\n'); await new Promise(r => setTimeout(r, 300)); child.kill('SIGTERM'); } } catch { /* cleanup */ }
  cp.spawnSync(TMUX, ['-L', socket, 'kill-server'], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
  fs.rmSync(root, { recursive: true, force: true });
});

test('real tmux captures cwd, preserves truecolour and offers OSC52 write-only notification', { timeout: 60000 }, async () => {
  assert.equal((await request('sleep_configure', { authorized: false })).authorized, false);
  await assert.rejects(request('sleep_configure', { authorized: true, afterSeconds: 0 }), /between 1 and 86400/);
  const sleepConfig = await request('sleep_configure', { authorized: true, afterSeconds: 1 });
  assert.equal(sleepConfig.authorized, true);
  const ws = await request('open', { stationId: 'r2-desk', projectUri: pathToFileURL(project).href, projectDir: project, name: 'R2' });
  const first = ws.tabs[0];
  const view = await request('attach', { workspaceId: ws.id, tabId: first.id, cols: 80, rows: 20, stationId: 'r2-station' });
  await request('input', { viewId: view.viewId, data: "printf '\\033[38;2;12;34;56mR2RGB\\033[0m\\n'; printf '\\033]52;c;SGVsbG8gUjI=\\a'\r" });
  const frame = await poll(view.viewId, f => f.cells.some((row, i) => {
    const col = row.join('').indexOf('R2RGB');
    return col >= 0 && f.truecolor.foreground[i][col] === '#0c2238';
  }));
  let row = -1;
  let col = -1;
  for (let i = 0; i < frame.cells.length && row < 0; i++) {
    const candidate = frame.cells[i].join('').indexOf('R2RGB');
    if (candidate >= 0 && frame.truecolor.foreground[i][candidate] === '#0c2238') {
      row = i; col = candidate;
    }
  }
  assert.ok(row >= 0, 'truecolour output row is present');
  assert.equal(frame.truecolor.foreground[row][col], '#0c2238');
  assert.equal(frame.foreground.length, frame.lines.length, 'legacy palette field remains');
  let notice;
  for (let i = 0; i < 20 && !notice; i++) {
    notice = await request('clipboard_pending', { viewId: view.viewId });
    if (!notice) await new Promise(r => setTimeout(r, 50));
  }
  assert.deepEqual(notice, { viewId: view.viewId, text: 'Hello R2', chars: 8, userGestureRequired: true, writeOnly: true });
  assert.equal(await request('clipboard_pending', { viewId: view.viewId }), null);

  const nestedCommand = `cd ${JSON.stringify(nested)}; printf 'CWD_R2\\n'`;
  await request('input', { viewId: view.viewId, data: nestedCommand + '\r' });
  await poll(view.viewId, f => f.lines.some(line => line.includes('CWD_R2')));
  await new Promise(r => setTimeout(r, 1800));
  const meta = JSON.parse(fs.readFileSync(path.join(data, 'workspaces.json'), 'utf8'));
  assert.equal(meta.workspaces[ws.id].tabs[0].cwd, nested, 'periodic real tmux cwd capture');

  const second = await request('tab_new', { workspaceId: ws.id, kind: 'shell', confirmedStart: false });
  const mirror = await request('attach', { workspaceId: ws.id, tabId: second.tabs[1].id, cols: 100, rows: 10, stationId: 'r2-station' });
  assert.equal(mirror.tabId, second.tabs[1].id);
  const oldStationFrame = await poll(view.viewId, f => f.cols === 80 && f.rows === 20);
  const mirrorFrame = await poll(mirror.viewId, f => f.cols === 100 && f.rows === 10);
  assert.equal(oldStationFrame.cols, 80);
  assert.equal(mirrorFrame.cols, 100);

  await request('detach', { viewId: view.viewId });
  await request('detach', { viewId: mirror.viewId });
  cp.spawnSync(TMUX, ['-L', socket, 'kill-server'], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
  const reopened = await request('open', { stationId: 'r2-desk', projectUri: pathToFileURL(project).href, projectDir: project, name: 'ignored' });
  assert.equal(reopened.id, ws.id);
  const restored = await request('attach', { workspaceId: ws.id, tabId: first.id, cols: 80, rows: 20 });
  await request('input', { viewId: restored.viewId, data: "printf 'RESTORED_CWD:%s\\n' \"$(pwd)\"\r" });
  const cwdFrame = await poll(restored.viewId, f => f.lines.join('').includes(`RESTORED_CWD:${nested}`));
  assert.ok(cwdFrame.lines.join('').includes(`RESTORED_CWD:${nested}`), 'restored shell starts in saved cwd');
  await request('detach', { viewId: restored.viewId });
});

test('real tmux tab cap denies max+1 without creating a tab', { timeout: 60000 }, async () => {
  const ws = await request('open', { stationId: 'cap-desk', projectUri: pathToFileURL(project).href, projectDir: project, name: 'Caps' });
  for (let i = 1; i < 12; i++) await request('tab_new', { workspaceId: ws.id, kind: 'shell', confirmedStart: false });
  const full = await request('get', { workspaceId: ws.id });
  assert.equal(full.tabs.length, 12);
  await assert.rejects(request('tab_new', { workspaceId: ws.id, kind: 'shell', confirmedStart: false }), /tab limit reached/);
  assert.equal((await request('get', { workspaceId: ws.id })).tabs.length, 12);
});

test('real tmux workspace and view caps deny max+1 with readable errors', { timeout: 180000 }, async () => {
  const status = await request('status');
  assert.deepEqual(status.limits, { workspaces: 128, tabsPerWorkspace: 12, views: 192 });
  const base = await request('open', { stationId: 'boundary-0', projectUri: pathToFileURL(project).href, projectDir: project, name: 'Boundary' });
  const existingWorkspaces = (await request('ws_list')).length;
  for (let i = existingWorkspaces; i < status.limits.workspaces; i++) {
    await request('open', { stationId: `boundary-${i}`, projectUri: pathToFileURL(project).href, projectDir: project, name: `B${i}` });
  }
  assert.equal((await request('ws_list')).length, status.limits.workspaces);
  await assert.rejects(request('open', { stationId: 'boundary-over', projectUri: pathToFileURL(project).href, projectDir: project, name: 'Overflow' }), /workspace limit reached/);
  assert.equal((await request('ws_list')).length, status.limits.workspaces, 'workspace denial leaked no state');

  const views = [];
  for (let i = 0; i < status.limits.views; i++) {
    views.push((await request('attach', { workspaceId: base.id, tabId: base.tabs[0].id, cols: 20 + (i % 3), rows: 8 + (i % 2) })).viewId);
  }
  await assert.rejects(request('attach', { workspaceId: base.id, tabId: base.tabs[0].id, cols: 80, rows: 20 }), /too many open views \(192\)/);
  for (const viewId of views) await request('detach', { viewId });
});
