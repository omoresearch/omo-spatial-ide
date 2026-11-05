const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeConsoleController } = require('../src/browser/runtime-console-controller.ts');

function rig() {
  const calls = [];
  let workspace = { id: 'ws-1', name: 'Room', projectUri: 'file:///p', profile: 'default', state: 'running', tabs: [{ id: 'tab-1', name: 'Shell', kind: 'shell', state: 'running', busy: false }] };
  let attachCount = 0;
  const service = {
    async status() { return { available: true, tmux: true, python: true, profiles: ['default'], agents: [{ kind: 'shell', available: true, detail: 'ok' }, { kind: 'hermes', available: true, detail: 'ok' }, { kind: 'claude', available: true, detail: 'ok' }, { kind: 'codex', available: true, detail: 'ok' }], detail: 'ok' }; },
    async openWorkspace() { return workspace; },
    async attach(input) { calls.push(['attach', input]); return { viewId: `view-${++attachCount}` }; },
    async poll(input) { calls.push(['poll', input]); return { state: 'live', frame: { sequence: 1, cols: input.viewId === 'view-1' ? 80 : 120, rows: 22, lines: ['ready'] } }; },
    async detach(id) { calls.push(['detach', id]); },
    async input() {}, async resize() {},
    async newTab(input) { calls.push(['newTab', input]); workspace = { ...workspace, tabs: [...workspace.tabs, { id: `tab-${workspace.tabs.length + 1}`, name: input.name || input.kind, kind: input.kind, state: 'running', busy: false }] }; return workspace; },
    async setWorkspaceProfile(input) { calls.push(['profile', input]); workspace = { ...workspace, profile: input.profile }; return workspace; },
  };
  const states = []; const timers = [];
  const controller = new RuntimeConsoleController({ service, schedule: (fn) => { timers.push(fn); return fn; }, cancel: () => {}, onChange: state => states.push(state) });
  return { controller, service, calls, states, timers };
}

test('desk and mirror attach use the same station id but keep requested dimensions', async () => {
  const r = rig(); await r.controller.bind({ stationId: 'desk-a', projectUri: 'file:///p', name: 'Room' });
  assert.deepEqual(r.calls.find(c => c[0] === 'attach')[1], { workspaceId: 'ws-1', tabId: 'tab-1', cols: 80, rows: 22, stationId: 'desk-a' });
  assert.equal(await r.controller.attachMirror('desk-a'), true);
  assert.deepEqual(r.calls.filter(c => c[0] === 'attach')[1][1], { workspaceId: 'ws-1', tabId: 'tab-1', cols: 120, rows: 40, stationId: 'desk-a' });
  assert.ok(r.calls.filter(c => c[0] === 'poll').length >= 2);
});

test('recipe apply is pending until one explicit confirmation', async () => {
  const r = rig(); await r.controller.bind({ stationId: 'desk-a', projectUri: 'file:///p', name: 'Room' });
  const recipe = { version: 1, id: 'r1', name: 'Review pair', stationId: 'terminal', profile: 'default', tabs: [{ kind: 'hermes' }, { kind: 'shell' }] };
  r.controller.requestRecipeApply(recipe);
  assert.equal(r.calls.filter(c => c[0] === 'newTab').length, 0);
  assert.equal(r.controller.state.pending.type, 'recipe');
  await r.controller.confirmPending();
  assert.equal(r.calls.filter(c => c[0] === 'newTab').length, 2);
  assert.match(r.controller.state.notice, /Recipe/);
});
