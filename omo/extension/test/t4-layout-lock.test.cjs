// t4:polish (3) — the room layout lock message names the locked desk(s).
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
const { lockedLayoutReason } = require('../src/browser/world-stations.ts');
const model = require('../src/common/world-model.ts');
const rules = require('../src/common/world-admin-rules.ts');
Module._extensions['.ts'] = originalTsLoader;
Module._resolveFilename = originalResolve;

const SRC = path.resolve(__dirname, '../src/browser');

test('(3) the layout lock message names the locked desk(s) and says where to unlock', () => {
  assert.equal(lockedLayoutReason([]), '');
  assert.equal(lockedLayoutReason([{ name: 'Data', inSetup: false }]), 'Desk “Data” is locked, so the room layout cannot change. Unlock it in Station recipes, or keep this layout.');
  assert.equal(lockedLayoutReason([{ name: 'Data', inSetup: false }, { name: 'Writing', inSetup: true }]), 'Desks “Data” and “Writing” are locked, so the room layout cannot change. Unlock them in build mode (Station Setup) or in Station recipes, or keep this layout.');
  assert.match(lockedLayoutReason([{ name: 'A', inSetup: false }, { name: 'B', inSetup: false }, { name: 'C', inSetup: false }]), /^Desks “A”, “B” and “C” are locked/);
  const widget = fs.readFileSync(path.join(SRC, 'omo-world-widget.tsx'), 'utf8');
  assert.doesNotMatch(widget, /A desk is locked/, 'no message leaves the desk unnamed');
  assert.match(widget, /data-testid="room-layout-locked"[^>]*>🔒 \{this\.layoutLockReason\}/);
});
