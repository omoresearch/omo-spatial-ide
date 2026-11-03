// Integration tests for the persistent tmux runtime backend. They run the real vendored bridge,
// a real tmux server on a scratch socket and real bash, with a scratch HOME and data dir. Agent
// CLIs are fixture scripts that only record how they were started: no agent or model ever runs.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./runtime-test-helpers.cjs');

const s = h.scratch('int');
const haveRuntime = !!(s.env.OMO_SPATIAL_TMUX && s.env.OMO_SPATIAL_PYTHON);
const skip = haveRuntime ? false : 'tmux or python3 not available on this machine';
let { host, service } = haveRuntime ? h.makeService(s) : {};
let ws;
let shellPid;

after(async () => {
  if (host) {
    await host.stop();
  }
  h.killScratchServer(s);
});

async function type(viewId, line) {
  await service.input({ viewId, data: line + '\r' });
}

test('opens a project workspace whose first shell starts in the project directory', { skip }, async () => {
  ws = await service.openWorkspace({ stationId: 'desk-1', projectUri: s.projectUri, name: 'Demo' });
  assert.equal(ws.projectUri, s.projectUri);
  assert.equal(ws.state, 'running');
  assert.equal(ws.tabs.length, 1);
  assert.equal(ws.tabs[0].kind, 'shell');
  assert.equal(ws.tabs[0].state, 'running');
  const { viewId } = await service.attach({ workspaceId: ws.id, tabId: ws.tabs[0].id, cols: 200, rows: 30 });
  await type(viewId, 'echo "CWD:$(pwd):END"; echo "PID:$$:END"');
  const p = await h.pollUntil(service, viewId, t => /PID:\d+:END/.test(t) && /CWD:.*:END/.test(t.replace(/CWD:\$\(pwd\)/, '')));
  assert.equal(p.state, 'live');
  assert.ok(p.frame && p.frame.cols === 200 && p.frame.rows === 30, 'frame has the requested size');
  assert.equal(p.frame.foreground.length, p.frame.lines.length);
  assert.ok(p.frame.cursor && typeof p.frame.cursor.visible === 'boolean');
  const cwd = [...p.text.matchAll(/CWD:(.*?):END/g)].map(m => m[1]).find(v => v !== '$(pwd)');
  assert.equal(cwd, fs.realpathSync(s.project), 'shell output reports the project directory');
  shellPid = Number(p.text.match(/PID:(\d+):END/)[1]);
  assert.ok(shellPid > 1);
  await service.detach(viewId);
});

test('shells never inherit parent Hermes routing or the Minecraft bridge settings', { skip }, async () => {
  const { viewId } = await service.attach({ workspaceId: ws.id, tabId: ws.tabs[0].id, cols: 200, rows: 30 });
  await type(viewId, 'echo "LEAK:${HERMES_SESSION_ID:-none}:${HERMES_HOME:-none}:${OMO_DATA:-none}:${OMO_TMUX_SOCKET:-none}:END"; echo "SOCK:${TMUX%%,*}:END"');
  const p = await h.pollUntil(service, viewId, t => /LEAK:[^$]*:END/.test(t) && /SOCK:\//.test(t));
  assert.match(p.text, /LEAK:none:none:none:none:END/);
  assert.match(p.text, new RegExp(`SOCK:[^\\n]*/${s.socket}:END`), 'the shell runs on the scratch socket, not omo');
  await service.detach(viewId);
});

test('detach keeps the shell; reattach finds the same PID and exported environment', { skip }, async () => {
  let { viewId } = await service.attach({ workspaceId: ws.id, tabId: ws.tabs[0].id, cols: 120, rows: 30 });
  await type(viewId, 'export OMO_KEEP=kept-$((40+2)); echo READY-$OMO_KEEP');
  await h.pollUntil(service, viewId, t => t.includes('READY-kept-42'));
  await service.detach(viewId);
  const gone = await service.poll({ viewId, afterSequence: 0 });
  assert.equal(gone.state, 'detached');
  assert.ok(process.kill(shellPid, 0), 'shell still alive after detach');
  ({ viewId } = await service.attach({ workspaceId: ws.id, tabId: ws.tabs[0].id, cols: 120, rows: 30 }));
  await type(viewId, 'echo "AGAIN:$$:$OMO_KEEP:END"');
  const p = await h.pollUntil(service, viewId, t => /AGAIN:\d+:kept-42:END/.test(t));
  assert.equal(Number(p.text.match(/AGAIN:(\d+):/)[1]), shellPid);
  await service.resize({ viewId, cols: 90, rows: 20 });
  // stty reads the pane's real PTY size. tmux (3.3+) applies a pane resize on a short timer, so the
  // shell may see the old size for a moment: ask again (bounded) until it sees the new one.
  let q;
  for (let i = 0; i < 10; i++) {
    await type(viewId, `clear; echo "SIZE${i}:$(stty size):END"`);
    q = await h.pollUntil(service, viewId, t => new RegExp(`SIZE${i}:\\d+ \\d+:END`).test(t), 2000);
    if (new RegExp(`SIZE${i}:20 90:END`).test(q.text)) {
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const diag = () => ['list-clients -F #{client_session}_#{client_width}x#{client_height}_pid#{client_pid}', 'list-windows -a -F #{session_name}_#{window_width}x#{window_height}_#{window_id}']
    .map(c => h.tmux(s, ...c.split(' ')).stdout).join('\n');
  assert.ok(/SIZE\d:20 90:END/.test(q.text) && q.frame.cols === 90 && q.frame.rows === 20, `the PTY and the shell both see the new size:\n${diag()}\ntimedOut=${q.timedOut} state=${q.state} frame=${q.frame && q.frame.cols}x${q.frame && q.frame.rows}\n${q.text.split('\n').filter(l => l.trim()).slice(-4).join('\n')}`);
  await service.detach(viewId);
});

test('reopening the same station and project reuses the workspace; another station gets its own', { skip }, async () => {
  const again = await service.openWorkspace({ stationId: 'desk-1', projectUri: s.projectUri, name: 'Demo again' });
  assert.equal(again.id, ws.id);
  assert.equal(again.tabs.length, 1, 'no duplicate shell');
  const other = await service.openWorkspace({ stationId: 'desk-2', projectUri: s.projectUri, name: 'Other' });
  assert.notEqual(other.id, ws.id);
  const bindings = JSON.parse(fs.readFileSync(path.join(s.data, 'spatial-stations.json'), 'utf8')).bindings;
  const byStation = Object.values(bindings).map(b => [b.station, b.workspace]).sort();
  assert.deepEqual(byStation, [['desk-1', ws.id], ['desk-2', other.id]]);
  await assert.rejects(service.openWorkspace({ stationId: 'desk-1', projectUri: 'file:///definitely/not/here', name: 'x' }), /does not exist/);
  await assert.rejects(service.openWorkspace({ stationId: 'desk-1', projectUri: 'http://example.com/', name: 'x' }), /file:\/\//);
});

test('status reports tmux, profile names only, and missing agents with install hints', { skip }, async () => {
  const st = await service.status();
  assert.equal(st.available, true);
  assert.equal(st.tmux, true);
  assert.deepEqual(st.profiles, ['default', 'alpha'], 'directory names only; invalid names skipped');
  const byKind = Object.fromEntries(st.agents.map(a => [a.kind, a]));
  assert.equal(byKind.shell.available, true);
  assert.equal(byKind.hermes.available, true);
  assert.equal(byKind.claude.available, true);
  assert.equal(byKind.codex.available, false);
  assert.match(byKind.codex.installHint, /npm install -g @openai\/codex/);
  assert.ok(!JSON.stringify(st).includes('never-read'), 'profile contents are never read');
  assert.ok(!/token/i.test(JSON.stringify(st)), 'no bridge token in status');
});

test('agent tabs never start without an explicit confirmed start', { skip }, async () => {
  for (const kind of ['claude', 'hermes', 'codex']) {
    await assert.rejects(service.newTab({ workspaceId: ws.id, kind, confirmedStart: false }), /confirmed start/);
  }
  await assert.rejects(service.newTab({ workspaceId: ws.id, kind: 'codex', confirmedStart: true }), /not available.*npm install -g @openai\/codex/);
  await assert.rejects(service.newTab({ workspaceId: ws.id, kind: 'hermes', profile: 'nope', confirmedStart: true }), /no Hermes profile/);
  assert.deepEqual(h.agentLog(s), [], 'no agent process was started');
  assert.equal((await service.getWorkspace(ws.id)).tabs.length, 1);
});

test('confirmed agent tabs start their CLI in the project directory', { skip }, async () => {
  let w = await service.newTab({ workspaceId: ws.id, kind: 'claude', confirmedStart: true });
  w = await service.newTab({ workspaceId: ws.id, kind: 'hermes', profile: 'alpha', name: 'Planner', confirmedStart: true });
  assert.deepEqual(w.tabs.map(t => [t.kind, t.name]), [['shell', 'Shell'], ['claude', 'Claude Code'], ['hermes', 'Planner']]);
  const end = Date.now() + 8000;
  while (h.agentLog(s).length < 2 && Date.now() < end) {
    await new Promise(r => setTimeout(r, 100));
  }
  const log = h.agentLog(s);
  const project = fs.realpathSync(s.project);
  const claude = log.find(l => l[0] === 'claude');
  const hermes = log.find(l => l[0] === 'hermes');
  assert.ok(claude && hermes, `both fixtures started: ${JSON.stringify(log)}`);
  assert.equal(claude[1], project);
  assert.match(claude[2], /^--session-id [0-9a-f-]{36}$/);
  assert.equal(hermes[1], project);
  assert.match(hermes[2], /^-p alpha chat --tui -c omo:[0-9a-f]{12}:[0-9a-f]{12} --create-if-missing$/);
  const tab = w.tabs.find(t => t.kind === 'claude');
  const { viewId } = await service.attach({ workspaceId: ws.id, tabId: tab.id, cols: 100, rows: 20 });
  const p = await h.pollUntil(service, viewId, t => t.includes('FIXTURE-claude-STARTED'));
  assert.ok(p.text.includes('FIXTURE-claude-STARTED'));
  await service.detach(viewId);
});

test('rename and close: closing needs confirmation and only then ends the tab', { skip }, async () => {
  let w = await service.getWorkspace(ws.id);
  const hermesTab = w.tabs.find(t => t.kind === 'hermes');
  w = await service.renameTab({ workspaceId: ws.id, tabId: hermesTab.id, name: 'Renamed' });
  assert.equal(w.tabs.find(t => t.id === hermesTab.id).name, 'Renamed');
  await assert.rejects(service.closeTab({ workspaceId: ws.id, tabId: hermesTab.id, confirmedClose: false }), /confirm/);
  assert.ok((await service.getWorkspace(ws.id)).tabs.some(t => t.id === hermesTab.id));
  w = await service.closeTab({ workspaceId: ws.id, tabId: hermesTab.id, confirmedClose: true });
  assert.ok(!w.tabs.some(t => t.id === hermesTab.id));
  assert.equal(w.tabs.length, 2);
});

test('backend host stop leaves tmux running; a new host reattaches to the same shell', { skip }, async () => {
  await host.stop();
  assert.ok(process.kill(shellPid, 0), 'shell survives the host stopping');
  assert.equal(h.tmux(s, 'has-session', '-t', `=omo-${ws.id}`).status, 0);
  ({ host, service } = h.makeService(s));
  const w = await service.getWorkspace(ws.id);
  assert.equal(w.state, 'running');
  const { viewId } = await service.attach({ workspaceId: ws.id, tabId: w.tabs[0].id, cols: 120, rows: 30 });
  await type(viewId, 'echo "NEWHOST:$$:$OMO_KEEP:END"');
  const p = await h.pollUntil(service, viewId, t => /NEWHOST:\d+:kept-42:END/.test(t));
  assert.equal(Number(p.text.match(/NEWHOST:(\d+):/)[1]), shellPid);
  await service.detach(viewId);
});

test('a lost session server reads as interrupted; only a confirmed revive restarts an agent', { skip }, async () => {
  h.tmux(s, 'kill-server');    // our scratch server only: simulates a reboot
  let w = await service.getWorkspace(ws.id);
  assert.equal(w.state, 'interrupted');
  assert.ok(w.tabs.every(t => t.state === 'interrupted'), JSON.stringify(w.tabs));
  const claudeTab = w.tabs.find(t => t.kind === 'claude');
  const starts = () => h.agentLog(s).filter(l => l[0] === 'claude').length;
  const before = starts();
  await assert.rejects(service.attach({ workspaceId: ws.id, tabId: claudeTab.id, cols: 80, rows: 24 }), /interrupted.*revive/);
  // Reopening the station restores the shell (nothing re-run) but never the agent.
  w = await service.openWorkspace({ stationId: 'desk-1', projectUri: s.projectUri, name: 'Demo' });
  assert.equal(w.tabs.find(t => t.kind === 'shell').state, 'running');
  assert.equal(w.tabs.find(t => t.kind === 'claude').state, 'interrupted');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(starts(), before, 'no agent restarted on attach or reopen');
  await assert.rejects(service.reviveTab({ workspaceId: ws.id, tabId: claudeTab.id, confirmedStart: false }), /confirm/);
  w = await service.reviveTab({ workspaceId: ws.id, tabId: claudeTab.id, confirmedStart: true });
  assert.equal(w.tabs.find(t => t.id === claudeTab.id).state, 'running');
  const end = Date.now() + 8000;
  while (starts() === before && Date.now() < end) {
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(starts(), before + 1);
  const relaunch = h.agentLog(s).filter(l => l[0] === 'claude').pop();
  assert.equal(relaunch[1], fs.realpathSync(s.project), 'revived agent starts in the project directory');
});

test('the runtime never touched the Minecraft omo socket or data directory', { skip }, () => {
  assert.ok(!fs.existsSync(path.join(s.home, '.local', 'share', 'omo')), 'no legacy data dir created in scratch HOME');
  assert.ok(fs.existsSync(path.join(s.data, 'workspaces.json')));
  assert.ok(fs.existsSync(path.join(s.data, 'token')));
  assert.equal((fs.statSync(path.join(s.data, 'token')).mode & 0o777), 0o600);
  const meta = fs.readFileSync(path.join(s.data, 'workspaces.json'), 'utf8');
  assert.ok(!meta.includes('parent-session-must-not-leak'));
});
