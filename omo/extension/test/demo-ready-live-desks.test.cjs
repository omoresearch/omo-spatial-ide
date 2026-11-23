// demo-ready (1) — every idle desk opens a plain live shell when a world loads; agents start only on the user's pick,
// through the 'Start station tabs' confirmation when the desk has that agent configured. View caps are respected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');

const originalTsLoader = Module._extensions['.ts'];
const originalResolve = Module._resolveFilename;
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
Module._resolveFilename = function (request, parent, ...rest) {
  try { return originalResolve.call(this, request, parent, ...rest); }
  catch (error) { if (request.startsWith('.')) return originalResolve.call(this, request + '.ts', parent, ...rest); throw error; }
};
const { WorldStations, IDLE_VIEW_RESERVE } = require('../src/browser/world-stations.ts');
const model = require('../src/common/world-model.ts');
const rules = require('../src/common/world-admin-rules.ts');
Module._extensions['.ts'] = originalTsLoader;
Module._resolveFilename = originalResolve;

const PROJECT = 'file:///demo/project';
const SRC = path.resolve(__dirname, '../src/browser');
function memoryStorage() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; }
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

function rig(views = 192) {
  const calls = []; let seq = 0;
  const service = {
    async status() { return { available: true, tmux: true, python: true, profiles: ['default'], limits: { workspaces: 128, tabsPerWorkspace: 12, views },
      agents: ['shell', 'hermes', 'claude', 'codex'].map(kind => ({ kind, available: true, detail: 'ok' })), detail: 'ok' }; },
    async openWorkspace(input) { calls.push(['openWorkspace', input.stationId]); return { id: `ws-${input.stationId}`, name: input.name, profile: 'default', projectUri: input.projectUri,
      tabs: [{ id: `t-${input.stationId}`, name: 'Shell', kind: 'shell', state: 'running' }] }; },
    async attach(input) { calls.push(['attach', input.tabId]); return { viewId: `view-${++seq}` }; },
    async poll() { return { state: 'live', frame: { sequence: 1, cols: 80, rows: 22, lines: ['fixture:~/project$ '] } }; },
    async detach() {}, async input() { calls.push(['input']); }, async resize() {},
    async newTab(input) { calls.push(['newTab', input.kind]); throw new Error('no tab may start in this test'); },
    async setWorkspaceProfile(input) { calls.push(['profile', input.profile]); throw new Error('no profile change in this test'); },
  };
  const stations = new WorldStations({ service, storage: memoryStorage(), schedule: () => 0, cancel: () => {}, onChange: () => {} });
  return { stations, calls };
}
function world(n) {
  let w = model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' });
  while (model.stations(w).length < n) {
    const plan = rules.planWithRules(w, 'add a desk for Claude');
    const r = model.applyWorldOps(w, plan.proposal.ops); assert.equal(r.ok, true, r.error); w = r.world;
  }
  return w;
}
const ctx = { projectUri: PROJECT, roomName: 'Fixture' };

test('a loaded world opens a plain live shell at every desk; no agent tab, no input', async () => {
  const r = rig(); r.stations.setWorld(world(4), true);
  const result = await r.stations.openIdleDesks(ctx); await flush();
  assert.deepEqual(result.opened, r.stations.ids()); assert.deepEqual(result.capped, []);
  for (const id of r.stations.ids()) assert.equal(r.stations.state(id).phase, 'live', id);
  assert.equal(r.calls.filter(c => c[0] === 'openWorkspace').length, 4);
  assert.deepEqual(r.calls.filter(c => c[0] === 'newTab' || c[0] === 'input' || c[0] === 'profile'), [], 'nothing started, nothing typed');
  for (const id of r.stations.ids()) assert.equal(r.stations.state(id).pending, undefined, 'no setup prompt on load');
  // A second load does not reopen live desks.
  const again = await r.stations.openIdleDesks(ctx); assert.deepEqual(again.opened, []);
});

test('the host view cap is respected: desks past it keep their idle card', async () => {
  const r = rig(IDLE_VIEW_RESERVE + 2); r.stations.setWorld(world(5), true);
  const result = await r.stations.openIdleDesks(ctx); await flush();
  assert.equal(result.opened.length, 2); assert.equal(result.capped.length, 3);
  for (const id of result.capped) assert.equal(r.stations.peek(id)?.state.phase ?? 'idle', 'idle');
});

test('picking a configured agent shows the Start station tabs confirmation; nothing starts before it', async () => {
  const r = rig(); r.stations.setWorld(world(3), true);
  await r.stations.openIdleDesks(ctx); await flush();
  const id = r.stations.ids().find(i => r.stations.info(i).config.tabs.some(t => t.kind === 'claude')); assert.ok(id, 'a Claude desk');
  const c = r.stations.controller(id);
  await c.requestNewTab('claude');
  const pending = c.state.pending;
  assert.equal(pending?.type, 'recipe'); assert.equal(pending?.setup, true); assert.equal(pending?.confirmLabel, 'Start station tabs');
  assert.deepEqual(pending.recipe.tabs.map(t => t.kind), ['claude']);
  assert.deepEqual(r.calls.filter(c => c[0] === 'newTab'), [], 'nothing started');
  c.cancelPending();
  // An agent the desk does not have configured: the plain one-agent confirmation.
  await c.requestNewTab('codex');
  assert.equal(c.state.pending?.type, 'new'); assert.equal(c.state.pending?.confirmLabel, 'Start Codex');
  assert.deepEqual(r.calls.filter(c => c[0] === 'newTab'), []);
});

test('the widget opens idle desks on world load, project change, presence change and room save; never from a state poll', () => {
  const src = fs.readFileSync(path.join(SRC, 'omo-world-widget.tsx'), 'utf8');
  const consoleChanged = src.slice(src.indexOf('private consoleChanged('), src.indexOf('private save('));
  assert.doesNotMatch(consoleChanged, /openIdleDesks/);
  assert.ok((src.match(/this\.openIdleDesks\(\)/g) ?? []).length >= 5);
  const body = src.slice(src.indexOf('private openIdleDesks('), src.indexOf('private stationsChanged('));
  assert.match(body, /this\.configuring/); assert.doesNotMatch(body, /newTab|requestRecipeApply|sendInput/);
});
