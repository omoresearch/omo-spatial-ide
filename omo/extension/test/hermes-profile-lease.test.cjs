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
const lease = require('../src/node/hermes-profile-lease.ts');
const { OmoRuntimeServiceImpl } = require('../src/node/omo-runtime-service.ts');
Module._extensions['.ts'] = originalTsLoader;

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-hermes-lease-'));
  roots.push(root);
  const profile = path.join(root, 'profiles', 'fixture');
  fs.mkdirSync(profile, { recursive: true });
  const dbPath = path.join(profile, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_turn_leases (conversation_id TEXT NOT NULL, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL)');
  db.close();
  return { root, profile, dbPath, env: { ...process.env, OMO_SPATIAL_HERMES_ROOT: root } };
}
function insert(dbPath, conversation, holder, expiresAt) {
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO session_turn_leases (conversation_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)').run(conversation, holder, Date.now() / 1000, expiresAt);
  db.close();
}
function clear(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('DELETE FROM session_turn_leases');
  db.close();
}

test.after(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('profile state paths respect the selected runtime home without reading the parent home', () => {
  assert.equal(lease.hermesProfileStateDb('default', {HOME:'/owned-runtime-home'}), path.join('/owned-runtime-home','.hermes','state.db'));
});
test('lease inspector follows Hermes state.db semantics and sees held then cleared leases', () => {
  const f = fixture();
  const now = Date.now() / 1000;
  assert.deepEqual(lease.inspectHermesProfileTurnLeases('fixture', f.env).leases, []);
  insert(f.dbPath, 'conversation', 'pid=fixture:turn=held', now + 60);
  const held = lease.inspectHermesProfileTurnLeases('fixture', f.env);
  assert.equal(held.leases.length, 1);
  assert.equal(held.leases[0].conversationId, 'conversation');
  assert.throws(() => lease.assertHermesProfileTurnLeaseFree('fixture', f.env), /refusing to start/);
  clear(f.dbPath);
  assert.deepEqual(lease.inspectHermesProfileTurnLeases('fixture', f.env).leases, []);
  lease.assertHermesProfileTurnLeaseFree('fixture', f.env);
});

test('expired rows do not block, but malformed configured lease evidence fails closed', () => {
  const f = fixture();
  insert(f.dbPath, 'expired', 'pid=fixture:turn=old', Date.now() / 1000 - 1);
  assert.deepEqual(lease.inspectHermesProfileTurnLeases('fixture', f.env).leases, []);
  const db = new DatabaseSync(f.dbPath);
  db.exec('DROP TABLE session_turn_leases');
  db.close();
  assert.throws(() => lease.inspectHermesProfileTurnLeases('fixture', f.env), /unavailable/);
});

test('malformed expired lease rows fail closed before expiry filtering in Node', () => {
  const f = fixture();
  insert(f.dbPath, 'expired-malformed', '', Date.now() / 1000 - 10);
  assert.throws(() => lease.assertHermesProfileTurnLeaseFree('fixture', f.env), /unavailable/);
});
test('malformed expired lease rows fail closed in the actual Python guard', () => {
  const f = fixture();
  insert(f.dbPath, 'expired-malformed', '', Date.now() / 1000 - 10);
  const script = `import ast,os,sys,sqlite3,time,math,re,types\np=sys.argv[1]\nt=ast.parse(open(p).read(),p)\nbody=[n for n in t.body if isinstance(n,ast.FunctionDef) and n.name in ('_hermes_state_db','_hermes_root','assert_hermes_turn_lease_free')]\nassert len(body)==3\nscope={'os':os,'sqlite3':sqlite3,'time':time,'math':math,'HostError':RuntimeError,'HERMES_ROOT_PIN':sys.argv[2],'ob':types.SimpleNamespace(PROFILE_RE=re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}'))}\nexec(compile(ast.Module(body=body,type_ignores=[]),p,'exec'),scope)\ntry:scope['assert_hermes_turn_lease_free']('fixture')\nexcept RuntimeError:print('REFUSED')\nelse:print('ACCEPTED')\n`;
  const result = require('node:child_process').spawnSync('python3', ['-c', script, path.resolve(__dirname, '../../runtime/omo_spatial_host.py'), f.root], {encoding:'utf8',timeout:5000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'REFUSED');
});
test('service checks the runtime hosts profile scope rather than ambient parent profile state', async () => {
  const selected = fixture(); const ambient = fixture();
  insert(ambient.dbPath, 'ambient-held', 'fixture-holder', Date.now() / 1000 + 60);
  const old = process.env.OMO_SPATIAL_HERMES_ROOT;
  process.env.OMO_SPATIAL_HERMES_ROOT = ambient.root;
  try {
    const host = new FakeHost({id:'ws',name:'Owned',profile:'fixture',state:'running',tabs:[]});
    host.hermesLeaseEnvironment = selected.env;
    const service = new OmoRuntimeServiceImpl(host);
    await service.newTab({workspaceId:'ws',kind:'hermes',confirmedStart:true});
    assert.equal(host.calls.filter(call=>call.op==='tab_new').length,1);
    insert(selected.dbPath, 'selected-held', 'fixture-holder', Date.now() / 1000 + 60);
    clear(ambient.dbPath);host.calls=[];
    await assert.rejects(service.newTab({workspaceId:'ws',kind:'hermes',confirmedStart:true}),/refusing to start/);
    assert.equal(host.calls.filter(call=>call.op==='tab_new').length,0);
  } finally {
    if(old===undefined) delete process.env.OMO_SPATIAL_HERMES_ROOT; else process.env.OMO_SPATIAL_HERMES_ROOT=old;
  }
});
class FakeHost {
  constructor(workspace) {
    this.locations = { dataDir: '/tmp/omo-runtime-test' };
    this.workspace = workspace;
    this.calls = [];
  }
  async request(op, args) {
    this.calls.push({ op, args });
    if (op === 'get') return this.workspace;
    if (op === 'tab_new') return this.workspace;
    if (op === 'tab_revive') return this.workspace;
    if (op === 'agent_resume') return { workspace: this.workspace, detail: 'fixture', fresh: false };
    throw new Error(`unexpected ${op}`);
  }
}

test('held lease denies new, revive and resume before any agent launch request', async () => {
  const f = fixture();
  insert(f.dbPath, 'conversation', 'pid=fixture:turn=held', Date.now() / 1000 + 60);
  const previousRoot = process.env.OMO_SPATIAL_HERMES_ROOT;
  process.env.OMO_SPATIAL_HERMES_ROOT = f.root;
  try {
    const workspace = {
      id: 'ws', name: 'Workspace', profile: 'fixture', projectUri: 'file:///project', state: 'running',
      tabs: [
        { id: 'hermes-tab', name: 'Hermes', kind: 'hermes', state: 'interrupted', busy: false },
        { id: 'hermes-live', name: 'Hermes live', kind: 'hermes', state: 'running', busy: false },
      ],
    };
    const host = new FakeHost(workspace);
    const service = new OmoRuntimeServiceImpl(host);
    const denied = /turn-lease state|refusing to start/;
    await assert.rejects(service.newTab({ workspaceId: 'ws', kind: 'hermes', confirmedStart: true }), denied);
    await assert.rejects(service.reviveTab({ workspaceId: 'ws', tabId: 'hermes-tab', confirmedStart: true }), denied);
    await assert.rejects(service.resumeAgent({ workspaceId: 'ws', tabId: 'hermes-live', confirmedStart: true }), denied);
    assert.deepEqual(host.calls.map(call => call.op), ['get', 'get', 'get']);
  } finally {
    if (previousRoot === undefined) delete process.env.OMO_SPATIAL_HERMES_ROOT;
    else process.env.OMO_SPATIAL_HERMES_ROOT = previousRoot;
  }
});

test('cleared lease permits the explicit launch request', async () => {
  const f = fixture();
  insert(f.dbPath, 'conversation', 'pid=fixture:turn=held', Date.now() / 1000 + 60);
  const previousRoot = process.env.OMO_SPATIAL_HERMES_ROOT;
  process.env.OMO_SPATIAL_HERMES_ROOT = f.root;
  try {
    const workspace = { id: 'ws', name: 'Workspace', profile: 'fixture', projectUri: 'file:///project', state: 'running', tabs: [] };
    const host = new FakeHost(workspace);
    const service = new OmoRuntimeServiceImpl(host);
    await assert.rejects(service.newTab({ workspaceId: 'ws', kind: 'hermes', confirmedStart: true }));
    clear(f.dbPath);
    await service.newTab({ workspaceId: 'ws', kind: 'hermes', confirmedStart: true });
    assert.equal(host.calls.at(-1).op, 'tab_new');
  } finally {
    if (previousRoot === undefined) delete process.env.OMO_SPATIAL_HERMES_ROOT;
    else process.env.OMO_SPATIAL_HERMES_ROOT = previousRoot;
  }
});

test('revive and resume preflight the tab captured profile, not the workspace default', async () => {
  // Same root, two profiles: workspace default "wsprof" is held, the tab's
  // captured "fixture" profile is free; then the reverse.
  const f = fixture();
  const wsDir = path.join(f.root, 'profiles', 'wsprof'); fs.mkdirSync(wsDir, { recursive: true });
  const wsDb = path.join(wsDir, 'state.db');
  const db = new DatabaseSync(wsDb);
  db.exec('CREATE TABLE session_turn_leases (conversation_id TEXT NOT NULL, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL)');
  db.close();
  insert(wsDb, 'ws-held', 'pid=other:turn=held', Date.now() / 1000 + 60);
  const previousRoot = process.env.OMO_SPATIAL_HERMES_ROOT;
  process.env.OMO_SPATIAL_HERMES_ROOT = f.root;
  try {
    const workspace = { id: 'ws', name: 'W', profile: 'wsprof', projectUri: 'file:///p', state: 'running', tabs: [
      { id: 'dead', name: 'H', kind: 'hermes', state: 'interrupted', busy: false, profile: 'fixture' },
      { id: 'live', name: 'H2', kind: 'hermes', state: 'running', busy: false, profile: 'fixture' },
    ] };
    const host = new FakeHost(workspace);
    const service = new OmoRuntimeServiceImpl(host);
    await service.reviveTab({ workspaceId: 'ws', tabId: 'dead', confirmedStart: true });
    await service.resumeAgent({ workspaceId: 'ws', tabId: 'live', confirmedStart: true });
    assert.deepEqual(host.calls.map(c => c.op), ['get', 'tab_revive', 'get', 'agent_resume']);
    clear(wsDb); insert(f.dbPath, 'tab-held', 'pid=other:turn=held', Date.now() / 1000 + 60); host.calls = [];
    await assert.rejects(service.reviveTab({ workspaceId: 'ws', tabId: 'dead', confirmedStart: true }), /refusing to start/);
    await assert.rejects(service.resumeAgent({ workspaceId: 'ws', tabId: 'live', confirmedStart: true }), /refusing to start/);
    assert.deepEqual(host.calls.map(c => c.op), ['get', 'get']);
  } finally {
    if (previousRoot === undefined) delete process.env.OMO_SPATIAL_HERMES_ROOT;
    else process.env.OMO_SPATIAL_HERMES_ROOT = previousRoot;
  }
});
