// w3:admin — expandable world in the Hermes admin, onboarding planner and templates.
// Run: node --test extension/test/w3-admin.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const model = require('../src/common/world-model.ts');
const rules = require('../src/common/world-admin-rules.ts');
Module._extensions['.ts'] = originalTsLoader;

const base = () => model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' });
const plan = (world, prompt) => rules.planWithRules(world, prompt, { makeId: () => 'fixed' });
const applied = (world, result) => { assert.ok(result.proposal, result.explanation); const r = model.applyWorldOps(world, result.proposal.ops); assert.equal(r.ok, true, r.error); return r.world; };
const near = (a, b) => Math.hypot(a.transform.x - b.transform.x, a.transform.z - b.transform.z);
const inside = (e, room) => { const r = model.roomRect(room); return e.transform.x > r.minX && e.transform.x < r.maxX && e.transform.z > r.minZ && e.transform.z < r.maxZ; };

// ------------------------------------------------------------------------------------- part 1: growth
test('w3 growth: 20 desks fit; the world grows past the old 40 m cap only as far as needed', () => {
  let world = base();
  for (let i = 0; i < 9; i++) world = applied(world, plan(world, 'add 2 desks'));
  assert.equal(model.stations(world).length, 20);
  assert.ok(world.shell.width <= model.SHELL_MAX && world.shell.depth <= model.SHELL_MAX);
  assert.ok(world.shell.width * world.shell.depth > 12 * 10, 'the world grew');
  assert.equal(model.validateWorld(world).ok, true);
});

test('w3 growth: the old planner stopped at 40 m wide; now 40 desks still fit (width and/or depth grow)', () => {
  let world = base();
  for (let i = 0; i < 5; i++) world = applied(world, plan(world, 'add 8 desks'));
  assert.equal(model.stations(world).length, 42);
  assert.ok(world.shell.depth > 10, 'depth grows too, not just width');
});

test('w3 growth: a monitor wall linked to a desk lands next to that desk, not in the middle', () => {
  let world = base();
  for (let i = 0; i < 4; i++) world = applied(world, plan(world, 'add 2 desks'));
  const desk = model.stations(world).at(-1);
  const r = plan(world, `add a monitor wall linked to ${desk.label.toLowerCase()}`);
  const after = applied(world, r);
  const wall = after.entities.find(e => e.kind === 'monitor-wall');
  assert.equal(wall.link, desk.id);
  assert.ok(near(wall, desk) < 4, `wall ${JSON.stringify(wall.transform)} is next to desk ${JSON.stringify(desk.transform)}`);
});

test('w3 growth: a new desk joins the other desks (not a far corner)', () => {
  let world = base();
  world = applied(world, plan(world, 'add a desk'));
  const desks = model.stations(world);
  const added = desks.at(-1);
  const others = desks.slice(0, -1);
  assert.ok(Math.min(...others.map(o => near(o, added))) < 6);
});
