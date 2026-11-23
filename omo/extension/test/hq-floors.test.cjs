// HQ floors (HQ-FLOORS.md) — RoomEntity.floor, floorSpot / floorSpawn, kitShellFits ignores floor rooms, the rail list
// and the 'Make HQ floors' seed ops (common/world-model.ts, room-modules.ts, world-style-kits.ts, hq-floors.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');
const loader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const rm = require('../src/common/room-modules.ts');
const model = require('../src/common/world-model.ts');
const kits = require('../src/common/world-style-kits.ts');
const hq = require('../src/common/hq-floors.ts');
const templates = require('../src/common/world-templates.ts');
Module._extensions['.ts'] = loader;

const penthouse = () => templates.instantiateTemplate('nyc-skyscraper', { name: 'HQ' });

test('floorSpot: x = 200 + 60 i, z = 0, door facing +z', () => {
  assert.deepEqual(rm.floorSpot(0), { x: 200, z: 0, rotation: 0 });
  assert.deepEqual(rm.floorSpot(1), { x: 260, z: 0, rotation: 0 });
  assert.deepEqual(rm.floorSpot(4), { x: 440, z: 0, rotation: 0 });
});

test('floorSpawn: just inside the door, on the centre line, facing the glass (-z)', () => {
  const s = rm.floorSpawn(rm.floorSpot(2));
  assert.equal(s.x, 320); assert.ok(s.z > 0 && s.z < rm.MODULE_DEPTH / 2, 'inside the front wall'); assert.equal(s.yaw, 0);
});

test('validRoom accepts floor: true / false and refuses a non-boolean floor', () => {
  const room = { id: 'f', kind: 'room', transform: { x: 0, z: 0, rotation: 0 }, width: 8, depth: 6, module: 'library' };
  assert.ok(model.validRoom({ ...room, floor: true }));
  assert.ok(model.validRoom({ ...room, floor: false }));
  assert.ok(model.validRoom(room));
  assert.equal(model.validRoom({ ...room, floor: 'yes' }), false);
});

test('a floor room (and a desk inside it) may stand far outside the shell; a plain room may not', () => {
  const w = penthouse();
  const floor = { id: 'floor-a', kind: 'room', transform: rm.floorSpot(0), width: 8, depth: 6, module: 'studio', floor: true };
  const desk = { id: 'floor-a-desk', kind: 'station', transform: rm.toWorld(rm.floorSpot(0), rm.MODULES.studio.desks[0]), station: model.defaultStation('Desk', 'shell') };
  const ok = model.validateWorld({ ...w, entities: [...w.entities, floor, desk] });
  assert.ok(ok.ok, ok.error);
  assert.equal(model.validateWorld({ ...w, entities: [...w.entities, { ...floor, floor: undefined }] }).ok, false);
  assert.equal(model.validateWorld({ ...w, entities: [...w.entities, { ...desk, transform: { x: 150, z: 0, rotation: 0 } }] }).ok, false, 'a desk on no floor stays in the shell');
});

test('kitShellFits ignores floor rooms: the penthouse kit stays active in an HQ world', () => {
  const w = penthouse();
  assert.equal(kits.activeKit(w)?.id, 'skyline-penthouse');
  const r = model.applyWorldOps(w, hq.hqFloorOps(w));
  assert.ok(r.ok, r.error);
  assert.equal(kits.activeKit(r.world)?.id, 'skyline-penthouse');
  const plain = { ...w, entities: [...w.entities, { id: 'room-a', kind: 'room', transform: { x: 0, z: 0, rotation: 0 }, width: 4, depth: 4 }] };
  assert.equal(kits.activeKit(plain), undefined, 'a room inside the shell still turns the kit off');
});

test('hqFloorOps: Library, Lounge, Studio on floorSpot 0..2, studio desks on the studio anchors as shells; idempotent', () => {
  const w = penthouse();
  const r = model.applyWorldOps(w, hq.hqFloorOps(w));
  assert.ok(r.ok, r.error);
  const floors = model.floorRooms(r.world);
  assert.deepEqual(floors.map(f => [f.label, f.module, f.transform.x, f.transform.z]), [['Library', 'library', 200, 0], ['Lounge', 'lounge', 260, 0], ['Studio', 'studio', 320, 0]]);
  const studio = floors[2];
  const desks = r.world.entities.filter(e => e.kind === 'station' && model.floorAt(r.world, e.transform)?.id === studio.id);
  assert.equal(desks.length, 3);
  desks.forEach((d, i) => { assert.deepEqual(d.transform, rm.toWorld(studio.transform, rm.MODULES.studio.desks[i])); assert.equal(d.station.kind, 'shell'); });
  assert.deepEqual(hq.hqFloorOps(r.world), [], 'nothing to add the second time');
});

test('railEntries: HQ first then each floor with its module icon and desk count; no floors -> no rail', () => {
  const w = penthouse();
  assert.deepEqual(hq.railEntries(w), []);
  const r = model.applyWorldOps(w, hq.hqFloorOps(w));
  const rail = hq.railEntries(r.world);
  assert.deepEqual(rail.map(e => [e.id, e.icon, e.desks]), [['hq', 'hq', w.entities.filter(e => e.kind === 'station').length], ['floor-library', 'library', 0], ['floor-lounge', 'lounge', 0], ['floor-studio', 'studio', 3]]);
  assert.deepEqual(hq.floorArrival(model.floorRooms(r.world)[0]), rm.floorSpawn(rm.floorSpot(0)));
});

test('floorAt: a point on a floor finds it; the HQ ground finds none', () => {
  const w = model.applyWorldOps(penthouse(), hq.hqFloorOps(penthouse())).world;
  assert.equal(model.floorAt(w, { x: 262, z: 1 })?.id, 'floor-lounge');
  assert.equal(model.floorAt(w, { x: 0, z: 0 }), undefined);
});
