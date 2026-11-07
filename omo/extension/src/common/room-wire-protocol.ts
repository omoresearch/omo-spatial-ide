/**
 * Omo remote room WIRE PROTOCOL v1 — the shared contract between the IDE backend (mp-client lane,
 * `node/remote-room-client.ts`) and the hosted room server (mp-server lane).
 *
 * Transport: ONE WebSocket per member connection, `wss://<host>[:port]${ROOM_WS_PATH}`.
 * `ws://` is accepted ONLY for loopback hosts (localhost / 127.0.0.1 / [::1]) during development.
 * Every frame is one UTF-8 JSON object (text frame), at most ROOM_FRAME_MAX_BYTES, with a string
 * discriminator `t`. Binary frames are a protocol error. Unknown `t` values MUST be ignored by the
 * receiver (forward compatibility) — but a frame whose known `t` has a bad shape is an error.
 *
 * Requests that expect a reply carry `rid` (client-chosen, 1..64 chars [A-Za-z0-9_-]). The server
 * echoes `rid` on the reply frame (`welcome`, `room`, `world-ack`, `chat-ack`, `invite`, `error`).
 *
 * Session order:
 *   client → hello            (first frame, within ROOM_HELLO_TIMEOUT_MS, carries credentials)
 *   server → welcome          (identity + a member token to store; or error + close 4001)
 *   client → join             (display name, optional colour, optional agents)
 *   server → room             (members + world snapshot with revision) — the client is now joined
 *   ... any order: pose, voice-status, colour, chat, emote, signal, agents, world-ops, world-get, ping
 *   server → presence | world | world-applied | chat | signal | agents | pong | error  (pushes)
 *   client → leave            (server removes the member and closes with 1000)
 *
 * Security rules (both lanes):
 *  - Credentials travel ONLY inside the `hello` frame body — never in the URL, query string,
 *    sub-protocol header or logs. Server compares tokens in constant time.
 *  - The member token returned in `welcome` is a bearer secret. The IDE stores it in the Theia
 *    config dir with file mode 0600; never in browser localStorage, never inside a WorldSpec.
 *  - No terminal contents, keystrokes, file paths or agent output ever cross this wire. Agent
 *    status is a closed-vocabulary summary only. Voice is signalling only (audio is peer to peer).
 *  - The server is the authority for world revisions: it applies `world-ops` with `applyWorldOps`
 *    from `world-model.ts` and rejects stale `baseRevision` with code `conflict`.
 *  - No op, chat line or signal ever starts an agent or types into a terminal.
 */
import type { PlayerPose } from './player-state';
import type { WorldOp, WorldSpec } from './world-model';
import { validateWorld, WORLD_MAX_BYTES } from './world-model';
import type { ChatEmote, ChatMessage, ChatSay, PresenceColour, RoomMember, VoiceSignal, VoiceSignalEnvelope, VoiceStatus } from './presence-protocol';
import { CHAT_EMOTES, PRESENCE_COLOURS, chatSay, presenceColour, voiceSignal, voiceStatus } from './presence-protocol';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const ROOM_WIRE_VERSION = 1 as const;
/** WebSocket endpoint path on the room server. */
export const ROOM_WS_PATH = '/omo-room/v1/ws';
/** Invite links are `https://<host>[:port]${ROOM_INVITE_PATH}<roomId>#invite=<code>` (code in the fragment, so it never reaches HTTP logs). */
export const ROOM_INVITE_PATH = '/omo-room/join/';
/** Largest accepted frame (JSON text). Must hold a full world (WORLD_MAX_BYTES) plus envelope. */
export const ROOM_FRAME_MAX_BYTES = WORLD_MAX_BYTES + 16 * 1024;
/** The client must send `hello` within this time or the server closes with 4001. */
export const ROOM_HELLO_TIMEOUT_MS = 10_000;
/** Client sends `ping` at this interval; server closes a socket silent for 3 intervals. */
export const ROOM_PING_INTERVAL_MS = 15_000;
/** Max members per room (server enforces, error `room-full`). */
export const ROOM_MAX_MEMBERS = 16;
/** Client sends at most this many `pose` frames per second; server may drop the excess quietly. */
export const ROOM_POSE_MAX_HZ = 10;
/** Max ops in one `world-ops` batch. */
export const ROOM_WORLD_OPS_MAX = 64;
/** Max agent summaries one member publishes. */
export const ROOM_AGENTS_MAX = 16;
/** Room ids: same shape as the local presence room code. */
export const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
/** Server-issued member ids. */
export const ROOM_MEMBER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** Invite codes, member tokens and owner tokens: opaque URL-safe strings. t2:pkg: '.' allowed (the room server's keys are `omo1.<room>.<member>.<secret>`, invites `omoinv1.<payload>.<sig>`). */
export const ROOM_SECRET_RE = /^[A-Za-z0-9_.-]{16,256}$/;
const RID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Half of the largest WorldShell size (40 m): poses are room-space metres, clamped by the world, not the v1 room. */
export const ROOM_POSE_LIMIT_M = 20;

/**
 * WebSocket close codes. Codes in ROOM_CLOSE_FINAL mean "do NOT auto-reconnect"; any other close
 * (network drop, 1001, 1006, 1011, 4008, 4009) is retried by the client with backoff.
 */
export const ROOM_CLOSE = {
    normal: 1000,
    /** Bad or expired credentials, or no hello in time. */
    auth: 4001,
    /** Another connection logged in with the same member token (e.g. second tab). */
    replaced: 4002,
    /** Unsupported protocol version. */
    version: 4003,
    /** The owner removed this member, or the room was closed. */
    removed: 4004,
    /** Protocol violation (bad frame). */
    protocol: 4005,
    /** Rate limit exceeded; reconnect after backoff. */
    rate: 4008,
    /** Server restarting; reconnect after backoff. */
    restart: 4009
} as const;
export const ROOM_CLOSE_FINAL: readonly number[] = [ROOM_CLOSE.auth, ROOM_CLOSE.replaced, ROOM_CLOSE.version, ROOM_CLOSE.removed, ROOM_CLOSE.protocol];

// ---------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------

export type RoomRole = 'owner' | 'member';

/**
 * Agent status summary: what a member's local agent tabs are doing, for the HUD of OTHER members.
 * Closed vocabulary only. Never terminal text, prompts, file names or output.
 */
export type AgentSummaryKind = 'hermes' | 'claude' | 'codex' | 'dsh';
export type AgentSummaryActivity = 'working' | 'idle' | 'background' | 'sleeping' | 'interrupted' | 'exited';
export interface AgentStatusSummary {
    /** Stable per member, [a-z0-9:-], e.g. `terminal:tab-3`. */
    key: string;
    /** The member's desk/station id in the shared world (WorldSpec station id). */
    desk: string;
    kind: AgentSummaryKind;
    /** Short display label, e.g. "Hermes · Desk one" (≤ 60 chars, one line). */
    label: string;
    activity: AgentSummaryActivity;
}

/** A member as the server reports it. Extends the local RoomMember, so avatars and the HUD reuse it. */
export interface RemoteRoomMember extends RoomMember {
    role: RoomRole;
    /** Latest agent summaries this member published (omitted = none). */
    agents?: AgentStatusSummary[];
}

/**
 * Credentials in `hello`:
 *  - `invite`: first join from an invite link. Server redeems the code and issues a member token.
 *  - `member`: reconnect with a stored member token (same member id as before).
 *  - `owner`: host the room. The owner token is configured on the server. If the room does not exist
 *    it is created, seeded with `seedWorld` (validated) or an empty default world.
 */
export type RoomAuth =
    | { kind: 'invite'; roomId: string; invite: string }
    | { kind: 'member'; roomId: string; token: string }
    | { kind: 'owner'; roomId: string; ownerToken: string; roomName?: string; seedWorld?: WorldSpec };

export type RoomErrorCode =
    | 'bad-frame'      // shape/size/JSON error
    | 'version'        // unsupported proto
    | 'auth'           // bad credentials (fatal)
    | 'invite-expired' // invite used up or expired (fatal)
    | 'forbidden'      // e.g. member tried an owner-only action
    | 'not-joined'     // frame before join
    | 'room-full'
    | 'rate'           // too many frames; the frame was dropped
    | 'conflict'       // world-ops baseRevision != current revision; carries `revision`
    | 'invalid-ops'    // applyWorldOps refused; carries `message`
    | 'not-found'      // signal target gone, unknown room
    | 'server';

// ---------------------------------------------------------------------------------------------
// Client → server frames
// ---------------------------------------------------------------------------------------------

/** hello/auth. MUST be the first frame. */
export interface HelloFrame { t: 'hello'; rid?: string; proto: typeof ROOM_WIRE_VERSION; client: { app: 'omo-ide'; version: string }; auth: RoomAuth }
/** Join the room after `welcome`. `name` 1–32 chars; `colour` optional preference. */
export interface JoinFrame { t: 'join'; rid?: string; name: string; colour?: PresenceColour; agents?: AgentStatusSummary[] }
/** Presence update: this member's pose (see `wirePose` for bounds). Fire and forget. */
export interface PoseFrame { t: 'pose'; pose: PlayerPose }
/** Publish (status) or clear (null) this member's voice status. */
export interface VoiceStatusFrame { t: 'voice-status'; status: VoiceStatus | null }
/** Choose a name-tag colour. */
export interface ColourFrame { t: 'colour'; colour: PresenceColour }
/** One chat line. Server replies `chat-ack` (rid) and pushes `chat` to the OTHER members. */
export interface ChatFrame { t: 'chat'; rid?: string; text: string }
/** One emote. Same delivery as chat (the pushed ChatMessage has kind 'emote'). */
export interface EmoteFrame { t: 'emote'; rid?: string; emote: ChatEmote }
/** Voice signalling addressed to one member id (`signal.to`) and its voice session. */
export interface SignalFrame { t: 'signal'; signal: VoiceSignal }
/** Replace this member's agent status summaries. */
export interface AgentsFrame { t: 'agents'; agents: AgentStatusSummary[] }
/** Ask for the current world snapshot (server replies `world` with the rid). */
export interface WorldGetFrame { t: 'world-get'; rid?: string }
/**
 * World ops batch. Applied atomically with `applyWorldOps` iff `baseRevision` equals the current
 * revision. Reply: `world-ack` (new revision) or `error` code `conflict` (with current `revision`;
 * the client refreshes via `world-get` / the pushed `world`, re-applies its preview and asks the user
 * again) or `invalid-ops`. Members may edit unless the server is configured owner-only (`forbidden`).
 */
export interface WorldOpsFrame { t: 'world-ops'; rid: string; baseRevision: number; ops: WorldOp[] }
/** Owner only: mint an invite link. */
export interface InviteCreateFrame { t: 'invite-create'; rid: string; ttlMinutes?: number; maxUses?: number }
export interface PingFrame { t: 'ping'; at: number }
/** Leave the room for good (server closes with 1000). Closing the socket without leave = transient. */
export interface LeaveFrame { t: 'leave' }

export type RoomClientFrame = HelloFrame | JoinFrame | PoseFrame | VoiceStatusFrame | ColourFrame | ChatFrame | EmoteFrame
    | SignalFrame | AgentsFrame | WorldGetFrame | WorldOpsFrame | InviteCreateFrame | PingFrame | LeaveFrame;

// ---------------------------------------------------------------------------------------------
// Server → client frames
// ---------------------------------------------------------------------------------------------

/**
 * Reply to hello. `memberToken` is the bearer secret for future `member` auth (stable per member;
 * the server may rotate it — the client always stores the latest one it receives).
 */
export interface WelcomeFrame {
    t: 'welcome'; rid?: string; proto: typeof ROOM_WIRE_VERSION;
    roomId: string; roomName: string; memberId: string; role: RoomRole; memberToken: string; serverTime: number;
}
/** Reply to join: full room snapshot including the shared world (with its revision). */
export interface RoomFrame { t: 'room'; rid?: string; roomId: string; roomName: string; selfId: string; members: RemoteRoomMember[]; world: WorldSpec }
/** Presence push: the full member list (sent on change, throttled to ≤ 10 Hz by the server). */
export interface PresenceFrame { t: 'presence'; members: RemoteRoomMember[] }
/** World snapshot (reply to world-get, or pushed after a conflict / server-side reset). */
export interface WorldFrame { t: 'world'; rid?: string; world: WorldSpec }
/** Reply to the sender of a successful world-ops. */
export interface WorldAckFrame { t: 'world-ack'; rid: string; revision: number }
/** Pushed to every member (including the sender) after a batch applied: replay `ops` on `baseRevision` to reach `revision`. */
export interface WorldAppliedFrame { t: 'world-applied'; by: string; baseRevision: number; revision: number; ops: WorldOp[] }
/** A chat line or emote from another member (never echoed to the sender; the sender gets chat-ack). */
export interface ChatPushFrame { t: 'chat'; message: ChatMessage }
export interface ChatAckFrame { t: 'chat-ack'; rid: string; message: ChatMessage }
/** Voice signalling relayed from `envelope.from`. */
export interface SignalPushFrame { t: 'signal'; envelope: VoiceSignalEnvelope }
/** One member's agent summaries changed. */
export interface AgentsPushFrame { t: 'agents'; memberId: string; agents: AgentStatusSummary[] }
/** Owner-only reply: the invite link to share. */
export interface InviteFrame { t: 'invite'; rid: string; link: string; expiresAt: number; maxUses?: number }
export interface PongFrame { t: 'pong'; at: number; serverTime: number }
/**
 * Error. With `rid` it answers that request; without, it is about the connection. `fatal: true`
 * is followed by a close with a ROOM_CLOSE_FINAL code. `revision` accompanies `conflict`.
 */
export interface ErrorFrame { t: 'error'; rid?: string; code: RoomErrorCode; message: string; fatal?: boolean; revision?: number }

export type RoomServerFrame = WelcomeFrame | RoomFrame | PresenceFrame | WorldFrame | WorldAckFrame | WorldAppliedFrame
    | ChatPushFrame | ChatAckFrame | SignalPushFrame | AgentsPushFrame | InviteFrame | PongFrame | ErrorFrame;

// ---------------------------------------------------------------------------------------------
// URLs and invite links
// ---------------------------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Normalise a server URL (https/wss/http/ws) to its WebSocket endpoint. http/ws only for loopback. */
export function roomSocketUrl(serverUrl: string): string {
    let url: URL;
    try { url = new URL(serverUrl.trim()); } catch { throw new Error('Enter a valid server address, like https://rooms.example.com.'); }
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const plain = url.protocol === 'http:' || url.protocol === 'ws:';
    if (!secure && !plain) throw new Error('The server address must start with https:// or wss://.');
    if (plain && !LOOPBACK.has(url.hostname)) throw new Error('Remote rooms need a secure (https/wss) server. Plain ws:// is only for localhost.');
    if (url.username || url.password) throw new Error('Do not put a user name or password in the server address.');
    return `${secure ? 'wss' : 'ws'}://${url.host}${ROOM_WS_PATH}`;
}
/** The display origin of a server (no path, no secrets), used as the token-store key. */
export function roomServerOrigin(serverUrl: string): string {
    const ws = new URL(roomSocketUrl(serverUrl));
    return `${ws.protocol === 'wss:' ? 'https' : 'http'}://${ws.host}`;
}
export interface ParsedInvite { server: string; socketUrl: string; roomId: string; invite: string }
/**
 * Parse an invite link. Canonical: `https://host/omo-room/join/<roomId>#invite=<code>`.
 * Also accepted: `?invite=<code>` instead of the fragment, and `omo-room://host/<roomId>?invite=<code>`
 * (treated as https).
 */
export function parseInviteLink(link: string): ParsedInvite {
    let raw = (link ?? '').trim();
    if (raw.startsWith('omo-room://')) raw = 'https://' + raw.slice('omo-room://'.length).replace(/^([^/]+)\//, `$1${ROOM_INVITE_PATH}`);
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('Paste the whole invite link, starting with https://.'); }
    const at = url.pathname.indexOf(ROOM_INVITE_PATH);
    const roomId = at >= 0 ? decodeURIComponent(url.pathname.slice(at + ROOM_INVITE_PATH.length).replace(/\/+$/, '')) : '';
    if (!ROOM_ID_RE.test(roomId)) throw new Error('This invite link has no valid room code.');
    const fromHash = new URLSearchParams(url.hash.replace(/^#/, '')).get('invite');
    const invite = fromHash ?? url.searchParams.get('invite') ?? '';
    if (!ROOM_SECRET_RE.test(invite)) throw new Error('This invite link has no valid invite code.');
    const server = roomServerOrigin(`${url.protocol}//${url.host}`);
    return { server, socketUrl: roomSocketUrl(server), roomId, invite };
}
export function inviteLink(serverOrigin: string, roomId: string, invite: string): string {
    return `${roomServerOrigin(serverOrigin)}${ROOM_INVITE_PATH}${encodeURIComponent(roomId)}#invite=${encodeURIComponent(invite)}`;
}

// ---------------------------------------------------------------------------------------------
// Validators (both lanes). Each returns a clean copy or throws Error(message).
// ---------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const line = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(s);
const optRid = (v: unknown): string | undefined => { if (v === undefined) return undefined; if (typeof v !== 'string' || !RID_RE.test(v)) throw new Error('Invalid request id.'); return v; };
const needRid = (v: unknown): string => { const r = optRid(v); if (!r) throw new Error('This request needs an id.'); return r; };
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

const AGENT_KINDS: readonly string[] = ['hermes', 'claude', 'codex', 'dsh'];
const AGENT_ACTIVITIES: readonly string[] = ['working', 'idle', 'background', 'sleeping', 'interrupted', 'exited'];
export function agentSummaries(input: unknown): AgentStatusSummary[] {
    if (!Array.isArray(input) || input.length > ROOM_AGENTS_MAX) throw new Error('Invalid agent summary list.');
    return input.map(a => {
        if (!isObj(a) || typeof a.key !== 'string' || !/^[A-Za-z0-9:_-]{1,80}$/.test(a.key) || typeof a.desk !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(a.desk)
            || !AGENT_KINDS.includes(a.kind as string) || !line(a.label, 60) || !AGENT_ACTIVITIES.includes(a.activity as string)) throw new Error('Invalid agent summary.');
        return { key: a.key, desk: a.desk, kind: a.kind as AgentSummaryKind, label: (a.label as string).trim(), activity: a.activity as AgentSummaryActivity };
    });
}
export function roomDisplayName(input: unknown): string {
    if (!line(input, 32)) throw new Error('Name must be 1–32 characters without control characters.');
    return (input as string).trim();
}
/**
 * Pose on the wire. Looser than the v1 local `presencePose` (12×10 m room) because v2 worlds can be
 * up to 40×40 m. Receivers may further clamp to the room's WorldShell.
 */
export function wirePose(input: unknown): PlayerPose {
    const p = input as PlayerPose;
    if (!p || ![p.x, p.z, p.yaw, p.pitch].every(n => typeof n === 'number' && Number.isFinite(n))
        || Math.abs(p.x) > ROOM_POSE_LIMIT_M || Math.abs(p.z) > ROOM_POSE_LIMIT_M || Math.abs(p.yaw) > Math.PI + 1e-6 || Math.abs(p.pitch) > 1.2) throw new Error('Invalid room position.');
    return { x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch };
}
function worldOps(input: unknown): WorldOp[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > ROOM_WORLD_OPS_MAX) throw new Error(`A world batch holds 1–${ROOM_WORLD_OPS_MAX} operations.`);
    // Deep validation happens in applyWorldOps + validateWorld on the result.
    for (const op of input) if (!isObj(op) || typeof op.op !== 'string') throw new Error('Invalid world operation.');
    return JSON.parse(JSON.stringify(input));
}
function world(input: unknown): WorldSpec {
    const r = validateWorld(input);
    if (!r.ok) throw new Error(r.error);
    return JSON.parse(JSON.stringify(r.world));
}
function member(input: unknown): RemoteRoomMember {
    if (!isObj(input) || typeof input.id !== 'string' || !ROOM_MEMBER_ID_RE.test(input.id) || (input.role !== 'owner' && input.role !== 'member')) throw new Error('Invalid room member.');
    const out: RemoteRoomMember = { id: input.id, name: roomDisplayName(input.name), pose: wirePose(input.pose), role: input.role };
    if (input.voice !== undefined && input.voice !== null) out.voice = voiceStatus(input.voice as VoiceStatus)!;
    if (input.colour !== undefined) out.colour = presenceColour(input.colour);
    if (input.agents !== undefined) out.agents = agentSummaries(input.agents);
    return out;
}
function members(input: unknown): RemoteRoomMember[] {
    if (!Array.isArray(input) || input.length > ROOM_MAX_MEMBERS) throw new Error('Invalid member list.');
    return input.map(member);
}
function chatMessage(input: unknown): ChatMessage {
    if (!isObj(input) || typeof input.id !== 'string' || input.id.length > 64 || typeof input.from !== 'string' || !ROOM_MEMBER_ID_RE.test(input.from) || !time(input.at)) throw new Error('Invalid chat message.');
    const say = chatSay(input.kind === 'emote' ? { kind: 'emote', emote: input.emote as ChatEmote } : { kind: 'text', text: input.text as string });
    const out: ChatMessage = { id: input.id, from: input.from, fromName: roomDisplayName(input.fromName), at: input.at, kind: say.kind };
    if (say.kind === 'text') out.text = say.text; else out.emote = say.emote;
    if (input.colour !== undefined) out.colour = presenceColour(input.colour);
    return out;
}
function auth(input: unknown): RoomAuth {
    if (!isObj(input) || typeof input.roomId !== 'string' || !ROOM_ID_RE.test(input.roomId)) throw new Error('Invalid room code.');
    switch (input.kind) {
        case 'invite': if (typeof input.invite !== 'string' || !ROOM_SECRET_RE.test(input.invite)) throw new Error('Invalid invite code.'); return { kind: 'invite', roomId: input.roomId, invite: input.invite };
        case 'member': if (typeof input.token !== 'string' || !ROOM_SECRET_RE.test(input.token)) throw new Error('Invalid member token.'); return { kind: 'member', roomId: input.roomId, token: input.token };
        case 'owner': {
            if (typeof input.ownerToken !== 'string' || !ROOM_SECRET_RE.test(input.ownerToken)) throw new Error('Invalid owner token.');
            const out: RoomAuth = { kind: 'owner', roomId: input.roomId, ownerToken: input.ownerToken };
            if (input.roomName !== undefined) { if (!line(input.roomName, 120)) throw new Error('Invalid room name.'); out.roomName = (input.roomName as string).trim(); }
            if (input.seedWorld !== undefined) out.seedWorld = world(input.seedWorld);
            return out;
        }
        default: throw new Error('Invalid credentials.');
    }
}

function parseJson(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string') throw new Error('Frames must be JSON text.');
    if (raw.length > ROOM_FRAME_MAX_BYTES) throw new Error('Frame too large.');
    let v: unknown;
    try { v = JSON.parse(raw); } catch { throw new Error('Frame is not JSON.'); }
    if (!isObj(v) || typeof v.t !== 'string') throw new Error('Frame has no type.');
    return v;
}

/**
 * Parse a client frame (server side). Returns undefined for an unknown `t` (ignore it);
 * throws for malformed known frames (reply `error` code `bad-frame`).
 */
export function parseClientFrame(raw: unknown): RoomClientFrame | undefined {
    const f = parseJson(raw);
    switch (f.t) {
        case 'hello': {
            if (f.proto !== ROOM_WIRE_VERSION) throw new Error('Unsupported protocol version.');
            const c = isObj(f.client) ? f.client : {};
            return { t: 'hello', rid: optRid(f.rid), proto: ROOM_WIRE_VERSION, client: { app: 'omo-ide', version: typeof c.version === 'string' ? c.version.slice(0, 32) : '0' }, auth: auth(f.auth) };
        }
        case 'join': {
            const out: JoinFrame = { t: 'join', rid: optRid(f.rid), name: roomDisplayName(f.name) };
            if (f.colour !== undefined) out.colour = presenceColour(f.colour);
            if (f.agents !== undefined) out.agents = agentSummaries(f.agents);
            return out;
        }
        case 'pose': return { t: 'pose', pose: wirePose(f.pose) };
        case 'voice-status': return { t: 'voice-status', status: voiceStatus((f.status ?? null) as VoiceStatus | null) };
        case 'colour': return { t: 'colour', colour: presenceColour(f.colour) };
        case 'chat': { const s = chatSay({ kind: 'text', text: f.text as string }) as { kind: 'text'; text: string }; return { t: 'chat', rid: optRid(f.rid), text: s.text }; }
        case 'emote': { const s = chatSay({ kind: 'emote', emote: f.emote as ChatEmote }) as { kind: 'emote'; emote: ChatEmote }; return { t: 'emote', rid: optRid(f.rid), emote: s.emote }; }
        case 'signal': return { t: 'signal', signal: voiceSignal(f.signal as VoiceSignal) };
        case 'agents': return { t: 'agents', agents: agentSummaries(f.agents) };
        case 'world-get': return { t: 'world-get', rid: optRid(f.rid) };
        case 'world-ops': {
            if (!int(f.baseRevision, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid base revision.');
            return { t: 'world-ops', rid: needRid(f.rid), baseRevision: f.baseRevision, ops: worldOps(f.ops) };
        }
        case 'invite-create': {
            const out: InviteCreateFrame = { t: 'invite-create', rid: needRid(f.rid) };
            if (f.ttlMinutes !== undefined) { if (!int(f.ttlMinutes, 1, 60 * 24 * 30)) throw new Error('Invite lifetime is 1 minute to 30 days.'); out.ttlMinutes = f.ttlMinutes; }
            if (f.maxUses !== undefined) { if (!int(f.maxUses, 1, 100)) throw new Error('Invite uses must be 1–100.'); out.maxUses = f.maxUses; }
            return out;
        }
        case 'ping': return { t: 'ping', at: time(f.at) ? f.at : 0 };
        case 'leave': return { t: 'leave' };
        default: return undefined;
    }
}

/**
 * Parse a server frame (client side). Returns undefined for an unknown `t` (ignore it);
 * throws for malformed known frames (the client drops the frame and logs a warning).
 */
export function parseServerFrame(raw: unknown): RoomServerFrame | undefined {
    const f = parseJson(raw);
    switch (f.t) {
        case 'welcome':
            if (f.proto !== ROOM_WIRE_VERSION) throw new Error('Unsupported protocol version.');
            if (typeof f.roomId !== 'string' || !ROOM_ID_RE.test(f.roomId) || typeof f.memberId !== 'string' || !ROOM_MEMBER_ID_RE.test(f.memberId)
                || (f.role !== 'owner' && f.role !== 'member') || typeof f.memberToken !== 'string' || !ROOM_SECRET_RE.test(f.memberToken)) throw new Error('Invalid welcome.');
            return { t: 'welcome', rid: optRid(f.rid), proto: ROOM_WIRE_VERSION, roomId: f.roomId, roomName: line(f.roomName, 120) ? (f.roomName as string).trim() : f.roomId,
                memberId: f.memberId, role: f.role, memberToken: f.memberToken, serverTime: time(f.serverTime) ? f.serverTime : 0 };
        case 'room':
            if (typeof f.roomId !== 'string' || !ROOM_ID_RE.test(f.roomId) || typeof f.selfId !== 'string' || !ROOM_MEMBER_ID_RE.test(f.selfId)) throw new Error('Invalid room snapshot.');
            return { t: 'room', rid: optRid(f.rid), roomId: f.roomId, roomName: line(f.roomName, 120) ? (f.roomName as string).trim() : f.roomId, selfId: f.selfId, members: members(f.members), world: world(f.world) };
        case 'presence': return { t: 'presence', members: members(f.members) };
        case 'world': return { t: 'world', rid: optRid(f.rid), world: world(f.world) };
        case 'world-ack': if (!int(f.revision, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid ack.'); return { t: 'world-ack', rid: needRid(f.rid), revision: f.revision };
        case 'world-applied':
            if (typeof f.by !== 'string' || !int(f.baseRevision, 0, Number.MAX_SAFE_INTEGER) || !int(f.revision, 1, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid world update.');
            return { t: 'world-applied', by: f.by, baseRevision: f.baseRevision, revision: f.revision, ops: worldOps(f.ops) };
        case 'chat': return { t: 'chat', message: chatMessage(f.message) };
        case 'chat-ack': return { t: 'chat-ack', rid: needRid(f.rid), message: chatMessage(f.message) };
        case 'signal': {
            const e = isObj(f.envelope) ? f.envelope : {};
            if (typeof e.from !== 'string' || !ROOM_MEMBER_ID_RE.test(e.from)) throw new Error('Invalid signal.');
            // Reuse the outbound validator for kind/data/session bounds.
            const v = voiceSignal({ to: 'x', toSession: e.fromSession as string, session: e.fromSession as string, kind: e.kind as VoiceSignal['kind'], data: e.data as string });
            return { t: 'signal', envelope: { from: e.from, fromSession: v.session, kind: v.kind, data: v.data } };
        }
        case 'agents': if (typeof f.memberId !== 'string' || !ROOM_MEMBER_ID_RE.test(f.memberId)) throw new Error('Invalid agents push.'); return { t: 'agents', memberId: f.memberId, agents: agentSummaries(f.agents) };
        case 'invite': if (typeof f.link !== 'string' || f.link.length > 2048 || !time(f.expiresAt)) throw new Error('Invalid invite.');
            return { t: 'invite', rid: needRid(f.rid), link: f.link, expiresAt: f.expiresAt, ...(int(f.maxUses, 1, 100) ? { maxUses: f.maxUses } : {}) };
        case 'pong': return { t: 'pong', at: time(f.at) ? f.at : 0, serverTime: time(f.serverTime) ? f.serverTime : 0 };
        case 'error': {
            const out: ErrorFrame = { t: 'error', rid: optRid(f.rid), code: (typeof f.code === 'string' ? f.code : 'server') as RoomErrorCode, message: typeof f.message === 'string' ? f.message.slice(0, 500) : 'Room server error.' };
            if (f.fatal === true) out.fatal = true;
            if (int(f.revision, 0, Number.MAX_SAFE_INTEGER)) out.revision = f.revision;
            return out;
        }
        default: return undefined;
    }
}

/** Serialize a frame (both sides). Throws if it exceeds the size limit. */
export function encodeFrame(frame: RoomClientFrame | RoomServerFrame): string {
    const text = JSON.stringify(frame);
    if (text.length > ROOM_FRAME_MAX_BYTES) throw new Error('Frame too large.');
    return text;
}

/** Re-export so server code needs one import for the palette/emotes. */
export { PRESENCE_COLOURS, CHAT_EMOTES };
export type { ChatSay };
