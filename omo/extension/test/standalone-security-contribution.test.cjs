const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const typescript = require('typescript');

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const { StandaloneSecurityContribution } = require('../src/node/standalone-security.ts');
Module._extensions['.ts'] = originalTsLoader;

function response() {
  return {
    code: 200,
    body: '',
    status(code) { this.code = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
}

test('standalone contribution guards HTTP before the next handler', () => {
  let middleware;
  new StandaloneSecurityContribution(false).configure({ use(fn) { middleware = fn; } });
  let next = 0;
  const denied = response();
  middleware({ headers: { host: 'evil.example', origin: 'http://evil.example' } }, denied, () => { next++; });
  assert.equal(denied.code, 403);
  assert.equal(next, 0);
  const accepted = response();
  middleware({ headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } }, accepted, () => { next++; });
  assert.equal(accepted.code, 200);
  assert.equal(next, 1);
});

test('standalone contribution uses Theia central WebSocket validator and retains duplicate header values', async () => {
  const contribution = new StandaloneSecurityContribution(false);
  assert.equal(typeof contribution.allowWsUpgrade, 'function', 'Theia must call the guard before accepting the upgrade');
  const { WsRequestValidator } = require('@theia/core/lib/node/ws-request-validators');
  const validator = new WsRequestValidator();
  validator.requestValidators = { getContributions: () => [contribution] };
  assert.equal(await validator.allowWsUpgrade({ headers: {host:'localhost:3190',origin:'http://localhost:3190'} }), true);
  assert.equal(await validator.allowWsUpgrade({ headers: {host:'localhost:3190',origin:'https://outside.invalid'} }), false);
  const duplicate = { headers: {host:'localhost:3190',origin:'http://localhost:3190'}, headersDistinct: {host:['localhost:3190','evil.example'],origin:['http://localhost:3190']} };
  assert.equal(await validator.allowWsUpgrade(duplicate), false);
  let middleware;
  contribution.configure({use(fn) {middleware=fn;}});
  const denied = response(); let next=0;
  middleware(duplicate, denied, () => next++);
  assert.equal(denied.code, 403); assert.equal(next, 0);
  const backend = fs.readFileSync(path.resolve(__dirname, '../src/node/omo-backend-module.ts'), 'utf8');
  assert.match(backend, /bind\(WsRequestValidatorContribution\)\.toService\(OmoStandaloneSecurity\)/);
});

test('team mode delegates HTTP and WebSocket authorization instead of applying loopback policy', () => {
  let middleware;
  const contribution = new StandaloneSecurityContribution(true);
  contribution.configure({ use(fn) { middleware = fn; } });
  let next = 0;
  middleware({ headers: { host: 'team.example', origin: 'https://team.example' } }, response(), () => { next++; });
  assert.equal(next, 1);
});
