/* w2 voice lane: STUN/TURN settings, config-dir store, signalling transports, spatial math. Pure Node; no browser. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText;
  module._compile(output, filename);
};
const src = p => path.resolve(__dirname, '../src', p);
const settings = require(src('common/voice-settings-protocol.ts'));
const { VoiceSettingsStore, turnRestHmac } = require(src('node/voice-settings-store.ts'));
const transport = require(src('common/voice-transport.ts'));
const spatial = require(src('browser/voice-spatial.ts'));
const worldModel = fs.readFileSync(src('common/world-model.ts'), 'utf8');
Module._extensions['.ts'] = originalTsLoader;

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-voice-'));

test('default network is public STUN only, no relay', () => {
  const ice = settings.voiceIceConfig(settings.DEFAULT_VOICE_NETWORK, 0, () => 'x');
  assert.deepEqual(ice.iceServers, [{ urls: [...settings.DEFAULT_STUN_URLS] }]);
  assert.equal(ice.iceTransportPolicy, 'all');
  assert.equal(ice.hasTurn, false);
  assert.ok(settings.DEFAULT_STUN_URLS.every(u => u.startsWith('stun:')));
});

test('ICE urls are validated strictly', () => {
  for (const ok of ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp', 'turn:10.0.0.5', 'turn:[2001:db8::1]:3478']) assert.equal(settings.iceUrl(ok, ['turn', 'turns']), ok);
  for (const bad of ['http://evil', 'turn:', 'turn:host:99999', 'turn:user@host', 'turn:host/path', 'turn:host?transport=sctp', 'stun:host?transport=udp', 'turn:host;rm -rf']) assert.throws(() => settings.iceUrl(bad, ['turn', 'turns', 'stun']), undefined, bad);
  assert.throws(() => settings.iceUrl('stun:x.com', ['turn']), /must start with turn/);
});

test('merge keeps stored secrets when left empty, and rejects incomplete TURN', () => {
  const first = settings.voiceNetworkMerge({ stun: 'default', relayOnly: false, turn: { urls: ['turn:t.example.com:3478'], mode: 'rest-secret', secret: 's3cret' } }, settings.DEFAULT_VOICE_NETWORK);
  assert.equal(first.turn.secret, 's3cret');
  const kept = settings.voiceNetworkMerge({ stun: 'default', relayOnly: true, turn: { urls: ['turn:t.example.com:3478'], mode: 'rest-secret' } }, first);
  assert.equal(kept.turn.secret, 's3cret');
  assert.equal(kept.relayOnly, true);
  assert.throws(() => settings.voiceNetworkMerge({ stun: 'default', relayOnly: false, turn: { urls: ['turn:t.example.com'], mode: 'static', username: 'u' } }, first), /user name and password/);
  assert.throws(() => settings.voiceNetworkMerge({ stun: 'default', relayOnly: true, turn: null }, first), /needs a TURN/);
  assert.throws(() => settings.voiceNetworkMerge({ stun: 'custom', stunUrls: [], relayOnly: false }, first), /at least one STUN/);
  assert.equal(settings.voiceNetworkMerge({ stun: 'off', relayOnly: false, turn: null }, first).turn, undefined);
});

test('coturn REST credentials: expiry:label user, base64 HMAC-SHA1 of the user with the secret', () => {
  const stored = settings.voiceNetworkMerge({ stun: 'off', relayOnly: true, turn: { urls: ['turns:t.example.com:5349?transport=tcp'], mode: 'rest-secret', username: 'harry', secret: 'shh' } }, settings.DEFAULT_VOICE_NETWORK);
  const now = Date.UTC(2026, 10, 7);
  const ice = settings.voiceIceConfig(stored, now, turnRestHmac);
  assert.equal(ice.iceServers.length, 1);
  const server = ice.iceServers[0];
  const expiry = now / 1000 + settings.TURN_REST_TTL_S;
  assert.equal(server.username, `${expiry}:harry`);
  assert.equal(server.credential, crypto.createHmac('sha1', 'shh').update(`${expiry}:harry`).digest('base64'));
  assert.notEqual(server.credential, 'shh');
  assert.equal(ice.iceTransportPolicy, 'relay');
  assert.equal(ice.expiresAt, expiry * 1000);
});

test('store writes 0600 JSON in the Theia config dir and never returns secrets in the view', async () => {
  const dir = tmp();
  const store = new VoiceSettingsStore(async () => dir, () => 1_000_000);
  assert.deepEqual((await store.get()).stun, 'default');
  const view = await store.save({ stun: 'default', relayOnly: false, turn: { urls: ['turn:turn.example.com:3478?transport=udp'], mode: 'static', username: 'omo', credential: 'pa55' } });
  const file = path.join(dir, settings.VOICE_SETTINGS_FILE);
  assert.equal(view.file, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(view.turn.hasCredential, true);
  assert.equal(JSON.stringify(view).includes('pa55'), false, 'the settings view must not contain the password');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).turn.credential, 'pa55');
  // A fresh store (backend restart) reads it back; ICE config hands the browser its own TURN login.
  const again = new VoiceSettingsStore(async () => dir);
  const ice = await again.iceConfig();
  assert.deepEqual(ice.iceServers.at(-1), { urls: ['turn:turn.example.com:3478?transport=udp'], username: 'omo', credential: 'pa55' });
  // A corrupt file falls back to defaults instead of breaking voice.
  fs.writeFileSync(file, '{not json');
  assert.equal((await new VoiceSettingsStore(async () => dir).iceConfig()).hasTurn, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voice settings are not part of the shared WorldSpec contract', () => {
  assert.doesNotMatch(worldModel, /\b(turns?|stuns?|iceServers?|credential|voice)\b/i);
});

test('local presence transport maps 1:1 onto the presence service', async () => {
  const calls = [];
  const t = transport.localPresenceTransport({ setVoice: async s => calls.push(['setVoice', s]), signal: async s => calls.push(['signal', s]), takeSignals: async () => [{ from: 'a', fromSession: 'abcdef12', kind: 'bye', data: '' }] });
  assert.equal(t.kind, 'local-presence');
  await t.publish(null); await t.send({ to: 'b', toSession: 'abcdef12', session: 'abcdef34', kind: 'ice', data: '{}' });
  assert.deepEqual(calls.map(c => c[0]), ['setVoice', 'signal']);
  assert.equal((await t.take()).length, 1);
});

test('remote room transport validates, queues (bounded) and exposes the room roster', async () => {
  let listener; const sent = [];
  const t = transport.remoteRoomVoiceTransport({ send: m => sent.push(m), onMessage: l => { listener = l; return () => { listener = undefined; }; } });
  assert.equal(t.kind, 'remote-room');
  await t.publish({ session: 'abcdef12', muted: false, speaking: true });
  await t.send({ to: 'peer-1', toSession: 'abcdef12', session: 'abcdef34', kind: 'offer', data: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' });
  assert.deepEqual(sent.map(m => m.type), ['voice.status', 'voice.signal']);
  await assert.rejects(() => t.send({ to: 'peer-1', toSession: 'abcdef12', session: 'abcdef34', kind: 'offer', data: 'v=0\nm=video 9 x\n' }), /audio only/);
  listener({ type: 'voice.signal', envelope: { from: 'peer-1', fromSession: 'abcdef12', kind: 'ice', data: '{"candidate":"x"}' } });
  listener({ type: 'voice.signal', envelope: { from: '../x', fromSession: 'abcdef12', kind: 'ice', data: '' } });
  listener({ type: 'voice.signal', envelope: { from: 'peer-1', fromSession: 'abcdef12', kind: 'offer', data: 'm=video 9' } });
  listener({ type: 'voice.signal', envelope: { from: 'peer-1', fromSession: 'abcdef12', kind: 'evil', data: '' } });
  assert.equal(t.queued, 1);
  for (let i = 0; i < 100; i++) listener({ type: 'voice.signal', envelope: { from: 'peer-1', fromSession: 'abcdef12', kind: 'ice', data: String(i) } });
  assert.equal(t.queued, 64);
  const taken = await t.take();
  assert.equal(taken.at(-1).data, '99');
  assert.equal(t.queued, 0);
  listener({ type: 'voice.roster', roster: { selfId: 'me', members: [{ id: 'me', name: 'Me', pose: { x: 0, z: 0, yaw: 0, pitch: 0 } }, { id: 'peer-1', name: 'P', pose: { x: 1, z: 2, yaw: 0, pitch: 0 }, voice: { session: 'abcdef12', muted: false, speaking: true } }, { id: 'bad', name: 'B', pose: { x: NaN } }] } });
  assert.deepEqual(t.roster().members.map(m => m.id), ['me', 'peer-1']);
  t.dispose();
  assert.equal(listener, undefined);
  await assert.rejects(() => t.publish(null), /closed/);
});

test('spatial math: facing, azimuth left/right/behind, proximity floor', () => {
  const me = { x: 0, z: 0, yaw: 0, pitch: 0 }; // facing -z
  const deg = r => Math.round(r * 180 / Math.PI);
  assert.equal(deg(spatial.relativeAzimuth(me, { x: 0, z: -2 })), 0);
  assert.equal(deg(spatial.relativeAzimuth(me, { x: 2, z: 0 })), 90);
  assert.equal(deg(spatial.relativeAzimuth(me, { x: -2, z: 0 })), -90);
  assert.equal(Math.abs(deg(spatial.relativeAzimuth(me, { x: 0, z: 2 }))), 180);
  // Turn left 90 degrees (yaw +pi/2 faces -x): a voice on +x is now directly behind, one on -z is to the right.
  const turned = { ...me, yaw: Math.PI / 2 };
  assert.deepEqual(spatial.facing(Math.PI / 2), { x: -1, y: 0, z: 0 });
  assert.equal(Math.abs(deg(spatial.relativeAzimuth(turned, { x: 2, z: 0 }))), 180);
  assert.equal(deg(spatial.relativeAzimuth(turned, { x: 0, z: -2 })), 90);
  // Co-located avatars: the source is kept MIN_SOURCE_DISTANCE away (ahead), never on the ear.
  const same = spatial.sourcePosition(me, { x: 0, z: 0 });
  assert.ok(Math.abs(Math.hypot(same.x, same.z) - spatial.MIN_SOURCE_DISTANCE) < 1e-9 && same.z < 0);
  const near = spatial.sourcePosition(me, { x: 0.1, z: 0 });
  assert.ok(near.x > 0.29 && Math.abs(near.z) < 1e-9);
  assert.deepEqual(spatial.sourcePosition(me, { x: 2, z: 1 }), { x: 2, y: spatial.EAR_HEIGHT, z: 1 });
  assert.equal(spatial.proximityVolume(1), 1);
  assert.equal(spatial.proximityVolume(50), spatial.PROXIMITY.floor);
  assert.ok(spatial.proximityVolume(6) < 1 && spatial.proximityVolume(6) > spatial.PROXIMITY.floor);
});
