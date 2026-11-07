#!/usr/bin/env node
'use strict';
// t2:pkg — the REAL compiled IDE client (extension/lib/node/remote-room-client.js) against the REAL room
// server: the owner hosts with the key printed by `create-room`, mints an invite link, a second IDE
// client joins with it, both see each other, a world op and a chat line cross, a bad key is refused,
// and a stored member key reconnects. Needs `npm run compile` first. Usage:
//   node omo/server/test/ide-client-smoke.cjs [--bin <omo-room-server launcher>] [--port N]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const BIN = opt('--bin');
const PORT = Number(opt('--port') || 0);
const { RemoteRoomClient } = require(path.resolve(__dirname, '../../extension/lib/node/remote-room-client.js'));
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-ide-wire-'));
const DATA = path.join(tmp, 'data');
let pass = 0;
const ok = (c, w) => { if (!c) { console.error(`FAIL ${w}`); throw new Error(w); } pass++; console.log(`ok   ${w}`); };
const cmd = BIN ? [BIN] : [process.execPath, path.resolve(__dirname, '../omo-room-server.cjs')];
const cli = (...a) => execFileSync(cmd[0], [...cmd.slice(1), ...a, '--data', DATA], { encoding: 'utf8' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function memStore() {
    const rooms = new Map(), claims = new Map();
    return {
        rooms,
        token: async (server, roomId) => { const e = [...rooms.values()].find(x => x.server === server && x.roomId === roomId); return e ? { token: e.token, memberId: e.memberId } : undefined; },
        save: async e => { rooms.set(`${e.server}|${e.roomId}|${e.memberId}`, e); },
        remove: async () => {}, list: async () => [...rooms.values()].map(({ token, ...rest }) => rest),
        claim: (s, r, m, c) => { const k = `${s}|${r}|${m}`; if (claims.has(k) && claims.get(k) !== c) return false; claims.set(k, c); return true; },
        release: c => { for (const [k, v] of claims) if (v === c) claims.delete(k); }
    };
}
const until = async (fn, what, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(50); } throw new Error(`timeout: ${what}`); };
(async () => {
    const owner = /\b(omo1\.\S+)/.exec(cli('create-room', '--id', 'ide-room', '--name', 'IDE room', '--owner', 'Ana'))[1];
    const srv = spawn(cmd[0], [...cmd.slice(1), '--data', DATA, '--port', String(PORT), '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const info = await new Promise((r, j) => { srv.stdout.once('data', d => r(JSON.parse(d))); srv.once('exit', c => j(new Error(`server exited ${c}`))); });
    const clients = [];
    try {
        ok(info.service === 'omo-room-server' && info.url.startsWith('http://127.0.0.1:'), `room server listening ${info.url}`);
        const storeA = memStore(), storeB = memStore();
        const A = new RemoteRoomClient({ store: storeA, handshakeMs: 5000 }); clients.push(A);
        const seed = JSON.parse(JSON.stringify(require('../vendor/world-model.cjs').worldFromRoomV1({ theme: 'jungle', projectName: 'Seed' })));
        const sa = await A.host({ server: info.url, ownerToken: owner, roomId: 'ide-room', seedWorld: seed }, { name: 'Ana' });
        ok(sa.phase === 'joined' && sa.role === 'owner', 'IDE client hosts with the create-room owner key');
        ok(A.world().shell.theme === 'jungle', 'owner seeds the untouched room with the IDE world');
        ok([...storeA.rooms.values()][0]?.token === owner, 'owner key stored as the member token (0600 store in the IDE)');
        const inv = await A.createInvite({ ttlMinutes: 30 });
        ok(/^http:\/\/127\.0\.0\.1:\d+\/omo-room\/join\/ide-room#invite=omoinv1\./.test(inv.link), 'owner mints an IDE invite link');
        const page = await fetch(inv.link.split('#')[0]);
        ok(page.status === 200 && /Join an Omo room/.test(await page.text()), 'invite link opens the join page in a browser');
        const B = new RemoteRoomClient({ store: storeB, handshakeMs: 5000 }); clients.push(B);
        const sb = await B.joinInvite(inv.link, { name: 'Ben' });
        ok(sb.phase === 'joined' && sb.role === 'builder', 'second IDE client joins with the invite link (no role asked = builder, as older IDE clients edited the world)');
        await until(() => A.status().members.some(m => m.name === 'Ben') && B.status().members.some(m => m.name === 'Ana'), 'both see each other');
        ok(true, 'both members see each other (presence)');
        const before = A.world().revision;
        const res = await B.applyWorldOps(before, [{ op: 'add', entity: { id: 'fern', kind: 'decor', decor: 'plant', transform: { x: 1, z: 1, rotation: 0 } } }]);
        ok(res.ok && res.revision === before + 1, 'invited member applies a world op');
        await until(() => A.world().entities.some(e => e.id === 'fern'), 'owner sees fern');
        ok(true, 'owner receives the shared world change');
        const stale = await A.applyWorldOps(before, [{ op: 'rename', id: 'terminal', label: 'Stale' }]);
        ok(!stale.ok && stale.conflict, 'stale baseRevision is a conflict, not a silent overwrite');
        const said = await B.say({ kind: 'text', text: 'hello from Ben' });
        ok(said.text === 'hello from Ben', 'chat-ack for the sender');
        await until(() => A.takeChat().some(m => m.text === 'hello from Ben'), 'owner gets chat');
        ok(true, 'owner receives the chat line');
        A.update({ x: 0.5, z: 1.5, yaw: 0, pitch: 0 });
        await until(() => B.status().members.find(m => m.name === 'Ana')?.pose.x === 0.5, 'pose crosses');
        ok(true, 'pose crosses to the other member');
        const reuse = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(reuse);
        const again = await reuse.joinInvite(inv.link, { name: 'Cy' }).then(() => 'joined', e => e.message);
        ok(/invalid|expired|used/i.test(again), 'invite is single use');
        const mInv = await A.createInvite({ ttlMinutes: 30, role: 'member' });
        const M = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(M);
        const sm = await M.joinInvite(mInv.link, { name: 'Mo' });
        ok(sm.phase === 'joined' && sm.role === 'member', 'member-role invite joins as member');
        const memberEdit = await M.applyWorldOps(M.world().revision, [{ op: 'rename', id: 'terminal', label: 'Nope' }]);
        ok(!memberEdit.ok && /builder|owner|permission|not allowed|cannot|role/i.test(String(memberEdit.error ?? memberEdit.message ?? '')), 'member world edit is refused readably: ' + String(memberEdit.error ?? memberEdit.message ?? ''));
        const bad = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(bad);
        const refused = await bad.host({ server: info.url, ownerToken: owner.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), roomId: 'ide-room' }, { name: 'Eve' }).then(() => 'joined', e => e.message);
        ok(/not accepted/i.test(refused), 'wrong owner key refused');
        B.dispose();
        await until(() => !A.status().members.some(m => m.name === 'Ben'), 'Ben left');
        const B2 = new RemoteRoomClient({ store: storeB, handshakeMs: 5000 }); clients.push(B2);
        const sb2 = await B2.rejoin(info.url, 'ide-room', { name: 'Ben' });
        ok(sb2.phase === 'joined' && B2.world().entities.some(e => e.id === 'fern'), 'stored member key reconnects and sees the world');
        console.log(`\n${pass} checks passed`);
    } finally {
        for (const c of clients) { try { c.dispose(); } catch { /* ignore */ } }
        srv.kill('SIGTERM'); await new Promise(r => srv.once('exit', r));
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
