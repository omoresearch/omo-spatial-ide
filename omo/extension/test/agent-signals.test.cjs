// w2:agents: Claude status opt-in (confirmed write inside the Omo data dir only), signals, check reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const signals = require('../src/node/agent-signals.ts');
Module._extensions['.ts'] = originalTsLoader;

const RUNTIME = path.resolve(__dirname, '..', '..', 'runtime');
const roots = [];
function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-agent-signals-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  const host = { locations: { dataDir, python: '/usr/bin/python3', hostScript: path.join(RUNTIME, 'omo_spatial_host.py') },
    hermesLeaseEnvironment: { HOME: root, OMO_SPATIAL_HERMES_ROOT: path.join(root, 'hermes') },
    request: async () => { throw new Error('no host in this test'); }, ...extra };
  return { root, dataDir, host, backend: new signals.AgentSignalsBackend(host) };
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test('claude session ids match the bridge uuid5', () => {
  // python3 -c "import uuid;print(uuid.uuid5(uuid.NAMESPACE_URL,'omo:abc:def'))"
  assert.equal(signals.claudeSessionId('abc', 'def'), '186b0636-fd16-51df-a2bd-d67a4f5968ca');
});

test('Claude status: shows exact JSON + target, writes only after confirmation, never outside the data dir', async () => {
  const { dataDir, backend } = fixture();
  const plan = await backend.claudeStatus();
  assert.equal(plan.enabled, false);
  assert.equal(plan.settingsFile, path.join(dataDir, 'claude-status', 'settings.json'));
  assert.ok(plan.settingsFile.startsWith(dataDir + path.sep));
  const config = JSON.parse(plan.json);
  for (const event of ['PermissionRequest', 'Notification', 'Stop', 'SessionEnd', 'UserPromptSubmit']) {
    const hook = config.hooks[event][0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.async, true);
    assert.match(hook.command, /claude_status_hook\.py' '.*events\.jsonl'$/);
  }
  await assert.rejects(backend.enableClaudeStatus({ confirmedWrite: false, json: plan.json }), /confirmation/);
  await assert.rejects(backend.enableClaudeStatus({ confirmedWrite: true, json: plan.json + ' ' }), /changed since you saw it/);
  assert.equal(fs.existsSync(plan.settingsFile), false);
  const on = await backend.enableClaudeStatus({ confirmedWrite: true, json: plan.json });
  assert.equal(on.enabled, true);
  assert.equal(fs.readFileSync(plan.settingsFile, 'utf8'), plan.json);
  assert.equal(fs.statSync(plan.settingsFile).mode & 0o777, 0o600);
  await assert.rejects(backend.disableClaudeStatus({ confirmedRemove: false }), /confirmation/);
  const off = await backend.disableClaudeStatus({ confirmedRemove: true });
  assert.equal(off.enabled, false);
  assert.equal(fs.existsSync(plan.settingsFile), false);
});

test('Claude status: a foreign file is never overwritten or removed', async () => {
  const { backend } = fixture();
  const plan = await backend.claudeStatus();
  fs.mkdirSync(path.dirname(plan.settingsFile), { recursive: true });
  fs.writeFileSync(plan.settingsFile, '{"mine":true}');
  const again = await backend.claudeStatus();
  assert.equal(again.foreign, true);
  await assert.rejects(backend.enableClaudeStatus({ confirmedWrite: true, json: plan.json }), /different file/);
  await assert.rejects(backend.disableClaudeStatus({ confirmedRemove: true }), /left it alone/);
  assert.equal(fs.readFileSync(plan.settingsFile, 'utf8'), '{"mine":true}');
});

test('the recorder written into the hook command records a real hook payload', async () => {
  const { backend } = fixture();
  const plan = await backend.claudeStatus();
  await backend.enableClaudeStatus({ confirmedWrite: true, json: plan.json });
  const command = JSON.parse(plan.json).hooks.Stop[0].hooks[0].command.replace("'/usr/bin/python3'", 'python3');
  require('node:child_process').execSync(command, { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'x' }), shell: '/bin/sh' });
  const line = JSON.parse(fs.readFileSync(plan.eventsFile, 'utf8').trim());
  assert.equal(line.event, 'Stop');
  assert.equal(line.sessionId, 'x');
});

module.exports = { fixture, signals };
