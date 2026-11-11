// w3:look — open world and rooms look good and readable: overview framing, room labels, label de-overlap,
// spawn spot, paths. Pure functions only (the real-browser look check is scripts/w3-expand-real.cjs).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const scale = require('../src/browser/world-scene-scale.ts');
const labels = require('../src/browser/workstation-label-visibility.ts');
Module._extensions['.ts'] = originalTsLoader;
Module._resolveFilename = originalResolve;

const station = (id, x, z, rotation = 0) => ({ id, kind: 'station', label: id, transform: { x, z, rotation }, station: { name: id, kind: 'shell', tabs: [{ name: 'Shell', kind: 'shell' }], locked: false } });
const room = (id, x, z, width, depth, rotation = 0) => ({ id, kind: 'room', label: id, transform: { x, z, rotation }, width, depth, doors: ['front'] });
/** The onboarding "two wings" world: a 54 x 48 open shell, two rooms either side of the street. */
function campus() {
  return { version: 2, name: 'campus', revision: 1, shell: { theme: 'station', width: 54, depth: 48, open: true }, entities: [
    room('research-wing', -9, -8, 14, 10), room('agent-wing', 9, -8, 18, 10),
    station('d1', -11, -10), station('d2', -7, -10), station('d3', 5, -10), station('d4', 9, -10), station('d5', 13, -10),
  ] };
}
/** Project a world point with the same camera model RoomScene uses (lookAt target, vertical fov, aspect). */
function project(frame, view, p) {
  const { azimuth: a, elevation: e } = view;
  const dir = [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
  const C = [frame.target.x + dir[0] * frame.distance, frame.target.y + dir[1] * frame.distance, frame.target.z + dir[2] * frame.distance];
  const f = [-dir[0], -dir[1], -dir[2]];
  const r = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]; const rl = Math.hypot(...r); r.forEach((v, i) => { r[i] = v / rl; });
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const v = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const t = Math.tan(view.fov * Math.PI / 360), z = dot(v, f);
  return { x: dot(v, r) / (z * t * view.aspect), y: dot(v, u) / (z * t) };
}

test('overview of an open world frames its rooms and desks, not the whole ground', () => {
  const view = { azimuth: 0.56, elevation: 0.61, aspect: 2.74, fov: 38 };
  const frame = scale.overviewFrame(campus(), view);
  assert.ok(frame, 'an open world gets a content frame');
  // Old behaviour: 24 m x worldScale(54 x 48) = 115 m away. The content frame must stand much nearer.
  assert.ok(frame.distance < 24 * scale.worldScale(campus().shell) * 0.75, `distance ${frame.distance}`);
  // The content box centre is the look-at target (rooms sit behind the street, z < 0).
  assert.ok(frame.target.z < -3 && Math.abs(frame.target.x) < 1.5, JSON.stringify(frame.target));
  // Every content corner is on screen, and the content fills the view (a corner reaches past 70 % of half the screen).
  let most = 0;
  // Content box: rooms x -16..18, z -13..-3, plus the strip in front of the doorways (name plates, to z -1).
  for (const x of [-16, 18]) for (const z of [-13, -1]) for (const y of [0, 2.8]) {
    const p = project(frame, view, [x, y, z]);
    assert.ok(Math.abs(p.x) <= 0.95 && Math.abs(p.y) <= 0.95, `corner ${x},${z} at ${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    most = Math.max(most, Math.abs(p.x), Math.abs(p.y));
  }
  assert.ok(most > 0.82, `content fills the view (largest corner ${most.toFixed(2)})`);
});

test('a classic walled room keeps the v1 overview camera (no content frame)', () => {
  const classic = { version: 2, name: 'p', revision: 0, shell: { theme: 'station', width: 12, depth: 10 }, entities: [station('terminal', -2.2, -0.7)] };
  assert.equal(scale.overviewFrame(classic, { azimuth: 0.56, elevation: 0.61, aspect: 2, fov: 38 }), undefined);
});

test('an empty open world frames the spawn area, never a zero-size box', () => {
  const empty = { version: 2, name: 'p', revision: 0, shell: { theme: 'station', width: 200, depth: 200, open: true }, entities: [] };
  const frame = scale.overviewFrame(empty, { azimuth: 0.56, elevation: 0.61, aspect: 2, fov: 38 });
  assert.ok(frame && frame.distance > 8 && frame.distance < 60, JSON.stringify(frame));
});

// ------------------------------------------------------------------------------------------- (2) rooms readable
function loadRooms() {
  Module._extensions['.ts'] = (module, filename) => module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
  Module._resolveFilename = function (request, parent, ...rest) { try { return originalResolve.call(this, request, parent, ...rest); } catch (error) { if (request.startsWith('.')) return originalResolve.call(this, request + '.ts', parent, ...rest); throw error; } };
  try { return require('../src/browser/world-scene-rooms.ts'); } finally { Module._extensions['.ts'] = originalTsLoader; Module._resolveFilename = originalResolve; }
}
const luminance = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
function meshes(root) { const out = []; root.traverse(n => { if (n.isMesh) out.push(n); }); return out; }

test('room walls are light and contrast with the room floor and the open ground', () => {
  const R = loadRooms();
  for (const theme of ['station', 'jungle']) {
    const built = R.buildRoom(room('r', 0, 0, 14, 10), theme === 'jungle');
    const walls = meshes(built.root.userData.roomWalls).filter(m => m.userData.part === 'wall');
    assert.ok(walls.length >= 4, `${theme}: wall pieces tagged`);
    const wallL = luminance(walls[0].material.color);
    const floor = meshes(built.root).find(m => m.userData.part === 'floor');
    assert.ok(floor, `${theme}: room floor tagged`);
    assert.ok(wallL > 0.45, `${theme}: walls are light (${wallL.toFixed(2)})`);
    assert.ok(wallL - luminance(floor.material.color) > 0.15, `${theme}: walls stand out from the floor`);
  }
});

test('every doorway is framed: two coloured jamb posts and a threshold strip per door', () => {
  const R = loadRooms();
  const built = R.buildRoom({ ...room('r', 0, 0, 14, 10), doors: ['front', 'left'] }, false);
  const all = meshes(built.root);
  assert.equal(all.filter(m => m.userData.part === 'jamb').length, 4);
  assert.equal(all.filter(m => m.userData.part === 'threshold').length, 2);
});

test('a room shows its name on a floor plate just outside its doorway', () => {
  const R = loadRooms();
  const built = R.buildRoom({ ...room('r', 0, 0, 14, 10), label: 'Research wing' }, false);
  const plate = meshes(built.root).find(m => m.userData.part === 'name-plate');
  assert.ok(plate, 'name plate exists');
  assert.equal(plate.userData.roomName, 'Research wing');
  assert.ok(plate.position.z > 5 && plate.position.z < 7.5, `outside the front door (z ${plate.position.z})`);
  assert.ok(Math.abs(plate.position.y) < 0.1, 'lies on the floor');
});

test('overview cutaway keeps walls tall enough to read (>= 1 m) but below desk tops (<= 1.3 m)', () => {
  const R = loadRooms();
  const h = R.ROOM_WALL_HEIGHT * R.ROOM_CUTAWAY_SCALE;
  assert.ok(h >= 1 && h <= 1.3, `cutaway wall height ${h}`);
});

// ------------------------------------------------------------------------------------------- (3) overview labels
test('overview chips never overlap: a chip that would touch a placed one is hidden, not stacked away from its desk', () => {
  const items = [
    { id: 'a', x: 100, y: 100, w: 30, h: 20 }, { id: 'b', x: 110, y: 104, w: 30, h: 20 }, { id: 'c', x: 300, y: 100, w: 30, h: 20 },
  ];
  const out = labels.declutterLabels(items);
  const shown = out.filter(i => !i.hidden);
  for (const i of out) assert.equal(i.y, items.find(o => o.id === i.id).y, 'chips keep their anchored spot (no vertical stacking)');
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const p = shown[i], q = shown[j];
    assert.ok(Math.abs(p.x - q.x) * 2 >= p.w + q.w || Math.abs(p.y - q.y) * 2 >= p.h + q.h, `${p.id} and ${q.id} overlap`);
  }
  assert.deepEqual(out.filter(i => i.hidden).map(i => i.id), ['a'], 'the front chip (larger y) wins');
});

test('room labels are placed before desk chips (priority 0 wins over a chip at the same spot)', () => {
  const out = labels.declutterLabels([{ id: 'chip', x: 200, y: 210, w: 30, h: 20, priority: 1 }, { id: 'room', x: 205, y: 200, w: 120, h: 24, priority: 0 }]);
  assert.equal(out.find(i => i.id === 'room').hidden, false);
  assert.equal(out.find(i => i.id === 'chip').hidden, true);
});

test('overview chip text is the desk number; full titles stay for walking and classic rooms', () => {
  assert.equal(labels.chipText('03  Desk three ↗'), '03');
  assert.equal(labels.chipText('Papers wall ↗'), 'Papers wall');
  assert.equal(labels.chipText('05  Mirror · Desk one ↗'), '05');
});

// ------------------------------------------------------------------------------------------- (5) doorway seams
test('doorway threshold stays inside the jamb depth (no light strip poking out past the wall faces)', () => {
  const R = loadRooms();
  const built = R.buildRoom({ ...room('r', 0, 0, 14, 10), doors: ['front', 'left'] }, false);
  const all = meshes(built.root);
  const jambs = all.filter(m => m.userData.part === 'jamb'), sills = all.filter(m => m.userData.part === 'threshold');
  // A jamb is 0.12 m along the wall and (wall thickness + a little) across it: its larger floor size is its depth.
  const jambDepth = Math.max(...jambs.map(j => Math.max(j.geometry.parameters.width, j.geometry.parameters.depth)));
  for (const sill of sills) {
    const p = sill.geometry.parameters, sillDepth = Math.min(p.width, p.depth);
    assert.ok(sillDepth <= jambDepth + 1e-6, `threshold depth ${sillDepth} > jamb depth ${jambDepth}`);
  }
});

test('the dark wall cap runs over every doorway too (no notch where the lintel meets the wall)', () => {
  const R = loadRooms();
  const built = R.buildRoom({ ...room('r', 0, 0, 14, 10), doors: ['front', 'left'] }, false);
  const all = meshes(built.root);
  const capTop = m => m.position.y + m.geometry.parameters.height / 2;
  const wallCap = all.find(m => m.userData.part === 'cap');
  const doorCaps = all.filter(m => m.userData.part === 'door-cap');
  assert.equal(doorCaps.length, 2, 'one cap per doorway');
  const jamb = all.find(m => m.userData.part === 'jamb').geometry.parameters, jambDepth = Math.min(jamb.width, jamb.depth);
  for (const cap of doorCaps) {
    assert.ok(Math.abs(capTop(cap) - capTop(wallCap)) < 1e-6, 'same top height as the wall cap');
    const p = cap.geometry.parameters, span = Math.max(p.width, p.depth), depth = Math.min(p.width, p.depth);
    assert.ok(span >= R.ROOM_DOOR_WIDTH + 0.2, `cap spans the doorway and both jambs (${span})`);
    assert.ok(depth >= jambDepth, `cap covers the jamb tops (${depth} < ${jambDepth})`);
  }
});
