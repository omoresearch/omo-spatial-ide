// Real-process tests for two runtime host defects found by foundation QA:
//  A. two host processes on one data directory erased each other's workspaces and
//     station bindings (each rewrites the whole metadata file from its own memory);
//  B. a custom OMO_HERMES_ROOT validated the profile, but the launched Hermes CLI was
//     never told that root, so `hermes -p <name>` resolved under ~/.hermes instead.
// Drives runtime/omo_spatial_host.py directly over its stdio protocol, in the same
// shape runtime-host.ts spawns it. Scratch HOME/data/Hermes root, private tmux sockets,
// and a fixture `hermes` that only records argv and environment: no agent or model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const readline = require('node:readline');
const h = require('./runtime-test-helpers.cjs');

const HOST_SCRIPT = path.resolve(__dirname, '../../runtime/omo_spatial_host.py');
const TMUX = h.findTmux();
const PYTHON = h.findPython();
const skip = TMUX && PYTHON ? false : 'tmux or python3 not available on this machine';

const FIXTURE_HERMES = `#!/bin/sh
# Fixture Hermes: records how it was started, then waits. Never calls a model.
printf 'argv=%s\\tHERMES_HOME=%s\\tHOME=%s\\n' "$*" "\${HERMES_HOME-<unset>}" "$HOME" >> "$FIXTURE_AGENT_LOG"
echo FIXTURE-HERMES-STARTED
while read -r line; do :; done
`;

const sockets = [];
const roots = [];

function scratch(label) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `omo-lock-${label}-`));
  roots.push(root);
  const s = { root, log: path.join(root, 'agents.log') };
  for (const k of ['home', 'bin', 'data', 'hermes', 'proj1', 'proj2']) {
    s[k] = path.join(root, k);
    fs.mkdirSync(s[k]);
  }
  fs.mkdirSync(path.join(s.hermes, 'profiles', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(s.hermes, 'profiles', 'alpha', 'config.yaml'), 'fixture: true\n');
  fs.writeFileSync(path.join(s.bin, 'hermes'), FIXTURE_HERMES, { mode: 0o755 });
  fs.writeFileSync(s.log, '');
  return s;
}

/** One host process, spawned as runtime-host.ts does: python -I -B -u <script>, cwd = data dir. */
function startHost(s, label, dataDir = s.data) {
  const sock = `omo-spatial-test-${process.pid}-${label}`;
  sockets.push(sock);
  const env = {
    HOME: s.home, PATH: `${s.bin}:/usr/bin:/bin`, LANG: 'C.UTF-8', TMPDIR: process.env.TMPDIR || os.tmpdir(),
    OMO_DATA: dataDir, OMO_TMUX_SOCKET: sock, OMO_TMUX: TMUX, OMO_SLEEP_AFTER: '0',
    OMO_HERMES_BIN: path.join(s.bin, 'hermes'), OMO_HERMES_ROOT: s.hermes, FIXTURE_AGENT_LOG: s.log
  };
  const child = cp.spawn(PYTHON, ['-I', '-B', '-u', HOST_SCRIPT], { env, cwd: dataDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const host = { child, sock, stderr: '', pending: new Map(), n: 0 };
  child.stderr.on('data', c => { host.stderr += c.toString('utf8'); });
  host.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  host.ready = new Promise(resolve => {
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 0) { resolve('ready'); return; }
      const p = host.pending.get(msg.id);
      if (p) {
        host.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
      }
    });
    host.exited.then(() => resolve('exited'));
  });
  host.call = (op, args = {}) => new Promise((resolve, reject) => {
    const id = ++host.n;
    host.pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
  });
  host.shutdown = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.write(JSON.stringify({ id: -1, op: 'shutdown' }) + '\n');
    }
    return host.exited;
  };
  return host;
}

function tmux(sock, ...args) {
  return cp.spawnSync(TMUX, ['-L', sock, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
}

function open(host, s, station, proj, extra = {}) {
  return host.call('open', { stationId: station, projectUri: 'file://' + s[proj], projectDir: s[proj], name: station, ...extra });
}

async function waitForLog(s, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const line = fs.readFileSync(s.log, 'utf8').trim();
    if (line) {
      return line;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return '';
}

function field(line, name) {
  const m = line.match(new RegExp(`(?:^|\\t)${name}=([^\\t]*)`));
  return m ? m[1] : undefined;
}

test.after(() => {
  for (const sock of sockets) {
    tmux(sock, 'kill-server');
  }
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second host on the same data directory refuses to start and leaves the first host\'s records intact', { skip }, async () => {
  const s = scratch('dup');
  const a = startHost(s, 'dupA');
  try {
    assert.equal(await a.ready, 'ready');
    const wa = await open(a, s, 'desk-a', 'proj1');
    const metaBefore = fs.readFileSync(path.join(s.data, 'workspaces.json'), 'utf8');
    const stationsBefore = fs.readFileSync(path.join(s.data, 'spatial-stations.json'), 'utf8');

    const alias = path.join(s.root, 'data-alias');
    fs.symlinkSync(s.data, alias);
    for (const [label, dir] of [['dupB', s.data], ['dupC', alias]]) {
      const b = startHost(s, label, dir);
      const outcome = await Promise.race([b.ready, new Promise(r => setTimeout(() => r('timeout'), 10000))]);
      if (outcome === 'ready') {
        await open(b, s, 'desk-b', 'proj2').catch(() => undefined);
        await b.shutdown();
      }
      assert.equal(outcome, 'exited', `second host (${label}, OMO_DATA=${dir}) must not start while the first one runs`);
      const { code } = await b.exited;
      assert.notEqual(code, 0, 'the refusal is a non-zero exit');
      assert.match(b.stderr, /another Omo spatial runtime host .*is using this data directory/);
      assert.equal(tmux(b.sock, 'has-session').status !== 0, true, 'the refused host started no tmux server');
    }

    assert.equal(fs.readFileSync(path.join(s.data, 'workspaces.json'), 'utf8'), metaBefore, 'workspaces.json is untouched');
    assert.equal(fs.readFileSync(path.join(s.data, 'spatial-stations.json'), 'utf8'), stationsBefore, 'station bindings are untouched');
    const list = await a.call('ws_list');
    assert.deepEqual(list.map(w => w.id), [wa.id], 'the first host still serves its workspace');
    assert.deepEqual(list[0].stations, ['desk-a']);
  } finally {
    await a.shutdown();
  }
});

test('the data-directory lock is released when the host exits, even though its tmux server keeps running', { skip }, async () => {
  const s = scratch('rel');
  const a = startHost(s, 'relA');
  assert.equal(await a.ready, 'ready');
  const wa = await open(a, s, 'desk-a', 'proj1');
  assert.equal((await a.shutdown()).code, 0);
  assert.equal(tmux(a.sock, 'has-session').status, 0, 'the tmux server outlives the host');

  // Same socket as the host that just stopped: the normal supervisor restart.
  const b = startHost(s, 'relA');
  assert.equal(await b.ready, 'ready', `a restarted host starts after a clean exit: ${b.stderr}`);
  const wb = await open(b, s, 'desk-a', 'proj1');
  assert.equal(wb.id, wa.id, 'the restarted host reuses the saved workspace');

  b.child.kill('SIGKILL');                         // a crash still frees the lock
  await b.exited;
  const c = startHost(s, 'relA');
  try {
    assert.equal(await c.ready, 'ready', `a host starts after the previous one was killed: ${c.stderr}`);
    const list = await c.call('ws_list');
    assert.deepEqual(list.map(w => w.id), [wa.id]);
  } finally {
    await c.shutdown();
  }
});

test('a Hermes tab under a custom Hermes root launches Hermes pinned to that root', { skip }, async () => {
  const s = scratch('root');
  const a = startHost(s, 'root');
  try {
    assert.equal(await a.ready, 'ready');
    const ws = await open(a, s, 'desk', 'proj1', { profile: 'alpha' });
    assert.equal(ws.profile, 'alpha', 'the profile was validated against the custom root');
    await a.call('tab_new', { workspaceId: ws.id, kind: 'hermes', confirmedStart: true });
    const line = await waitForLog(s);
    assert.ok(line, 'the fixture Hermes was launched');
    assert.match(field(line, 'argv'), new RegExp(`^-p alpha chat --tui -c omo:${ws.id}:[0-9a-f]{12} --create-if-missing$`));
    assert.equal(field(line, 'HOME'), s.home);
    assert.equal(field(line, 'HERMES_HOME'), s.hermes, 'the launched Hermes is told the custom root');
  } finally {
    await a.shutdown();
  }
});

// The real Hermes profile resolver (no agent, no model): given the environment the fixture
// recorded, `-p alpha` must resolve to the custom root's profile, not to ~/.hermes.
const HERMES_SRC = process.env.OMO_SPATIAL_TEST_HERMES_SRC || path.join(os.homedir(), '.hermes', 'hermes-agent');
const HERMES_PY = [path.join(HERMES_SRC, 'venv', 'bin', 'python3'), path.join(HERMES_SRC, '.venv', 'bin', 'python3')].find(p => fs.existsSync(p));
const realSkip = skip || (fs.existsSync(path.join(HERMES_SRC, 'hermes_cli', 'profiles.py')) && HERMES_PY ? false : 'Hermes source not found');

function realResolve(home, hermesHome) {
  const code = 'import sys; sys.path.insert(0, sys.argv[1])\n'
    + 'from hermes_cli.profiles import resolve_profile_env\n'
    + 'try:\n    print("RESOLVED", resolve_profile_env("alpha"))\n'
    + 'except FileNotFoundError as exc:\n    print("MISSING", exc)\n';
  const env = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  if (hermesHome !== undefined) {
    env.HERMES_HOME = hermesHome;
  }
  return cp.spawnSync(HERMES_PY, ['-I', '-B', '-c', code, HERMES_SRC], { encoding: 'utf8', env, cwd: home }).stdout.trim();
}

test('real Hermes profile selection: the recorded launch environment resolves the custom-root profile', { skip: realSkip }, async () => {
  const s = scratch('real');
  const a = startHost(s, 'real');
  try {
    assert.equal(await a.ready, 'ready');
    const ws = await open(a, s, 'desk', 'proj1', { profile: 'alpha' });
    await a.call('tab_new', { workspaceId: ws.id, kind: 'hermes', confirmedStart: true });
    const line = await waitForLog(s);
    const hh = field(line, 'HERMES_HOME');
    assert.equal(realResolve(s.home, undefined), "MISSING Profile 'alpha' does not exist. Create it with: hermes profile create alpha",
      'control: without the root pin, real Hermes looks under $HOME/.hermes and finds nothing');
    assert.equal(realResolve(field(line, 'HOME'), hh === '<unset>' ? undefined : hh),
      `RESOLVED ${path.join(s.hermes, 'profiles', 'alpha')}`);
  } finally {
    await a.shutdown();
  }
});
