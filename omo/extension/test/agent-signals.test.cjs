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

// ---- part 2: backend real signals (hook, Hermes lease, process tree) ----
const { DatabaseSync } = require('node:sqlite');
const WS = 'aaaaaaaaaaaa', CLAUDE_TAB = 'bbbbbbbbbbbb', HERMES_TAB = 'cccccccccccc', CODEX_TAB = 'dddddddddddd';

function hermesFixture(root, { lease, activity }) {
  // A fixture state.db with the installed Hermes shape (never a real profile DB).
  const dir = path.join(root, 'hermes', 'profiles', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec('CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL)');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL NOT NULL, last_activity_description TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('old', `omo:${WS}:${HERMES_TAB}`, 1, null);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('new', `omo:${WS}:${HERMES_TAB} #2`, 2, activity ?? null);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('other', `omo:${WS}:${HERMES_TAB}x`, 3, null);
  if (lease) db.prepare('INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)').run(lease, 'pid=1', Date.now() / 1000 - 1, Date.now() / 1000 + 60);
  db.close();
  return path.join(dir, 'state.db');
}

test('readSignals: Claude hook events for the tab session, Hermes lease (read-only), process tree', async () => {
  const procs = [];
  const { root, backend } = fixture({ request: async (op, args) => {
    procs.push([op, args]);
    return { at: 1000, tabs: [{ tabId: CODEX_TAB, paneAlive: true, agentAlive: false }, { tabId: CLAUDE_TAB, paneAlive: true, agentAlive: true }] };
  } });
  const plan = await backend.claudeStatus();
  fs.mkdirSync(path.dirname(plan.eventsFile), { recursive: true });
  const sid = signals.claudeSessionId(WS, CLAUDE_TAB);
  fs.writeFileSync(plan.eventsFile, [
    { event: 'UserPromptSubmit', sessionId: sid, at: 10 },
    { event: 'PermissionRequest', sessionId: sid, at: 20 },
    { event: 'Stop', sessionId: 'someone-else', at: 30 },
    'not json',
  ].map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') + '\n');
  const db = hermesFixture(root, { lease: 'new', activity: 'waiting for user approval' });
  const before = fs.readFileSync(db);
  const out = await backend.readSignals({ tabs: [
    { workspaceId: WS, tabId: CLAUDE_TAB, kind: 'claude' },
    { workspaceId: WS, tabId: HERMES_TAB, kind: 'hermes', profile: 'fixture' },
    { workspaceId: WS, tabId: CODEX_TAB, kind: 'codex' },
    { workspaceId: '../etc', tabId: CODEX_TAB, kind: 'codex' },
  ] });
  const by = Object.fromEntries(out.map(r => [r.tabId, r.readings]));
  assert.equal(out.length, 3, 'invalid ids are dropped');
  assert.deepEqual(by[CLAUDE_TAB].map(r => [r.source, r.status]), [['hook', 'waiting-approval']]);
  assert.deepEqual(by[HERMES_TAB].map(r => [r.source, r.status]), [['lease', 'waiting-approval']]);
  assert.deepEqual(by[CODEX_TAB].map(r => [r.source, r.status]), [['process', 'exited']]);
  assert.deepEqual(procs[0], ['agent_procs', { workspaceId: WS, tabIds: [CLAUDE_TAB, HERMES_TAB, CODEX_TAB] }]);
  assert.deepEqual(fs.readFileSync(db), before, 'the Hermes database is not changed');
});

test('readSignals: no lease means Hermes is idle; a lease on another conversation does not count', async () => {
  const { root, backend } = fixture();
  hermesFixture(root, { lease: 'unrelated' });
  const out = await backend.readSignals({ tabs: [{ workspaceId: WS, tabId: HERMES_TAB, kind: 'hermes', profile: 'fixture' }] });
  assert.deepEqual(out[0].readings.map(r => [r.source, r.status]), [['lease', 'idle']]);
});

// ---- notifications hub: real signals decide; the screen hint stays the fallback ----
function loadTs(rel) {
  const prev = Module._extensions['.ts'], prevX = Module._extensions['.tsx'];
  const loader = (module, filename) => module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React, esModuleInterop: true }, fileName: filename }).outputText, filename);
  Module._extensions['.ts'] = loader; Module._extensions['.tsx'] = loader;
  try { return require(path.resolve(__dirname, '..', 'src', rel)); } finally { Module._extensions['.ts'] = prev; if (prevX) Module._extensions['.tsx'] = prevX; else delete Module._extensions['.tsx']; }
}

test('notifications hub: hook approval and finish come from real signals, screen text is fallback', () => {
  const { NotificationsHub, realAgentStatus } = loadTs('browser/notifications-hub.ts');
  let now = 100000; let readings = []; let lines = [];
  const tab = { id: CLAUDE_TAB, name: 'Claude Code', kind: 'claude', state: 'running', busy: true };
  const desk = () => ({ workspace: { id: WS, tabs: [tab] }, activeTabId: CLAUDE_TAB, phase: 'live', lines, unreadBells: 0 });
  const agent = { key: `terminal:${CLAUDE_TAB}`, desk: 'terminal', kind: 'claude', tabName: 'Claude Code', label: 'Claude', activity: 'background' };
  const seen = [];
  const hub = new NotificationsHub({ desk, agents: () => [agent], watching: () => undefined, now: () => now, signals: () => readings }, n => seen.push(n));
  hub.tick(); hub.tick();
  readings = [{ status: 'working', source: 'hook', at: now }]; now += 1000; hub.tick();
  readings = [{ status: 'waiting-approval', source: 'hook', at: now }]; now += 1000; hub.tick();
  assert.equal(seen.at(-1).kind, 'approval');
  assert.match(seen.at(-1).text, /reported by the agent/);
  readings = [{ status: 'working', source: 'hook', at: now }]; now += 1000; hub.tick();
  now += 5000; readings = [{ status: 'idle', source: 'hook', at: now }]; hub.tick();
  assert.equal(seen.at(-1).kind, 'finished');
  readings = [{ status: 'idle', source: 'hook', at: now }, { status: 'exited', source: 'process', at: now }]; now += 1000; hub.tick();
  assert.equal(seen.at(-1).kind, 'ended');
  // No real signal: the old screen-text hint still works.
  readings = []; lines = ['Do you want to proceed?']; now += 1000; hub.tick(); hub.tick();
  readings = []; lines = []; hub.tick(); lines = ['Allow this command? (y/n)']; now += 1000; hub.tick();
  assert.equal(seen.at(-1).kind, 'approval');
  assert.match(seen.at(-1).text, /check the screen/);
  // Merge rules.
  assert.equal(realAgentStatus([], true, now), undefined);
  assert.equal(realAgentStatus([{ status: 'idle', source: 'hook', at: now }], true, now).status, 'idle', 'a hook outranks the screen text');
  assert.equal(realAgentStatus([{ status: 'idle', source: 'hook', at: now - 11 * 60 * 1000 }], false, now), undefined, 'stale readings are ignored');
});

// ---- part 3: dsh in the browser ----
test('dsh: launcher listed only when the host reports it, start asks first, web wall URL is loopback', async () => {
  const { dshWebUrl } = loadTs('browser/dsh-web.ts');
  const tab = { kind: 'dsh', webUrl: 'http://127.0.0.1:41234/', state: 'running' };
  assert.equal(dshWebUrl(tab, ['booting']), 'http://127.0.0.1:41234/');
  assert.equal(dshWebUrl(tab, ['dsh web: http://127.0.0.1:41234/?token=abc', 'later']), 'http://127.0.0.1:41234/?token=abc');
  assert.equal(dshWebUrl(tab, ['dsh web: http://127.0.0.1:9999/?token=abc']), 'http://127.0.0.1:41234/', 'another port is ignored');
  assert.equal(dshWebUrl({ kind: 'dsh', webUrl: 'http://example.com:41234/' }), undefined, 'only loopback');
  assert.equal(dshWebUrl({ kind: 'claude', webUrl: 'http://127.0.0.1:41234/' }), undefined);
  const { launcherOptions, AGENT_KINDS, DSH_START_NOTE } = loadTs('browser/runtime-console-controller.ts');
  assert.ok(AGENT_KINDS.includes('dsh'));
  const base = { available: true, tmux: true, python: true, detail: '', profiles: ['default'], agents: [{ kind: 'shell', available: true, detail: 'bash' }] };
  assert.equal(launcherOptions(base).find(o => o.kind === 'dsh'), undefined, 'not installed: not offered at all');
  const old = launcherOptions({ ...base, agents: [...base.agents, { kind: 'dsh', available: false, detail: 'dsh needs Node 24.9.0 or newer. The node on PATH is 22.23.4.' }] }).find(o => o.kind === 'dsh');
  assert.equal(old.available, false);
  assert.match(old.reason, /Node 24\.9\.0/);
  assert.match(DSH_START_NOTE, /loopback/);
});

// ---- part 4: Real agent check ----
test('Real agent check: explicit Run, confirm, one tab per installed agent, sends nothing, saves JSON', async () => {
  const { AgentCheckController, installedCheckKinds } = loadTs('browser/agent-check.ts');
  const { backend, dataDir } = fixture({ request: async (op, args) => ({ at: 5, tabs: args.tabIds.map(tabId => ({ tabId, paneAlive: true, agentAlive: true })) }) });
  const calls = [];
  let tabs = [{ id: 'eeeeeeeeeeee', name: 'Shell', kind: 'shell', state: 'running', busy: false }];
  let n = 0;
  const forbidden = name => async () => { calls.push(name); throw new Error(`${name} must never be called`); };
  const runtime = {
    status: async () => ({ available: true, tmux: true, python: true, detail: '', profiles: ['fixture'], agents: [
      { kind: 'shell', available: true, detail: '' }, { kind: 'hermes', available: true, detail: '' },
      { kind: 'claude', available: true, detail: '' }, { kind: 'codex', available: false, detail: 'not installed' }] }),
    newTab: async args => { calls.push(['newTab', args]); const id = String(++n).repeat(12); tabs = [...tabs, { id, name: args.name, kind: args.kind, state: 'running', busy: true, ...(args.kind === 'hermes' ? { profile: args.profile } : {}) }]; return { id: WS, name: 'Room', projectUri: 'file:///p', profile: 'fixture', state: 'running', tabs }; },
    getWorkspace: async () => ({ id: WS, name: 'Room', projectUri: 'file:///p', profile: 'fixture', state: 'running', tabs }),
    input: forbidden('input'), paste: forbidden('paste'), resumeAgent: forbidden('resumeAgent'), closeTab: forbidden('closeTab'),
  };
  let now = 1000;
  const states = [];
  const ctl = new AgentCheckController({ runtime, signals: backend, workspace: () => ({ id: WS, name: 'Room', projectUri: 'file:///p', tabs }), profile: () => 'fixture',
    now: () => now, sleep: async ms => { now += ms; }, onChange: s => states.push(s.phase), observeMs: 9000, pollMs: 3000 });
  assert.deepEqual(installedCheckKinds(await runtime.status()), ['hermes', 'claude']);
  await ctl.confirmRun();
  assert.equal(calls.length, 0, 'confirm without Run does nothing');
  await ctl.requestRun();
  assert.equal(ctl.state.phase, 'confirm');
  assert.equal(calls.length, 0, 'Run only asks; it starts nothing');
  ctl.cancel();
  assert.equal(ctl.state.phase, 'idle');
  assert.equal(calls.length, 0);
  await ctl.requestRun();
  await ctl.confirmRun();
  assert.equal(ctl.state.phase, 'done', ctl.state.message);
  const started = calls.filter(c => Array.isArray(c) && c[0] === 'newTab').map(c => c[1]);
  assert.deepEqual(started.map(a => [a.kind, a.confirmedStart]), [['hermes', true], ['claude', true]]);
  assert.equal(started[0].profile, 'fixture');
  assert.ok(!calls.some(c => typeof c === 'string'), 'no input, paste, resume or close');
  assert.ok(ctl.state.file.startsWith(path.join(dataDir, 'agent-checks') + path.sep));
  const report = JSON.parse(fs.readFileSync(ctl.state.file, 'utf8'));
  assert.equal(report.sentNothing, true);
  assert.deepEqual(report.observations.map(o => [o.kind, o.started]), [['hermes', true], ['claude', true]]);
  assert.ok(report.observations.every(o => o.states.length >= 1 && o.states[0].tabState === 'running'));
  assert.equal(fs.statSync(ctl.state.file).mode & 0o777, 0o600);
  await assert.rejects(backend.recordAgentCheck({ report: { ...report, sentNothing: false } }), /not valid/);
});

test('panels render: Agents panel shows Claude status and the Real agent check Run button', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { AgentsPanel } = loadTs('browser/agents-panel.tsx');
  const html = renderToStaticMarkup(React.createElement(AgentsPanel, { signals: { claudeStatus: () => new Promise(() => {}) }, runtime: {},
    desk: { profile: 'default', workspace: { id: WS, name: 'Room', tabs: [] } }, onOpenWeb: () => {}, onClose: () => {} }));
  assert.match(html, /data-testid="claude-status"/);
  assert.match(html, /data-testid="agent-check-run"/);
  assert.match(html, /types nothing into them/);
});
