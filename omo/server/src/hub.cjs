'use strict';
// The live room hub: authenticated sockets, presence, chat, emotes, voice signalling relay, agent
// status summaries and the shared WorldSpec with revision-based optimistic concurrency.
// Terminals are NEVER shared: there is no message type for terminal data, input or screens.
const crypto = require('crypto');
const U = require('./util.cjs');
const P = require('../vendor/presence-protocol.cjs');
const { applyBatch } = require('./world-guard.cjs');
const { issueInvite } = require('./store.cjs');
const { PROTOCOL_VERSION, LIMITS, MIN_ROLE, parseClient } = require('./protocol.cjs');
const { Buckets } = require('./rate.cjs');

const CLOSE = Object.freeze({ normal: 1000, policy: 1008, tooBig: 1009, auth: 4001, forbidden: 4003, replaced: 4009, rate: 4029, full: 4030, removed: 4040, shutdown: 1001 });

class Semaphore {
    constructor(n) { this.n = n; this.q = []; }
    async run(fn) {
        if (this.n <= 0) await new Promise(r => this.q.push(r));
        this.n--;
        try { return await fn(); } finally { this.n++; const next = this.q.shift(); if (next) next(); }
    }
}

class Hub {
    constructor({ data, log = () => {}, publicUrl }) {
        this.data = data; this.log = log; this.publicUrl = publicUrl;
        this.rooms = new Map();     // roomId -> live room { rec, conns: Map<memberId, conn>, chat: [], agents: Map, saveTimer }
        this.authCache = new Map(); // sha256(token) -> { roomId, memberId, tokenHash }
        this.scrypt = new Semaphore(4);
        this.rate = {
            pose: new Buckets({ capacity: 40, perSecond: 20 }),
            chat: new Buckets({ capacity: P.CHAT_RATE_COUNT, perSecond: P.CHAT_RATE_COUNT / (P.CHAT_RATE_WINDOW_MS / 1000) }),
            emote: new Buckets({ capacity: 6, perSecond: 0.5 }),
            signal: new Buckets({ capacity: 200, perSecond: 50 }),
            world: new Buckets({ capacity: 10, perSecond: 1 }),
            admin: new Buckets({ capacity: 20, perSecond: 0.2 }),
            agent: new Buckets({ capacity: 10, perSecond: 2 }),
            misc: new Buckets({ capacity: 30, perSecond: 10 })
        };
    }

    // ---------- rooms ----------
    live(roomId) {
        let r = this.rooms.get(roomId);
        if (r) return r;
        if (!this.data.exists(roomId)) return null;
        r = { rec: this.data.read(roomId), conns: new Map(), chat: [], agents: new Map(), saveTimer: null };
        this.rooms.set(roomId, r);
        return r;
    }
    saveNow(r) { if (r.saveTimer) { clearTimeout(r.saveTimer); r.saveTimer = null; } this.data.write(r.rec); }
    saveSoon(r) {
        if (r.saveTimer) return;
        r.saveTimer = setTimeout(() => {
            r.saveTimer = null;
            try { this.data.write(r.rec); } catch (e) { this.log('save failed', r.rec.id, e.message); }
            if (r.conns.size === 0 && this.rooms.get(r.rec.id) === r) this.rooms.delete(r.rec.id); // unload idle rooms
        }, 2000);
        r.saveTimer.unref?.();
    }
    flushAll() { for (const r of this.rooms.values()) if (r.saveTimer) this.saveNow(r); }

    // ---------- accounts ----------
    /** Verify a bearer token. Returns { r, member } or null. scrypt runs through a small semaphore. */
    async authenticate(token) {
        const parsed = U.parseToken(token);
        if (!parsed) return null;
        const r = this.live(parsed.roomId);
        const member = r?.rec.members[parsed.memberId];
        if (!member) return null;
        const key = U.sha256(token);
        const cached = this.authCache.get(key);
        if (cached && cached.tokenHash === member.tokenHash) return { r, member };
        const ok = await this.scrypt.run(() => U.verifySecret(parsed.secret, member.tokenHash));
        if (!ok || r.rec.members[parsed.memberId] !== member) return null;
        if (this.authCache.size > 5000) this.authCache.clear();
        this.authCache.set(key, { tokenHash: member.tokenHash });
        return { r, member };
    }
    nameTaken(r, name, exceptId) { const k = name.toLowerCase(); return Object.values(r.rec.members).some(m => m.id !== exceptId && m.name.toLowerCase() === k); }

    /** Redeem a signed, expiring, single-use invite. Returns the new member's token (shown once). */
    async redeemInvite(inviteToken, rawName) {
        const name = U.displayName(rawName);
        let roomId;
        try { roomId = JSON.parse(Buffer.from(String(inviteToken).split('.')[1] || '', 'base64url').toString('utf8')).r; } catch { /* fallthrough */ }
        const r = U.ROOM_ID_RE.test(roomId || '') ? this.live(roomId) : null;
        const bad = new Error('This invite is invalid, expired, revoked or already used.');
        if (!r) throw bad;
        const payload = U.verifyInvite(Buffer.from(r.rec.inviteKey, 'hex'), inviteToken);
        if (!payload || payload.r !== r.rec.id || payload.exp <= Date.now() || r.rec.usedInvites[payload.i] || r.rec.revokedInvites[payload.i]) throw bad;
        const record = this.data.readInviteRecords(r.rec.id).find(x => x.id === payload.i);
        if (!record || record.revokedAt || record.usedAt || record.role !== payload.role || record.expiresAt !== payload.exp) throw bad;
        if (Object.keys(r.rec.members).length >= LIMITS.maxMembersPerRoom) throw new Error('This room is full.');
        if (this.nameTaken(r, name)) throw new Error('That name is already used in this room. Choose another.');
        const memberId = U.newMemberId(), secret = U.newSecret(), now = Date.now();
        r.rec.usedInvites[payload.i] = { at: now, member: memberId };   // reserve synchronously: single use even across awaits
        let tokenHash;
        try { tokenHash = await this.scrypt.run(() => U.hashSecret(secret)); } catch (e) { delete r.rec.usedInvites[payload.i]; throw e; }
        r.rec.members[memberId] = { id: memberId, name, role: payload.role, tokenHash, createdAt: now, lastSeenAt: 0, via: payload.i };
        this.saveNow(r);
        try { this.data.writeInviteRecord(r.rec.id, { ...record, usedAt: now, usedBy: memberId }); } catch (e) { this.log('invite record update failed', e.message); }
        this.data.audit({ event: 'invite-used', room: r.rec.id, invite: payload.i, member: memberId, role: payload.role });
        this.broadcast(r, { type: 'member-added', member: this.publicMember(r, r.rec.members[memberId]) });
        return { roomId: r.rec.id, roomName: r.rec.name, memberId, role: payload.role, name, token: U.formatToken(r.rec.id, memberId, secret) };
    }

    // ---------- views ----------
    publicMember(r, m) { return { id: m.id, name: m.name, role: m.role, online: r.conns.has(m.id) }; }
    presenceOf(conn) {
        const out = { id: conn.member.id, name: conn.member.name, role: conn.member.role, colour: conn.colour };
        if (conn.pose) out.pose = conn.pose;
        if (conn.voice) out.voice = { ...conn.voice };
        return out;
    }
    welcome(r, conn) {
        const agents = {};
        for (const [id, stations] of r.agents) if (r.conns.has(id)) agents[id] = stations;
        return {
            type: 'welcome', protocol: PROTOCOL_VERSION,
            room: { id: r.rec.id, name: r.rec.name },
            self: { id: conn.member.id, name: conn.member.name, role: conn.member.role, colour: conn.colour },
            world: r.rec.world,
            presence: [...r.conns.values()].map(c => this.presenceOf(c)),
            members: Object.values(r.rec.members).map(m => this.publicMember(r, m)),
            chat: r.chat.slice(-LIMITS.chatBacklog),
            agents,
            limits: { maxFrameBytes: LIMITS.maxFrameBytes, chatTextMax: P.CHAT_TEXT_MAX, voiceSignalMax: P.VOICE_SIGNAL_MAX_CHARS }
        };
    }

    // ---------- sockets ----------
    send(conn, msg) { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg)); }
    broadcast(r, msg, exceptId) { const text = JSON.stringify(msg); for (const [id, c] of r.conns) if (id !== exceptId && c.ws.readyState === 1) c.ws.send(text); }

    /** Attach an authenticated socket. Replaces an older socket of the same member. */
    attach(ws, auth, hello, ip) {
        const { r, member } = auth;
        if (!r.conns.has(member.id) && r.conns.size >= LIMITS.maxOnlinePerRoom) { ws.close(CLOSE.full, 'Room is full'); return null; }
        if (hello.name && hello.name !== member.name) {
            if (this.nameTaken(r, hello.name, member.id)) { ws.close(CLOSE.policy, 'Name already used in this room'); return null; }
            member.name = hello.name;
        }
        const old = r.conns.get(member.id);
        const conn = { ws, r, member, ip, colour: hello.colour || old?.colour || P.PRESENCE_COLOURS[parseInt(member.id.slice(2, 4), 16) % P.PRESENCE_COLOURS.length], pose: hello.pose, voice: null, strikes: 0 };
        if (old) { old.replaced = true; old.ws.close(CLOSE.replaced, 'Signed in elsewhere'); }
        r.conns.set(member.id, conn);
        member.lastSeenAt = Date.now(); this.saveSoon(r);
        this.send(conn, this.welcome(r, conn));
        this.broadcast(r, { type: 'presence-join', member: this.presenceOf(conn) }, member.id);
        this.log('join', r.rec.id, member.id, member.role);
        return conn;
    }
    detach(conn) {
        const { r, member } = conn;
        if (r.conns.get(member.id) !== conn) return;
        r.conns.delete(member.id);
        r.agents.delete(member.id);
        member.lastSeenAt = Date.now(); this.saveSoon(r);
        this.broadcast(r, { type: 'presence-leave', id: member.id });
        if (r.conns.size === 0 && !r.saveTimer) this.rooms.delete(r.rec.id); // unload idle rooms (chat backlog is memory-only)
    }

    reply(conn, id, body) { this.send(conn, { type: 'reply', id, ok: true, ...body }); }
    fail(conn, id, error, extra = {}) { this.send(conn, { type: 'error', id, error, ...extra }); }
    limited(conn, bucket, id) {
        if (this.rate[bucket].take(`${conn.r.rec.id}:${conn.member.id}`)) return false;
        conn.strikes++;
        this.fail(conn, id, 'Slow down.', { code: 'rate' });
        if (conn.strikes > 50) conn.ws.close(CLOSE.rate, 'Rate limit');
        return true;
    }

    /** Handle one text frame from an authenticated connection. */
    async handle(conn, text) {
        const { r } = conn;
        let m;
        try { m = parseClient(text, r.rec.world.shell); } catch (e) { conn.strikes++; this.fail(conn, undefined, e.message, { code: 'bad-request' }); if (conn.strikes > 50) conn.ws.close(CLOSE.policy, 'Too many bad frames'); return; }
        const member = r.rec.members[conn.member.id];
        if (!member) { conn.ws.close(CLOSE.removed, 'Removed from room'); return; }
        conn.member = member;
        const need = MIN_ROLE[m.type];
        if (!need || !U.atLeast(member.role, need)) { this.fail(conn, m.id, `Your role (${member.role}) cannot do that.`, { code: 'forbidden' }); return; }
        switch (m.type) {
            case 'ping': this.reply(conn, m.id, { at: Date.now() }); return;
            case 'pose':
                if (this.limited(conn, 'pose', m.id)) return;
                conn.pose = m.pose;
                this.broadcast(r, { type: 'pose', id: member.id, pose: m.pose }, member.id);
                return;
            case 'colour':
                if (this.limited(conn, 'misc', m.id)) return;
                conn.colour = m.colour;
                this.broadcast(r, { type: 'presence-update', member: this.presenceOf(conn) });
                return;
            case 'emote': {
                if (this.limited(conn, 'emote', m.id)) return;
                const msg = this.chatMessage(conn, { kind: 'emote', emote: m.emote });
                this.broadcast(r, { type: 'chat', message: msg });
                return;
            }
            case 'chat': {
                if (this.limited(conn, 'chat', m.id)) return;
                if (U.looksSecret(m.say.text)) { this.fail(conn, m.id, 'That message looks like it holds a secret, token or file path. It was not sent.', { code: 'secret' }); return; }
                const msg = this.chatMessage(conn, m.say);
                r.chat.push(msg); if (r.chat.length > LIMITS.chatBacklog) r.chat.splice(0, r.chat.length - LIMITS.chatBacklog);
                this.broadcast(r, { type: 'chat', message: msg });
                return;
            }
            case 'voice': {
                if (this.limited(conn, 'misc', m.id)) return;
                const prev = conn.voice?.session;
                conn.voice = m.status;
                if (prev && prev !== m.status?.session) this.broadcast(r, { type: 'signal', from: member.id, fromSession: prev, kind: 'bye', data: '' }, member.id);
                this.broadcast(r, { type: 'presence-update', member: this.presenceOf(conn) });
                return;
            }
            case 'signal': {
                if (this.limited(conn, 'signal', m.id)) return;
                const s = m.signal;
                if (!conn.voice || conn.voice.session !== s.session) { this.fail(conn, m.id, 'Turn on voice first.', { code: 'voice-off' }); return; }
                const target = r.conns.get(s.to);
                // Members only: viewers never take part in voice, and only same-room, voice-enabled peers are reachable.
                if (!target || target === conn || !U.atLeast(target.member.role, 'member') || !target.voice || target.voice.session !== s.toSession) return; // stale peer: drop quietly
                this.send(target, { type: 'signal', from: member.id, fromSession: s.session, kind: s.kind, data: s.data });
                return;
            }
            case 'agent-status': {
                if (this.limited(conn, 'agent', m.id)) return;
                r.agents.set(member.id, m.stations);
                this.broadcast(r, { type: 'agent-status', member: member.id, stations: m.stations });
                return;
            }
            case 'world-get': this.reply(conn, m.id, { world: r.rec.world }); return;
            case 'world-ops': {
                if (this.limited(conn, 'world', m.id)) return;
                const ops = Array.isArray(m.ops) ? m.ops : [];
                if (member.role !== 'owner' && ops.some(o => o && o.op === 'update-station' && o.station && typeof o.station === 'object' && 'locked' in o.station)) {
                    this.fail(conn, m.id, 'Only the room owner can lock or unlock desks.', { code: 'forbidden' }); return;
                }
                const res = applyBatch(r.rec.world, m.baseRevision, m.ops);
                if (!res.ok) { this.fail(conn, m.id, res.error, { code: res.conflict ? 'conflict' : 'invalid', revision: r.rec.world.revision }); return; }
                r.rec.world = res.world;
                this.saveNow(r); // durable before anyone sees it
                this.reply(conn, m.id, { revision: res.world.revision });
                this.broadcast(r, { type: 'world', world: res.world, by: member.id, ops: res.ops });
                this.data.audit({ event: 'world-ops', room: r.rec.id, member: member.id, revision: res.world.revision, ops: res.ops.map(o => o.op) });
                return;
            }
            case 'rotate-token': {
                if (this.limited(conn, 'admin', m.id)) return;
                const secret = U.newSecret();
                member.tokenHash = await this.scrypt.run(() => U.hashSecret(secret));
                this.saveNow(r);
                this.data.audit({ event: 'token-rotated', room: r.rec.id, member: member.id });
                this.reply(conn, m.id, { token: U.formatToken(r.rec.id, member.id, secret) });
                return;
            }
            case 'invite-create': {
                if (this.limited(conn, 'admin', m.id)) return;
                const out = issueInvite(this.data, r.rec, { role: m.role, ttlMs: m.ttlMs, note: m.note, createdBy: member.id, publicUrl: this.publicUrl });
                this.reply(conn, m.id, { invite: out.record, token: out.token, link: out.link });
                return;
            }
            case 'invite-list': {
                const now = Date.now();
                const list = this.data.readInviteRecords(r.rec.id).map(x => ({ ...x, status: x.revokedAt || r.rec.revokedInvites[x.id] ? 'revoked' : x.usedAt || r.rec.usedInvites[x.id] ? 'used' : x.expiresAt <= now ? 'expired' : 'open' }));
                this.reply(conn, m.id, { invites: list });
                return;
            }
            case 'invite-revoke': {
                if (this.limited(conn, 'admin', m.id)) return;
                const rec = this.data.readInviteRecords(r.rec.id).find(x => x.id === m.invite);
                if (!rec) { this.fail(conn, m.id, 'No such invite.'); return; }
                r.rec.revokedInvites[m.invite] = { at: Date.now(), by: member.id };
                this.saveNow(r);
                this.data.writeInviteRecord(r.rec.id, { ...rec, revokedAt: Date.now() });
                this.data.audit({ event: 'invite-revoked', room: r.rec.id, invite: m.invite, by: member.id });
                this.reply(conn, m.id, {});
                return;
            }
            case 'member-list': this.reply(conn, m.id, { members: Object.values(r.rec.members).map(x => ({ ...this.publicMember(r, x), createdAt: x.createdAt, lastSeenAt: x.lastSeenAt })) }); return;
            case 'member-role': {
                if (this.limited(conn, 'admin', m.id)) return;
                const target = r.rec.members[m.member];
                if (!target || target.role === 'owner') { this.fail(conn, m.id, 'The owner role cannot be changed here.'); return; }
                target.role = m.role; this.saveNow(r);
                this.data.audit({ event: 'role-changed', room: r.rec.id, member: target.id, role: m.role, by: member.id });
                const c = r.conns.get(target.id);
                if (c) {
                    c.member = target;
                    if (!U.atLeast(m.role, 'member') && c.voice) { this.broadcast(r, { type: 'signal', from: target.id, fromSession: c.voice.session, kind: 'bye', data: '' }, target.id); c.voice = null; }
                    if (!U.atLeast(m.role, 'member')) r.agents.delete(target.id);
                    this.send(c, { type: 'self', self: { id: target.id, name: target.name, role: target.role, colour: c.colour } });
                    this.broadcast(r, { type: 'presence-update', member: this.presenceOf(c) });
                }
                this.broadcast(r, { type: 'member-updated', member: this.publicMember(r, target) });
                this.reply(conn, m.id, {});
                return;
            }
            case 'member-remove': {
                if (this.limited(conn, 'admin', m.id)) return;
                const target = r.rec.members[m.member];
                if (!target || target.role === 'owner') { this.fail(conn, m.id, 'The owner cannot be removed.'); return; }
                delete r.rec.members[target.id]; this.saveNow(r);
                this.data.audit({ event: 'member-removed', room: r.rec.id, member: target.id, by: member.id });
                const c = r.conns.get(target.id);
                if (c) c.ws.close(CLOSE.removed, 'Removed from room');
                this.broadcast(r, { type: 'member-removed', id: target.id });
                this.reply(conn, m.id, {});
                return;
            }
            default: this.fail(conn, m.id, 'Unknown message type.');
        }
    }
    chatMessage(conn, say) {
        const msg = { id: crypto.randomBytes(8).toString('hex'), from: conn.member.id, fromName: conn.member.name, colour: conn.colour, at: Date.now(), kind: say.kind };
        if (say.kind === 'text') msg.text = say.text; else msg.emote = say.emote;
        return msg;
    }
    closeAll() { for (const r of this.rooms.values()) for (const c of r.conns.values()) c.ws.close(CLOSE.shutdown, 'Server shutting down'); this.flushAll(); }
}

module.exports = { Hub, CLOSE };
