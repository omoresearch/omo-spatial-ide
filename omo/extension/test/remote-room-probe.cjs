// Probe: real compiled remote-room client against a mock room server speaking room-wire-protocol v1.
// Run (after npm run compile): node extension/test/remote-room-probe.cjs
const path = require('path'), fs = require('fs'), os = require('os');
const omo = process.argv[2] || path.join(__dirname, '..', '..');
const lib = p => require(path.join(omo, 'extension/lib', p));
const { WebSocketServer } = require(path.join(omo, 'node_modules/ws'));
const W = lib('common/room-wire-protocol.js');
const { applyWorldOps, worldFromRoomV1 } = lib('common/world-model.js');
const { remoteRoomConnection } = lib('node/remote-room-client.js');
const { RemoteRoomTokenStore } = lib('node/remote-room-token-store.js');
const { RoutedPresenceService, RemoteWorldSource } = lib('browser/remote-room-controller.js');

const OWNER = 'owner-token-0123456789abcdef';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000, what = 'condition') => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(25); } throw new Error('timeout waiting for ' + what); };
const log = (...a) => console.log('  ', ...a);
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); pass++; console.log('PASS', m); };

// ---------------- mock server ----------------
const rooms = new Map(); const invites = new Map(); const tokens = new Map(); const sockets = new Set();
let nextId = 1;
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: W.ROOM_WS_PATH });
const send = (ws, f) => ws.send(W.encodeFrame(f));
const view = room => [...room.members.values()].filter(m => m.ws).map(m => ({ id: m.id, name: m.name, pose: m.pose, role: m.role, ...(m.voice ? { voice: m.voice } : {}), ...(m.colour ? { colour: m.colour } : {}), ...(m.agents?.length ? { agents: m.agents } : {}) }));
const broadcast = (room, f, except) => { for (const m of room.members.values()) if (m.ws && m !== except && m.joined) send(m.ws, f); };
wss.on('connection', ws => {
    sockets.add(ws); ws.on('close', () => sockets.delete(ws));
    let me, room;
    ws.on('message', raw => {
        let f; try { f = W.parseClientFrame(raw.toString()); } catch (e) { return send(ws, { t: 'error', code: 'bad-frame', message: e.message }); }
        if (!f) return;
        if (!me && f.t !== 'hello') return ws.close(W.ROOM_CLOSE.auth, 'hello first');
        switch (f.t) {
            case 'hello': {
                const a = f.auth; room = rooms.get(a.roomId);
                if (a.kind === 'owner') {
                    if (a.ownerToken !== OWNER) { send(ws, { t: 'error', rid: f.rid, code: 'auth', message: 'Bad owner token.', fatal: true }); return ws.close(W.ROOM_CLOSE.auth, 'Bad owner token.'); }
                    if (!room) { room = { id: a.roomId, name: a.roomName || a.roomId, world: a.seedWorld || worldFromRoomV1({ theme: 'station', projectName: 'Room' }), members: new Map() }; rooms.set(a.roomId, room); }
                    me = { id: 'm' + String(nextId++).padStart(6, '0'), role: 'owner' };
                } else if (a.kind === 'invite') {
                    const inv = invites.get(a.invite);
                    if (!room || !inv || inv.roomId !== a.roomId) { send(ws, { t: 'error', rid: f.rid, code: 'invite-expired', message: 'Invite expired.', fatal: true }); return ws.close(W.ROOM_CLOSE.auth, 'Invite expired.'); }
                    me = { id: 'm' + String(nextId++).padStart(6, '0'), role: 'member' };
                } else {
                    const t = tokens.get(a.token);
                    if (!room || !t || t.roomId !== a.roomId) { send(ws, { t: 'error', rid: f.rid, code: 'auth', message: 'Unknown member.', fatal: true }); return ws.close(W.ROOM_CLOSE.auth, 'Unknown member.'); }
                    me = room.members.get(t.memberId) || { id: t.memberId, role: 'member' };
                    if (me.ws && me.ws !== ws) { try { me.ws.close(W.ROOM_CLOSE.replaced, 'replaced'); } catch {} }
                }
                me = room.members.get(me.id) || Object.assign(me, { pose: { x: 0, z: 2, yaw: 0, pitch: 0 } });
                me.ws = ws; me.joined = false; room.members.set(me.id, me);
                const token = 'tok_' + me.id + '_' + 'x'.repeat(20); tokens.set(token, { roomId: room.id, memberId: me.id });
                return send(ws, { t: 'welcome', rid: f.rid, proto: 1, roomId: room.id, roomName: room.name, memberId: me.id, role: me.role, memberToken: token, serverTime: Date.now() });
            }
            case 'join': me.name = f.name; if (f.colour) me.colour = f.colour; if (f.agents) me.agents = f.agents; me.joined = true;
                send(ws, { t: 'room', rid: f.rid, roomId: room.id, roomName: room.name, selfId: me.id, members: view(room), world: room.world });
                return broadcast(room, { t: 'presence', members: view(room) }, me);
            case 'pose': me.pose = f.pose; return broadcast(room, { t: 'presence', members: view(room) }, me);
            case 'voice-status': me.voice = f.status || undefined; return broadcast(room, { t: 'presence', members: view(room) });
            case 'colour': me.colour = f.colour; return broadcast(room, { t: 'presence', members: view(room) });
            case 'chat': case 'emote': {
                const msg = { id: 'c' + nextId++, from: me.id, fromName: me.name, at: Date.now(), kind: f.t === 'chat' ? 'text' : 'emote', ...(f.t === 'chat' ? { text: f.text } : { emote: f.emote }), ...(me.colour ? { colour: me.colour } : {}) };
                send(ws, { t: 'chat-ack', rid: f.rid, message: msg }); return broadcast(room, { t: 'chat', message: msg }, me);
            }
            case 'signal': { const to = room.members.get(f.signal.to); if (to?.ws) send(to.ws, { t: 'signal', envelope: { from: me.id, fromSession: f.signal.session, kind: f.signal.kind, data: f.signal.data } }); return; }
            case 'agents': me.agents = f.agents; return broadcast(room, { t: 'agents', memberId: me.id, agents: f.agents });
            case 'world-get': return send(ws, { t: 'world', rid: f.rid, world: room.world });
            case 'world-ops': {
                if (f.baseRevision !== room.world.revision) return send(ws, { t: 'error', rid: f.rid, code: 'conflict', message: 'Stale revision.', revision: room.world.revision });
                const r = applyWorldOps(room.world, f.ops); if (!r.ok) return send(ws, { t: 'error', rid: f.rid, code: 'invalid-ops', message: r.error });
                room.world = r.world; send(ws, { t: 'world-ack', rid: f.rid, revision: r.world.revision });
                return broadcast(room, { t: 'world-applied', by: me.id, baseRevision: f.baseRevision, revision: r.world.revision, ops: f.ops });
            }
            case 'invite-create': { if (me.role !== 'owner') return send(ws, { t: 'error', rid: f.rid, code: 'forbidden', message: 'Owner only.' });
                const code = 'inv_' + Math.random().toString(36).slice(2).padEnd(20, 'q'); invites.set(code, { roomId: room.id });
                return send(ws, { t: 'invite', rid: f.rid, link: W.inviteLink(`http://127.0.0.1:${port}`, room.id, code), expiresAt: Date.now() + 3600e3 }); }
            case 'ping': return send(ws, { t: 'pong', at: f.at, serverTime: Date.now() });
            case 'leave': room.members.delete(me.id); broadcast(room, { t: 'presence', members: view(room) }); return ws.close(1000, 'bye');
        }
    });
    ws.on('close', () => { if (me && room && me.ws === ws) { me.ws = undefined; broadcast(room, { t: 'presence', members: view(room) }); } });
});
let port;

(async () => {
    await new Promise(r => wss.on('listening', r)); port = wss.address().port;
    console.log('mock room server on 127.0.0.1:' + port);
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-rr-'));
    const storeA = new RemoteRoomTokenStore(async () => path.join(dir, 'a', 'omo', 'remote-rooms.json'));
    const storeB = new RemoteRoomTokenStore(async () => path.join(dir, 'b', 'omo', 'remote-rooms.json'));
    const A = remoteRoomConnection(storeA), B = remoteRoomConnection(storeB);

    // URL rules
    let threw = ''; try { W.roomSocketUrl('ws://example.com'); } catch (e) { threw = e.message; } ok(/secure/.test(threw), 'plain ws:// refused for non-loopback hosts');
    ok(W.roomSocketUrl('https://rooms.example.com/x') === 'wss://rooms.example.com/omo-room/v1/ws', 'https server URL maps to wss endpoint');

    // Host
    const seed = worldFromRoomV1({ theme: 'jungle', projectName: 'Harry room' });
    const sA = await A.host({ server: `http://127.0.0.1:${port}`, ownerToken: OWNER, roomId: 'harry-room', roomName: 'Harry room', seedWorld: seed }, { name: 'Harry' });
    ok(sA.phase === 'joined' && sA.role === 'owner' && sA.worldRevision === 0, `owner hosts room (phase=${sA.phase}, role=${sA.role}, rev=${sA.worldRevision})`);
    await until(async () => (await storeA.list()).length === 1, 2000, 'token saved');
    const fileA = path.join(dir, 'a', 'omo', 'remote-rooms.json');
    const mode = (fs.statSync(fileA).mode & 0o777).toString(8), dmode = (fs.statSync(path.dirname(fileA)).mode & 0o777).toString(8);
    ok(mode === '600' && dmode === '700', `token file mode ${mode}, dir ${dmode}`);
    ok(!fs.readFileSync(fileA, 'utf8').includes(OWNER), 'owner token is NOT stored');
    ok((await A.world()).shell.theme === 'jungle', 'seed world became the room world');

    // Invite + join
    const inv = await A.createInvite({ ttlMinutes: 60, maxUses: 3 });
    log('invite link:', inv.link.replace(/invite=.*/, 'invite=<redacted>'));
    const sB = await B.joinInvite(inv.link, { name: 'Bob' });
    ok(sB.phase === 'joined' && sB.role === 'member', 'second IDE joins from pasted invite link');
    await until(async () => (await A.status()).members.length === 2, 3000, 'A sees B');
    const snapA = await A.snapshot();
    ok(snapA.members.map(m => m.name).sort().join(',') === 'Bob,Harry' && snapA.selfId !== (await B.snapshot()).selfId, `shared presence: A sees [${snapA.members.map(m => m.name + (m.id === snapA.selfId ? ' (you)' : '')).join(', ')}]`);

    // Pose
    await A.update({ x: 1.5, z: -1, yaw: 0.5, pitch: 0 });
    await until(async () => (await B.snapshot()).members.find(m => m.name === 'Harry').pose.x === 1.5, 3000, 'pose');
    ok(true, 'pose update reaches the other member');

    // Routed presence: the same OmoPresenceService surface the HUD/chat/voice use
    const localCalls = []; const local = new Proxy({}, { get: (_, k) => async () => { localCalls.push(k); return []; } });
    const routedB = new RoutedPresenceService(local, B); routedB.route = 'remote';
    const sent = await routedB.say({ kind: 'text', text: 'hi @harry' });
    ok(sent.kind === 'text' && sent.fromName === 'Bob', 'chat via routed presence service is acked');
    await routedB.say({ kind: 'emote', emote: 'wave' });
    await until(async () => { const got = await A.takeChat(); if (got.length) A._got = (A._got || []).concat(got); return (A._got || []).length >= 2; }, 3000, 'chat');
    ok(A._got[0].text === 'hi @harry' && A._got[1].emote === 'wave' && localCalls.length === 0, 'chat line + emote reach the other member, nothing went to local presence');

    // Colour + voice + signalling addressed to member id
    await A.setColour('mint');
    const sessA = 'aaaaaaaa11', sessB = 'bbbbbbbb22';
    await A.setVoice({ session: sessA, muted: false, speaking: false });
    await routedB.setVoice({ session: sessB, muted: true, speaking: false });
    await until(async () => { const m = (await B.snapshot()).members.find(x => x.name === 'Harry'); return m.colour === 'mint' && m.voice?.session === sessA; }, 3000, 'colour/voice');
    ok(true, 'colour and voice status visible to other member');
    const aId = (await A.snapshot()).selfId;
    await routedB.signal({ to: aId, toSession: sessA, session: sessB, kind: 'offer', data: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' });
    await until(async () => { const s = await A.takeSignals(); if (s.length) A._sig = s; return !!A._sig; }, 3000, 'signal');
    ok(A._sig[0].kind === 'offer' && A._sig[0].fromSession === sessB, 'voice offer relayed to the addressed member');

    // Agent summaries
    await B.setAgents([{ key: 'terminal:t1', desk: 'terminal', kind: 'hermes', label: 'Hermes · Desk one', activity: 'working' }]);
    await until(async () => (await A.status()).members.find(m => m.name === 'Bob').agents?.[0]?.activity === 'working', 3000, 'agents');
    ok(true, 'agent status summary reaches the other member');

    // World ops + conflict
    const wa = new RemoteWorldSource(A), wb = new RemoteWorldSource(B);
    await wa.refresh(); await wb.refresh();
    const add = id => ({ op: 'add', entity: { id, kind: 'decor', decor: 'plant', transform: { x: 1, z: 1, rotation: 0 } } });
    const r1 = await wa.apply({ id: 'p1', source: 'build-mode', summary: 'plant', ops: [add('plant-a')], baseRevision: 0 });
    ok(r1.ok && r1.world.revision === 1, 'world ops batch applied by server (rev 0 -> 1)');
    await until(async () => (await B.status()).worldRevision === 1, 3000, 'B world rev');
    ok((await B.world()).entities.some(e => e.id === 'plant-a'), 'other member receives world-applied');
    const r2 = await wb.apply({ id: 'p2', source: 'build-mode', summary: 'lamp', ops: [add('lamp-b')], baseRevision: 0 });
    ok(!r2.ok && r2.conflict && r2.rebased?.baseRevision === 1 && r2.preview?.entities.some(e => e.id === 'lamp-b') && r2.preview.entities.some(e => e.id === 'plant-a'), 'stale baseRevision -> conflict, refreshed world + rebased preview');
    const r3 = await wb.apply(r2.rebased);
    ok(r3.ok && r3.world.revision === 2, 're-applied rebased proposal succeeds (rev 2)');
    const r4 = await wa.apply({ id: 'p4', source: 'build-mode', summary: 'bad', ops: [{ op: 'remove', id: 'nope' }], baseRevision: 2 });
    await until(async () => (await A.status()).worldRevision === 2, 2000);
    ok(!r4.ok && !r4.conflict, `invalid ops refused: ${r4.error}`);

    // Reconnect with backoff after a network drop
    for (const ws of sockets) { const m = [...rooms.get('harry-room').members.values()].find(x => x.ws === ws && x.name === 'Bob'); if (m) ws.terminate(); }
    await until(async () => (await B.status()).phase === 'reconnecting', 2000, 'reconnecting');
    const rs = await B.status(); log('B status after drop:', rs.phase, 'attempt', rs.attempt, 'retry in', rs.retryAt - Date.now(), 'ms');
    ok(rs.phase === 'reconnecting' && rs.attempt === 1, 'network drop -> reconnecting with backoff');
    await until(async () => (await B.status()).phase === 'joined', 5000, 'rejoined');
    ok((await B.snapshot()).members.length === 2, 'reconnected automatically with stored member token (same membership)');

    // Leave + rejoin from saved token
    await B.leave();
    ok((await B.status()).phase === 'idle', 'leave -> idle');
    await until(async () => (await A.status()).members.length === 1, 3000, 'A sees leave');
    ok(true, 'other member sees the leave');
    const saved = await B.saved(); ok(saved.length === 1 && !('token' in saved[0]), 'saved rooms listed without tokens');
    const rj = await B.rejoin(saved[0].server, saved[0].roomId, { name: 'Bob' });
    ok(rj.phase === 'joined', 'rejoin from saved membership');

    // Two tabs on ONE IDE backend (shared token store) join the same room as two distinct members
    const A2 = remoteRoomConnection(storeA);
    const inv2 = await A.createInvite({});
    const s2 = await A2.joinInvite(inv2.link, { name: 'Harry tab 2' });
    await until(async () => (await A.status()).members.length === 3, 3000, 'third member');
    ok(s2.phase === 'joined' && s2.selfId !== (await A.status()).selfId && (await A.status()).phase === 'joined', 'second tab on the same IDE joins as a new member without kicking the first');
    await A2.leave(); A2.dispose();

    // Fatal auth: no retry
    const C = remoteRoomConnection(new RemoteRoomTokenStore(async () => path.join(dir, 'c', 'r.json')));
    let err = ''; try { await C.host({ server: `http://127.0.0.1:${port}`, ownerToken: 'wrong-token-0123456789', roomId: 'harry-room' }, { name: 'Eve' }); } catch (e) { err = e.message; }
    await sleep(1500);
    const cs = await C.status();
    ok(err === 'Bad owner token.' && cs.phase === 'failed' && cs.attempt === 0, `bad owner token -> failed, no retry (${err})`);

    A.dispose(); B.dispose(); C.dispose(); wss.close();
    console.log(`\nALL ${pass} CHECKS PASSED`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
