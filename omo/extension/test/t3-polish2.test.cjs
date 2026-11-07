// t3:polish2 — world UI polish: rotation stays exact after quarter turns; overview labels never overlap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');

const originalTsLoader = Module._extensions['.ts'];
const originalResolve = Module._resolveFilename;
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
Module._resolveFilename = function (request, parent, ...rest) {
  try { return originalResolve.call(this, request, parent, ...rest); }
  catch (error) { if (request.startsWith('.')) return originalResolve.call(this, request + '.ts', parent, ...rest); throw error; }
};
const { normalizeRotation } = require('../src/browser/build-catalog.ts');
const { layoutLabels } = require('../src/browser/workstation-label-visibility.ts');
const model = require('../src/common/world-model.ts');
const rules = require('../src/common/world-admin-rules.ts');
Module._extensions['.ts'] = originalTsLoader;
Module._resolveFilename = originalResolve;

const QUARTER = Math.PI / 2;

test('four quarter turns in build mode come back to exactly 0 (not 0.001)', () => {
  let r = 0;
  for (let i = 0; i < 4; i++) r = normalizeRotation(r + QUARTER);
  assert.equal(r, 0);
  assert.equal(Object.is(r, -0), false);
  for (let i = 0; i < 4; i++) r = normalizeRotation(r - QUARTER);
  assert.equal(r, 0);
});

test('quarter turns stay on exact quarters and +pi / -pi are one value', () => {
  const seen = new Set();
  let r = 0;
  for (let i = 0; i < 40; i++) { r = normalizeRotation(r + QUARTER); seen.add(r); }
  assert.deepEqual([...seen].sort((a, b) => a - b), [-1.571, 0, 1.571, normalizeRotation(Math.PI)].sort((a, b) => a - b));
  assert.equal(normalizeRotation(Math.PI), normalizeRotation(-Math.PI));
  assert.equal(normalizeRotation(0.3), 0.3, 'free angles are kept');
});

test('admin "turn" four times returns a desk to 0', () => {
  let world = model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' });
  for (let i = 0; i < 4; i++) {
    const plan = rules.planWithRules(world, 'turn desk one');
    const ops = plan.proposal?.ops ?? [];
    assert.ok(ops.length > 0, 'the planner proposes a turn');
    const applied = model.applyWorldOps(world, ops);
    assert.equal(applied.ok, true, applied.error);
    world = applied.world;
  }
  assert.equal(world.entities.find(e => e.id === 'terminal').transform.rotation, 0);
});

test('overview labels are laid out without overlap; free labels keep their spot', () => {
  const items = [
    { id: 'a', x: 600, y: 480, w: 160, h: 26 },
    { id: 'b', x: 640, y: 486, w: 120, h: 26 },
    { id: 'c', x: 660, y: 470, w: 110, h: 26 },
    { id: 'far', x: 1100, y: 300, w: 100, h: 26 },
  ];
  const out = layoutLabels(items);
  const box = i => [i.x - i.w / 2, i.y - i.h / 2, i.x + i.w / 2, i.y + i.h / 2];
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = box(out[i]), b = box(out[j]);
    const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    assert.ok(!(ox > 0 && oy > 0), `${out[i].id} overlaps ${out[j].id}`);
  }
  assert.equal(out.find(i => i.id === 'far').y, 300);
  assert.equal(out.find(i => i.id === 'b').y, 486, 'the front label keeps its projected spot');
});
