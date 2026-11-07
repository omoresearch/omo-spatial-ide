// w2:admin — backend checks for the world admin with a FAKE hermes executable (no model calls).
// Run: node --test extension/test/world-admin-service.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const { DatabaseSync } = require('node:sqlite');

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const model = require('../src/common/world-model.ts');
const admin = require('../src/node/world-admin-service.ts');
Module._extensions['.ts'] = originalTsLoader;

const world = () => model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture' });

function setup(answer, { lease = false, sleep = 0, exit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-admin-test-'));
  const hermesRoot = path.join(root, '.hermes');
  fs.mkdirSync(path.join(hermesRoot, 'profiles', 'coder'), { recursive: true });
  const db = new DatabaseSync(path.join(hermesRoot, 'profiles', 'coder', 'state.db'));
  db.exec('CREATE TABLE session_turn_leases (conversation_id TEXT, holder TEXT, expires_at REAL)');
  if (lease) db.prepare('INSERT INTO session_turn_leases VALUES (?, ?, ?)').run('c1', 'h1', Date.now() / 1000 + 600);
  db.close();
  const record = path.join(root, 'record.json');
  const answerFile = path.join(root, 'answer.txt');
  fs.writeFileSync(answerFile, answer);
  const bin = path.join(root, 'hermes');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).filter(k => /^(HERMES_|OMO_)/.test(k)), home: process.env.HERMES_HOME }));
setTimeout(() => { process.stdout.write(fs.readFileSync(${JSON.stringify(answerFile)}, 'utf8')); process.exit(${exit}); }, ${sleep});
`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: root, OMO_HERMES_BIN: bin, OMO_SPATIAL_HERMES_ROOT: hermesRoot, HERMES_SECRET_LEAK: 'x', OMO_OTHER: 'y' };
  const backend = new admin.WorldAdminBackend({ env, timeoutMs: 3000 });
  return { backend, record, root, hermesRoot };
}

const good = JSON.stringify({ summary: 'Add a Codex desk', explanation: 'A third desk for Codex.', ops: [
  { op: 'add', entity: { id: 'codex', kind: 'station', label: 'Codex', transform: { x: 0, z: -3, rotation: 0 }, station: { name: 'Codex', kind: 'shell', tabs: [{ name: 'Codex', kind: 'codex' }], locked: false } } },
  { op: 'add', entity: { id: 'codex-wall', kind: 'monitor-wall', label: 'Codex wall', width: 4, height: 2, elevation: 0.8, link: 'codex', transform: { x: 0, z: -4.6, rotation: 0 } } },
] });

test('rules planner is the default and never runs hermes', async () => {
  const { backend, record } = setup(good);
  const plan = await backend.plan({ world: world(), prompt: 'add a desk for codex' });
  assert.equal(plan.planner, 'rules');
  assert.ok(plan.proposal);
  assert.equal(fs.existsSync(record), false);
});

test('hermes without confirmation is refused and nothing starts', async () => {
  const { backend, record } = setup(good);
  const plan = await backend.plan({ world: world(), prompt: 'add a desk', useHermes: true, profile: 'coder' });
  assert.equal(plan.proposal, null);
  assert.match(plan.error, /confirmation/);
  assert.equal(fs.existsSync(record), false);
});

test('confirmed hermes: argv-only, no tools, ignore rules, sanitised env, empty cwd, valid proposal', async () => {
  const { backend, record, hermesRoot } = setup('Sure!\n```json\n' + good + '\n```\n');
  const plan = await backend.plan({ world: world(), prompt: 'add a third desk for Codex and a big monitor wall linked to it', useHermes: true, confirmedHermes: true, profile: 'coder' });
  assert.equal(plan.error, undefined, plan.explanation);
  assert.equal(plan.planner, 'hermes');
  assert.equal(plan.proposal.ops.length, 2);
  assert.equal(plan.proposal.baseRevision, 0);
  const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.deepEqual([seen.argv[0], seen.argv[1], seen.argv[2]], ['-p', 'coder', '-z']);
  assert.deepEqual(seen.argv.slice(4), ['-t', 'bot_room', '--ignore-rules']);
  assert.match(seen.argv[3], /ONE JSON object/);
  assert.deepEqual(seen.env, ['HERMES_HOME']);
  assert.equal(seen.home, hermesRoot);
  assert.match(path.basename(seen.cwd), /^omo-world-admin-/);
  assert.equal(fs.existsSync(seen.cwd), false, 'temp cwd removed');
});

test('a live turn lease blocks hermes', async () => {
  const { backend, record } = setup(good, { lease: true });
  const status = await backend.hermesStatus('coder');
  assert.equal(status.busy, true);
  const plan = await backend.plan({ world: world(), prompt: 'add a desk', useHermes: true, confirmedHermes: true, profile: 'coder' });
  assert.match(plan.error, /busy/);
  assert.equal(fs.existsSync(record), false);
});

test('invalid hermes answers are rejected with a readable error', async () => {
  const bad = [
    ['no json at all', /did not answer with JSON/],
    [JSON.stringify({ ops: [{ op: 'remove', id: 'nope' }] }), /Change 1 .*does not exist/],
    [JSON.stringify({ ops: [{ op: 'explode' }] }), /not a known world operation/],
    [JSON.stringify({ ops: [{ op: 'rename', id: 'terminal', label: 'see /home/harry/.ssh/id_rsa' }] }), /file path, password or key/],
    [JSON.stringify({ ops: [{ op: 'add', entity: { id: 'w', kind: 'web-wall', width: 2, height: 1, elevation: 1, home: 'https://x.dev/?token=abc', transform: { x: 0, z: 0, rotation: 0 } } }] }), /file path, password or key/],
  ];
  for (const [answer, re] of bad) {
    const { backend } = setup(answer);
    const plan = await backend.plan({ world: world(), prompt: 'do it', useHermes: true, confirmedHermes: true, profile: 'coder' });
    assert.equal(plan.proposal, null, answer);
    assert.match(plan.error, re, answer);
  }
});

test('hard timeout kills hermes', async () => {
  const { backend } = setup(good, { sleep: 10000 });
  const started = Date.now();
  const plan = await backend.plan({ world: world(), prompt: 'add a desk', useHermes: true, confirmedHermes: true, profile: 'coder' });
  assert.match(plan.error, /did not answer within/);
  assert.ok(Date.now() - started < 8000);
});
