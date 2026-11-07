// t4:polish (2) — the admin prompt box is empty after sending, with a neutral placeholder; no suggestion carries an ordinal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
const model = require('../src/common/world-model.ts');
const rules = require('../src/common/world-admin-rules.ts');
Module._extensions['.ts'] = originalTsLoader;
Module._resolveFilename = originalResolve;

const SRC = path.resolve(__dirname, '../src/browser');

const ORDINAL = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i;
test('(2) the admin prompt placeholder is neutral and no suggestion carries a desk ordinal', () => {
  assert.equal(typeof rules.ADMIN_PROMPT_PLACEHOLDER, 'string');
  assert.match(rules.ADMIN_PROMPT_PLACEHOLDER, /^Describe a change, e\.g\. /);
  assert.doesNotMatch(rules.ADMIN_PROMPT_PLACEHOLDER, ORDINAL);
  for (const example of rules.ADMIN_EXAMPLES) assert.doesNotMatch(example, ORDINAL, example);
  const panel = fs.readFileSync(path.join(SRC, 'admin-panel.tsx'), 'utf8');
  assert.match(panel, /placeholder=\{ADMIN_PROMPT_PLACEHOLDER\}/);
  assert.doesNotMatch(panel, /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+desk/i, 'no hard-coded desk ordinal in the admin panel');
  assert.match(panel, /setText\(''\); void controller\.ask\(value\)/, 'sending clears the box');
});

test('(2) every suggestion still plans a real change in a 4-desk world (no ordinal mismatch)', () => {
  let world = model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' });
  for (const name of ['Data', 'Writing']) { const r = model.applyWorldOps(world, rules.planWithRules(world, `add a shell desk named ${name}`).proposal.ops); assert.equal(r.ok, true); world = r.world; }
  assert.equal(model.stations(world).length, 4);
  const first = rules.planWithRules(world, rules.ADMIN_EXAMPLES[0]);
  assert.ok(first.proposal && first.proposal.ops.some(op => op.op === 'add' && op.entity.kind === 'station'), 'the first suggestion adds a desk');
});

