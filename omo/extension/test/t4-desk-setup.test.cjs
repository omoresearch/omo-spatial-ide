// t4:polish (1) — a new desk never pops 'Set up this station?'; setup is offered only on the user's first open, confirm first.
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
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
Module._resolveFilename = function (request, parent, ...rest) {
  try { return originalResolve.call(this, request, parent, ...rest); }
  catch (error) { if (request.startsWith('.')) return originalResolve.call(this, request + '.ts', parent, ...rest); throw error; }
};
const { WorldStations } = require('../src/browser/world-stations.ts');
const model = require('../src/common/world-model.ts');
const rules = require('../src/common/world-admin-rules.ts');
Module._extensions['.ts'] = originalTsLoader;
Module._resolveFilename = originalResolve;

const SRC = path.resolve(__dirname, '../src/browser');
const PROJECT = 'file:///t4/project';

function memoryStorage() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; }

/** WorldStations over a fake runtime: every desk opens a fresh workspace with one shell tab. Records every start. */
function rig() {
  const calls = [];
  let seq = 0;
  const service = {
    async status() { return { available: true, tmux: true, python: true, profiles: ['default'], agents: ['shell', 'hermes', 'claude', 'codex'].map(kind => ({ kind, available: true, detail: 'ok' })), detail: 'ok' }; },
    async openWorkspace(input) { calls.push(['openWorkspace', input.stationId]); return { id: `ws-${input.stationId}`, name: 'Room', projectUri: PROJECT, profile: 'default', state: 'running', tabs: [{ id: `tab-${++seq}`, name: 'Shell', kind: 'shell', state: 'running', busy: false }] }; },
    async attach() { return { viewId: `view-${++seq}` }; },
    async poll() { return { state: 'live', frame: { sequence: 1, cols: 80, rows: 22, lines: ['$'] } }; },
    async detach() {}, async input() {}, async resize() {},
    async newTab(input) { calls.push(['newTab', input.kind]); throw new Error('no tab may start in this test'); },
    async setWorkspaceProfile(input) { calls.push(['profile', input.profile]); throw new Error('no profile change in this test'); },
  };
  const storage = memoryStorage();
  const stations = new WorldStations({ service, storage, schedule: () => 0, cancel: () => {}, onChange: () => {} });
  const offer = id => stations.maybeOfferSetup(id, stations.state(id), PROJECT);
  const open = async id => { await stations.controller(id).bind({ stationId: `rt-${id}`, projectUri: PROJECT, name: 'Room' }); };
  return { stations, calls, offer, open, storage };
}

function worldWithNewDesk() {
  const base = model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' });
  const plan = rules.planWithRules(base, 'add a desk for Codex');
  const applied = model.applyWorldOps(base, plan.proposal.ops);
  assert.equal(applied.ok, true, applied.error);
  const added = model.stations(applied.world).map(s => s.id).find(id => id !== 'terminal' && id !== 'terminal-2');
  assert.ok(added, 'the planner added a desk');
  return { world: applied.world, added };
}

test('(1) adding a desk to the world never opens a setup prompt, on the new desk or on a desk already in use', async () => {
  const r = rig();
  r.stations.setWorld(model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' }), true);
  await r.open('terminal');
  assert.equal(r.stations.state('terminal').phase, 'live');
  const { world, added } = worldWithNewDesk();
  r.stations.setWorld(world, true); // build mode / admin Apply
  // Every later poll of the live desk re-checks; none of them may offer setup.
  for (let i = 0; i < 5; i++) assert.equal(r.offer('terminal'), false, 'a desk already in use is never offered setup');
  assert.equal(r.offer(added), false, 'the new desk is not offered setup just because it was added');
  assert.equal(r.stations.state('terminal').pending, undefined);
  assert.equal(r.stations.peek(added), undefined, 'adding a desk does not even create its controller');
  assert.deepEqual(r.calls.filter(c => c[0] !== 'openWorkspace'), [], 'nothing started');
});

test('(1) a desk first opened before the world was saved is not offered setup later, when a desk is added', async () => {
  const r = rig();
  r.stations.setWorld(model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' }), false); // classic room, no saved world
  r.stations.armSetup('terminal');
  await r.open('terminal');
  assert.equal(r.offer('terminal'), false, 'no setup offer without a saved world');
  const { world } = worldWithNewDesk();
  r.stations.setWorld(world, true); // the first Apply saves the world
  for (let i = 0; i < 5; i++) assert.equal(r.offer('terminal'), false, 'the earlier open does not carry over to a later poll');
  assert.equal(r.stations.state('terminal').pending, undefined);
});

test('(1) the first explicit open of a desk offers its setup once, and nothing starts until confirmation', async () => {
  const r = rig();
  const { world, added } = worldWithNewDesk();
  r.stations.setWorld(world, true);
  r.stations.armSetup(added); // the user clicked its monitor / picked it in the desk switcher
  await r.open(added);
  assert.equal(r.offer(added), true, 'the first open offers the configured tabs');
  const pending = r.stations.state(added).pending;
  assert.equal(pending?.type, 'recipe');
  assert.equal(pending?.setup, true);
  assert.match(pending.message, /Nothing launches until you confirm/);
  assert.deepEqual(r.calls.filter(c => c[0] === 'newTab' || c[0] === 'profile'), [], 'no tab or profile change before confirmation');
  r.stations.controller(added).cancelPending();
  assert.equal(r.offer(added), false, 'offered once only');
  r.stations.armSetup(added);
  assert.equal(r.offer(added), false, 'opening the same workspace again does not ask again');
});

test('(1) the widget arms setup only from an explicit open, never from a world change or a state poll', () => {
  const widget = fs.readFileSync(path.join(SRC, 'omo-world-widget.tsx'), 'utf8');
  const consoleChanged = widget.slice(widget.indexOf('private consoleChanged('), widget.indexOf('private save('));
  assert.ok(consoleChanged.length > 0);
  assert.doesNotMatch(consoleChanged, /armSetup/, 'a state change never arms the setup offer');
  const openTerminal = widget.slice(widget.indexOf('private async openTerminal('), widget.indexOf('private async openReviewSnapshot('));
  assert.match(openTerminal, /armSetup\(/, 'opening a desk (monitor click / desk switcher) arms the offer');
  const readWorld = widget.slice(widget.indexOf('private readWorld('), widget.indexOf('private stationsChanged('));
  assert.doesNotMatch(readWorld, /armSetup|maybeOfferSetup|requestRecipeApply/, 'a world change never offers setup');
});


test('(1) a failed first open, a project change or a presence change clears the first-open arm (no later unprompted setup)', async () => {
  const r = rig();
  const { world, added } = worldWithNewDesk();
  r.stations.setWorld(world, true);
  r.stations.armSetup(added);
  r.stations.disarmSetup(added); // openTerminal: the bind did not go live
  await r.open(added);
  assert.equal(r.offer(added), false, 'a reconnect after a failed first open asks nothing');
  r.stations.armSetup(added);
  r.stations.disarmSetup(); // project switch / join / leave a room
  assert.equal(r.stations.isSetupArmed(added), false);
  assert.equal(r.offer(added), false);
  assert.deepEqual(r.calls.filter(c => c[0] !== 'openWorkspace'), [], 'no tab or profile change: nothing started');
  const src = fs.readFileSync(path.join(SRC, 'omo-world-widget.tsx'), 'utf8');
  const openTerminal = src.slice(src.indexOf('private async openTerminal('), src.indexOf('private async openReviewSnapshot('));
  assert.match(openTerminal, /catch \(error\) \{ this\.stations\.disarmSetup\(station\)/, 'a thrown open disarms');
  assert.match(openTerminal, /phase !== 'live'\) this\.stations\.disarmSetup\(station\)/, 'an open that is not live disarms');
  assert.match(src, /joinPresence=\([^)]*\):void=>\{this\.stations\.disarmSetup\(\)/);
  assert.match(src, /leavePresence=\(\):void=>\{this\.stations\.disarmSetup\(\)/);
  assert.match(src, /this\.stations\.disarmSetup\(\); \/\/ t4:polish: a project change/);
});
