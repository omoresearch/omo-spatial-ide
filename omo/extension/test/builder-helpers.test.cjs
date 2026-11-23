// builder-ui — pure helpers of the World Builder panel (builder-helpers.ts) and the Add-tab additions to
// build-catalog.ts (room presets, desk tab kinds, monitor link, web wall page).
// Run: node --test extension/test/builder-helpers.test.cjs
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
const helpers = require('../src/browser/builder-helpers.ts');
const catalog = require('../src/browser/build-catalog.ts');
Module._extensions['.ts'] = originalTsLoader;

const base = () => model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' });
const applyOps = (world, ops) => { const r = model.applyWorldOps(world, ops); assert.equal(r.ok, true, r.error); return r.world; };
const planned = (world, prompt) => { const p = rules.planWithRules(world, prompt, { makeId: () => 'fixed' }); assert.ok(p.proposal, p.explanation); return applyOps(world, p.proposal.ops); };

test('diffSummary: the Talk example reads "+1 room \'Research\', +2 desks"', () => {
  const before = base();
  const after = planned(before, 'add a room for research with 2 desks');
  const s = helpers.diffSummary(before, after);
  // A classic world opens first (its old walls stay as a room), so the plan can add 2 rooms: both are named.
  assert.match(s, /^\+[12] rooms? ('[^']*', )?'[^']*Research[^']*'/i);
  assert.match(s, /\+2 desks/);
});

test('diffSummary: one desk shows its name; removals use a minus; no change is empty', () => {
  const w = base();
  assert.equal(helpers.diffSummary(w, w), '');
  const desk = catalog.makeEntity('agent-desk', w, { x: 2, z: 1, rotation: 0 });
  const added = applyOps(w, [{ op: 'add', entity: desk }]);
  assert.equal(helpers.diffSummary(w, added), `+1 desk '${desk.label}'`);
  const removed = applyOps(added, [{ op: 'remove', id: desk.id }]);
  assert.equal(helpers.diffSummary(added, removed), `−1 desk '${desk.label}'`);
  const plant = catalog.makeEntity('decor-plant', w, { x: 1, z: 1, rotation: 0 });
  const lamp = catalog.makeEntity('decor-lamp', w, { x: -1, z: 1, rotation: 0 });
  assert.equal(helpers.diffSummary(w, applyOps(w, [{ op: 'add', entity: plant }, { op: 'add', entity: lamp }])), '+2 decor items');
});

test('diffSummary: a grown world and an edited thing are reported', () => {
  const w = base();
  const wider = applyOps(w, [{ op: 'shell', shell: { width: w.shell.width + 4 } }, { op: 'rename', id: model.stations(w)[0].id, label: 'Build' }]);
  const s = helpers.diffSummary(w, wider);
  assert.match(s, /1 changed/);
  assert.match(s, new RegExp(`world ${w.shell.width + 4} × ${w.shell.depth} m`));
});

test('ghostIds: only added and edited things are outlined (the data-ghost-preview hook)', () => {
  const w = base();
  const desk = catalog.makeEntity('shell-desk', w, { x: 3, z: 0, rotation: 0 });
  const first = model.stations(w)[0];
  const after = applyOps(w, [{ op: 'add', entity: desk }, { op: 'rename', id: first.id, label: 'Renamed' }]);
  assert.deepEqual(helpers.ghostIds(w, after), [desk.id, first.id].sort());
  assert.deepEqual(helpers.ghostIds(w, w), []);
});

test('room presets S / M / L place fixed-size rooms with a front door and free names', () => {
  const w = base();
  for (const [id, size] of Object.entries(catalog.ROOM_PRESETS)) {
    const room = catalog.makeEntity(id, w, { x: 0, z: 0, rotation: 0 });
    assert.equal(room.kind, 'room');
    assert.equal(room.width, size.width); assert.equal(room.depth, size.depth);
    assert.deepEqual(room.doors, ['front']);
    assert.ok(room.width >= model.ROOM_MIN && room.width <= model.ROOM_MAX);
  }
  assert.ok(catalog.PALETTE.some(p => p.id === 'room-s') && catalog.PALETTE.some(p => p.id === 'room-l'));
});

test('tabsFromKinds: one tab per kind, unique names, at most 8', () => {
  assert.deepEqual(catalog.tabsFromKinds(['hermes', 'shell', 'claude']), [{ name: 'Hermes', kind: 'hermes' }, { name: 'Shell', kind: 'shell' }, { name: 'Claude', kind: 'claude' }]);
  assert.deepEqual(catalog.tabsFromKinds(['shell', 'shell']).map(t => t.name), ['Shell', 'Shell 2']);
  assert.equal(catalog.tabsFromKinds(new Array(12).fill('shell')).length, 8);
});

test('makeEntity uses the Add-tab choices: desk tabs, monitor link, web page', () => {
  const w = base();
  const deskId = model.stations(w)[0].id;
  const prefs = { deskTabs: ['codex', 'shell'], monitorLink: deskId, webHome: '127.0.0.1:9999/page.html' };
  const desk = catalog.makeEntity('agent-desk', w, { x: 2, z: 2, rotation: 0 }, undefined, prefs);
  assert.deepEqual(desk.station.tabs.map(t => t.kind), ['codex', 'shell']);
  const wall = catalog.makeEntity('monitor-wall', w, { x: 0, z: -3, rotation: 0 }, undefined, prefs);
  assert.equal(wall.link, deskId);
  const web = catalog.makeEntity('web-wall', w, { x: 0, z: -3, rotation: 0 }, undefined, prefs);
  assert.equal(web.home, 'https://127.0.0.1:9999/page.html');
  // An unknown desk id is not linked; defaults stay as before.
  const none = catalog.makeEntity('monitor-wall', w, { x: 0, z: -3, rotation: 0 }, undefined, { deskTabs: [], monitorLink: 'desk-404', webHome: '' });
  assert.equal(none.link, undefined);
  const plain = catalog.makeEntity('agent-desk', w, { x: 2, z: 2, rotation: 0 }, undefined, { deskTabs: [], monitorLink: '', webHome: '' });
  assert.deepEqual(plain.station.tabs.map(t => t.kind), ['hermes', 'shell']);
  // Every entity is valid for the world model.
  for (const e of [desk, wall, web]) assert.equal(model.applyWorldOps(w, [{ op: 'add', entity: e }]).ok, true);
});

test('webHomeUrl: http(s) only, bare hosts get https, junk is refused', () => {
  assert.equal(catalog.webHomeUrl('http://127.0.0.1:4100/x'), 'http://127.0.0.1:4100/x');
  assert.equal(catalog.webHomeUrl(' example.com '), 'https://example.com');
  assert.equal(catalog.webHomeUrl(''), '');
  assert.equal(catalog.webHomeUrl('javascript:alert(1)'), '');
  assert.equal(catalog.webHomeUrl('file:///etc/passwd'), '');
  assert.equal(catalog.webHomeUrl('http://a b'), '');
});

test('roomRows: rooms sorted by name with desk and screen counts inside', () => {
  let w = planned(base(), 'add a room for research with 2 desks');
  const rows = helpers.roomRows(w);
  assert.ok(rows.length >= 1);
  const research = rows.find(r => /research/i.test(r.name));
  assert.ok(research, JSON.stringify(rows));
  assert.equal(research.desks, 2);
  const names = rows.map(r => r.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
});

test('jumpPose stands inside the room, near its front edge, facing in', () => {
  const room = { id: 'room-1', kind: 'room', transform: { x: 10, z: -4, rotation: 0 }, width: 8, depth: 6, doors: ['front'] };
  const pose = helpers.jumpPose(room);
  assert.ok(helpers.inRoom(room, pose));
  assert.equal(pose.x, 10); assert.ok(pose.z > -4); assert.equal(pose.yaw, 0);
});

test('duplicateOps: a valid unlocked copy next to it with a fresh id; rooms are refused', () => {
  let w = base();
  const desk = model.stations(w)[0];
  w = applyOps(w, [{ op: 'update-station', id: desk.id, station: { locked: true } }]);
  const ops = helpers.duplicateOps(w, desk.id);
  assert.equal(ops.length, 1);
  const copy = ops[0].entity;
  assert.notEqual(copy.id, desk.id);
  assert.equal(copy.station.locked, false);
  assert.match(copy.label, / copy$/);
  assert.ok(Math.hypot(copy.transform.x - desk.transform.x, copy.transform.z - desk.transform.z) > 3);
  const next = applyOps(w, ops);
  assert.equal(model.validateWorld(next).ok, true);
  // A second copy gets another id.
  assert.notEqual(helpers.duplicateOps(next, desk.id)[0].entity.id, copy.id);
  const room = catalog.makeEntity('room-s', w, { x: 0, z: 0, rotation: 0 });
  assert.equal(helpers.duplicateOps(applyOps(w, [{ op: 'add', entity: room }]), room.id), undefined);
  assert.equal(helpers.duplicateOps(w, 'nope'), undefined);
});

test('talkChips: four chips; "here" follows the selection', () => {
  const w = base();
  const chips = helpers.talkChips(w);
  assert.equal(chips.length, 4);
  assert.ok(chips.includes('make the world bigger'));
  const desk = model.stations(w)[0];
  assert.match(helpers.talkChips(w, desk.id)[2], new RegExp(`linked to ${(desk.label ?? desk.station.name).toLowerCase()}`));
  // Every chip is a request the rules planner understands.
  for (const chip of chips) assert.ok(rules.planWithRules(w, chip, { makeId: () => 'x' }).proposal, chip);
});

test('nextTab cycles Talk ↔ Add', () => {
  assert.equal(helpers.nextTab('talk'), 'add');
  assert.equal(helpers.nextTab('add'), 'talk');
});

test('clearOfCentre: a right-column panel is clear; a centred one is not', () => {
  const view = { width: 1600, height: 900 };
  assert.equal(helpers.clearOfCentre({ left: 1200, top: 64, right: 1588, bottom: 700 }, view), true);
  assert.equal(helpers.clearOfCentre({ left: 600, top: 300, right: 1000, bottom: 600 }, view), false);
  assert.equal(helpers.clearOfCentre({ left: 600, top: 700, right: 1000, bottom: 880 }, view), false);
});
