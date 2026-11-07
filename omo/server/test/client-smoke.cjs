#!/usr/bin/env node
'use strict';
// Client smoke: plain loopback server (the "behind Tailscale Serve / reverse proxy" mode) + RoomClient.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RoomClient, redeemInvite } = require('../client/room-client.cjs');
const BIN = path.resolve(__dirname, '../omo-room-server.cjs');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-room-client-'));
const DATA = path.join(tmp, 'data');
let pass = 0;
const ok = (c, w) => { if (!c) { console.error(`FAIL ${w}`); throw new Error(w); } pass++; console.log(`ok   ${w}`); };
const cli = (...a) => execFileSync(process.execPath, [BIN, ...a, '--data', DATA], { encoding: 'utf8' });
(async () => {
    const owner = /\b(omo1\.\S+)/.exec(cli('create-room', '--id', 'loop-room', '--owner', 'Ana', '--theme', 'jungle'))[1];
    const inv = /Invite code: (omoinv1\.\S+)/.exec(cli('invite', '--room', 'loop-room', '--role', 'builder', '--ttl', '10m'))[1];
    const srv = spawn(process.execPath, [BIN, '--data', DATA, '--port', '0', '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const info = await new Promise(r => srv.stdout.once('data', d => r(JSON.parse(d))));
    try {
        ok(info.url.startsWith('http://127.0.0.1:'), 'loopback plain mode (for Tailscale Serve / TLS proxy in front)');
        const joined = await redeemInvite(info.url, inv, 'Ben');
        ok(joined.role === 'builder' && joined.wsUrl === `ws://127.0.0.1:${info.port}/ws`, 'redeemInvite helper');
        const events = [];
        const a = new RoomClient({ url: info.ws, token: owner, colour: 'amber' });
        const b = new RoomClient({ url: joined.wsUrl, token: joined.token, onMessage: m => events.push(m) });
        const wa = await a.connect(); await b.connect();
        ok(wa.world.shell.theme === 'jungle' && a.self.role === 'owner', 'RoomClient connect + welcome');
        const res = await b.request({ type: 'world-ops', baseRevision: b.world.revision, ops: [{ op: 'add', entity: { id: 'fern', kind: 'decor', decor: 'plant', transform: { x: 1, z: 1, rotation: 0 } } }] });
        ok(res.ok && res.revision === 1, 'RoomClient request world-ops');
        await new Promise(r => setTimeout(r, 150));
        ok(a.world.revision === 1 && a.world.entities.some(e => e.id === 'fern'), 'other client tracks the new world');
        a.send({ type: 'pose', pose: { x: 0.5, z: 0.5, yaw: 0, pitch: 0 } });
        await new Promise(r => setTimeout(r, 150));
        ok(b.presence.get(a.self.id)?.pose?.x === 0.5, 'presence pose tracked');
        let rejected = '';
        await new RoomClient({ url: info.ws, token: 'omo1.loop-room.m_0000000000000000.' + 'A'.repeat(43), reconnect: false }).connect().catch(e => { rejected = e.message; });
        ok(/4001/.test(rejected), 'bad key rejected with 4001');
        a.close(); b.close();
    } finally { srv.kill('SIGTERM'); await new Promise(r => srv.once('exit', r)); }
    console.log(`\n${pass} checks passed`);
    fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
