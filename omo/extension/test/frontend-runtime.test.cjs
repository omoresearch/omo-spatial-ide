const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./frontend-runtime-helpers.cjs');

const PROJECT_A = { stationId: 'terminal-1', projectUri: 'file:///p/a', name: 'Room A' };
const PROJECT_B = { stationId: 'terminal-1', projectUri: 'file:///p/b', name: 'Room B' };
const frame = (sequence, lines, extra = {}) => ({ state: 'live', frame: { sequence, cols: 80, rows: 22, lines, ...extra } });

async function live(options) {
  const env = H.make(options);
  await env.controller.bind(PROJECT_A);
  await H.settle();
  return env;
}

test('binding opens the station workspace once, attaches the active tab at 80x22 and polls frames by sequence', async () => {
  const service = new H.FakeRuntime();
  service.pollQueue.push(frame(3, ['$ ls', 'README.md'], { foreground: ['7777', '777777777'], background: ['0000', '000000000'], palette: { '7': 'e8e1d5', '0': '1a1511' }, cursor: { x: 2, y: 0, visible: true } }));
  const { controller, timers } = await live({ service });
  assert.deepEqual(service.named('openWorkspace').map(c => c.arg), [{ stationId: 'terminal-1', projectUri: 'file:///p/a', name: 'Room A' }]);
  assert.deepEqual(service.named('attach').map(c => c.arg), [{ workspaceId: 'ws-1', tabId: 't1', cols: 80, rows: 22 }]);
  assert.deepEqual(service.named('poll')[0].arg, { viewId: 'v1', afterSequence: 0 });
  const s = controller.state;
  assert.equal(s.phase, 'live');
  assert.deepEqual(s.lines, ['$ ls', 'README.md']);
  assert.deepEqual(s.foreground, ['7777', '777777777']);
  assert.deepEqual(s.cursor, { x: 2, y: 0, visible: true });
  assert.equal(s.palette['7'], 'e8e1d5');
  await timers.tick();
  assert.deepEqual(service.named('poll')[1].arg, { viewId: 'v1', afterSequence: 3 });
  assert.equal(service.named('newTab').length, 0, 'binding must never launch tabs');
  controller.dispose();
});

test('stale or older frames never overwrite newer monitor output, and only one poll is in flight', async () => {
  const service = new H.FakeRuntime();
  service.pollQueue.push(frame(5, ['new']));
  const { controller, timers } = await live({ service });
  service.pollQueue.push(frame(4, ['old']));
  await timers.tick();
  assert.deepEqual(controller.state.lines, ['new']);
  const hold = H.deferred(); service.hold.poll = hold;
  await timers.tick();
  const before = service.named('poll').length;
  await timers.tick(); await timers.tick();
  assert.equal(service.named('poll').length, before, 'no overlapping polls while one is pending');
  assert.equal(timers.queue.filter(t => t.ms <= 1000).length, 0, 'no poll timer queued while a poll is pending');
  hold.resolve(frame(6, ['newer'])); await H.settle();
  assert.deepEqual(controller.state.lines, ['newer']);
  controller.dispose();
});

test('typing forwards to the same attached view; without a view nothing is sent and the UI says so', async () => {
  const { controller, service } = await live();
  await controller.sendInput('ls\r');
  assert.deepEqual(service.named('input').map(c => c.arg), [{ viewId: 'v1', data: 'ls\r' }]);
  controller.dispose();
  const idle = H.make();
  await idle.controller.sendInput('x');
  assert.equal(idle.service.named('input').length, 0);
  assert.match(idle.controller.state.error, /not connected/i);
});

test('a refresh reconnects the stored project+station binding to the same tab without new sessions', async () => {
  const storage = new H.MemoryStorage();
  const service = new H.FakeRuntime();
  service.ws = H.workspace([H.tab('t1'), H.tab('t2', { kind: 'hermes', name: 'Hermes' })]);
  const first = H.make({ service, storage });
  await first.controller.bind(PROJECT_A); await H.settle();
  await first.controller.selectTab('t2'); await H.settle();
  first.controller.dispose();
  assert.deepEqual(service.named('detach').map(c => c.arg), ['v1', 'v2']);

  const fresh = H.make({ storage, service: new H.FakeRuntime() });
  fresh.service.ws = service.ws;
  await fresh.controller.reconnect(PROJECT_A); await H.settle();
  assert.equal(fresh.service.named('openWorkspace').length, 1);
  assert.equal(fresh.service.named('attach')[0].arg.tabId, 't2', 'reattach the tab that was on the monitor');
  for (const name of ['newTab', 'reviveTab', 'closeTab']) assert.equal(fresh.service.named(name).length, 0, `${name} must not run on refresh`);

  const unbound = H.make({ storage: new H.MemoryStorage() });
  await unbound.controller.reconnect(PROJECT_A); await H.settle();
  assert.equal(unbound.service.named('openWorkspace').length, 0, 'no binding: wait for the user to click the monitor');
  fresh.controller.dispose();
});

test('interrupted agents are shown as interrupted and never auto-restarted; dispose only detaches', async () => {
  const service = new H.FakeRuntime();
  service.ws = H.workspace([H.tab('t1', { kind: 'hermes', name: 'Hermes', state: 'interrupted', detail: 'lost after restart' })]);
  const { controller } = await live({ service });
  assert.equal(service.named('reviveTab').length, 0);
  assert.equal(service.named('newTab').length, 0);
  assert.equal(service.named('attach').length, 0, 'an interrupted tab is not attached as if live');
  assert.match(controller.state.statusText, /interrupted/i);
  controller.dispose();
  assert.equal(service.named('closeTab').length, 0);
});

test('busy and exited state comes from runtime metadata in poll results', async () => {
  const service = new H.FakeRuntime();
  service.pollQueue.push({ state: 'live', workspace: H.workspace([H.tab('t1', { busy: true })]) });
  const { controller, timers } = await live({ service });
  assert.equal(controller.state.workspace.tabs[0].busy, true);
  service.pollQueue.push({ state: 'live', workspace: H.workspace([H.tab('t1', { state: 'exited' })]) });
  await timers.tick();
  assert.equal(controller.state.workspace.tabs[0].state, 'exited');
  assert.equal(controller.state.workspace.tabs[0].busy, false);
  controller.dispose();
});

test('dispose while the workspace is opening prevents a late attach', async () => {
  const env = H.make();
  const hold = H.deferred(); env.service.hold.openWorkspace = hold;
  const binding = env.controller.bind(PROJECT_A);
  await H.settle();
  env.controller.dispose();
  hold.resolve(H.workspace([H.tab('t1')]));
  await binding; await H.settle();
  assert.equal(env.service.named('attach').length, 0);
  assert.equal(env.service.named('poll').length, 0);
});

test('a view that attaches after dispose is detached at once and never polled', async () => {
  const env = H.make();
  const hold = H.deferred(); env.service.hold.attach = hold;
  const binding = env.controller.bind(PROJECT_A);
  await H.settle();
  env.controller.dispose();
  hold.resolve({ viewId: 'late' });
  await binding; await H.settle();
  assert.deepEqual(env.service.named('detach').map(c => c.arg), ['late']);
  assert.equal(env.service.named('poll').length, 0);
});

test('switching project detaches the old view, opens the new binding and ignores the old poll result', async () => {
  const service = new H.FakeRuntime();
  const { controller, timers } = await live({ service });
  const hold = H.deferred(); service.hold.poll = hold;
  await timers.tick(); // project A's poll is now in flight
  await controller.bind(PROJECT_B); await H.settle();
  assert.ok(service.named('detach').some(c => c.arg === 'v1'));
  assert.equal(service.named('openWorkspace')[1].arg.projectUri, 'file:///p/b');
  hold.resolve(frame(99, ['from project A']));
  await H.settle();
  assert.ok(!controller.state.lines.includes('from project A'));
  controller.dispose();
});

test('switching to a project with no saved binding detaches the old view and opens nothing', async () => {
  const { controller, service } = await live();
  await controller.reconnect(PROJECT_B); await H.settle();
  assert.deepEqual(service.named('detach').map(c => c.arg), ['v1']);
  assert.equal(service.named('openWorkspace').length, 1);
  assert.equal(controller.state.phase, 'idle');
  assert.deepEqual(controller.state.lines, []);
  controller.dispose();
});

test('agent launches need an explicit confirm; only then newTab is sent with confirmedStart true', async () => {
  const { controller, service } = await live();
  await controller.requestNewTab('claude');
  assert.equal(service.named('newTab').length, 0, 'clicking + Claude only shows the warning');
  assert.equal(controller.state.pending.type, 'new');
  assert.match(controller.state.pending.message, /Claude Code/);
  controller.cancelPending();
  assert.equal(controller.state.pending, undefined);
  assert.equal(service.named('newTab').length, 0);
  await controller.requestNewTab('claude');
  await controller.confirmPending(); await H.settle();
  const call = service.named('newTab')[0].arg;
  assert.equal(call.kind, 'claude'); assert.equal(call.confirmedStart, true); assert.equal(call.workspaceId, 'ws-1');
  assert.equal(controller.state.activeTabId, 't2', 'the new tab goes on the monitor');
  assert.equal(service.named('attach').at(-1).arg.tabId, 't2');
  controller.dispose();
});

test('a new shell is started directly by the click, Hermes uses the selected profile', async () => {
  const { controller, service } = await live();
  await controller.requestNewTab('shell'); await H.settle();
  assert.deepEqual(service.named('newTab')[0].arg, { workspaceId: 'ws-1', kind: 'shell', confirmedStart: true });
  controller.setProfile('not-a-profile');
  assert.equal(controller.state.profile, 'omo-dev');
  controller.setProfile('default');
  await controller.requestNewTab('hermes');
  assert.match(controller.state.pending.message, /default/);
  await controller.confirmPending(); await H.settle();
  assert.deepEqual(service.named('newTab')[1].arg, { workspaceId: 'ws-1', kind: 'hermes', profile: 'default', confirmedStart: true });
  controller.dispose();
});

test('unavailable CLIs are disabled with the reason and install hint, and cannot be launched', async () => {
  const { loadController } = H;
  const { launcherOptions } = loadController();
  const codex = launcherOptions(H.hostStatus()).find(o => o.kind === 'codex');
  assert.equal(codex.available, false);
  assert.match(codex.reason, /codex not found/);
  assert.equal(codex.installHint, 'npm install -g @openai/codex');
  const missingTmux = launcherOptions(H.hostStatus({ tmux: false, detail: 'tmux is not installed' }));
  assert.ok(missingTmux.every(o => !o.available && /tmux/.test(o.reason)));
  assert.ok(launcherOptions(undefined).every(o => !o.available));
  const { controller, service } = await live();
  await controller.requestNewTab('codex');
  assert.equal(controller.state.pending, undefined);
  assert.equal(service.named('newTab').length, 0);
  assert.match(controller.state.error, /npm install -g @openai\/codex/);
  controller.dispose();
});

test('a failed launch shows the error and leaves no fake tab or success label', async () => {
  const { controller, service } = await live();
  const hold = H.deferred(); service.hold.newTab = hold;
  await controller.requestNewTab('claude');
  const confirming = controller.confirmPending();
  hold.reject(new Error('claude exited with code 127'));
  await confirming; await H.settle();
  assert.match(controller.state.error, /claude exited with code 127/);
  assert.doesNotMatch(controller.state.statusText, /started/i);
  assert.equal(controller.state.workspace.tabs.length, 1);
  assert.equal(controller.state.activeTabId, 't1');
  assert.equal(controller.state.pending, undefined);
  controller.dispose();
});

test('closing and reviving a tab each need explicit confirmation flags', async () => {
  const service = new H.FakeRuntime();
  service.ws = H.workspace([H.tab('t1'), H.tab('t2', { kind: 'hermes', name: 'Hermes', state: 'interrupted' })]);
  const { controller } = await live({ service });
  controller.requestRevive('t2');
  assert.equal(service.named('reviveTab').length, 0);
  await controller.confirmPending(); await H.settle();
  assert.deepEqual(service.named('reviveTab')[0].arg, { workspaceId: 'ws-1', tabId: 't2', confirmedStart: true });
  controller.requestClose('t2');
  assert.match(controller.state.pending.message, /Hermes/);
  assert.equal(service.named('closeTab').length, 0);
  await controller.confirmPending(); await H.settle();
  assert.deepEqual(service.named('closeTab')[0].arg, { workspaceId: 'ws-1', tabId: 't2', confirmedClose: true });
  assert.deepEqual(controller.state.workspace.tabs.map(t => t.id), ['t1']);
  controller.dispose();
});

test('poll failures show reconnecting and a detached view is re-attached without new sessions', async () => {
  const service = new H.FakeRuntime();
  service.pollQueue.push(() => { throw new Error('socket closed'); });
  const { controller, timers } = await live({ service });
  assert.equal(controller.state.phase, 'reconnecting');
  assert.match(controller.state.statusText, /reconnect/i);
  service.pollQueue.push({ state: 'detached', detail: 'view expired' });
  await timers.tick(5000); await H.settle();
  await timers.tick(5000); await H.settle();
  assert.equal(service.named('attach').length, 2, 'a detached view is attached again');
  assert.equal(service.named('newTab').length, 0);
  service.pollQueue.push(frame(1, ['back']));
  await timers.tick(5000);
  assert.equal(controller.state.phase, 'live');
  assert.equal(controller.state.error, '');
  controller.dispose();
});

test('an unavailable host is reported honestly and no workspace is opened', async () => {
  const service = new H.FakeRuntime();
  service.statusValue = H.hostStatus({ available: false, tmux: false, detail: 'tmux is not installed. Install it with: sudo apt install tmux' });
  const { controller } = await live({ service });
  assert.equal(controller.state.phase, 'unavailable');
  assert.match(controller.state.statusText, /sudo apt install tmux/);
  assert.equal(service.named('openWorkspace').length, 0);
});

test('monitor cell runs map per-cell palette colours and fall back to defaults', () => {
  const { cellRuns } = H.loadController();
  const runs = cellRuns('ab cd', '11777', '00004', { '1': 'e5645a', '7': '#e8e1d5', '0': '1a1511', '4': '6a9fd8' }, { fg: '#e0e8eb', bg: '#091119' });
  assert.deepEqual(runs, [
    { x: 0, text: 'ab', fg: '#e5645a', bg: '#1a1511' },
    { x: 2, text: ' c', fg: '#e8e1d5', bg: '#1a1511' },
    { x: 4, text: 'd', fg: '#e8e1d5', bg: '#6a9fd8' }
  ]);
  assert.deepEqual(cellRuns('plain', undefined, undefined, undefined, { fg: '#fff', bg: '#000' }), [{ x: 0, text: 'plain', fg: '#fff', bg: '#000' }]);
});

test('closing the project releases the monitor view but a later project can still connect', async () => {
  const { controller, service } = await live();
  controller.release();
  assert.deepEqual(service.named('detach').map(c => c.arg), ['v1']);
  assert.equal(service.named('closeTab').length, 0);
  assert.equal(controller.state.phase, 'idle');
  await controller.bind(PROJECT_B); await H.settle();
  assert.equal(controller.state.phase, 'live');
  assert.equal(service.named('openWorkspace').at(-1).arg.projectUri, 'file:///p/b');
  controller.dispose();
});

test('the most common background key is treated as the terminal background', () => {
  const { dominantKey } = H.loadController();
  assert.equal(dominantKey(['0000', '0044', '000']), '0');
  assert.equal(dominantKey(undefined), undefined);
});
