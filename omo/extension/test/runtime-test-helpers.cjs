// Shared fixtures for the runtime backend tests: a scratch HOME, data dir and tmux socket,
// fixture agent CLIs that only record how they were started (no real agent ever runs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LIB = path.resolve(__dirname, '../lib/node');

function lib(name) {
  const file = path.join(LIB, `${name}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing: run "npm run compile" first`);
  }
  return require(file);
}

function locateTmux() {
  const candidates = [process.env.OMO_SPATIAL_TEST_TMUX, ...String(process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'tmux')),
    path.join(os.homedir(), '.local', 'share', 'omo', 'bin', 'tmux')];
  return candidates.find(c => c && fs.existsSync(c) && (() => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch { return false; } })());
}

function locatePython() {
  return ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'].find(p => fs.existsSync(p));
}

// Resolved once, before any test rewrites process.env.
const TMUX = locateTmux();
const PYTHON = locatePython();
function findTmux() { return TMUX; }
function findPython() { return PYTHON; }

const FIXTURE = `#!/bin/sh
# Fixture agent: records argv and cwd, then waits. Never calls a model.
log="$FIXTURE_AGENT_LOG"
printf '%s\\t%s\\t%s\\n' "$(basename "$0")" "$(pwd)" "$*" >> "$log"
echo "FIXTURE-$(basename "$0")-STARTED"
while read -r line; do echo "fixture got: $line"; done
`;

function scratch(label = 'rt') {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `omo-${label}-`));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const data = path.join(root, 'data');
  const hermesRoot = path.join(root, 'hermes');
  const project = path.join(root, "my project's dir");
  for (const d of [home, bin, data, project, path.join(hermesRoot, 'profiles', 'alpha'), path.join(hermesRoot, 'profiles', 'bad name')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(hermesRoot, 'profiles', 'alpha', 'config.yaml'), 'secret: never-read\n');
  const log = path.join(root, 'agents.log');
  fs.writeFileSync(log, '');
  for (const name of ['hermes', 'claude']) {
    fs.writeFileSync(path.join(bin, name), FIXTURE, { mode: 0o755 });
  }
  const socket = `omo-spatial-test-${process.pid}-${label}`;
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: 'C.UTF-8', TMPDIR: process.env.TMPDIR || os.tmpdir(),
    OMO_SPATIAL_DATA: data, OMO_SPATIAL_TMUX_SOCKET: socket, OMO_SPATIAL_TMUX: findTmux(), OMO_SPATIAL_PYTHON: findPython(),
    OMO_SPATIAL_HERMES_ROOT: hermesRoot, FIXTURE_AGENT_LOG: log,
    // Inherited parent routing that must never reach the runtime or its shells.
    HERMES_SESSION_ID: 'parent-session-must-not-leak', HERMES_HOME: '/parent/hermes', OMO_TMUX_SOCKET: 'omo', OMO_DATA: '/parent/omo-data',
    TMUX: '/tmp/parent-tmux,1,0'
  };
  return { root, home, bin, data, project, projectUri: require('node:url').pathToFileURL(project).href, log, socket, env, hermesRoot };
}

function killScratchServer(s) {
  if (s.env.OMO_SPATIAL_TMUX) {
    cp.spawnSync(s.env.OMO_SPATIAL_TMUX, ['-L', s.socket, 'kill-server'], { env: { PATH: '/usr/bin:/bin' } });
  }
}

function tmux(s, ...args) {
  return cp.spawnSync(s.env.OMO_SPATIAL_TMUX, ['-L', s.socket, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: s.home } });
}

function makeService(s, extraEnv = {}) {
  const { discoverRuntime } = lib('runtime-discovery');
  const { RuntimeHost } = lib('runtime-host');
  const { OmoRuntimeServiceImpl } = lib('omo-runtime-service');
  const env = { ...s.env, ...extraEnv };
  const host = new RuntimeHost(discoverRuntime(env, s.home), env);
  return { host, service: new OmoRuntimeServiceImpl(host) };
}

/** Poll a view until `predicate(screenText)` holds; returns the last poll. */
async function pollUntil(service, viewId, predicate, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let seq = 0;
  let text = '';
  let last;
  let frame;
  while (Date.now() < end) {
    last = await service.poll({ viewId, afterSequence: seq });
    if (last.frame) {
      frame = last.frame;
      seq = frame.sequence;
      text = frame.lines.join('\n');
    }
    if (last.state !== 'live' || predicate(text)) {
      return { ...last, frame, text };
    }
  }
  return { ...last, frame, text, timedOut: true };
}

function agentLog(s) {
  return fs.readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
}

module.exports = { lib, scratch, makeService, pollUntil, agentLog, killScratchServer, tmux, findTmux, findPython };
