// w4:big — Minecraft-size worlds: 1 km ground, desks into new/other rooms, moving desks between rooms.
// Run: node --test extension/test/w4-big.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const model = require('../src/common/world-model.ts');
const rules = require('../src/common/world-admin-rules.ts');
const templates = require('../src/common/world-templates.ts');
Module._extensions['.ts'] = originalTsLoader;

const plan = (world, prompt) => rules.planWithRules(world, prompt, { makeId: () => 'fixed' });
const applied = (world, result) => { assert.ok(result.proposal, result.explanation); const r = model.applyWorldOps(world, result.proposal.ops); assert.equal(r.ok, true, r.error); return r.world; };
const campus = () => { const t = templates.instantiateTemplate('open-campus', { projectName: 'p' }); return t.world || t; };
const roomsOf = w => w.entities.filter(e => e.kind === 'room');
const roomOf = (w, e) => roomsOf(w).find(r => { const b = model.roomRect(r); return e.transform.x > b.minX && e.transform.x < b.maxX && e.transform.z > b.minZ && e.transform.z < b.maxZ; });
const desksIn = (w, room) => w.entities.filter(e => e.kind === 'station' && roomOf(w, e)?.id === room.id).length;

test('a world can be 1 km x 1 km', () => {
  assert.equal(model.SHELL_MAX, 1000);
  const w = campus(); w.shell = { ...w.shell, width: 1000, depth: 1000 };
  assert.equal(model.validateWorld(w).ok, true);
});

for (const prompt of ['add 5 desks into the next room', 'add 5 desks to a new room', 'add 5 desks in another room', 'put 5 desks in a separate room']) {
  test(`"${prompt}" builds a NEW room holding all 5 desks (not the busiest room)`, () => {
    const w0 = campus(), before = roomsOf(w0).length;
    const w = applied(w0, plan(w0, prompt));
    assert.equal(roomsOf(w).length, before + 1, 'one new room');
    const fresh = roomsOf(w).find(r => !roomsOf(w0).some(o => o.id === r.id));
    assert.equal(desksIn(w, fresh), 5, 'all five desks inside the new room');
    for (const r of roomsOf(w0)) assert.equal(desksIn(w, r), desksIn(w0, r), `“${r.label}” unchanged`);
  });
}

test('"add 2 desks to the lounge" puts them in the lounge', () => {
  const w0 = campus(); const lounge = roomsOf(w0).find(r => /lounge/i.test(r.label));
  const w = applied(w0, plan(w0, 'add 2 desks to the lounge'));
  assert.equal(desksIn(w, lounge), desksIn(w0, lounge) + 2);
});

test('"move desk one to the lounge" moves a desk into another room', () => {
  const w0 = campus(); const lounge = roomsOf(w0).find(r => /lounge/i.test(r.label));
  const desk = w0.entities.find(e => e.kind === 'station');
  const w = applied(w0, plan(w0, `move ${desk.label} to the lounge`));
  const moved = w.entities.find(e => e.id === desk.id);
  assert.equal(roomOf(w, moved)?.id, lounge.id);
});

test('"make the world as big as possible" opens up to 1000 x 1000 m; "huge" is at least 400 m', () => {
  const w = applied(campus(), plan(campus(), 'make the world as big as possible'));
  assert.deepEqual([w.shell.width, w.shell.depth], [1000, 1000]);
  const classic = model.worldFromRoomV1({ theme: 'station', projectName: 'p', layout: 'classic', kit: 'hermes-desk' });
  const h = applied(classic, plan(classic, 'make the world huge'));
  assert.ok(h.shell.open && h.shell.width >= 400 && h.shell.depth >= 400, JSON.stringify(h.shell));
});

test('"make it an open world" gives real room to roam (>= 160 m each way)', () => {
  const classic = model.worldFromRoomV1({ theme: 'station', projectName: 'p', layout: 'classic', kit: 'hermes-desk' });
  const w = applied(classic, plan(classic, 'make it an open world'));
  assert.ok(w.shell.open && w.shell.width >= 160 && w.shell.depth >= 160, JSON.stringify(w.shell));
});

test('World size +/- steps grow with the world: 4 m, then 20 m, then 100 m, capped at 1 km', () => {
  const src = fs.readFileSync(require.resolve('../src/browser/build-world-size.tsx'), 'utf8');
  assert.match(src, /base < 40 \? SHELL_STEP : base < 200 \? 20 : 100/);
});
