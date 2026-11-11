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
const onboarding = require('../src/browser/onboarding-planner.ts');
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

// ------------------------------------------------------------------------------------- part 2: intents
test('w3 intents: "add a room for research with 4 desks" — a room next to the existing area, desks inside, door facing it', () => {
  const world = base();
  const r = plan(world, 'add a room for research with 4 desks');
  const after = applied(world, r);
  const room = model.rooms(after).find(x => /research/i.test(x.label));
  assert.ok(room, 'research room');
  const desks = model.stations(after).filter(d => inside(d, room));
  assert.equal(desks.length, 4, 'the 4 new desks are inside the room');
  assert.equal(model.stations(after).length, 6);
  // the old classic room became the main room of an open world; nothing in it moved
  assert.equal(after.shell.open, true);
  const main = model.rooms(after).find(x => x.id !== room.id);
  assert.ok(main, 'the old room is kept as a room');
  for (const e of world.entities) assert.deepEqual(after.entities.find(x => x.id === e.id).transform, e.transform);
  // the door faces the main room
  const dx = main.transform.x - room.transform.x, dz = main.transform.z - room.transform.z;
  const want = Math.abs(dx) > Math.abs(dz) ? (dx < 0 ? 'left' : 'right') : (dz < 0 ? 'back' : 'front');
  assert.deepEqual(room.doors, [want]);
  assert.equal(r.proposal.source, 'admin');
});

test('w3 intents: a second room goes next to the first rooms, not far away', () => {
  let world = applied(base(), plan(base(), 'add a room for research with 2 desks'));
  world = applied(world, plan(world, 'add a lounge'));
  const lounge = model.rooms(world).find(x => /lounge/i.test(x.label));
  assert.ok(lounge);
  const others = model.rooms(world).filter(x => x.id !== lounge.id);
  assert.ok(Math.min(...others.map(o => near(o, lounge))) < 25);
});

test('w3 intents: "add 2 desks in the research room" puts them inside that room (growing it if needed)', () => {
  let world = applied(base(), plan(base(), 'add a room for research with 4 desks'));
  const room = model.rooms(world).find(x => /research/i.test(x.label));
  world = applied(world, plan(world, 'add 6 desks in the research room'));
  const grown = world.entities.find(x => x.id === room.id);
  assert.equal(model.stations(world).filter(d => inside(d, grown)).length, 10);
});

test('w3 intents: "make the world huge" and "make the world bigger" grow the shell beyond 40 m', () => {
  const huge = applied(base(), plan(base(), 'make the world huge'));
  assert.ok(huge.shell.width >= 100 && huge.shell.depth >= 100, JSON.stringify(huge.shell));
  let w = base();
  for (let i = 0; i < 8; i++) w = applied(w, plan(w, 'make the world bigger'));
  assert.ok(w.shell.width > 40, JSON.stringify(w.shell));
});

test('w3 intents: "make it an open world" opens the shell and keeps the room', () => {
  const world = base();
  const after = applied(world, plan(world, 'make it an open world'));
  assert.equal(after.shell.open, true);
  assert.ok(after.shell.width >= 40);
  assert.equal(model.rooms(after).length, 1);
  assert.equal(model.validateWorld(after).ok, true);
});

test('w3 intents: "add a door to the left of the research room" and "resize the research room to 14 x 10"', () => {
  let world = applied(base(), plan(base(), 'add a room for research with 2 desks'));
  const room = model.rooms(world).find(x => /research/i.test(x.label));
  world = applied(world, plan(world, 'add a door to the back of the research room'));
  assert.ok(world.entities.find(x => x.id === room.id).doors.includes('back'));
  world = applied(world, plan(world, 'resize the research room to 14 x 10'));
  const after = world.entities.find(x => x.id === room.id);
  assert.equal(after.width, 14); assert.equal(after.depth, 10);
});

test('w3 intents: proposals never start agents and contain only world ops', () => {
  const r = plan(base(), 'add a room for agents with 3 codex desks');
  assert.ok(r.proposal);
  const allowed = new Set(['add', 'remove', 'move', 'update-station', 'resize', 'link', 'rename', 'shell', 'reshape', 'name']);
  for (const op of r.proposal.ops) assert.ok(allowed.has(op.op), op.op);
  const codex = applied(base(), r).entities.filter(e => e.kind === 'station' && e.station.tabs[0].kind === 'codex');
  assert.equal(codex.length, 3);
});

// ------------------------------------------------------------------------------------- part 3: onboarding
// sha256(JSON(world)).slice(0,16) of planWorld() for small plans, taken BEFORE this lane changed the planner.
const SMALL_PLAN_GOLDEN = {
  'research lab: 3 Hermes desks for literature, data and writing, a shared monitor wall, a web wall for papers': 'd75ed6a1e420a47e',
  'agent team: a Hermes desk for planning, a Claude desk for code, a Codex desk for review, a monitor wall for planning, a web wall for docs': '12ade1539d05cb88',
  'a cosy space station: 1 Hermes desk for building, a web wall for docs, a plant and a lamp': '680cdd528242448c',
  'prehistoric jungle studio: 2 Hermes desks for writing and editing, a web wall for references, plants and a sofa': 'bb5e0a993f704cc1',
  'mission control in orbit: 4 shell desks for build, deploy, logs and alerts, 2 monitor walls, a web wall for dashboards': '938e28a54c212596',
  'classic room: 2 desks, a web wall and a mirror': 'a91f516a23f5d332',
  '': 'c82d7771044a7a3b',
  '2 desks and a plant': 'ed53ccc23c2812ef',
  'a jungle room with 4 claude desks for a, b, c and d, 2 monitor walls': 'd45a083d75f1328b',
  'solo focus room with a lamp': 'f5911695e7f6a07e',
  '3 shell desks, a web wall for https://example.com/x?y=1, a mirror': '267f17429a7c86b3',
};
test('w3 onboarding: small plans (<= 4 desks) give exactly the same single classic room as before', () => {
  const crypto = require('node:crypto');
  for (const [prompt, hash] of Object.entries(SMALL_PLAN_GOLDEN)) {
    const w = onboarding.planWorld(prompt).world;
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16), hash, prompt);
    assert.equal(model.rooms(w).length, 0, prompt); assert.equal(w.shell.open, undefined, prompt);
  }
});

test('w3 onboarding: "12 Hermes desks" builds rooms inside an open world, every desk inside a room', () => {
  const { world } = onboarding.planWorld('12 Hermes desks');
  assert.equal(model.validateWorld(world).ok, true);
  assert.equal(world.shell.open, true);
  assert.equal(model.stations(world).length, 12);
  const rs = model.rooms(world);
  assert.ok(rs.length >= 2, `rooms: ${rs.length}`);
  for (const d of model.stations(world)) assert.ok(rs.some(r => inside(d, r)), `${d.id} is inside a room`);
});

test('w3 onboarding: "a research wing and an agent wing" makes one room per named area', () => {
  const { world } = onboarding.planWorld('a research wing with 4 Hermes desks and a web wall for papers, and an agent wing with 6 codex desks and a monitor wall');
  assert.equal(model.validateWorld(world).ok, true);
  const rs = model.rooms(world);
  assert.deepEqual(rs.map(r => r.label).sort(), ['Agent wing', 'Research wing']);
  const research = rs.find(r => r.label === 'Research wing'), agent = rs.find(r => r.label === 'Agent wing');
  assert.equal(model.stations(world).filter(d => inside(d, research)).length, 4);
  const agentDesks = model.stations(world).filter(d => inside(d, agent));
  assert.equal(agentDesks.length, 6);
  assert.ok(agentDesks.every(d => d.station.tabs[0].kind === 'codex'));
  assert.ok(world.entities.filter(e => e.kind === 'web-wall').every(e => inside(e, research)));
  assert.ok(world.entities.filter(e => e.kind === 'monitor-wall').every(e => inside(e, agent)));
  // rooms never overlap
  const [a, b] = rs.map(model.roomRect);
  assert.ok(a.maxX <= b.minX || b.maxX <= a.minX || a.maxZ <= b.minZ || b.maxZ <= a.minZ);
});

test('w3 onboarding: named areas without desk counts still get rooms (a lounge has no desks)', () => {
  const { world } = onboarding.planWorld('a research wing, an agent wing and a lounge');
  const rs = model.rooms(world);
  assert.equal(rs.length, 3);
  const lounge = rs.find(r => /lounge/i.test(r.label));
  assert.ok(lounge);
  assert.equal(model.stations(world).filter(d => inside(d, lounge)).length, 0);
  assert.ok(model.stations(world).length >= 2);
});

test('w3 onboarding: adding a desk in step 2 puts it inside an existing room (rooms resize, the world stays valid)', () => {
  const { world } = onboarding.planWorld('12 Hermes desks');
  const taken = new Set(world.entities.map(e => e.id));
  const id = onboarding.nextStationId(taken);
  const r = onboarding.applyOnboardingEdit(world, [{ op: 'add', entity: { id, kind: 'station', label: 'Extra', transform: { x: 0, z: 0, rotation: 0 }, station: onboarding.stationForAgent('Extra', 'hermes') } }]);
  assert.equal(r.ok, true, r.error);
  const desk = r.world.entities.find(e => e.id === id);
  assert.ok(model.rooms(r.world).some(room => inside(desk, room)), JSON.stringify(desk.transform));
  assert.equal(model.rooms(r.world).length, model.rooms(world).length, 'no new room for one desk');
});

test('w3 onboarding: caps are 48 desks and 256 things', () => {
  const { world, warnings } = onboarding.planWorld('60 Hermes desks');
  assert.equal(model.stations(world).length, 48);
  assert.ok(warnings.some(w => /48/.test(w)));
  assert.equal(model.validateWorld(world).ok, true);
  assert.ok(world.entities.length <= 256);
});
