// w2:admin — admin console controller against the local stand-in world store (no backend, no model).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const { AdminController, LocalAdminWorldStore } = require('../src/browser/admin-controller.ts');
const { planWithRules } = require('../src/common/world-admin-rules.ts');
const model = require('../src/common/world-model.ts');
Module._extensions['.ts'] = originalTsLoader;

class MemoryStorage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
const room = { version: 1, theme: 'station', projectUri: 'file:///p', projectName: 'P', camera: { azimuth: 0, elevation: 0.6, distance: 20 } };
const service = { calls: [], async plan(req) { this.calls.push(req); const r = planWithRules(req.world, req.prompt); return { proposal: r.proposal, explanation: r.explanation, planner: 'rules', steps: r.steps, notes: r.notes }; }, async hermesStatus() { return { available: true, busy: false, profile: 'default', message: 'ok' }; } };

function make() {
  const storage = new MemoryStorage();
  const store = new LocalAdminWorldStore(storage, 'file:///p', room);
  const c = new AdminController({ service, store: () => store, onChange: () => {}, storage });
  c.toggle(true);
  return { c, store, storage };
}

test('ask → proposed; nothing applied until Apply; Apply saves world v2', async () => {
  const { c, store, storage } = make();
  await c.ask('add a third desk for Codex and a big monitor wall linked to it');
  const e = c.state.entries[0];
  assert.equal(e.status, 'proposed');
  assert.equal(store.world.revision, 0);
  assert.equal(storage.getItem(model.worldStorageKey('file:///p')), null);
  c.apply(e.id);
  assert.equal(c.state.entries[0].status, 'applied');
  assert.equal(store.world.revision, 1);
  assert.equal(model.stations(store.world).length, 3);
  assert.ok(storage.getItem(model.worldStorageKey('file:///p')));
});

test('Discard leaves the world unchanged; a new ask replaces the pending plan', async () => {
  const { c, store } = make();
  await c.ask('add a plant');
  await c.ask('add a lamp');
  assert.deepEqual(c.state.entries.map(e => e.status), ['discarded', 'proposed']);
  c.discard(c.state.entries[1].id);
  assert.equal(c.state.entries[1].status, 'discarded');
  assert.equal(store.world.revision, 0);
});

test('a plan made on an older revision goes stale and cannot apply', async () => {
  const { c, store } = make();
  await c.ask('add a plant');
  const first = c.state.entries[0];
  // Another edit lands first (e.g. build mode).
  const other = planWithRules(store.world, 'add a lamp'); store.propose(other.proposal); assert.equal(store.apply(other.proposal.id).ok, true);
  assert.equal(c.state.entries[0].status, 'stale');
  c.apply(first.id);
  assert.equal(store.world.revision, 1);
});

test('Hermes is never requested unless turned on and confirmed', async () => {
  const { c } = make();
  service.calls.length = 0;
  c.setUseHermes(true);              // opens confirmation only
  await c.ask('add a desk');
  assert.equal(service.calls[0].useHermes, undefined);
  await c.refreshHermes(); c.confirmHermes();
  await c.ask('add a lamp');
  assert.equal(service.calls[1].useHermes, true);
  assert.equal(service.calls[1].confirmedHermes, true);
  c.setProfile('other');             // a new profile needs a new confirmation
  await c.ask('add a rug');
  assert.equal(service.calls[2].useHermes, undefined);
});
