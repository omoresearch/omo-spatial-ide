// sky:merge M7 — the world planner builds style-kit rooms, kit props and whole worlds from one sentence.
// Rules path (planWithRules) and the Hermes JSON path with a fake runner. Run: node --test extension/test/sky-merge-planner.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const { DatabaseSync } = require('node:sqlite');

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
const kits = require('../src/common/world-style-kits.ts');
const templates = require('../src/common/world-templates.ts');
const admin = require('../src/node/world-admin-service.ts');
Module._extensions['.ts'] = originalTsLoader;

const station = () => model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' });
const skyline = () => templates.instantiateTemplate('nyc-skyscraper');
const plan = (world, prompt) => rules.planWithRules(world, prompt, { makeId: () => 'fixed' });
function applied(world, result) {
  assert.ok(result.proposal, `expected a proposal: ${result.explanation}`);
  const res = model.applyWorldOps(world, result.proposal.ops);
  assert.ok(res.ok, res.error);
  return res.world;
}
const added = (before, after) => after.entities.filter(e => !before.entities.some(b => b.id === e.id));

test('M7 phrasing 1: "add a skyline lounge with 2 desks" adds a skyline room holding 2 desks', () => {
  const w = station();
  const after = applied(w, plan(w, 'add a skyline lounge with 2 desks'));
  const room = after.entities.find(e => e.kind === 'room' && !w.entities.some(b => b.id === e.id) && e.label !== 'Main room');
  assert.ok(room, 'a new room');
  assert.equal(room.theme, 'skyline');
  const r = model.roomRect(room);
  const desks = added(w, after).filter(e => e.kind === 'station');
  assert.equal(desks.length, 2);
  for (const d of desks) assert.ok(d.transform.x > r.minX && d.transform.x < r.maxX && d.transform.z > r.minZ && d.transform.z < r.maxZ, `${d.id} inside the room`);
});

test('M7 phrasing 2: "add a skyline-penthouse room called Research" names the room and furnishes it from the kit', () => {
  const w = station();
  const after = applied(w, plan(w, 'add a skyline-penthouse room called Research'));
  const room = after.entities.find(e => e.kind === 'room' && e.label === 'Research');
  assert.ok(room, JSON.stringify(after.entities.map(e => e.label)));
  assert.equal(room.theme, 'skyline');
  assert.ok(added(w, after).some(e => e.kind === 'decor' && kits.kitProp(e.prop)), 'a catalogue prop in the room');
});

test('M7 phrasing 3: a kit lounge gets the catalogue sofa, coffee table and money tree', () => {
  const w = station();
  const after = applied(w, plan(w, 'please create a penthouse lounge'));
  const props = added(w, after).filter(e => e.kind === 'decor').map(e => e.prop).sort();
  assert.deepEqual(props, ['coffee_table_round_01', 'pachira_aquatica_01', 'sofa_02']);
});

test('M7 phrasing 4: "place a sofa from the kit in the lounge" puts the catalogue sofa inside that room', () => {
  const w0 = station();
  const w = applied(w0, plan(w0, 'add a room for research with 2 desks, then add a lounge'));
  const lounge = w.entities.find(e => e.kind === 'room' && /lounge/i.test(e.label));
  assert.ok(lounge);
  const after = applied(w, plan(w, 'place a sofa from the kit in the lounge'));
  const sofa = added(w, after).find(e => e.kind === 'decor');
  assert.equal(sofa.prop, 'sofa_02');
  assert.equal(sofa.decor, 'sofa');
  const r = model.roomRect(lounge);
  assert.ok(sofa.transform.x > r.minX && sofa.transform.x < r.maxX && sofa.transform.z > r.minZ && sofa.transform.z < r.maxZ, 'sofa inside the lounge');
});

test('M7 phrasing 5: catalogue-only names work without saying "kit" ("add an armchair and a money tree")', () => {
  const w = station();
  const after = applied(w, plan(w, 'add an armchair and a money tree'));
  assert.deepEqual(added(w, after).map(e => e.prop).sort(), ['modern_arm_chair_01', 'pachira_aquatica_01']);
});

test('M7 phrasing 6: in a skyline world a plain "add a plant" uses the kit model; a station world keeps the plain plant', () => {
  const sky = skyline();
  const a = added(sky, applied(sky, plan(sky, 'add a plant')));
  assert.equal(a.length, 1); assert.ok(kits.kitProp(a[0].prop), 'kit plant');
  const st = station();
  const b = added(st, applied(st, plan(st, 'add a plant')));
  assert.equal(b.length, 1); assert.equal(b[0].prop, undefined);
});

test('M7 phrasing 7: "make me a skyline penthouse world" builds the kit world (desks on the kit anchors, web wall on webwall_anchor)', () => {
  const w = station();
  const result = plan(w, 'make me a skyline penthouse world');
  const after = applied(w, result);
  const kit = kits.styleKit('skyline-penthouse');
  assert.equal(after.shell.theme, 'skyline');
  assert.equal(kits.activeKit(after)?.id, 'skyline-penthouse', 'the baked shell fits');
  const desks = after.entities.filter(e => e.kind === 'station');
  assert.equal(desks.length, 3);
  for (const d of desks) assert.ok(kits.kitDeskIndex(kit, d.transform) >= 0, `${d.id} on a kit desk anchor`);
  const web = after.entities.find(e => e.kind === 'web-wall');
  assert.ok(web && kits.onKitWebWall(kit, web.transform));
  assert.match(result.notes.join(' '), /NYC skyscraper/);
});

test('M7 phrasing 8: "build us a jungle world called Camp" picks the jungle template and names it', () => {
  const w = station();
  const after = applied(w, plan(w, 'build us a jungle world called Camp'));
  assert.equal(after.shell.theme, 'jungle');
  assert.equal(after.name, 'Camp');
});

test('M7 phrasing 9: "make me a research world with lots of bookshelves" picks the nearest template by words', () => {
  const pick = rules.nearestTemplate('make me a research world with lots of bookshelves');
  assert.equal(pick.template.id, 'research-library');
  assert.equal(rules.nearestTemplate('a manhattan high-rise office world').kit?.id, 'skyline-penthouse');
});

test('M7: "switch to the skyline theme" is a theme change; locked desks block a whole new world', () => {
  const w = station();
  const after = applied(w, plan(w, 'switch to the skyline theme'));
  assert.equal(after.shell.theme, 'skyline');
  const locked = applied(w, plan(w, 'lock desk one'));
  const refused = plan(locked, 'make me a skyline world');
  assert.equal(refused.proposal, null);
  assert.match(refused.explanation, /locked/);
});

test('M7: the rules path is validated WorldOps only (every proposal applies atomically to the base world)', () => {
  for (const prompt of ['add a skyline lounge with 3 desks', 'add a penthouse room called Ops', 'place a coffee table from the kit', 'make me a skyline world']) {
    const w = station();
    const r = plan(w, prompt);
    assert.ok(r.proposal, `${prompt}: ${r.explanation}`);
    assert.equal(r.proposal.baseRevision, w.revision);
    assert.ok(model.applyWorldOps(w, r.proposal.ops).ok, prompt);
  }
});

// ---- Hermes JSON path (fake runner) ----
function hermesSetup(answer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-sky-admin-'));
  const hermesRoot = path.join(root, '.hermes');
  fs.mkdirSync(path.join(hermesRoot, 'profiles', 'coder'), { recursive: true });
  const db = new DatabaseSync(path.join(hermesRoot, 'profiles', 'coder', 'state.db'));
  db.exec('CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, expires_at REAL)');
  db.close();
  const seen = [];
  const runner = async (executable, argv) => { seen.push(argv); return { stdout: answer, stderr: '', code: 0, timedOut: false }; };
  const env = { PATH: process.env.PATH, HOME: root, OMO_SPATIAL_HERMES_ROOT: hermesRoot };
  const backend = new admin.WorldAdminBackend({ env, runner, findHermes: () => '/fake/hermes', timeoutMs: 3000 });
  return { backend, seen };
}

test('M7 Hermes: the JSON prompt lists the style kits, their anchors and every catalogue prop id', () => {
  const text = admin.buildHermesPrompt(station(), 'add a skyline lounge');
  assert.match(text, /skyline-penthouse/);
  assert.match(text, /"skyline"/);
  for (const p of kits.KIT_PROPS) assert.ok(text.includes(p.id), `prompt lists ${p.id}`);
  assert.match(text, /"prop"/);
});

test('M7 Hermes: a fake-runner kit answer (skyline room + catalogue props) becomes a validated proposal', async () => {
  const answer = JSON.stringify({ summary: 'Add a skyline lounge', explanation: 'A skyline lounge with a sofa and a money tree.', ops: [
    { op: 'shell', shell: { open: true, width: 60, depth: 60 } },
    { op: 'add', entity: { id: 'sky-lounge', kind: 'room', label: 'Skyline lounge', width: 10, depth: 8, theme: 'skyline', transform: { x: 0, z: -18, rotation: 0 } } },
    { op: 'add', entity: { id: 'sofa', kind: 'decor', decor: 'sofa', prop: 'sofa_02', transform: { x: 0, z: -18, rotation: 0 } } },
    { op: 'add', entity: { id: 'tree', kind: 'decor', decor: 'plant', prop: 'pachira_aquatica_01', scale: 1.4, transform: { x: 3, z: -20, rotation: 0 } } },
  ] });
  const { backend, seen } = hermesSetup('```json\n' + answer + '\n```');
  const result = await backend.plan({ world: station(), prompt: 'add a skyline lounge with a sofa and a money tree', useHermes: true, confirmedHermes: true, profile: 'coder' });
  assert.equal(result.error, undefined, result.explanation);
  assert.equal(result.planner, 'hermes');
  assert.equal(result.proposal.ops.length, 4);
  assert.equal(seen.length, 1);
  assert.match(seen[0][3], /pachira_aquatica_01/);
});

test('M7 Hermes: an unknown catalogue prop id is rejected with a readable error', async () => {
  const answer = JSON.stringify({ summary: 'x', explanation: 'x', ops: [
    { op: 'add', entity: { id: 'bad', kind: 'decor', decor: 'plant', prop: 'not_a_real_prop', transform: { x: 1, z: 1, rotation: 0 } } },
  ] });
  const { backend } = hermesSetup(answer);
  const result = await backend.plan({ world: station(), prompt: 'add a plant', useHermes: true, confirmedHermes: true, profile: 'coder' });
  assert.equal(result.proposal, null);
  assert.match(result.error, /not_a_real_prop|catalogue/);
});
