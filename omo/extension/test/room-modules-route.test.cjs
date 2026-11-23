// room modules (1) — the /omo-kits route serves kits/modules/<id>/* for exact module ids only; traversal and odd ids 404.
// Run: node --test extension/test/room-modules-route.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const typescript = require('typescript');
require('reflect-metadata');

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, experimentalDecorators: true, emitDecoratorMetadata: false },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const route = require('../src/node/style-kit-assets.ts');
Module._extensions['.ts'] = originalTsLoader;
const express = require('@theia/core/shared/express');

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-kits-'));
  fs.mkdirSync(path.join(root, 'modules', 'library'), { recursive: true });
  fs.writeFileSync(path.join(root, 'modules', 'library', 'module.json'), '{"id":"library"}');
  fs.writeFileSync(path.join(root, 'modules', 'library', 'props.json'), '[]');
  fs.mkdirSync(path.join(root, 'modules', 'nojson'), { recursive: true });
  fs.writeFileSync(path.join(root, 'modules', 'nojson', 'room.glb'), 'x');
  fs.mkdirSync(path.join(root, 'skyline-penthouse'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skyline-penthouse', 'lamps.json'), '[]');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
  return root;
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject); req.end();
  });
}

test('room modules route: kitDir takes exact ids only', () => {
  const root = fixture();
  assert.equal(route.kitDir(root, 'modules', 'library'), path.join(root, 'modules', 'library'));
  assert.equal(route.kitDir(root, 'modules', 'nojson'), undefined, 'a module needs its module.json');
  for (const bad of ['..', '../..', 'library/..', '.library', 'Library', 'lib rary', '', '%2e%2e', 'a'.repeat(49)]) assert.equal(route.kitDir(root, 'modules', bad), undefined, bad);
  assert.equal(route.kitDir(root, 'modules', undefined), undefined);
  assert.equal(route.kitDir(root, 'skyline-penthouse'), path.join(root, 'skyline-penthouse'));
  assert.equal(route.kitDir(undefined, 'modules', 'library'), undefined);
});

test('room modules route: serves module files, rejects traversal over HTTP', async () => {
  const root = fixture();
  const app = express();
  route.mountStyleKits(app, root);
  app.use((err, _req, res, _next) => res.status(err.status || 500).end()); // quiet: no stack traces for the expected 403/404s
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const ok = await get(port, '/omo-kits/modules/library/module.json');
    assert.equal(ok.status, 200); assert.equal(ok.body, '{"id":"library"}');
    assert.equal((await get(port, '/omo-kits/modules/library/props.json')).status, 200);
    assert.equal((await get(port, '/omo-kits/skyline-penthouse/lamps.json')).status, 200, 'the penthouse kit is unchanged');
    for (const p of ['/omo-kits/modules/library/../../secret.txt', '/omo-kits/modules/library/%2e%2e/%2e%2e/secret.txt', '/omo-kits/modules/%2e%2e/secret.txt',
      '/omo-kits/modules/..%2fsecret.txt', '/omo-kits/modules/library/..%2f..%2fsecret.txt', '/omo-kits/modules/nojson/room.glb', '/omo-kits/modules/missing/module.json',
      '/omo-kits/modules/module.json', '/omo-kits/%2e%2e/secret.txt', '/omo-kits/modules/Library/module.json']) {
      const r = await get(port, p);
      assert.notEqual(r.status, 200, `${p} -> ${r.status}`);
      assert.ok(!r.body.includes('SECRET'), p);
    }
  } finally { server.close(); }
});
