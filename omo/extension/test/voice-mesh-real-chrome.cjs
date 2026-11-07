/* w2 voice lane — REAL Chrome WebRTC harness for the room voice mesh.
 *
 * Runs the real voice modules (esbuild bundle of src/browser/voice-controller.ts + voice-check.ts)
 * in N real Chrome tabs with fake microphones. Node plays the remote room server: it relays the
 * VoiceWireOut/VoiceWireIn messages of common/voice-transport.ts and publishes the roster.
 *
 * Proves: N-peer mesh, glare (simultaneous renegotiation), ICE restart + rebuild after a peer
 * reload, audio actually flowing, HRTF left/right placement by avatar pose, per-person mute,
 * coturn TURN relay (relay-only, REST shared-secret credentials minted by the backend store),
 * and the voice check helpers (ICE candidate types, loopback, 3 s record).
 *
 * Usage: node extension/test/voice-mesh-real-chrome.cjs [--turn]   (needs docker for --turn)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'evidence');
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-voice-mesh-'));
const WITH_TURN = process.argv.includes('--turn');
const TURN_PORT = 3479, TURN_SECRET = 'omo-voice-test-secret', TURN_NAME = 'omo-voice-coturn-test';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function bundle() {
  const out = path.join(TMP, 'voice-mesh.js');
  execFileSync(path.join(ROOT, 'node_modules/.bin/esbuild'), [path.join(__dirname, 'voice/mesh-entry.ts'), '--bundle', '--format=iife', `--outfile=${out}`], { stdio: 'pipe' });
  return fs.readFileSync(out, 'utf8');
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('172.')) return a.address;
  return '127.0.0.1';
}
function loadTs(file) {
  const Module = require('node:module'), ts = require('typescript');
  const prev = Module._extensions['.ts'];
  Module._extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: f }).outputText, f);
  try { return require(file); } finally { Module._extensions['.ts'] = prev; }
}

/** A steady 440 Hz tone as the fake microphone (Chrome's default fake mic only beeps briefly). */
function toneWav(file, seconds = 30, rate = 48000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tone = path.join(TMP, 'tone.wav'); toneWav(tone);
  const script = bundle();
  const server = http.createServer((req, res) => {
    if (req.url === '/voice-mesh.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(script); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>voice mesh</title><script src="/voice-mesh.js"></script>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tone}`, '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });
  const proof = { pass: false, startedAt: new Date().toISOString(), steps: {} };
  const room = new Map(); // id -> { page, name, pose, voice }
  const relayed = {}; const count = k => { relayed[k] = (relayed[k] || 0) + 1; };
  let rosterTimer;
  const deliver = (id, message) => room.get(id)?.page.evaluate(json => window.__relayDeliver(json), JSON.stringify(message)).catch(() => undefined);
  const roster = () => [...room.entries()].map(([id, m]) => ({ id, name: m.name, pose: m.pose, ...(m.voice ? { voice: m.voice } : {}) }));
  async function join(id, name, pose) {
    const page = await browser.newPage();
    page.on('pageerror', e => console.error(`[${id}] pageerror`, e.message));
    const member = { page, name, pose, voice: undefined };
    room.set(id, member);
    // The room server: validate the sender, then route. Peers never get each other's raw messages otherwise.
    await page.exposeFunction('__relaySend', json => {
      const m = JSON.parse(json);
      if (m.type === 'voice.status') { member.voice = m.status ?? undefined; return; }
      if (m.type === 'voice.signal') {
        const s = m.signal;
        if (!member.voice || member.voice.session !== s.session) { count(`drop-from:${s.kind}`); return; }
        const target = room.get(s.to);
        if (!target?.voice || target.voice.session !== s.toSession) { count(`drop-to:${s.kind}`); return; }
        count(s.kind);
        void deliver(s.to, { type: 'voice.signal', envelope: { from: id, fromSession: s.session, kind: s.kind, data: s.data } });
      }
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__voice);
    await page.evaluate(p => { window.__pose = p; }, pose);
    return page;
  }
  const tickRoster = () => { const members = roster(); for (const id of room.keys()) void deliver(id, { type: 'voice.roster', roster: { selfId: id, members } }); };
  const call = (id, fn, ...args) => room.get(id).page.evaluate(fn, ...args);
  const state = id => call(id, () => { const c = window.__voice.controller; return { phase: c.state.phase, peers: c.state.peers, debug: c.debugPeers(), errors: window.__voice.errors.slice(-5), network: c.state.network }; });
  async function waitMesh(ids, label, timeout = 30000) {
    const until = Date.now() + timeout;
    for (;;) {
      const all = await Promise.all(ids.map(id => state(id)));
      if (all.every(s => s.peers.length === ids.length - 1 && s.peers.every(p => p.connection === 'connected'))) return all;
      if (Date.now() > until) throw new Error(`${label}: mesh not connected: ${JSON.stringify(all.map((s, i) => [ids[i], s.peers.map(p => `${p.name}:${p.connection}`), s.debug, s.errors]))}`);
      await sleep(250);
    }
  }
  const setPose = (id, pose) => { room.get(id).pose = pose; return call(id, p => { window.__pose = p; }, pose); };
  async function energy(id) { return call(id, () => window.__voice.controller.debugAudio()); }
  const ears = async () => { const s = []; for (let i = 0; i < 12; i++) { s.push((await energy('peer-b')).ears); await sleep(120); } return { left: Math.max(...s.map(x => x.left)), right: Math.max(...s.map(x => x.right)) }; };
  let coturn = false;
  try {
    rosterTimer = setInterval(tickRoster, 200);
    const ice0 = { iceServers: [], iceTransportPolicy: 'all', hasTurn: false };
    // ---------- 1. three peers, all turned on at the same instant (maximal glare) ----------
    const ids = ['peer-a', 'peer-b', 'peer-c'];
    const TURN_ONLY = process.env.VOICE_TURN_ONLY === '1';
    if (TURN_ONLY) { for (const [i, id] of ids.entries()) await join(id, ['Alice', 'Bob', 'Cleo'][i], { x: i, z: 0, yaw: 0, pitch: 0 }); }
    else {
    await join('peer-a', 'Alice', { x: 0, z: 0, yaw: 0, pitch: 0 });
    await join('peer-b', 'Bob', { x: -2, z: 0, yaw: 0, pitch: 0 });
    await join('peer-c', 'Cleo', { x: 4, z: -3, yaw: 0, pitch: 0 });
    await sleep(500);
    for (const id of ids) await call(id, c => window.__voice.setIce(c), ice0);
    await Promise.all(ids.map(id => call(id, () => window.__voice.controller.enable())));
    const t0 = Date.now();
    const mesh = await waitMesh(ids, 'initial mesh');
    proof.steps.mesh3 = { connectedMs: Date.now() - t0, paths: mesh.map((s, i) => [ids[i], s.peers.map(p => `${p.name}:${p.path ?? '?'}`)]), politeness: mesh.map(s => s.debug.map(d => `${d.id}:${d.polite ? 'polite' : 'impolite'}`)) };
    // ---------- 2. glare: every peer restarts ICE on every link at the same instant ----------
    await Promise.all(ids.map(id => call(id, () => window.__voice.controller.restartAll())));
    await sleep(300);
    const glare = await waitMesh(ids, 'after simultaneous ICE restart');
    proof.steps.glare = { stillConnected: true, restarts: glare.map((s, i) => [ids[i], s.debug.map(d => d.restarts)]), errors: glare.flatMap(s => s.errors) };
    // ---------- 3. audio flows; spatial: Bob hears Alice (open mic) from his RIGHT ----------
    // Bob at x=-2 facing -z; Alice at x=0 => Alice is 90 degrees to Bob's right.
    await call('peer-a', () => window.__voice.controller.setMode('open'));
    await call('peer-b', () => window.__voice.controller.setPersonMuted('peer-c', true)); // only hear Alice
    await sleep(2500);
    const e1 = await energy('peer-b'); await sleep(1500); const e2 = await energy('peer-b');
    const fromAlice = e2.peers.find(p => p.id === 'peer-a'), fromAlice1 = e1.peers.find(p => p.id === 'peer-a');
    assert.ok(fromAlice.packets > fromAlice1.packets, 'Bob receives RTP audio packets from Alice');

    const right = await ears();
    assert.ok(right.right > right.left * 1.5, `Alice on Bob's right must be louder in the right ear: ${JSON.stringify(right)}`);
    // Bob turns around (yaw = pi, facing +z): Alice is now on his LEFT.
    await setPose('peer-b', { x: -2, z: 0, yaw: Math.PI, pitch: 0 });
    await sleep(1200);
    const left = await ears();
    assert.ok(left.left > left.right * 1.5, `after turning, Alice must be louder in the left ear: ${JSON.stringify(left)}`);
    // Per-person mute (local only): Bob mutes Alice -> silence at Bob; Alice still sending.
    await call('peer-b', () => window.__voice.controller.setPersonMuted('peer-a', true));
    await sleep(1200);
    const muted = await ears();
    assert.ok(muted.left < 0.002 && muted.right < 0.002, `personal mute silences that person: ${JSON.stringify(muted)}`);
    const bobView = (await state('peer-b')).peers.find(p => p.id === 'peer-a');
    assert.equal(bobView.personalMuted, true); assert.equal(bobView.volume, 0);
    await call('peer-b', () => { const c = window.__voice.controller; c.setPersonMuted('peer-a', false); c.setPersonMuted('peer-c', false); c.setPersonVolume('peer-a', 1.5); });
    proof.steps.audioAndSpatial = { rtpPackets: fromAlice.packets, aliceOnRight: right, afterTurnAliceOnLeft: left, personalMuted: muted, direction: bobView.direction };
    // ---------- 4. reconnect: Cleo reloads (new session); a 4th peer joins late ----------
    await room.get('peer-c').page.reload({ waitUntil: 'load' });
    room.get('peer-c').voice = undefined;
    await room.get('peer-c').page.waitForFunction(() => !!window.__voice);
    await setPose('peer-c', room.get('peer-c').pose);
    await call('peer-c', c => window.__voice.setIce(c), ice0);
    await sleep(400);
    await call('peer-c', () => window.__voice.controller.enable());
    await join('peer-d', 'Dev', { x: 1, z: 2, yaw: 0, pitch: 0 });
    await sleep(400);
    await call('peer-d', c => window.__voice.setIce(c), ice0);
    await call('peer-d', () => window.__voice.controller.enable());
    const t1 = Date.now();
    const mesh4 = await waitMesh([...ids, 'peer-d'], 'after reload + late joiner');
    await setPose('peer-b', { x: -2, z: 0, yaw: 0, pitch: 0 });
    await sleep(1500);
    const afterReconnect = await ears();
    assert.ok(afterReconnect.right > 0.05, `audio still plays after glare, reload and a late joiner: ${JSON.stringify(afterReconnect)}`);
    proof.steps.reloadAndLateJoin = { audibleAfter: afterReconnect, reconnectedMs: Date.now() - t1, peers: 4, links: mesh4.reduce((n, s) => n + s.peers.length, 0) / 2 };
    // ---------- 5. leaving voice removes the links everywhere ----------
    await call('peer-d', () => window.__voice.controller.disable());
    await sleep(800);
    const after = await Promise.all(ids.map(id => state(id)));
    assert.ok(after.every(s => s.peers.length === 2 && !s.peers.some(p => p.id === 'peer-d')), 'peer-d left voice everywhere');
    proof.steps.leave = { ok: true };
    for (const id of [...ids, 'peer-d']) await call(id, () => window.__voice.controller.disable());

    // ---------- 6. voice check helpers (no peers) ----------
    const check = await call('peer-a', async () => {
      const v = window.__voice;
      const stun = await v.gatherIce({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], iceTransportPolicy: 'all', hasTurn: false }, undefined, 5000);
      const prefs = v.controller.state.prefs;
      const loop = await v.startLoopback({ iceServers: [], iceTransportPolicy: 'all', hasTurn: false }, prefs, '', () => undefined);
      let path; for (let i = 0; i < 40 && !path; i++) { await new Promise(r => setTimeout(r, 150)); path = await loop.path(); }
      const level = loop.level(); loop.stop();
      const clip = await v.recordClip(prefs, 3000);
      URL.revokeObjectURL(clip.url);
      return { stun: { counts: stun.counts, sample: stun.candidates.slice(0, 3), errors: stun.errors }, loopback: { path, level }, record: { bytes: clip.bytes, mime: clip.mime } };
    });
    assert.ok(check.stun.counts.host > 0, 'host candidates gathered');
    assert.ok(check.loopback.path, 'loopback connected');
    assert.ok(check.record.bytes > 1000, 'record 3 s produced audio');
    proof.steps.voiceCheck = check;
    }

    // ---------- 7. TURN (coturn in docker) relay-only, REST credentials minted by the backend store ----------
    if (WITH_TURN) {
      const ip = lanIp();
      spawnSync('docker', ['rm', '-f', TURN_NAME], { stdio: 'ignore' });
      execFileSync('docker', ['run', '-d', '--rm', '--name', TURN_NAME, '--network', 'host', 'coturn/coturn:4.6', '-n', '--log-file=stdout', `--listening-port=${TURN_PORT}`, `--listening-ip=${ip}`, `--relay-ip=${ip}`, `--external-ip=${ip}`,
        '--min-port=50000', '--max-port=59999', '--total-quota=0', '--user-quota=0', '--use-auth-secret', `--static-auth-secret=${TURN_SECRET}`, '--realm=omo.test', '--no-tls', '--no-dtls', '--no-cli', '--fingerprint', '--allow-loopback-peers', '--no-multicast-peers'], { stdio: 'pipe' });
      coturn = true;
      await sleep(1500);
      const { VoiceSettingsStore } = loadTs(path.join(ROOT, 'extension/src/node/voice-settings-store.ts'));
      const configDir = path.join(TMP, 'theia-config');
      const store = new VoiceSettingsStore(async () => configDir);
      const view = await store.save({ stun: 'off', relayOnly: true, turn: { urls: [`turn:${ip}:${TURN_PORT}?transport=udp`], mode: 'rest-secret', username: 'omo-test', secret: TURN_SECRET } });
      assert.equal(JSON.stringify(view).includes(TURN_SECRET), false);
      const turnIce = await store.iceConfig();
      assert.equal(turnIce.iceTransportPolicy, 'relay');
      const turnCheck = await call('peer-a', async c => { const g = await window.__voice.gatherIce(c, undefined, 6000); return { counts: g.counts, errors: g.errors, sample: g.candidates.slice(0, 2) }; }, turnIce);
      assert.ok(turnCheck.counts.relay > 0, `coturn must hand out relay candidates: ${JSON.stringify(turnCheck)}`);
      for (const id of ['peer-a', 'peer-b', 'peer-c']) await call(id, c => window.__voice.setIce(c), turnIce);
      for (const k of Object.keys(relayed)) delete relayed[k];
      room.delete('peer-d');
      await Promise.all(ids.map(id => call(id, () => window.__voice.controller.enable())));
      const t2 = Date.now();
      let relayMesh;
      for (;;) {
        if (process.env.VOICE_DEBUG) setTimeout(async () => { for (const id of ids) console.log('dbg', id, JSON.stringify(await call(id, async () => { const out = []; for (const p of window.__voice.controller.peers.values()) { let rc = 0, lc = 0, pairs = 0; (await p.pc.getStats()).forEach(s => { if (s.type === 'remote-candidate') rc++; if (s.type === 'local-candidate') lc++; if (s.type === 'candidate-pair') pairs++; }); out.push({ id: p.id, sig: p.pc.signalingState, ice: p.pc.iceConnectionState, gather: p.pc.iceGatheringState, rc, lc, pairs, pend: p.pendingIce.length, remote: !!p.pc.remoteDescription, cfg: p.pc.getConfiguration().iceTransportPolicy, servers: p.pc.getConfiguration().iceServers.length }); } return out; }))); }, 6000);
        relayMesh = await waitMesh(ids, 'TURN relay-only mesh', 40000);
        if (relayMesh.every(s => s.peers.every(p => p.path))) break;
        if (Date.now() - t2 > 20000) break;
        await sleep(500);
      }
      const paths = relayMesh.flatMap(s => s.peers.map(p => p.path));
      assert.ok(paths.length === 6 && paths.every(p => p === 'relay/relay'), `relay-only links must use the TURN relay: ${JSON.stringify(paths)}`);
      await call('peer-a', () => window.__voice.controller.setMode('open'));
      await sleep(2000);
      const relayedAudio = (await energy('peer-b')).peers.find(p => p.id === 'peer-a');
      assert.ok(relayedAudio.packets > 20, `audio flows through TURN: ${JSON.stringify(relayedAudio)}`);
      await setPose('peer-b', { x: -2, z: 0, yaw: 0, pitch: 0 });
      await sleep(800);
      const relayEars = await ears();
      assert.ok(relayEars.right > 0.05, `relayed audio is audible: ${JSON.stringify(relayEars)}`);
      const log = execFileSync('docker', ['logs', TURN_NAME], { encoding: 'utf8' });
      const allocations = Math.max(0, ...[...log.matchAll(/allocation count incremented, now (\d+)/g)].map(m => Number(m[1])));
      proof.steps.turn = { relayIp: ip, port: TURN_PORT, gather: turnCheck, connectedMs: Date.now() - t2, paths, audioOverRelay: relayedAudio, relayEars, coturnPeakAllocations: allocations, secretInView: false, network: (await state('peer-a')).network };
    }
    proof.pass = true;
  } finally {
    clearInterval(rosterTimer);
    await browser.close().catch(() => undefined);
    server.close();
    if (coturn) { fs.writeFileSync(path.join(OUT, 'voice-coturn.log'), spawnSync('docker', ['logs', TURN_NAME], { encoding: 'utf8' }).stdout || ''); spawnSync('docker', ['rm', '-f', TURN_NAME], { stdio: 'ignore' }); }
    proof.relayedSignals = relayed;
    fs.writeFileSync(path.join(OUT, 'voice-mesh-real-chrome.json'), JSON.stringify(proof, null, 2));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(JSON.stringify(proof, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
