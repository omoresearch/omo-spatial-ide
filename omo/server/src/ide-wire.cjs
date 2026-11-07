'use strict';
// t2:pkg — the IDE wire protocol (omo/extension/src/common/room-wire-protocol.ts, ROOM_WS_PATH) on top of
// the room hub. The Omo IDE backend (node/remote-room-client.ts) speaks `{t, rid}` frames on
// /omo-room/v1/ws with `hello.auth = owner | invite | member`; the hub speaks `{type, id}` on /ws with a
// bearer token. This adapter authenticates the IDE hello with the SAME hub accounts (owner keys from
// `create-room`, signed single-use invites, member keys), then runs the session through the hub with a
// translating socket, so roles, rate limits, world guards and secret checks are the hub's own.
// Terminals are still never shared: there is no frame for them in either protocol.
const crypto = require('crypto');
const U = require('./util.cjs');

const IDE_WS_PATH = '/omo-room/v1/ws';
const IDE_INVITE_PATH = '/omo-room/join/';
const IDE_PROTO = 1;
/** Hub close codes -> IDE ROOM_CLOSE codes (4001 auth, 4002 replaced, 4004 removed, 4005 protocol, 4008 rate, 4009 restart). */
const CLOSE_MAP = { 1000: 1000, 1008: 4005, 1009: 4005, 4001: 4001, 4003: 4005, 4009: 4002, 4029: 4008, 4030: 4008, 4040: 4004, 1001: 4009 };
const ERROR_CODE = { conflict: 'conflict', forbidden: 'forbidden', rate: 'rate', invalid: 'invalid-ops', 'bad-request': 'bad-frame', secret: 'forbidden', 'voice-off': 'forbidden' };
/** IDE agent activity <-> hub desk state. */
const TO_STATE = { working: 'working', background: 'working', idle: 'idle', sleeping: 'idle', interrupted: 'needs-input', exited: 'done' };
const TO_ACTIVITY = { working: 'working', waiting: 'idle', 'needs-input': 'interrupted', idle: 'idle', done: 'exited', error: 'exited', offline: 'exited' };
const IDE_AGENT_KINDS = ['hermes', 'claude', 'codex', 'dsh'];
const DEFAULT_POSE = { x: 0, z: 2, yaw: 0, pitch: 0 };
const RID_RE = /^[A-Za-z0-9_-]{1,40}$/;
// t3:mp2 — the IDE now sees the real server role (viewer/member/builder/owner), so it can explain refusals.
const IDE_ROLES = ['viewer', 'member', 'builder', 'owner'];
const ideRole = role => (IDE_ROLES.includes(role) ? role : 'viewer');
const INVITE_ROLES = ['viewer', 'member', 'builder'];
/** t3:mp2 — test-only frame trace: secrets are redacted before anything is written. */
const redact = text => String(text).replace(/"(ownerToken|token|memberToken|invite)":"[^"]*"/g, '"$1":"<redacted>"').replace(/#invite=[^"\s]*/g, '#invite=<redacted>');

/** Invite link the IDE accepts: <origin>/omo-room/join/<roomId>#invite=<code> (code in the fragment). */
function ideInviteLink(origin, roomId, token) { return `${origin.replace(/\/+$/, '')}${IDE_INVITE_PATH}${encodeURIComponent(roomId)}#invite=${encodeURIComponent(token)}`; }

/**
 * Serve one IDE socket. `ctx`: { hub, ip, origin (http(s)://host of this server), authFail (Buckets),
 * helloTimeoutMs, log }. Returns nothing; everything happens on socket events.
 */
function serveIdeSocket(ws, ctx) {
    const { hub, ip, origin, authFail, log = () => {} } = ctx;
    const trace = typeof ctx.trace === 'function' ? (dir, text) => { try { ctx.trace(dir, redact(text)); } catch { /* trace is best effort */ } } : () => {};
    const raw = (frame) => { if (ws.readyState === 1) { const text = JSON.stringify(frame); trace('out', text); ws.send(text); } };
    const closeIde = (code, reason) => { try { ws.close(code, String(reason || '').slice(0, 100)); } catch { /* closed */ } };
    let phase = 'hello';          // hello -> authed (welcome sent) -> joined
    let auth = null, conn = null, selfId = '', helloRid, roomId = '';
    const presence = new Map();   // memberId -> RemoteRoomMember (IDE shape)
    const agents = new Map();     // memberId -> AgentStatusSummary[]
    const pending = new Map();    // hub request id -> IDE request kind
    const chatAcks = [];          // rids of our own chat/emote frames, in order
    const timer = setTimeout(() => { if (phase === 'hello') closeIde(4001, 'Say hello first'); }, ctx.helloTimeoutMs || 10_000);

    const ideMember = (p) => {
        const m = { id: p.id, name: p.name, role: ideRole(p.role), pose: p.pose ? { ...p.pose } : { ...DEFAULT_POSE } };
        if (p.colour) m.colour = p.colour;
        if (p.voice) m.voice = { ...p.voice };
        const a = agents.get(p.id); if (a && a.length) m.agents = a;
        return m;
    };
    const pushPresence = () => raw({ t: 'presence', members: [...presence.values()].map(m => { const a = agents.get(m.id); return a && a.length ? { ...m, agents: a } : m; }) });
    const fromStations = (stations) => (stations || []).filter(s => IDE_AGENT_KINDS.includes(s.agent)).slice(0, 16).map(s => ({
        key: `${s.station}:${s.agent}`.slice(0, 80), desk: s.station, kind: s.agent,
        label: (s.detail || `${s.agent} · ${s.station}`).slice(0, 60), activity: TO_ACTIVITY[s.state] || 'idle'
    }));

    /** Hub -> IDE translation (the hub thinks this is the member's socket). */
    const fakeSocket = {
        get readyState() { return ws.readyState; },
        send(text) {
            let m; try { m = JSON.parse(text); } catch { return; }
            switch (m.type) {
                case 'welcome': {
                    selfId = m.self.id;
                    for (const p of m.presence || []) presence.set(p.id, ideMember(p));
                    for (const [id, stations] of Object.entries(m.agents || {})) agents.set(id, fromStations(stations));
                    phase = 'joined';
                    raw({ t: 'room', rid: 'join', roomId: m.room.id, roomName: m.room.name, selfId, members: [...presence.values()].map(ideMember), world: m.world });
                    return;
                }
                case 'presence-join': case 'presence-update': presence.set(m.member.id, ideMember(m.member)); pushPresence(); return;
                case 'presence-leave': presence.delete(m.id); agents.delete(m.id); pushPresence(); return;
                case 'pose': { const p = presence.get(m.id); if (p) { p.pose = { ...m.pose }; pushPresence(); } return; }
                case 'self': { const p = presence.get(m.self.id); if (p) { p.role = ideRole(m.self.role); p.name = m.self.name; pushPresence(); } return; }
                case 'chat': {
                    if (m.message.from === selfId) { const rid = chatAcks.shift(); if (rid) raw({ t: 'chat-ack', rid, message: m.message }); return; }
                    raw({ t: 'chat', message: m.message }); return;
                }
                case 'signal': raw({ t: 'signal', envelope: { from: m.from, fromSession: m.fromSession, kind: m.kind, data: m.data } }); return;
                case 'agent-status': { const list = fromStations(m.stations); agents.set(m.member, list); raw({ t: 'agents', memberId: m.member, agents: list }); return; }
                case 'world': raw({ t: 'world', world: m.world }); return;
                case 'reply': {
                    const kind = pending.get(m.id); pending.delete(m.id);
                    if (kind === 'world-get') raw({ t: 'world', rid: m.id, world: m.world });
                    else if (kind === 'world-ops') raw({ t: 'world-ack', rid: m.id, revision: m.revision });
                    else if (kind === 'invite-create') raw({ t: 'invite', rid: m.id, link: ideInviteLink(origin, roomId, m.token), expiresAt: m.invite.expiresAt, role: m.invite.role });
                    else if (kind && kind.startsWith('member-role:')) { const [, member, role] = kind.split(':'); raw({ t: 'role-ack', rid: m.id, member, role }); }
                    return;
                }
                case 'error': {
                    if (m.id) { pending.delete(m.id); const i = chatAcks.indexOf(m.id); if (i >= 0) chatAcks.splice(i, 1); }
                    const out = { t: 'error', code: ERROR_CODE[m.code] || 'server', message: String(m.error || 'Room server error.').slice(0, 500) };
                    if (m.id && RID_RE.test(m.id)) out.rid = m.id;
                    if (Number.isInteger(m.revision)) out.revision = m.revision;
                    raw(out); return;
                }
                default: return; // member-added/updated/removed: the presence frames already cover the room view
            }
        },
        close(code, reason) { closeIde(CLOSE_MAP[code] || 4005, reason); }
    };

    const toHub = async (msg) => { if (conn) { try { await hub.handle(conn, JSON.stringify(msg)); } catch (e) { log('ide handler error', e.message); } } };

    async function onHello(f) {
        if (f.proto !== IDE_PROTO) { raw({ t: 'error', rid: f.rid, code: 'version', message: `Protocol ${IDE_PROTO} required.`, fatal: true }); return closeIde(4003, 'version'); }
        helloRid = typeof f.rid === 'string' && RID_RE.test(f.rid) ? f.rid : undefined;
        const a = f.auth || {};
        roomId = typeof a.roomId === 'string' ? a.roomId : '';
        const deny = (code, message) => { authFail.take(ip); raw({ t: 'error', rid: helloRid, code, message, fatal: true }); closeIde(4001, code); };
        if (!U.ROOM_ID_RE.test(roomId)) return deny('auth', 'Unknown room.');
        if (!authFail.has(ip)) { raw({ t: 'error', rid: helloRid, code: 'rate', message: 'Too many failed sign-ins. Wait.', fatal: true }); return closeIde(4008, 'rate'); }
        let token;
        if (a.kind === 'invite') {
            // The hub redeems with a name; the IDE sends its name in `join`, so redeem with a placeholder and rename on join.
            try { token = (await hub.redeemInvite(String(a.invite || ''), `Guest ${crypto.randomBytes(2).toString('hex')}`)).token; }
            catch (e) { return deny('invite-expired', e.message); }
        } else if (a.kind === 'owner') token = String(a.ownerToken || '');
        else if (a.kind === 'member') token = String(a.token || '');
        else return deny('auth', 'Invalid credentials.');
        const found = await hub.authenticate(token);
        if (!found || found.r.rec.id !== roomId) return deny('auth', a.kind === 'owner' ? 'Owner key not accepted for this room.' : 'Room key not accepted.');
        if (a.kind === 'owner' && found.member.role !== 'owner') return deny('auth', 'That key is not the room owner key.');
        if (ws.readyState !== 1) return;
        // "Start a new room from my current room layout": only an owner, only while the room world was never edited.
        if (a.kind === 'owner' && a.seedWorld && found.r.rec.world.revision === 0) {
            try {
                const { canonicalWorld, worldLeaks } = require('./world-guard.cjs');
                const W = require('../vendor/world-model.cjs');
                const seed = canonicalWorld({ ...JSON.parse(JSON.stringify(a.seedWorld)), revision: 0 });
                if (W.validateWorld(seed).ok && !worldLeaks(seed)) { found.r.rec.world = seed; hub.saveNow(found.r); }
            } catch (e) { log('ide seed world refused', e.message); }
        }
        auth = found; phase = 'authed'; clearTimeout(timer);
        raw({ t: 'welcome', rid: helloRid, proto: IDE_PROTO, roomId, roomName: found.r.rec.name, memberId: found.member.id, role: ideRole(found.member.role), memberToken: token, serverTime: Date.now() });
    }

    function onJoin(f) {
        let name;
        try { name = U.displayName(f.name); } catch (e) { raw({ t: 'error', rid: f.rid, code: 'bad-frame', message: e.message, fatal: true }); return closeIde(4005, 'bad name'); }
        const hello = { name };
        if (typeof f.colour === 'string') hello.colour = f.colour;
        conn = hub.attach(fakeSocket, auth, hello, ip);
        if (conn && Array.isArray(f.agents) && f.agents.length) onAgents(f.agents);
    }
    function onAgents(list) {
        const byDesk = new Map();
        for (const a of Array.isArray(list) ? list : []) if (a && typeof a.desk === 'string' && !byDesk.has(a.desk)) byDesk.set(a.desk, { station: a.desk, state: TO_STATE[a.activity] || 'idle', agent: a.kind, detail: a.label });
        void toHub({ type: 'agent-status', stations: [...byDesk.values()].slice(0, 16) });
    }

    ws.on('message', async (data, isBinary) => {
        if (isBinary) return closeIde(4005, 'Text frames only');
        trace('in', data.toString('utf8'));
        let f; try { f = JSON.parse(data.toString('utf8')); } catch { raw({ t: 'error', code: 'bad-frame', message: 'Frame is not JSON.' }); return; }
        if (!f || typeof f !== 'object' || typeof f.t !== 'string') { raw({ t: 'error', code: 'bad-frame', message: 'Frame has no type.' }); return; }
        if (phase === 'hello') { if (f.t !== 'hello') return closeIde(4001, 'Say hello first'); phase = 'authing'; return onHello(f); }
        if (phase === 'authing') return closeIde(4005, 'Wait for welcome');
        if (phase === 'authed') { if (f.t === 'join') return onJoin(f); raw({ t: 'error', rid: f.rid, code: 'not-joined', message: 'Join the room first.' }); return; }
        const rid = typeof f.rid === 'string' && RID_RE.test(f.rid) ? f.rid : undefined;
        switch (f.t) {
            case 'ping': raw({ t: 'pong', at: typeof f.at === 'number' ? f.at : 0, serverTime: Date.now() }); return;
            case 'pose': return toHub({ type: 'pose', pose: f.pose });
            case 'colour': return toHub({ type: 'colour', colour: f.colour });
            case 'voice-status': return toHub({ type: 'voice', status: f.status ?? null });
            case 'signal': return toHub({ type: 'signal', ...(f.signal || {}) });
            case 'agents': return onAgents(f.agents);
            case 'chat': if (rid) chatAcks.push(rid); return toHub({ type: 'chat', id: rid, text: f.text });
            case 'emote': if (rid) chatAcks.push(rid); return toHub({ type: 'emote', id: rid, emote: f.emote });
            case 'world-get': if (rid) pending.set(rid, 'world-get'); return toHub({ type: 'world-get', id: rid });
            case 'world-ops': if (rid) pending.set(rid, 'world-ops'); return toHub({ type: 'world-ops', id: rid, baseRevision: f.baseRevision, ops: f.ops });
            case 'invite-create': {
                if (rid) pending.set(rid, 'invite-create');
                // t3:mp2: the owner picks the role (viewer/member/builder). No role = builder (older IDE clients edited the world).
                const role = INVITE_ROLES.includes(f.role) ? f.role : 'builder';
                return toHub({ type: 'invite-create', id: rid, role, ttl: Number.isInteger(f.ttlMinutes) ? `${f.ttlMinutes}m` : undefined });
            }
            case 'member-role': { // t3:mp2: owner changes a member's role (hub checks owner + valid role)
                if (rid && typeof f.member === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(f.member) && INVITE_ROLES.includes(f.role)) pending.set(rid, `member-role:${f.member}:${f.role}`);
                return toHub({ type: 'member-role', id: rid, member: f.member, role: f.role });
            }
            case 'leave': return closeIde(1000, 'left');
            default: return; // unknown types are ignored (forward compatibility)
        }
    });
    ws.on('close', () => { clearTimeout(timer); if (conn) hub.detach(conn); });
    ws.on('error', () => { /* close follows */ });
}

module.exports = { IDE_WS_PATH, IDE_INVITE_PATH, serveIdeSocket, ideInviteLink };
