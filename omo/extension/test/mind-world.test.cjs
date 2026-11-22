// promise:onboarding — the first minute's planning, on this device: the sentence picks a style (library / garden /
// observatory / ...) -> an existing template/kit + a decor set; imported topics become rooms with a sign + note boards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const mw = require('../src/browser/mind-world.ts');
const mind = require('../src/node/mind-import.ts');
const model = require('../src/common/world-model.ts');
const kits = require('../src/common/world-style-kits.ts');
Module._extensions['.ts'] = originalTsLoader;

const FIXTURE = path.join(__dirname, 'fixtures', 'mind');
function loadEntities() {
  const resolve = Module._resolveFilename, loader = Module._extensions['.ts'];
  Module._extensions['.ts'] = (module, filename) => module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
  Module._resolveFilename = function (request, parent, ...rest) { try { return resolve.call(this, request, parent, ...rest); } catch (error) { if (request.startsWith('.')) return resolve.call(this, request + '.ts', parent, ...rest); throw error; } };
  try { return require('../src/browser/world-scene-entities.ts'); } finally { Module._extensions['.ts'] = loader; Module._resolveFilename = resolve; }
}

test('style words map to an existing theme/kit and decor set', () => {
  const cases = [
    ['A lighthouse library at the edge of the sea', ['sea', 'library'], 'nyc-skyscraper', 'skyline', ['window', 'bookshelf']],
    ['a library full of old books', ['library'], 'nyc-skyscraper', 'skyline', ['bookshelf', 'bookshelf']],
    ['a quiet garden with a greenhouse', ['garden'], 'jungle-expedition', 'jungle', ['plant', 'rug']],
    ['an observatory under the stars', ['observatory'], 'space-station', 'station', ['crystal', 'window']],
    ['a cosy cabin', ['cabin'], 'nyc-skyscraper', 'skyline', ['sofa', 'rug']],
    ['a bright studio with whiteboards', ['studio'], 'nyc-skyscraper', 'skyline', ['whiteboard', 'lamp']],
    ['a penthouse above the city', ['penthouse'], 'nyc-skyscraper', 'skyline', []]
  ];
  for (const [sentence, styles, template, theme, decor] of cases) {
    const s = mw.mindStyle(sentence);
    assert.deepEqual(s.styles, styles, sentence);
    assert.equal(s.template, template, sentence);
    assert.equal(s.theme, theme, sentence);
    assert.deepEqual(s.decor, decor, sentence);
  }
});

test('no style words: the skyline penthouse kit is the default, with nothing added', () => {
  for (const sentence of ['', 'somewhere calm', 'I do not know yet']) {
    const h = mw.homeWorld(sentence);
    assert.deepEqual(h.style.styles, []);
    assert.equal(h.world.shell.theme, 'skyline');
    assert.equal(kits.activeKit(h.world)?.id, 'skyline-penthouse', sentence);
  }
});

test('homeWorld builds through the planner: valid, named from the sentence, penthouse kit floor kept, style decor present', () => {
  const h = mw.homeWorld('A lighthouse library at the edge of the sea…');
  assert.ok(model.validateWorld(h.world).ok);
  assert.equal(h.world.name, 'Lighthouse library');
  assert.equal(kits.activeKit(h.world)?.id, 'skyline-penthouse', 'the baked penthouse floor still fits');
  const decor = h.world.entities.filter(e => e.kind === 'decor').map(e => e.decor);
  assert.ok(decor.includes('bookshelf') && decor.includes('window'), decor.join(','));
  assert.equal(h.world.entities.filter(e => e.kind === 'station').length, 3);
  const g = mw.homeWorld('a quiet garden with a greenhouse');
  assert.equal(g.world.shell.theme, 'jungle'); assert.ok(model.validateWorld(g.world).ok);
  assert.ok(g.world.entities.filter(e => e.kind === 'decor' && e.decor === 'plant').length >= 6);
});

test('world names: short, from the sentence, no secrets or paths', () => {
  assert.equal(mw.worldNameFrom('A lighthouse library at the edge of the sea…'), 'Lighthouse library');
  assert.equal(mw.worldNameFrom('an observatory under the stars'), 'Observatory');
  assert.equal(mw.worldNameFrom(''), 'My world');
  assert.doesNotMatch(mw.worldNameFrom('sk-abcdefghijklmnop1234 garden'), /sk-/);
});

test('imported topics become small rooms, each with a sign and up to 4 note boards; the home stays in a Home room', async () => {
  const r = await mind.importMind({}, { home: FIXTURE });
  const home = mw.homeWorld('A lighthouse library at the edge of the sea').world;
  const w = mw.mindWorld(home, r.rooms);
  assert.ok(model.validateWorld(w).ok);
  assert.equal(w.shell.open, true);
  const c = mw.mindCounts(w);
  assert.equal(c.rooms, r.rooms.length); assert.equal(c.signs, r.rooms.length);
  assert.equal(c.notes, r.counts.screens);
  const moon = w.entities.find(e => e.id === 'mind-moonbase');
  assert.equal(moon.kind, 'room'); assert.equal(moon.label, 'Moonbase');
  const inside = (e, room) => { const b = model.roomRect(room); return e.transform.x > b.minX && e.transform.x < b.maxX && e.transform.z > b.minZ && e.transform.z < b.maxZ; };
  for (const e of w.entities.filter(x => /^note-moonbase/.test(x.id))) assert.ok(inside(e, moon), `${e.id} is inside its room`);
  // promise:onboarding (4): ONE topic board per topic room, just outside its front doorway, beside the path, facing the street.
  for (const room of w.entities.filter(e => e.kind === 'room' && e.id.startsWith('mind-'))) {
    const boards = w.entities.filter(e => e.id === `sign-${room.id.slice(5)}`);
    assert.equal(boards.length, 1, `${room.id} has one board`);
    const b = boards[0], c = Math.cos(room.transform.rotation), sn = Math.sin(room.transform.rotation);
    const dx = b.transform.x - room.transform.x, dz = b.transform.z - room.transform.z, lx = c * dx - sn * dz, lz = sn * dx + c * dz;
    assert.ok(lz > room.depth / 2 && lz < room.depth / 2 + 1.2, `${b.id} stands just outside the front wall (local z ${lz})`);
    assert.ok(Math.abs(lx) > 0.8 + 1.1 && Math.abs(lx) < room.width / 2, `${b.id} is beside the doorway, not in it (local x ${lx})`);
    assert.ok(Math.abs(Math.cos(b.transform.rotation - room.transform.rotation) - 1) < 1e-6, `${b.id} faces out of the door, towards the path`);
    assert.ok(b.scale >= 1.2, 'big enough to read');
  }
  assert.ok(w.entities.filter(x => x.id.startsWith('note-')).every(x => x.kind === 'decor' && x.decor === 'whiteboard' && x.label.length <= 60));
  const homeRoom = w.entities.find(e => e.id === 'home');
  for (const s of w.entities.filter(e => e.kind === 'station')) assert.ok(inside(s, homeRoom), `${s.id} stays home`);
  assert.equal(w.entities.filter(e => e.kind === 'station').length, 3);
  assert.equal(mw.mindWorld(home, []), home, 'no topics: the home world, unchanged');
});

test('a topic board lists 2-4 note lines from its room, using existing fields only (labels of the room\'s note-* entities)', async () => {
  const ents = loadEntities();
  const r = await mind.importMind({}, { home: FIXTURE });
  const w = mw.mindWorld(mw.homeWorld('A lighthouse library at the edge of the sea').world, r.rooms);
  const moonNotes = w.entities.filter(e => e.id.startsWith('note-moonbase')).map(e => e.label);
  assert.deepEqual(ents.topicBoardLines(w, 'sign-moonbase'), moonNotes.slice(0, 4));
  assert.ok(moonNotes.length >= 2);
  for (const s of w.entities.filter(e => e.id.startsWith('sign-'))) {
    const lines = ents.topicBoardLines(w, s.id);
    assert.ok(lines.length >= 1 && lines.length <= 4, `${s.id}: ${lines.length} lines`);
    const room = w.entities.find(e => e.id === `mind-${s.id.slice(5)}`);
    for (const l of lines) assert.ok(w.entities.some(e => e.id.startsWith('note-') && e.label === l && model.roomRect(room).minX < e.transform.x && e.transform.x < model.roomRect(room).maxX), `${l} is a note of ${room.id}`);
  }
  assert.ok(model.validateWorld(w).ok, 'the shared world format is unchanged');
});

test('caps: at most 6 topic rooms and 4 notes each, even with more given', () => {
  const rooms = Array.from({ length: 9 }, (_, i) => ({ title: `Topic ${i}`, source: 'hermes', chats: 9, screens: Array.from({ length: 7 }, (_, j) => ({ title: `Note ${j}`, summary: 's' })) }));
  const w = mw.mindWorld(mw.homeWorld('').world, rooms);
  const c = mw.mindCounts(w);
  assert.equal(c.rooms, 6); assert.equal(c.notes, 24);
  assert.ok(model.validateWorld(w).ok);
});
