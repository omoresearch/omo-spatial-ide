// Unit and wiring tests for the runtime backend: discovery isolation, missing-dependency honesty,
// argument validation, the Theia JSON-RPC binding, and a seeded no-op-input fault.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./runtime-test-helpers.cjs');

const cleanup = [];
after(async () => {
  for (const fn of cleanup.reverse()) {
    await fn();
  }
});

test('discovery uses its own data dir and socket and refuses the Minecraft ones', () => {
  const { discoverRuntime, DEFAULT_SOCKET } = h.lib('runtime-discovery');
  const home = '/nonexistent-home';
  const loc = discoverRuntime({ PATH: '' }, home);
  assert.equal(loc.dataDir, path.join(home, '.local', 'share', 'omo-spatial-ide'));
  assert.equal(loc.tmuxSocket, DEFAULT_SOCKET);
  assert.notEqual(loc.tmuxSocket, 'omo');
  assert.throws(() => discoverRuntime({ OMO_SPATIAL_TMUX_SOCKET: 'omo' }, home), /not allowed/);
  assert.throws(() => discoverRuntime({ OMO_SPATIAL_TMUX_SOCKET: 'default' }, home), /not allowed/);
  assert.throws(() => discoverRuntime({ OMO_SPATIAL_TMUX_SOCKET: '../x' }, home), /not allowed/);
  assert.throws(() => discoverRuntime({ OMO_SPATIAL_DATA: path.join(home, '.local', 'share', 'omo') }, home), /Minecraft/);
  // The bridge's own variables are ignored: they belong to the Minecraft bridge.
  const inherited = discoverRuntime({ OMO_DATA: '/x/omo', OMO_TMUX_SOCKET: 'omo', PATH: '' }, home);
  assert.equal(inherited.tmuxSocket, DEFAULT_SOCKET);
  assert.equal(inherited.dataDir, path.join(home, '.local', 'share', 'omo-spatial-ide'));
});

test('discovery finds tmux on PATH, then the generic per-user Omo install, and a pinned wrong path reads as missing', () => {
  const { discoverRuntime } = h.lib('runtime-discovery');
  const s = h.scratch('disc');
  const legacyBin = path.join(s.home, '.local', 'share', 'omo', 'bin');
  fs.mkdirSync(legacyBin, { recursive: true });
  fs.writeFileSync(path.join(legacyBin, 'tmux'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(discoverRuntime({ PATH: '' }, s.home).tmux, path.join(legacyBin, 'tmux'));
  fs.writeFileSync(path.join(s.bin, 'tmux'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(discoverRuntime({ PATH: s.bin }, s.home).tmux, path.join(s.bin, 'tmux'));
  assert.equal(discoverRuntime({ PATH: s.bin, OMO_SPATIAL_TMUX: '/no/such/tmux' }, s.home).tmux, undefined);
});

test('the host script is found from compiled lib/node and from a bundled browser-app/lib/backend', () => {
  const { resolveHostScript } = h.lib('runtime-discovery');
  const omo = path.resolve(__dirname, '..', '..');
  const expected = path.join(omo, 'runtime', 'omo_spatial_host.py');
  assert.ok(fs.existsSync(expected));
  assert.equal(resolveHostScript({}, path.join(omo, 'extension', 'lib', 'node')), expected);
  const bundled = path.join(omo, 'browser-app', 'lib', 'backend');
  assert.equal(resolveHostScript({ THEIA_APP_PROJECT_PATH: path.join(omo, 'browser-app') }, bundled), expected);
  assert.equal(resolveHostScript({}, bundled), expected, 'falls back to the app directory two levels up');
  assert.equal(resolveHostScript({ OMO_SPATIAL_HOST_SCRIPT: '/x/host.py' }, bundled), '/x/host.py');
});

test('sanitizedEnv strips parent Hermes routing, Omo bridge settings and an enclosing tmux client', () => {
  const { sanitizedEnv } = h.lib('runtime-discovery');
  const out = sanitizedEnv({
    PATH: '/usr/bin', HOME: '/h', HERMES_SESSION_ID: 's', HERMES_HOME: '/hh', OMO_TMUX_SOCKET: 'omo', OMO_DATA: '/d',
    TMUX: '/tmp/t,1,0', TMUX_PANE: '%1', CLAUDECODE: '1', NODE_OPTIONS: '--inspect', LANG: 'C.UTF-8'
  });
  assert.deepEqual(out, { PATH: '/usr/bin', HOME: '/h', LANG: 'C.UTF-8' });
});

test('missing tmux gives an honest unavailable status with an install hint and starts nothing', async () => {
  const s = h.scratch('notmux');
  const { service, host } = h.makeService(s, { OMO_SPATIAL_TMUX: '/no/such/tmux' });
  const st = await service.status();
  assert.equal(st.available, false);
  assert.equal(st.tmux, false);
  assert.match(st.detail, /tmux was not found/);
  assert.ok(st.agents.length === 4 && st.agents.every(a => !a.available && /Install tmux/.test(a.installHint)));
  await assert.rejects(service.openWorkspace({ stationId: 'a', projectUri: s.projectUri, name: 'x' }), /tmux is not available/);
  assert.equal(host.pid, undefined, 'no host process was spawned');
  assert.deepEqual(fs.readdirSync(s.data), [], 'nothing written to the data dir');
});

test('RPC arguments are validated before reaching the host', async () => {
  const s = h.scratch('valid');
  const { service } = h.makeService(s, { OMO_SPATIAL_TMUX: '/no/such/tmux' });
  await assert.rejects(service.newTab({ workspaceId: 'abc', kind: 'rm -rf', confirmedStart: true }), /kind must be/);
  await assert.rejects(service.openWorkspace({ stationId: '', projectUri: s.projectUri, name: 'x' }), /stationId is required/);
  await assert.rejects(service.openWorkspace({ stationId: 'a', projectUri: 'file:///no/such/dir', name: 'x' }), /does not exist/);
  await assert.rejects(service.attach({ workspaceId: 'a', tabId: 'b', cols: 'x', rows: 1 }), /cols must be a number/);
  await assert.rejects(service.input({ viewId: 'v', data: 42 }), /data must be a string/);
});

test('the Theia backend module binds OmoRuntimeService on OMO_RUNTIME_PATH over JSON-RPC', { skip: !(h.findTmux() && h.findPython()) && 'tmux/python3 missing' }, async () => {
  const s = h.scratch('rpc');
  const saved = { ...process.env };
  cleanup.push(() => { for (const k of Object.keys(process.env)) { delete process.env[k]; } Object.assign(process.env, saved); });
  for (const [k, v] of Object.entries(s.env)) {
    process.env[k] = v;   // the module reads process.env, like the real backend
  }
  cleanup.push(() => h.killScratchServer(s));
  require('reflect-metadata');
  const { Container } = require('@theia/core/shared/inversify');
  const { ConnectionHandler, RpcProxyFactory } = require('@theia/core/lib/common/messaging');
  const { BackendApplicationContribution } = require('@theia/core/lib/node/backend-application');
  const { ForwardingChannel } = require('@theia/core/lib/common/message-rpc/channel');
  const { Uint8ArrayWriteBuffer, Uint8ArrayReadBuffer } = require('@theia/core/lib/common/message-rpc/uint8-array-message-buffer');
  const { OMO_RUNTIME_PATH } = require(path.resolve(__dirname, '../lib/common/runtime-protocol.js'));
  const container = new Container();
  container.load(h.lib('omo-backend-module').default);
  const handler = container.getAll(ConnectionHandler).find(c => c.path === OMO_RUNTIME_PATH);
  assert.ok(handler, 'a ConnectionHandler is bound on ' + OMO_RUNTIME_PATH);
  assert.equal(OMO_RUNTIME_PATH, '/services/omo-runtime');
  const lifecycle = container.getAll(BackendApplicationContribution);
  cleanup.push(() => lifecycle[0].host.stop());
  // An in-memory pipe between a "frontend" proxy and the backend handler: Theia's real RPC encoding.
  let left, right;
  const writer = target => () => {
    const b = new Uint8ArrayWriteBuffer();
    b.onCommit(buf => target().onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(buf)));
    return b;
  };
  left = new ForwardingChannel('front', () => right.onCloseEmitter.fire({ reason: 'closed' }), writer(() => right));
  right = new ForwardingChannel('back', () => left.onCloseEmitter.fire({ reason: 'closed' }), writer(() => left));
  handler.onConnection(right);
  const factory = new RpcProxyFactory();
  factory.listen(left);
  const proxy = factory.createProxy();
  const st = await proxy.status();
  assert.equal(st.available, true);
  const ws = await proxy.openWorkspace({ stationId: 'rpc-desk', projectUri: s.projectUri, name: 'RPC' });
  assert.equal(ws.tabs[0].kind, 'shell');
  const { viewId } = await proxy.attach({ workspaceId: ws.id, tabId: ws.tabs[0].id, cols: 100, rows: 20 });
  await proxy.input({ viewId, data: 'echo RPC-$((6*7))\r' });
  let text = '';
  for (let i = 0; i < 40 && !text.includes('RPC-42'); i++) {
    const p = await proxy.poll({ viewId, afterSequence: 0 });
    text = p.frame ? p.frame.lines.join('\n') : text;
  }
  assert.ok(text.includes('RPC-42'), 'typed input round-tripped through Theia RPC');
  const serialized = JSON.stringify([st, ws]);
  const token = fs.readFileSync(path.join(s.data, 'token'), 'utf8').trim();
  assert.ok(!serialized.includes(token), 'bridge token never crosses RPC');
  await assert.rejects(proxy.newTab({ workspaceId: ws.id, kind: 'claude', confirmedStart: false }), /confirmed start/);
  // Closing the frontend connection detaches its views only; the shell keeps running.
  left.close();
  await new Promise(r => setTimeout(r, 300));
  const viewSessions = h.tmux(s, 'list-sessions', '-F', '#{session_name}').stdout.split('\n').filter(n => /-v[0-9a-f]{6}$/.test(n));
  assert.deepEqual(viewSessions, [], 'connection close detached the view');
  assert.equal(h.tmux(s, 'has-session', '-t', `=omo-${ws.id}`).status, 0, 'workspace session still alive');
});

test('seeded fault: a host that drops input is caught by the output round-trip check', { skip: !(h.findTmux() && h.findPython()) && 'tmux/python3 missing' }, async () => {
  const s = h.scratch('fault');
  const { service, host } = h.makeService(s, { OMO_SPATIAL_FAULT: 'noop-input' });
  cleanup.push(async () => { await host.stop(); h.killScratchServer(s); });
  const ws = await service.openWorkspace({ stationId: 'f', projectUri: s.projectUri, name: 'F' });
  const { viewId } = await service.attach({ workspaceId: ws.id, tabId: ws.tabs[0].id, cols: 100, rows: 20 });
  await service.input({ viewId, data: 'echo FAULT-$((6*7))\r' });   // the faulty host reports success
  const p = await h.pollUntil(service, viewId, t => t.includes('FAULT-42'), 2500);
  assert.ok(p.timedOut && !p.text.includes('FAULT-42'), 'the round-trip check detects input that never arrived');
});
