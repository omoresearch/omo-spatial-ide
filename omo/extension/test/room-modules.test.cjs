// room modules — the baked library / lounge / studio rooms: the module table, pickModule() from purpose words,
// the studio desk cap and the tidy grid helpers (common/room-modules.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const loader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const rm = require('../src/common/room-modules.ts');
const model = require('../src/common/world-model.ts');
Module._extensions['.ts'] = loader;

test('MODULES: library, lounge and studio are 8 x 6 m with one front-centre door', () => {
  assert.deepEqual(Object.keys(rm.MODULES).sort(), ['library', 'lounge', 'studio']);
  for (const m of Object.values(rm.MODULES)) {
    assert.equal(m.width, 8); assert.equal(m.depth, 6);
    assert.deepEqual(m.door, { side: 'front', x: 0, width: 1.6 });
    for (const t of [...m.desks, ...m.boards]) assert.ok(Math.abs(t.x) < m.width / 2 && Math.abs(t.z) < m.depth / 2, `${m.id} anchor inside`);
  }
  assert.equal(rm.MODULES.studio.desks.length, 3);
  assert.equal(rm.STUDIO_DESKS, 3);
  assert.equal(rm.MODULES.library.desks.length, 0);
  assert.equal(rm.MODULES.lounge.desks.length, 0);
});

test('the module table matches the baked kit (kits/modules/<id>/module.json) when the kit is present', () => {
  for (const id of ['library', 'lounge', 'studio']) {
    const file = path.join(__dirname, '..', '..', 'kits', 'modules', id, 'module.json');
    if (!fs.existsSync(file)) continue; // the kit ships on the renderer branch
    const kit = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(kit.footprint.width, rm.MODULES[id].width); assert.equal(kit.footprint.depth, rm.MODULES[id].depth);
    assert.equal(kit.anchors.door.side, 'front'); assert.equal(kit.anchors.door.x, 0);
    rm.MODULES[id].desks.forEach((d, i) => { assert.equal(d.x, kit.anchors.desks[i].x); assert.equal(d.z, kit.anchors.desks[i].z); });
  }
});

test('pickModule: purpose words -> library / lounge / studio, else desks -> studio, else lounge', () => {
  const cases = [
    ['Lighthouse', [], false, 'library'], ['My book club', [], false, 'library'], ['Reading nook', [], false, 'library'],
    ['Library', [], false, 'library'], ['Notes', [], false, 'library'], ['Trip ideas', ['read later', 'notes'], false, 'library'],
    ['Chats', [], false, 'lounge'], ['Lounge', [], false, 'lounge'], ['Social', [], false, 'lounge'], ['Talks', [], false, 'lounge'], ['Friends', [], false, 'lounge'],
    ['Desks', [], false, 'studio'], ['Code', [], false, 'studio'], ['Work', [], false, 'studio'], ['Build', [], false, 'studio'], ['Dev', [], false, 'studio'],
    ['Research wing', [], true, 'studio'], ['Research wing', [], false, 'lounge'], ['Agent wing', [], true, 'studio'], ['Ops', [], false, 'studio'],
    ['Room 2', [], true, 'studio'], ['Room 2', [], false, 'lounge'], ['', [], false, 'lounge'], [undefined, undefined, false, 'lounge'],
    ['Q3 plans', 'chat with friends', false, 'lounge'], ['Q3 plans', 'code reviews', false, 'studio']
  ];
  for (const [title, words, desks, want] of cases) assert.equal(rm.pickModule(title, words, desks), want, `${title} / ${words}`);
});

test('pickModule: the title wins over the purpose text', () => {
  assert.equal(rm.pickModule('Library', 'code and build'), 'library');
  assert.equal(rm.pickModule('Dev', 'books and reading'), 'studio');
});

test('the purpose words are shared with the set-dressing presets (re-exported from the old place)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser', 'world-scene-dressing.ts'), 'utf8');
  assert.match(src, /export \{ PURPOSE_WORDS \} from '\.\.\/common\/room-modules'/);
  assert.match(src, /export type \{ DressPreset \} from '\.\.\/common\/room-modules'/);
  assert.match(src, /const WORDS = PURPOSE_WORDS;/);
  assert.deepEqual(rm.PURPOSE_WORDS.map(([k]) => k), ['library', 'observatory', 'dining', 'garden', 'lounge', 'work']);
});

test('module anchors: desks, decor spots and boards keep the doorway clear and miss the baked furniture', () => {
  const hit = (p, r, b) => Math.abs(p.x - b.x) < r + b.hx && Math.abs(p.z - b.z) < r + b.hz;
  const inDoor = (p, r) => p.x + r > rm.DOOR_CLEAR.minX && p.x - r < rm.DOOR_CLEAR.maxX && p.z + r > rm.DOOR_CLEAR.minZ;
  for (const m of Object.values(rm.MODULES)) {
    for (const d of rm.MODULE_DECOR_SPOTS) {
      assert.ok(!inDoor(d, 0.45), `${m.id} decor spot ${d.x},${d.z} clear of the doorway`);
      for (const b of m.blocks) assert.ok(!hit(d, 0.45, b), `${m.id} decor spot ${d.x},${d.z} misses furniture ${b.x},${b.z}`);
    }
    for (const d of m.desks) assert.ok(!inDoor(d, 0.3), `${m.id} desk clear of the doorway`);
    for (const b of m.boards) assert.ok(Math.abs(b.x) - 0.6 >= rm.DOOR_CLEAR.maxX, `${m.id} board beside the door, not over it`);
  }
});

test('studioSplit caps desks at 3 per studio; extra desks go to another studio', () => {
  assert.deepEqual(rm.studioSplit(0), []);
  assert.deepEqual(rm.studioSplit(2), [2]);
  assert.deepEqual(rm.studioSplit(3), [3]);
  assert.deepEqual(rm.studioSplit(4), [3, 1]);
  assert.deepEqual(rm.studioSplit(7), [3, 3, 1]);
});

test('moduleGrid: even spacing, 2 m gaps, one row (<= 3) or two rows facing a central path, no overlaps', () => {
  for (let n = 1; n <= 12; n++) {
    const g = rm.moduleGrid(n);
    assert.equal(g.length, n);
    for (const row of [0, 1]) {
      const xs = g.filter(s => s.row === row).map(s => s.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) assert.equal(Math.round((xs[i] - xs[i - 1]) * 1000) / 1000, rm.GRID_PITCH, `n=${n} even pitch`);
      if (xs.length) assert.ok(Math.abs(xs[0] + xs[xs.length - 1]) < 1e-9, `n=${n} row centred`);
    }
    for (const s of g) {
      assert.equal(s.rotation, s.row ? Math.PI : 0);
      // the doorway (local front, +z) faces the path at z = 0
      const door = rm.toWorld(s, { x: 0, z: rm.MODULE_DEPTH / 2, rotation: 0 });
      assert.equal(Math.abs(door.z), n > 3 ? rm.GRID_PATH / 2 : 0, `n=${n} door on the path edge`);
    }
    const rect = s => ({ minX: s.x - 4, maxX: s.x + 4, minZ: s.z - 3, maxZ: s.z + 3 });
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = rect(g[i]), b = rect(g[j]);
      const gapX = Math.max(a.minX - b.maxX, b.minX - a.maxX), gapZ = Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ);
      assert.ok(Math.max(gapX, gapZ) >= rm.GRID_GAP - 1e-9, `n=${n} rooms ${i},${j} keep 2 m apart`);
    }
  }
});

test('groundFor: the bounding box plus 4 m, in whole even metres', () => {
  assert.deepEqual(rm.groundFor([{ minX: -9, maxX: 9, minZ: -8, maxZ: 8 }]), { width: 26, depth: 24 });
  assert.deepEqual(rm.groundFor([{ minX: -4, maxX: 4, minZ: -8, maxZ: -2 }]), { width: 16, depth: 24 });
});

test('RoomEntity.module is optional: old worlds stay valid, a module id validates, junk does not', () => {
  const world = (module) => ({ version: 2, name: 'w', shell: { theme: 'station', width: 40, depth: 40, open: true }, revision: 0,
    entities: [{ id: 'r', kind: 'room', label: 'R', transform: { x: 0, z: 0, rotation: 0 }, width: 8, depth: 6, doors: ['front'], ...(module === undefined ? {} : { module }) }] });
  assert.equal(model.validateWorld(world(undefined)).ok, true);
  assert.equal(model.validateWorld(world('library')).ok, true);
  assert.equal(model.validateWorld(world('future-room')).ok, true); // forward compatible: the renderer ignores ids it does not know
  assert.equal(model.validateWorld(world(42)).ok, false);
  assert.equal(model.validateWorld(world('<script>')).ok, false);
});
