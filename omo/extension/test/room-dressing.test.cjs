// beauty r2 (5) — room set-dressing: every runtime room gets a deterministic preset of CC0 kit furniture, placed in
// wall-aligned slots that keep the doorways, the boards/desks already in the room and the walls clear.
// Run: node --test extension/test/room-dressing.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const DIR = path.join(__dirname, '..', 'src', 'browser');
function loadBrowser(file) {
  const loader = Module._extensions['.ts'], resolve = Module._resolveFilename;
  Module._extensions['.ts'] = (module, filename) => module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
  Module._resolveFilename = function (request, parent, ...rest) { try { return resolve.call(this, request, parent, ...rest); } catch (error) { if (request.startsWith('.')) return resolve.call(this, request + '.ts', parent, ...rest); throw error; } };
  try { return require(path.join(DIR, file)); } finally { Module._extensions['.ts'] = loader; Module._resolveFilename = resolve; }
}
const D = loadBrowser('world-scene-dressing.ts');
const room = (id, label, extra = {}) => ({ id, kind: 'room', label, transform: { x: 0, z: 0, rotation: 0 }, width: 8, depth: 7, doors: ['front'], ...extra });
const world = (...entities) => ({ version: 2, name: 'w', shell: { theme: 'station', width: 60, depth: 50, open: true }, entities, revision: 0 });
const ids = d => d.pieces.flatMap(p => p.plan === 'rug' ? ['rug'] : p.plan.map(k => k.id));

test('the preset comes from the title words, else desks -> work, else generic', () => {
  assert.equal(D.dressPreset({ label: 'Lighthouse library' }), 'library');
  assert.equal(D.dressPreset({ label: 'My novel notes' }), 'library');
  assert.equal(D.dressPreset({ label: 'Garden' }), 'garden');
  assert.equal(D.dressPreset({ label: 'House plants' }), 'garden');
  // beauty r3 (3): wider word lists — lighthouse -> library, moon/space -> observatory, recipe/food -> dining, chats/other -> lounge.
  assert.equal(D.dressPreset({ label: 'Lighthouse' }), 'library');
  assert.equal(D.dressPreset({ label: 'Moonbase' }), 'observatory');
  assert.equal(D.dressPreset({ label: 'Space trip' }), 'observatory');
  assert.equal(D.dressPreset({ label: 'Recipe App' }), 'dining');
  assert.equal(D.dressPreset({ label: 'Kitchen' }), 'dining');
  assert.equal(D.dressPreset({ label: 'Other chats' }), 'lounge');
  assert.equal(D.dressPreset({ label: 'Room 7 1' }), 'generic');
  assert.equal(D.dressPreset({ label: 'Room 7 1' }, [{ kind: 'station' }]), 'work');
});

test('library, lounge, garden and generic rooms get their kit furniture; the same room always gets the same layout', () => {
  const lib = D.roomDressing(room('mind-library', 'Lighthouse library'), world(room('mind-library', 'Lighthouse library')));
  assert.equal(lib.preset, 'library');
  for (const id of ['steel_frame_shelves_03', 'book_encyclopedia_set_01', 'round_wooden_table_01', 'dining_chair_02', 'mid_century_lounge_chair', 'side_table_01', 'desk_lamp_arm_01', 'hanging_picture_frame_02', 'rug'])
    assert.ok(ids(lib).includes(id), `library has ${id}: ${ids(lib).join(', ')}`);
  assert.ok(ids(lib).some(i => /plant|pachira|calathea/.test(i)), 'library has a plant');
  const again = D.roomDressing(room('mind-library', 'Lighthouse library'), world(room('mind-library', 'Lighthouse library')));
  assert.deepEqual(again.pieces, lib.pieces, 'deterministic');
  const lounge = D.roomDressing(room('r', 'Lounge', { width: 9 }), world(room('r', 'Lounge', { width: 9 })));
  for (const id of ['sofa_02', 'coffee_table_round_01', 'modern_arm_chair_01', 'Ottoman_01', 'calathea_orbifolia_01']) assert.ok(ids(lounge).includes(id), `lounge has ${id}: ${ids(lounge).join(', ')}`);
  const garden = D.roomDressing(room('g', 'Garden'), world(room('g', 'Garden')));
  assert.ok(new Set(ids(garden).filter(i => /plant|pachira|calathea/.test(i))).size >= 3, `garden has 3+ plant kinds: ${ids(garden).join(', ')}`);
  assert.ok(ids(garden).includes('Ottoman_01'), 'garden has seating');
  const gen = D.roomDressing(room('m', 'Room 7'), world(room('m', 'Room 7')));
  for (const id of ['mid_century_lounge_chair', 'side_table_01', 'desk_lamp_arm_01', 'hanging_picture_frame_02', 'rug']) assert.ok(ids(gen).includes(id), `generic has ${id}`);
});

test('pieces stay inside the walls, out of the doorway, clear of boards/desks and of each other', () => {
  const r = room('data-south', 'South · 3 rows', { width: 11, depth: 7 });
  const boards = [-2.4, 0, 2.4].map((x, i) => ({ id: `data-south-board-${i + 1}`, kind: 'decor', decor: 'whiteboard', label: 'n', transform: { x, z: -3.5 + 0.75, rotation: 0 } }));
  for (const rr of [r, room('m', 'Moonbase'), room('l', 'Lighthouse library', { doors: ['front', 'left'] }), room('t', 'Garden', { transform: { x: 10, z: 4, rotation: Math.PI / 2 } })]) {
    const w = world(rr, ...(rr === r ? boards : []));
    const d = D.roomDressing(rr, w);
    assert.ok(d.pieces.length >= 4, `${rr.label}: furnished (${d.pieces.length})`);
    const boxes = d.pieces.filter(p => p.half).map(p => { const c = Math.abs(Math.cos(p.rotY)), s = Math.abs(Math.sin(p.rotY)), ex = c * p.half[0] + s * p.half[1], ez = s * p.half[0] + c * p.half[1]; return { k: p.key, minX: p.x - ex, maxX: p.x + ex, minZ: p.z - ez, maxZ: p.z + ez }; });
    for (const b of boxes) {
      assert.ok(b.minX >= -rr.width / 2 && b.maxX <= rr.width / 2 && b.minZ >= -rr.depth / 2 && b.maxZ <= rr.depth / 2, `${rr.label} ${b.k} inside`);
      assert.ok(!(b.maxZ > rr.depth / 2 - 2.4 && Math.abs((b.minX + b.maxX) / 2) < 1.25 + (b.maxX - b.minX) / 2), `${rr.label} ${b.k} out of the front doorway`);
      if (rr === r) for (const bd of boards) assert.ok(b.maxX < bd.transform.x - 1 || b.minX > bd.transform.x + 1 || b.minZ > bd.transform.z + 0.34, `${b.k} clear of ${bd.id}`);
    }
    // Clusters do not overlap each other (pieces inside one cluster may sit close).
    const cl = new Map(); for (const b of boxes) { const k = b.k.split(':')[0]; const c = cl.get(k) ?? { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 }; cl.set(k, { minX: Math.min(c.minX, b.minX), maxX: Math.max(c.maxX, b.maxX), minZ: Math.min(c.minZ, b.minZ), maxZ: Math.max(c.maxZ, b.maxZ) }); }
    const list = [...cl.entries()];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const [ka, a] = list[i], [kb, b] = list[j]; assert.ok(!(a.minX < b.maxX - 0.05 && a.maxX > b.minX + 0.05 && a.minZ < b.maxZ - 0.05 && a.maxZ > b.minZ + 0.05), `${rr.label}: ${ka} overlaps ${kb}`); }
    assert.equal(d.blocks.length, boxes.length, 'every solid piece collides');
  }
});

// beauty r3 (3) — zones, not furniture scattered along the walls.
const centre = (d, key) => d.pieces.find(p => p.key === key);
test('the reading nook: chair ON its rug, turned toward the focal point, side table + emitting lamp beside it', () => {
  const r = room('data-south', 'Room 9', { width: 11, depth: 7 });
  const boards = [-2.4, 0, 2.4].map((x, i) => ({ id: `b-${i}`, kind: 'decor', decor: 'whiteboard', label: 'n', transform: { x, z: -3.5 + 0.75, rotation: 0 } }));
  const d = D.roomDressing(r, world(r, ...boards));
  const rug = centre(d, 'nook:rug'), chair = centre(d, 'nook:lounge-chair'), table = centre(d, 'nook:side-table');
  assert.ok(rug && chair && table, d.pieces.map(p => p.key).join(', '));
  const rw = 2.6 * rug.scale / 2, rd = 1.8 * rug.scale / 2, c = Math.cos(rug.rotY), s = Math.sin(rug.rotY);
  const lx = c * (chair.x - rug.x) - s * (chair.z - rug.z), lz = s * (chair.x - rug.x) + c * (chair.z - rug.z);
  assert.ok(Math.abs(lx) < rw && Math.abs(lz) < rd, `chair stands on the rug (${lx.toFixed(2)}, ${lz.toFixed(2)})`);
  assert.ok(table.lamp, 'the side table carries the lamp (it emits)');
  assert.ok(Math.hypot(table.x - chair.x, table.z - chair.z) < 1.4, 'side table beside the chair');
  // Facing: the chair's forward (+z rotated by rotY) points within 75 degrees of the boards' centre.
  const fwd = [Math.sin(chair.rotY), Math.cos(chair.rotY)], to = [0 - chair.x, -2.75 - chair.z], n = Math.hypot(...to);
  assert.ok((fwd[0] * to[0] + fwd[1] * to[1]) / n > Math.cos(75 * Math.PI / 180), `chair faces the focal point (rotY ${chair.rotY})`);
});
test('plants come in odd groups (3 or 5) at varied heights; dining has a round table + 4 chairs on a rug; library has a shelf run', () => {
  for (const label of ['Room 7', 'Garden', 'Lighthouse library', 'Moonbase', 'Recipe App', 'Other chats']) {
    const d = D.roomDressing(room('x', label, { width: 9, depth: 8 }), world(room('x', label, { width: 9, depth: 8 })));
    const groups = new Map(); for (const p of d.pieces.filter(p => p.plan !== 'rug' && p.plan.some(k => /plant|pachira|calathea/.test(k.id)))) { const g = p.key.split(':')[0]; groups.set(g, [...(groups.get(g) ?? []), p]); }
    assert.ok(groups.size >= 1, `${label}: has a plant group`);
    for (const [g, list] of groups) {
      assert.ok(list.length % 2 === 1, `${label}: ${g} has an odd number of plants (${list.length})`);
      assert.ok(new Set(list.map(p => p.plan[0].id)).size >= 2, `${label}: ${g} mixes plant kinds (heights)`);
    }
  }
  const dine = D.roomDressing(room('r', 'Recipe App', { width: 9, depth: 8 }), world(room('r', 'Recipe App', { width: 9, depth: 8 })));
  assert.equal(dine.preset, 'dining');
  assert.equal(dine.pieces.filter(p => /^table:chair-/.test(p.key)).length, 4, '4 chairs');
  assert.ok(centre(dine, 'table:rug') && centre(dine, 'table:table'), 'table on a rug');
  const lib = D.roomDressing(room('l', 'Lighthouse', { width: 9, depth: 8 }), world(room('l', 'Lighthouse', { width: 9, depth: 8 })));
  assert.equal(lib.preset, 'library');
  const units = lib.pieces.filter(p => /^shelves:shelves-/.test(p.key));
  assert.equal(units.length, 2, 'two shelving units');
  assert.ok(Math.abs(units[0].rotY - units[1].rotY) < 1e-6 && Math.hypot(units[0].x - units[1].x, units[0].z - units[1].z) < 2.2, 'side by side as one wall run');
});
test('a wall screen gets the media cabinet right under it', () => {
  const r = room('m', 'Room 3', { width: 10, depth: 8 });
  const scr = { id: 'web', kind: 'web-wall', width: 2.4, height: 1.4, transform: { x: 1, z: -4 + 0.08, rotation: 0 } };
  const d = D.roomDressing(r, world(r, scr));
  const cab = centre(d, 'media:cabinet');
  assert.ok(cab, d.pieces.map(p => p.key).join(', '));
  assert.ok(Math.abs(cab.x - 1) < 0.05 && cab.z < -3.2, `under the screen (${cab.x}, ${cab.z})`);
});
