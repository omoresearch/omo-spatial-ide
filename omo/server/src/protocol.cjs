'use strict';
// Wire protocol of the Omo room server (JSON text frames over WSS). Bump PROTOCOL_VERSION on breaking change.
// Clients: see README.md "Protocol". Every client message is checked here before the hub touches it.
const P = require('../vendor/presence-protocol.cjs');
const U = require('./util.cjs');

const PROTOCOL_VERSION = 1;
const LIMITS = Object.freeze({
    maxFrameBytes: 256 * 1024,      // ws maxPayload (a 192 KiB world / op batch plus envelope) — w3:expand
    maxSmallFrameBytes: 24 * 1024,  // every message type except world-ops and signal
    helloTimeoutMs: 10_000,
    maxOnlinePerRoom: 32,
    maxMembersPerRoom: 256,
    maxSocketsPerIp: 16,
    maxSocketsTotal: 1024,
    chatBacklog: 30,
    agentStations: 16,
    agentDetailMax: 80
});
const AGENT_STATES = Object.freeze(['idle', 'working', 'waiting', 'needs-input', 'done', 'error', 'offline']);
/** Minimum role per client message type. */
const MIN_ROLE = Object.freeze({
    ping: 'viewer', pose: 'viewer', colour: 'viewer', emote: 'viewer', 'world-get': 'viewer', 'rotate-token': 'viewer',
    chat: 'member', voice: 'member', signal: 'member', 'agent-status': 'member',
    'world-ops': 'builder',
    'invite-create': 'owner', 'invite-list': 'owner', 'invite-revoke': 'owner', 'member-list': 'owner', 'member-role': 'owner', 'member-remove': 'owner'
});
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const reqId = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : undefined);

/** Pose bounds come from the shared world shell, not from the fixed v1 room. */
function pose(input, shell) {
    if (!isObj(input) || ![input.x, input.z, input.yaw, input.pitch].every(n => typeof n === 'number' && Number.isFinite(n))) throw new Error('Invalid room position.');
    if (Math.abs(input.x) > shell.width / 2 || Math.abs(input.z) > shell.depth / 2 || Math.abs(input.yaw) > Math.PI * 4 || Math.abs(input.pitch) > 1.6) throw new Error('Invalid room position.');
    return { x: input.x, z: input.z, yaw: input.yaw, pitch: input.pitch };
}
/** Agent status: an enum per desk plus a short label. Never terminal contents, prompts, paths or secrets. */
function agentStatus(input) {
    if (!Array.isArray(input) || input.length > LIMITS.agentStations) throw new Error(`Send at most ${LIMITS.agentStations} desk statuses.`);
    const seen = new Set();
    return input.map(s => {
        if (!isObj(s) || typeof s.station !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(s.station) || seen.has(s.station)) throw new Error('Invalid desk id.');
        seen.add(s.station);
        if (!AGENT_STATES.includes(s.state)) throw new Error(`Desk state must be one of ${AGENT_STATES.join(', ')}.`);
        const out = { station: s.station, state: s.state };
        const agent = s.agent === undefined ? undefined : String(s.agent);
        if (agent !== undefined) { if (!['hermes', 'claude', 'codex', 'shell', 'dsh'].includes(agent)) throw new Error('Unknown agent kind.'); out.agent = agent; }
        const detail = U.label(s.detail, LIMITS.agentDetailMax);
        if (detail !== undefined) { if (U.looksSecret(detail)) throw new Error('Status text must not contain secrets, tokens or file paths.'); out.detail = detail; }
        if (s.progress !== undefined) { if (typeof s.progress !== 'number' || !(s.progress >= 0 && s.progress <= 1)) throw new Error('Progress is 0–1.'); out.progress = Math.round(s.progress * 100) / 100; }
        return out;
    });
}

/** Parse and validate one client frame. Returns { type, id?, ...fields } or throws. */
function parseClient(text, shell) {
    if (typeof text !== 'string') throw new Error('Text frames only.');
    let m;
    try { m = JSON.parse(text); } catch { throw new Error('Frames are JSON.'); }
    if (!isObj(m) || typeof m.type !== 'string') throw new Error('Missing message type.');
    const id = reqId(m.id);
    const big = m.type === 'world-ops' || m.type === 'signal';
    if (!big && text.length > LIMITS.maxSmallFrameBytes) throw new Error('Message too large.');
    switch (m.type) {
        case 'hello': {
            if (typeof m.token !== 'string') throw new Error('hello needs a token.');
            const out = { type: 'hello', id, token: m.token, protocol: m.protocol };
            if (m.name !== undefined) out.name = U.displayName(m.name);
            if (m.colour !== undefined) out.colour = P.presenceColour(m.colour);
            if (m.pose !== undefined) out.pose = pose(m.pose, shell || { width: 40, depth: 40 });
            return out;
        }
        case 'ping': return { type: 'ping', id };
        case 'pose': return { type: 'pose', id, pose: pose(m.pose, shell) };
        case 'colour': return { type: 'colour', id, colour: P.presenceColour(m.colour) };
        case 'emote': {
            if (!P.CHAT_EMOTES.includes(m.emote)) throw new Error('Unknown emote.');
            return { type: 'emote', id, emote: m.emote };
        }
        case 'chat': return { type: 'chat', id, say: P.chatSay({ kind: 'text', text: m.text }) };
        case 'voice': return { type: 'voice', id, status: P.voiceStatus(m.status === undefined ? null : m.status) };
        case 'signal': {
            const s = P.voiceSignal({ to: m.to, toSession: m.toSession, session: m.session, kind: m.kind, data: m.data });
            if (!U.MEMBER_ID_RE.test(s.to)) throw new Error('Invalid voice signal address.');
            return { type: 'signal', id, signal: s };
        }
        case 'agent-status': return { type: 'agent-status', id, stations: agentStatus(m.stations) };
        case 'world-get': return { type: 'world-get', id };
        case 'world-ops': return { type: 'world-ops', id, baseRevision: m.baseRevision, ops: m.ops };
        case 'rotate-token': return { type: 'rotate-token', id };
        case 'invite-create': {
            const role = m.role === undefined ? 'member' : m.role;
            if (!U.INVITE_ROLES.includes(role)) throw new Error(`Invite role must be one of ${U.INVITE_ROLES.join(', ')}.`);
            return { type: 'invite-create', id, role, ttlMs: U.parseDuration(m.ttl, 24 * 3600e3), note: U.label(m.note, 80) };
        }
        case 'invite-list': case 'member-list': return { type: m.type, id };
        case 'invite-revoke': {
            if (!U.INVITE_ID_RE.test(m.invite || '')) throw new Error('Invalid invite id.');
            return { type: 'invite-revoke', id, invite: m.invite };
        }
        case 'member-role': {
            if (!U.MEMBER_ID_RE.test(m.member || '') || !U.INVITE_ROLES.includes(m.role)) throw new Error('Choose a member and one of viewer, member, builder.');
            return { type: 'member-role', id, member: m.member, role: m.role };
        }
        case 'member-remove': {
            if (!U.MEMBER_ID_RE.test(m.member || '')) throw new Error('Invalid member id.');
            return { type: 'member-remove', id, member: m.member };
        }
        default: throw new Error(`Unknown message type ${String(m.type).slice(0, 40)}.`);
    }
}

module.exports = { PROTOCOL_VERSION, LIMITS, AGENT_STATES, MIN_ROLE, parseClient, pose, agentStatus };
