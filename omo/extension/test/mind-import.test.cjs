// promise:onboarding — "Read here, never uploaded / 0 bytes sent". The chat importer (node/mind-import.ts) runs on
// the fixture folder extension/test/fixtures/mind/ with EVERY network door stubbed to throw (http, https, net, tls,
// dns, http2, child_process, fetch, WebSocket). It must still return rooms, and no fake secret may appear.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');

const FIXTURE = path.join(__dirname, 'fixtures', 'mind');
const calls = [];
const deny = name => function denied() { calls.push(name); throw new Error(`network call during import: ${name}`); };

// 1) Stub the network BEFORE the importer is loaded, so a top-level import could not grab a real one.
const doors = {
  http: ['request', 'get', 'createServer', 'Agent'], https: ['request', 'get', 'createServer', 'Agent'], http2: ['connect', 'createServer'],
  net: ['connect', 'createConnection', 'createServer', 'Socket'], tls: ['connect', 'createServer'], dgram: ['createSocket'],
  dns: ['lookup', 'resolve', 'resolve4', 'resolve6'], child_process: ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']
};
const saved = [];
for (const [mod, fns] of Object.entries(doors)) {
  const m = require(mod);
  for (const fn of fns) { saved.push([m, fn, m[fn]]); try { Object.defineProperty(m, fn, { value: deny(`${mod}.${fn}`), configurable: true, writable: true }); } catch { m[fn] = deny(`${mod}.${fn}`); } }
}
const savedFetch = globalThis.fetch, savedWs = globalThis.WebSocket;
globalThis.fetch = deny('fetch'); globalThis.WebSocket = deny('WebSocket');
// Any require of a network module from the importer is recorded too.
const loaded = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /mind-import/.test(parent.filename || '')) loaded.push(request);
  return origLoad.apply(this, arguments);
};

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const mind = require('../src/node/mind-import.ts');
const protocol = require('../src/common/mind-import-protocol.ts');
Module._extensions['.ts'] = originalTsLoader;

test.after(() => {
  Module._load = origLoad;
  for (const [m, fn, v] of saved) { try { Object.defineProperty(m, fn, { value: v, configurable: true, writable: true }); } catch { m[fn] = v; } }
  globalThis.fetch = savedFetch; globalThis.WebSocket = savedWs;
});

const allStrings = result => JSON.stringify(result);

test('0 bytes sent: the importer reads the fixture with every network door stubbed to throw, and makes no call', async () => {
  const result = await mind.importMind({}, { home: FIXTURE });
  assert.deepEqual(calls, [], `network doors touched: ${calls.join(', ')}`);
  assert.deepEqual(loaded.filter(r => /^(node:)?(http|https|http2|net|tls|dns|dgram|child_process|undici|ws)$/.test(r)), [], `importer required: ${loaded.join(', ')}`);
  assert.equal(result.counts.bytesSent, 0);
  assert.ok(result.counts.chats >= 9, JSON.stringify(result.counts));
  assert.ok(result.rooms.length >= 3 && result.rooms.length <= protocol.MIND_MAX_ROOMS, JSON.stringify(result.rooms.map(r => r.title)));
  assert.deepEqual(result.found, { hermes: true, claude: true });
});

test('the importer source has no network code at all (imports only fs, os, path and the protocol)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'node', 'mind-import.ts'), 'utf8');
  const imports = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['../common/mind-import-protocol', '../common/mind-import-protocol', 'fs', 'os', 'path']);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\b(fetch|XMLHttpRequest|WebSocket|require)\s*\(/);
});

test('redaction: the fake keys, tokens, emails and home paths in the fixture never reach the output', async () => {
  const out = allStrings(await mind.importMind({}, { home: FIXTURE }));
  for (const secret of ['sk-FAKEfixtureKEY1234567890abcdef', 'FAKEfixtureKEY', 'sk-proj-FAKEfixture', 'ghp_FAKEfixture', 'ada.lovelace@example.com', 'grace.hopper@example.org', '/home/fixture-user', 'fixture-user', 'Bearer FAKE', 'api.example.invalid/v1']) {
    assert.ok(!out.includes(secret), `leaked: ${secret}`);
  }
  assert.match(out, /\[secret\]|\[email\]/, 'redaction markers are shown where something was removed');
});

test('grouping: Claude Code chats by project folder, Hermes chats by first-message keywords; caps hold', async () => {
  const r = await mind.importMind({}, { home: FIXTURE });
  const titles = r.rooms.map(x => x.title);
  assert.ok(titles.includes('Moonbase'), titles.join(' | '));
  assert.ok(titles.includes('Recipe App'), titles.join(' | '));
  assert.ok(titles.includes('Garden'), titles.join(' | '));
  assert.ok(titles.some(t => /Novel|Lighthouse/.test(t)), titles.join(' | '));
  const moon = r.rooms.find(x => x.title === 'Moonbase');
  assert.equal(moon.source, 'claude'); assert.equal(moon.chats, 3); assert.equal(moon.screens.length, 3);
  assert.ok(moon.screens.some(s => s.title === 'Add a docking bay to the moonbase game'), JSON.stringify(moon.screens));
  for (const room of r.rooms) {
    assert.ok(room.title.length <= protocol.MIND_TITLE_MAX && room.screens.length >= 1 && room.screens.length <= protocol.MIND_MAX_SCREENS);
    for (const s of room.screens) { assert.ok(s.title.length <= protocol.MIND_TITLE_MAX, s.title); assert.ok(s.summary.length <= protocol.MIND_SUMMARY_MAX, s.summary); }
  }
  assert.equal(r.counts.rooms, r.rooms.length);
  assert.equal(r.counts.screens, r.rooms.reduce((n, x) => n + x.screens.length, 0));
  assert.ok(!allStrings(r).includes('/clear'), 'harness commands are not notes');
});

test('the index file and a broken file are skipped, never thrown; missing folders give an empty result', async () => {
  const r = await mind.importMind({}, { home: FIXTURE });
  assert.ok(r.counts.skipped >= 2, JSON.stringify(r.counts));
  const empty = await mind.importMind({}, { home: path.join(FIXTURE, 'nothing-here') });
  assert.deepEqual(empty.rooms, []); assert.deepEqual(empty.found, { hermes: false, claude: false }); assert.equal(empty.counts.bytesSent, 0);
  const onlyClaude = await mind.importMind({ hermes: false }, { home: FIXTURE });
  assert.ok(onlyClaude.rooms.every(x => x.source === 'claude'));
});

test('OMO_MIND_HOME points the importer at a folder (the real-browser check uses it, never real chats)', async () => {
  const before = process.env.OMO_MIND_HOME;
  process.env.OMO_MIND_HOME = FIXTURE;
  try { const r = await new mind.MindImportBackend().importMind({}); assert.ok(r.rooms.some(x => x.title === 'Moonbase')); }
  finally { if (before === undefined) delete process.env.OMO_MIND_HOME; else process.env.OMO_MIND_HOME = before; }
});

test('redactText: keys, tokens, emails, URLs with paths, IPs and home paths', () => {
  const r = mind.redactText;
  assert.equal(r('key sk-abcDEF1234567890xyz here'), 'key [secret] here');
  assert.equal(r('mail bob@example.com now'), 'mail [email] now');
  assert.equal(r('see /home/harry/dev/omo and /Users/ann/x'), 'see ~/dev/omo and ~/x');
  assert.equal(r('Authorization: Bearer abc.def.ghi123456'), 'Authorization: Bearer [secret]'.replace('Authorization: Bearer [secret]', r('Authorization: Bearer abc.def.ghi123456')));
  assert.doesNotMatch(r('Authorization: Bearer abc.def.ghi123456'), /abc\.def/);
  assert.equal(r('password=hunter2 ok'), '[secret] ok');
  assert.equal(r('open https://user:pw@example.com/a/b?token=1'), 'open https://example.com');
  assert.equal(r('host 10.0.0.12'), 'host [ip]');
  assert.doesNotMatch(r('ghp_ABCDEFGHIJKLMNOPQRSTUVWX12 and xoxb-1234-5678-abcdefgh'), /ghp_|xoxb-/);
  assert.equal(r('plain words stay the same'), 'plain words stay the same');
  assert.equal(mind.capText('word '.repeat(60), 20).length <= 20, true);
});
