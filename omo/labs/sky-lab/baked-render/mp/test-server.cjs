#!/usr/bin/env node
// Server-level checks for mp/server.cjs (no browser): node mp/test-server.cjs
'use strict';
const path = require('node:path'), http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const NM = '~/dev/omo-skyscraper/omo/node_modules';
const WebSocket = require(NM + '/ws');
const PORT = 3702, LIVE_PORT = 3701;
let fail = 0, srv;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SERVER = path.join(__dirname, 'server.cjs');

function start(args) {
    const p = spawn(process.execPath, [SERVER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    return { p, out: () => out, ready: () => new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => { const m = /host-key=([0-9a-f]{48})/.exec(out); if (m) { clearInterval(iv); res(m[1]); } else if (Date.now() - t0 > 8000 || p.exitCode !== null) { clearInterval(iv); rej(new Error('no host key: ' + out)); } }, 50); }) };
}
function get(p, host) { return new Promise(r => { const q = http.request({ host: '127.0.0.1', port: PORT, path: p, headers: host ? { Host: host } : {} }, res => { res.resume(); r(res.statusCode); }); q.on('error', () => r(-1)); q.end(); }); }
function client(origin = `http://127.0.0.1:${LIVE_PORT}`) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/mp/ws`, { headers: origin ? { Origin: origin } : {} });
    const inbox = [];
    ws.on('message', m => inbox.push(JSON.parse(String(m))));
    const c = {
        ws, inbox,
        open: () => new Promise((res) => { ws.on('open', () => res('open')); ws.on('unexpected-response', (_q, r) => res('http ' + r.statusCode)); ws.on('error', e => res('error ' + e.message)); }),
        send: o => ws.send(JSON.stringify(o)),
        wait: async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = inbox.find(pred); if (f) return f; await sleep(20); } return null; },
        closed: () => new Promise(r => { if (ws.readyState === 3) return r(true); ws.on('close', (code) => r(code)); setTimeout(() => r(false), 3000); }),
    };
    return c;
}

(async () => {
    const any = spawnSync(process.execPath, [SERVER, '--host', '0.0.0.0', '--port', String(PORT)], { encoding: 'utf8', timeout: 5000 });
    ok('refuses to listen on 0.0.0.0', any.status !== 0 && /Refusing/i.test(any.stderr), (any.stderr || '').trim().slice(0, 90));
    const lan = spawnSync(process.execPath, [SERVER, '--host', '192.168.1.5', '--port', String(PORT)], { encoding: 'utf8', timeout: 5000 });
    ok('refuses a LAN address (only loopback or Tailscale 100.64/10)', lan.status !== 0, (lan.stderr || '').trim().slice(0, 90));

    srv = start(['--port', String(PORT), '--live-port', String(LIVE_PORT)]);
    const hostKey = await srv.ready();
    const room = /room=([0-9a-f]{8})/.exec(srv.out())[1];
    const ss = spawnSync('ss', ['-Hltn', `sport = :${PORT}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    ok('listens on 127.0.0.1 only by default', ss.length > 0 && ss.every(l => /\s127\.0\.0\.1:\d+\s/.test(l)), ss.map(l => l.replace(/\s+/g, ' ')).join(' | '));
    ok('serves the page', await get('/') === 200 && await get('/mp/mp.js') === 200 && await get('/live/live.js') === 200);
    ok('does not serve server code, logs or the terminal workspace', await get('/mp/server.cjs') === 403 && await get('/live/server.cjs') === 403 && await get('/live/workspace/x') === 403 && await get('/live/out/test-result.json') === 403);
    ok('rejects a foreign Host header (DNS rebinding)', await get('/', 'evil.example') === 403);
    const evil = client('https://evil.example');
    ok('ws rejects a foreign Origin', (await evil.open()) === 'http 403');

    const A = client(); await A.open();
    A.send({ type: 'pose', p: { x: 1, y: 0, z: -1, yaw: 0, pitch: 0, lv: 0 } });
    ok('nothing works before hello', !!(await A.wait(m => m.type === 'error' && m.code === 'hello')));
    A.send({ type: 'hello', host: 'f'.repeat(48), name: 'X' });
    ok('a wrong host key is refused', (await A.closed()) === 4001);

    const H = client(); await H.open();
    H.send({ type: 'hello', host: hostKey, name: 'Harry' });
    const hw = await H.wait(m => m.type === 'welcome');
    ok('host joins with the host key', hw && hw.self.role === 'host' && hw.self.name === 'Harry' && hw.room === room, JSON.stringify(hw && hw.self));
    H.send({ type: 'invite', id: 'i1' });
    const inv = await H.wait(m => m.type === 'invite' && m.id === 'i1');
    const re = new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?room=${room}#invite=(v1\\.[A-Za-z0-9._-]+)$`);
    ok('host gets a share link http://host:port/?room=<id>#invite=<signed>', inv && re.test(inv.link), inv && inv.link);
    const token = re.exec(inv.link)[1];

    const bad = client(`http://127.0.0.1:${PORT}`); await bad.open();
    bad.send({ type: 'hello', invite: token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA'), name: 'Mallory' });
    ok('a tampered invite is refused', (await bad.closed()) === 4001);

    const G = client(`http://127.0.0.1:${PORT}`); await G.open();
    G.send({ type: 'hello', invite: token, name: '  Kaviru  ' });
    const gw = await G.wait(m => m.type === 'welcome');
    ok('guest joins with the invite and a display name', gw && gw.self.role === 'guest' && gw.self.name === 'Kaviru' && gw.members.some(m => m.name === 'Harry'));
    ok('guest welcome carries no host key', gw && !JSON.stringify(gw).includes(hostKey));
    ok('host sees the guest join', !!(await H.wait(m => m.type === 'join' && m.member.name === 'Kaviru')));
    ok('colours differ per person', gw && hw && gw.self.colour !== hw.self.colour, `${hw && hw.self.colour} / ${gw && gw.self.colour}`);
    G.send({ type: 'invite', id: 'i2' });
    ok('a guest cannot make invites', !!(await G.wait(m => m.type === 'error' && m.id === 'i2' && m.code === 'forbidden')));

    G.send({ type: 'pose', p: { x: 5.5, y: 0, z: -4, yaw: 1, pitch: 0, lv: 0.2 } });
    const hp = await H.wait(m => m.type === 'pose' && m.id === gw.self.id);
    ok('pose is relayed to the others', hp && hp.p.x === 5.5 && hp.p.z === -4);
    G.send({ type: 'pose', p: { x: 1e6, y: 0, z: 0, yaw: 0, pitch: 0 } });
    ok('an out-of-room pose is rejected', !!(await G.wait(m => m.type === 'error' && m.code === 'bad-request')));
    G.send({ type: 'desk-input', desk: 'desk-0', data: 'ls\r' });
    ok('there is no message type for terminals', !!(await G.wait(m => m.type === 'error' && /Unknown message type/.test(m.error))));

    G.send({ type: 'signal', to: hw.self.id, toSession: 'aaaaaaaa', session: 'bbbbbbbb', kind: 'offer', data: 'v=0' });
    ok('signals need voice on first', !!(await G.wait(m => m.type === 'error' && m.code === 'voice-off')));
    H.send({ type: 'voice', status: { session: 'aaaaaaaa', muted: false, deaf: false } });
    G.send({ type: 'voice', status: { session: 'bbbbbbbb', muted: false, deaf: false } });
    await G.wait(m => m.type === 'update' && m.member.id === hw.self.id && m.member.voice);
    G.send({ type: 'signal', to: hw.self.id, toSession: 'aaaaaaaa', session: 'bbbbbbbb', kind: 'offer', data: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' });
    ok('voice signals are relayed between voice members', !!(await H.wait(m => m.type === 'signal' && m.from === gw.self.id && m.kind === 'offer')));
    G.send({ type: 'signal', to: hw.self.id, toSession: 'aaaaaaaa', session: 'bbbbbbbb', kind: 'offer', data: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
    ok('video SDP is refused (voice carries audio only)', !!(await G.wait(m => m.type === 'error' && /audio only/.test(m.error))));

    G.send({ type: 'chat', text: 'hello penthouse' });
    ok('chat is relayed', !!(await H.wait(m => m.type === 'chat' && m.message.text === 'hello penthouse')));
    G.send({ type: 'chat', text: 'token: ghp_abcdefghijklmnop1234' });
    ok('chat that looks like a secret is refused', !!(await G.wait(m => m.type === 'error' && m.code === 'secret')));

    // one-use invite
    H.send({ type: 'invite', id: 'i3', oneUse: true });
    const one = await H.wait(m => m.type === 'invite' && m.id === 'i3');
    const t1 = /#invite=(.+)$/.exec(one.link)[1];
    const U1 = client(`http://127.0.0.1:${PORT}`); await U1.open(); U1.send({ type: 'hello', invite: t1, name: 'One' });
    const u1w = await U1.wait(m => m.type === 'welcome');
    const U2 = client(`http://127.0.0.1:${PORT}`); await U2.open(); U2.send({ type: 'hello', invite: t1, name: 'Two' });
    ok('a one-use invite works once, then is refused', !!u1w && (await U2.closed()) === 4001);
    // member token lets a guest come back (reload) without the invite
    const R = client(`http://127.0.0.1:${PORT}`); await R.open(); R.send({ type: 'hello', member: u1w.memberToken, name: 'One' });
    const rw = await R.wait(m => m.type === 'welcome');
    ok('the member token rejoins as the same person (reload)', rw && rw.self.id === u1w.self.id);
    G.ws.close();
    ok('others see a leave', !!(await H.wait(m => m.type === 'leave' && m.id === gw.self.id)));
})().catch(e => ok('ran to completion', false, String(e.stack || e))).finally(() => { if (srv) srv.p.kill('SIGTERM'); setTimeout(() => process.exit(fail ? 1 : 0), 300); });
