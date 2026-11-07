#!/usr/bin/env node
'use strict';
// End-to-end smoke check of the room server over real TLS (self-signed cert made with openssl).
// Usage: node omo/server/test/e2e-smoke.cjs   (exits non-zero on the first failed check)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const WebSocket = require(require.resolve('ws', { paths: [path.resolve(__dirname, '../..')] }));

const BIN = path.resolve(__dirname, '../omo-room-server.cjs');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-room-e2e-'));
const DATA = path.join(tmp, 'data');
let pass = 0;
const ok = (cond, what) => { if (!cond) { console.error(`FAIL ${what}`); process.exitCode = 1; throw new Error(what); } pass++; console.log(`ok   ${what}`); };
const cli = (...args) => execFileSync(process.execPath, [BIN, ...args, '--data', DATA], { encoding: 'utf8' });
const tokenFrom = out => /\b(omo1\.\S+)/.exec(out)[1];
const inviteFrom = out => /Invite code: (omoinv1\.\S+)/.exec(out)[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const agent = new https.Agent({ rejectUnauthorized: false });

function request(port, method, p, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = https.request({ host: '127.0.0.1', port, method, path: p, agent, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
            let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode, body: j, headers: res.headers }); });
        });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
}
class Client {
    constructor(port, token, extra = {}, wsOpts = {}) {
        this.msgs = []; this.waiters = [];
        this.ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false, ...wsOpts });
        this.closed = new Promise(r => this.ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
        this.ws.on('message', d => { const m = JSON.parse(d.toString()); this.msgs.push(m); this.waiters = this.waiters.filter(w => !(w.pred(m) && (w.res(m), true))); });
        this.ws.on('error', () => {});
        this.opened = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('unexpected-response', (_, r) => rej(new Error(`HTTP ${r.statusCode}`))); this.ws.on('error', rej); });
        this.opened.then(() => this.send({ type: 'hello', protocol: 1, token, ...extra })).catch(() => {});
    }
    send(m) { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
    wait(pred, ms = 4000) {
        const hit = this.msgs.find(pred); if (hit) { this.msgs.splice(this.msgs.indexOf(hit), 1); return Promise.resolve(hit); }
        return new Promise((res, rej) => { const w = { pred, res: m => { clearTimeout(t); this.msgs.splice(this.msgs.indexOf(m), 1); res(m); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error('timeout waiting')); }, ms); this.waiters.push(w); });
    }
    req(m) { const id = `r${Math.random().toString(36).slice(2, 10)}`; this.send({ ...m, id }); return this.wait(x => x.id === id); }
    close() { this.ws.close(); return this.closed; }
}

(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });

    // ---- CLI: create room + invites (offline) ----
    const created = cli('create-room', '--id', 'team-a', '--name', 'Team A', '--owner', 'Harry');
    const ownerToken = tokenFrom(created);
    ok(/Room created: team-a/.test(created) && ownerToken, 'create-room prints a one-time owner key');
    const roomFile = path.join(DATA, 'rooms', 'team-a.json');
    const roomRaw = fs.readFileSync(roomFile, 'utf8');
    ok(!roomRaw.includes(ownerToken.split('.')[3]), 'owner secret is not stored (only scrypt hash)');
    ok((fs.statSync(roomFile).mode & 0o777) === 0o600 && (fs.statSync(DATA).mode & 0o777) === 0o700, 'room file 0600, data dir 0700');
    const inv1 = inviteFrom(cli('invite', '--room', 'team-a', '--role', 'builder', '--ttl', '1h', '--public-url', 'https://omo.test'));
    const inv2 = inviteFrom(cli('invite', '--room', 'team-a', '--role', 'member'));
    const inv3 = inviteFrom(cli('invite', '--room', 'team-a', '--role', 'viewer'));
    const invRevoke = cli('invite', '--room', 'team-a', '--role', 'member');
    const revokeId = /Invite (i_[a-f0-9]{16})/.exec(invRevoke)[1];
    cli('revoke', '--room', 'team-a', '--invite', revokeId);

    // ---- plain HTTP on a public host is refused ----
    let refused = false;
    try { execFileSync(process.execPath, [BIN, '--data', path.join(tmp, 'd2'), '--port', '0', '--host', '0.0.0.0'], { stdio: 'pipe' }); } catch (e) { refused = /Refusing plain HTTP/.test(String(e.stderr)); }
    ok(refused, 'serve refuses plain HTTP on a non-loopback host');

    // ---- server ----
    const srv = spawn(process.execPath, [BIN, '--data', DATA, '--port', '0', '--tls-cert', path.join(tmp, 'cert.pem'), '--tls-key', path.join(tmp, 'key.pem'), '--public-url', 'https://omo.test', '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const info = await new Promise((res, rej) => { srv.stdout.once('data', d => res(JSON.parse(d.toString()))); srv.once('exit', c => rej(new Error(`server exited ${c}`))); });
    const port = info.port;
    try {
        ok(info.url.startsWith('https://'), `server listening over TLS on ${port}`);
        let lockErr = '';
        try { execFileSync(process.execPath, [BIN, '--data', DATA, '--port', '0'], { stdio: 'pipe' }); } catch (e) { lockErr = String(e.stderr); }
        ok(/Another room server/.test(lockErr), 'second server on the same data dir is refused (lock)');

        const health = await request(port, 'GET', '/healthz');
        ok(health.status === 200 && health.body.ok && health.headers['strict-transport-security'], 'healthz + HSTS');
        ok((await request(port, 'GET', '/healthz', undefined, { origin: 'https://evil.example' })).status === 403, 'foreign Origin refused on HTTP');
        const page = await request(port, 'GET', '/join');
        ok(page.status === 200 && /script-src 'self'/.test(page.headers['content-security-policy']) && !/<script>/.test(page.body), 'join page with strict CSP, no inline script');

        // ---- invites ----
        const j1 = await request(port, 'POST', '/api/join', { invite: inv1, name: 'Bob' });
        ok(j1.status === 201 && j1.body.role === 'builder' && /^omo1\.team-a\.m_/.test(j1.body.token) && j1.body.wsUrl === 'wss://omo.test/ws', 'builder invite redeemed -> member key');
        const reuse = await request(port, 'POST', '/api/join', { invite: inv1, name: 'Mallory' });
        ok(reuse.status === 400 && /already used/.test(reuse.body.error), 'invite is single-use');
        const tampered = inv2.slice(0, -3) + (inv2.endsWith('A') ? 'BBB' : 'AAA');
        ok((await request(port, 'POST', '/api/join', { invite: tampered, name: 'Eve' })).status === 400, 'tampered invite signature refused');
        ok((await request(port, 'POST', '/api/join', { invite: inv2, name: 'bob' })).status === 400, 'duplicate display name refused (case-insensitive)');
        const j2 = await request(port, 'POST', '/api/join', { invite: inv2, name: 'Cara' });
        ok(j2.status === 201 && j2.body.role === 'member', 'member invite redeemed');
        const j3 = await request(port, 'POST', '/api/join', { invite: inv3, name: 'Vik' });
        ok(j3.status === 201 && j3.body.role === 'viewer', 'viewer invite redeemed');
        const revokedTry = /Invite code: (omoinv1\.\S+)/.exec(invRevoke)[1];
        ok((await request(port, 'POST', '/api/join', { invite: revokedTry, name: 'Rex' })).status === 400, 'revoked invite refused (CLI revoke while server runs)');
        ok((await request(port, 'POST', '/api/join', { invite: 'x'.repeat(5000), name: 'Big' })).status === 413, 'request body size cap (413)');
        const stored = fs.readFileSync(roomFile, 'utf8');
        ok(![ownerToken, j1.body.token, j2.body.token, j3.body.token].some(t => stored.includes(t.split('.')[3])), 'no member secret on disk');

        const w = await request(port, 'GET', '/api/world', undefined, { authorization: `Bearer ${j3.body.token}` });
        ok(w.status === 200 && w.body.world.version === 2 && w.body.role === 'viewer', 'GET /api/world with bearer key');
        ok((await request(port, 'GET', '/api/world', undefined, { authorization: 'Bearer omo1.team-a.m_0000000000000000.' + 'A'.repeat(43) })).status === 401, 'bad key -> 401');

        // ---- sockets ----
        const owner = new Client(port, ownerToken, { colour: 'sky', pose: { x: 0, z: 3, yaw: 0, pitch: 0 } });
        const wOwner = await owner.wait(m => m.type === 'welcome');
        ok(wOwner.self.role === 'owner' && wOwner.world.revision === 0 && wOwner.members.length === 4, 'owner welcome: world rev 0, 4 members');
        const bob = new Client(port, j1.body.token, { colour: 'mint' });
        const wBob = await bob.wait(m => m.type === 'welcome');
        ok(wBob.self.name === 'Bob' && wBob.presence.some(p => p.name === 'Harry' && p.pose && p.colour === 'sky'), 'Bob sees Harry presence (pose, colour)');
        const joined = await owner.wait(m => m.type === 'presence-join');
        ok(joined.member.name === 'Bob' && joined.member.id !== wOwner.self.id, 'owner sees Bob join as a distinct member (not "you")');
        const cara = new Client(port, j2.body.token); await cara.wait(m => m.type === 'welcome');
        const vik = new Client(port, j3.body.token); await vik.wait(m => m.type === 'welcome');

        bob.send({ type: 'pose', pose: { x: 1.5, z: -2, yaw: 0.4, pitch: 0.1 } });
        const pz = await owner.wait(m => m.type === 'pose' && m.id === wBob.self.id);
        ok(pz.pose.x === 1.5, 'pose relayed');
        bob.send({ type: 'pose', pose: { x: 99, z: 0, yaw: 0, pitch: 0 } });
        ok((await bob.wait(m => m.type === 'error')).code === 'bad-request', 'out-of-room pose refused');

        cara.send({ type: 'chat', text: 'hello room' });
        const ch = await vik.wait(m => m.type === 'chat');
        ok(ch.message.text === 'hello room' && ch.message.fromName === 'Cara', 'chat relayed to viewer');
        vik.send({ type: 'chat', text: 'can viewers talk?' });
        ok((await vik.wait(m => m.type === 'error')).code === 'forbidden', 'viewer cannot chat');
        vik.send({ type: 'emote', emote: 'wave' });
        ok((await owner.wait(m => m.type === 'chat' && m.message.kind === 'emote')).message.emote === 'wave', 'viewer emote relayed');
        cara.send({ type: 'chat', text: 'my key is sk-abcdefghijklmnopqrstuvwxyz123456' });
        ok((await cara.wait(m => m.type === 'error')).code === 'secret', 'secret-looking chat blocked');

        // voice signalling: members only, same session
        bob.send({ type: 'voice', status: { session: 'aaaa1111', muted: false, speaking: false } });
        cara.send({ type: 'voice', status: { session: 'bbbb2222', muted: false, speaking: false } });
        await owner.wait(m => m.type === 'presence-update' && m.member.name === 'Cara' && m.member.voice);
        const caraId = wOwner.members.find(x => x.name === 'Cara').id;
        bob.send({ type: 'signal', to: caraId, toSession: 'bbbb2222', session: 'aaaa1111', kind: 'offer', data: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' });
        const offer = await cara.wait(m => m.type === 'signal' && m.kind === 'offer');
        ok(offer.from === wBob.self.id && offer.fromSession === 'aaaa1111', 'WebRTC offer relayed member -> member');
        bob.send({ type: 'signal', to: caraId, toSession: 'bbbb2222', session: 'aaaa1111', kind: 'offer', data: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
        ok((await bob.wait(m => m.type === 'error')).code === 'bad-request', 'video offer refused (audio only)');
        vik.send({ type: 'signal', to: wBob.self.id, toSession: 'aaaa1111', session: 'cccc3333', kind: 'ice', data: '{}' });
        ok((await vik.wait(m => m.type === 'error')).code === 'forbidden', 'viewer cannot signal');

        // agent status summaries
        cara.send({ type: 'agent-status', stations: [{ station: 'terminal', state: 'working', agent: 'hermes', detail: 'Refactoring tests', progress: 0.4 }] });
        const as = await owner.wait(m => m.type === 'agent-status');
        ok(as.stations[0].state === 'working' && as.stations[0].detail === 'Refactoring tests', 'agent status summary relayed');
        cara.send({ type: 'agent-status', stations: [{ station: 'terminal', state: 'working', detail: 'cat /home/harry/.ssh/id_rsa' }] });
        ok(/secrets, tokens or file paths/.test((await cara.wait(m => m.type === 'error')).error), 'agent status with host path refused');
        cara.send({ type: 'terminal-data', data: 'ls\r' });
        ok(/Unknown message type/.test((await cara.wait(m => m.type === 'error')).error), 'no terminal relay message exists');

        // world ops: roles + optimistic concurrency
        const addDesk = { op: 'add', entity: { id: 'bob-desk', kind: 'station', label: 'Bob desk', transform: { x: 3, z: 2, rotation: 0 }, station: { name: 'Bob desk', kind: 'shell', tabs: [{ name: 'Shell', kind: 'shell' }], locked: false } } };
        const rCara = await cara.req({ type: 'world-ops', baseRevision: 0, ops: [addDesk] });
        ok(rCara.type === 'error' && rCara.code === 'forbidden', 'member cannot edit the world');
        const rBob = await bob.req({ type: 'world-ops', baseRevision: 0, ops: [addDesk] });
        ok(rBob.ok && rBob.revision === 1, 'builder applies a batch -> revision 1');
        const wv = await vik.wait(m => m.type === 'world');
        ok(wv.world.revision === 1 && wv.world.entities.some(e => e.id === 'bob-desk'), 'world broadcast to everyone');
        const stale = await owner.req({ type: 'world-ops', baseRevision: 0, ops: [{ op: 'name', name: 'Renamed' }] });
        ok(stale.type === 'error' && stale.code === 'conflict' && stale.revision === 1, 'stale baseRevision -> conflict');
        const bad = await owner.req({ type: 'world-ops', baseRevision: 1, ops: [{ op: 'remove', id: 'bob-desk' }, { op: 'remove', id: 'nope' }] });
        ok(bad.type === 'error' && bad.code === 'invalid', 'invalid batch rejected atomically');
        const leak = await owner.req({ type: 'world-ops', baseRevision: 1, ops: [{ op: 'rename', id: 'bob-desk', label: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }] });
        ok(leak.type === 'error' && /secrets/.test(leak.error), 'secret-looking world label refused');
        const lockTry = await bob.req({ type: 'world-ops', baseRevision: 1, ops: [{ op: 'update-station', id: 'bob-desk', station: { locked: true } }] });
        ok(lockTry.type === 'error' && lockTry.code === 'forbidden', 'only owner locks desks');
        const extra = await owner.req({ type: 'world-ops', baseRevision: 1, ops: [{ op: 'move', id: 'bob-desk', transform: { x: 2, z: 1, rotation: 0, evil: 'x' }, junk: 1 }] });
        ok(extra.ok && extra.revision === 2, 'owner move ok');
        const onDisk = JSON.parse(fs.readFileSync(roomFile, 'utf8'));
        ok(onDisk.world.revision === 2 && !JSON.stringify(onDisk.world).includes('evil'), 'world persisted at rev 2, unknown keys stripped');

        // owner admin over WS
        const ci = await owner.req({ type: 'invite-create', role: 'member', ttl: '30m' });
        ok(ci.ok && /^https:\/\/omo\.test\/join#invite=omoinv1\./.test(ci.link), 'owner creates invite link over WS');
        const notOwner = await bob.req({ type: 'invite-create', role: 'member' });
        ok(notOwner.code === 'forbidden', 'builder cannot invite');
        const roleChange = await owner.req({ type: 'member-role', member: wBob.self.id, role: 'viewer' });
        ok(roleChange.ok && (await bob.wait(m => m.type === 'self')).self.role === 'viewer', 'owner demotes Bob to viewer live');
        const rBob2 = await bob.req({ type: 'world-ops', baseRevision: 2, ops: [{ op: 'name', name: 'X' }] });
        ok(rBob2.code === 'forbidden', 'demoted Bob can no longer build');
        const rot = await cara.req({ type: 'rotate-token' });
        ok(rot.ok && rot.token !== j2.body.token, 'member rotates own key');
        ok((await request(port, 'GET', '/api/world', undefined, { authorization: `Bearer ${j2.body.token}` })).status === 401, 'old key dead after rotation');
        const rm = await owner.req({ type: 'member-remove', member: wBob.self.id });
        const bobClosed = await bob.closed;
        ok(rm.ok && bobClosed.code === 4040, 'removed member is disconnected (4040)');
        ok((await request(port, 'GET', '/api/world', undefined, { authorization: `Bearer ${j1.body.token}` })).status === 401, 'removed member key no longer works');

        // limits
        const big = new Client(port, ownerToken);
        await big.wait(m => m.type === 'welcome');
        await owner.closed.then(c => ok(c.code === 4009, 'second login of same member replaces the first (4009)'));
        big.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(200 * 1024) }));
        const bigClose = await big.closed;
        ok(bigClose.code === 1009, 'oversized frame closes socket (1009)');
        let originRefused = false;
        const evil = new Client(port, j3.body.token, {}, { origin: 'https://evil.example' });
        await evil.opened.catch(e => { originRefused = /403/.test(e.message); });
        ok(originRefused, 'foreign Origin refused on WebSocket upgrade');
        const noHello = new Client(port, 'omo1.team-a.m_0000000000000000.' + 'A'.repeat(43));
        ok((await noHello.closed).code === 4001, 'bad key on socket -> 4001');
        let spam = 0; for (let i = 0; i < 20; i++) { cara.send({ type: 'chat', text: `spam ${i}` }); }
        await sleep(300); spam = cara.msgs.filter(m => m.type === 'error' && m.code === 'rate').length;
        ok(spam >= 10, `chat rate limit hit (${spam} refusals)`);
        cara.close(); vik.close();
    } finally {
        srv.kill('SIGTERM');
        await new Promise(r => srv.once('exit', r));
    }
    ok(!fs.existsSync(path.join(DATA, 'server.lock')), 'lock released on SIGTERM');
    ok(!fs.readdirSync(path.join(DATA, 'rooms')).some(f => f.endsWith('.tmp')), 'no temp files left behind');
    const audit = fs.readFileSync(path.join(DATA, 'audit.log'), 'utf8');
    ok(!/omo1\.|omoinv1\./.test(audit), 'audit log holds no keys or invite codes');
    console.log(`\n${pass} checks passed`);
    fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error(e.stack || e.message); console.error(`data kept at ${tmp}`); process.exit(1); });
