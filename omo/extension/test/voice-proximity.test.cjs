/* promise:share — proximity voice (L5): the pure gain curve. Full volume within ~2 m, fading to 0 by ~12 m. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }, fileName: filename }).outputText;
  module._compile(output, filename);
};
const spatial = require(path.resolve(__dirname, '../src/browser/voice-spatial.ts'));
Module._extensions['.ts'] = originalTsLoader;
const { proximityVolume: v, PROXIMITY } = spatial;

test('constants: near 2 m, far 12 m, silent beyond', () => {
  assert.deepEqual(PROXIMITY, { near: 2, far: 12, floor: 0 });
});

test('gain is 1.0 within 2 m (and for a bad distance)', () => {
  for (const d of [0, 0.5, 1, 1.99, 2]) assert.equal(v(d), 1, `${d} m`);
  assert.equal(v(NaN), 1); assert.equal(v(-3), 1);
});

test('gain fades smoothly and never rises with distance between 2 m and 12 m', () => {
  let last = 1;
  for (let d = 2; d <= 12.0001; d += 0.25) {
    const g = v(d);
    assert.ok(g <= last + 1e-9, `monotone at ${d} m: ${g} > ${last}`);
    assert.ok(g >= 0 && g <= 1);
    last = g;
  }
  assert.ok(v(3) > 0.9, `3 m still clear: ${v(3)}`);
  assert.ok(Math.abs(v(7) - 0.5) <= 0.01, `half way at 7 m: ${v(7)}`);
  assert.ok(v(10) < 0.15, `10 m nearly gone: ${v(10)}`);
  assert.ok(v(11.5) <= 0.01, `11.5 m: ${v(11.5)}`);
});

test('gain is 0 at and beyond 12 m (open worlds: a far voice does not follow you)', () => {
  for (const d of [12, 15, 40, 200]) assert.equal(v(d), 0, `${d} m`);
});

test('spatial panning is on by default and the panner leaves loudness to the gain', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/browser/voice-spatial.ts'), 'utf8');
  assert.match(src, /panningModel = 'HRTF'/);
  assert.match(src, /rolloffFactor = 0/);
  const ctrl = fs.readFileSync(path.resolve(__dirname, '../src/browser/voice-controller.ts'), 'utf8');
  assert.match(ctrl, /proximity: true, spatial: true/, 'proximity + spatial default on');
  assert.match(ctrl, /proximityVolume\(distance\)/, 'the controller applies the curve per peer');
});
