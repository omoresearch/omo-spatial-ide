/**
 * Remote room client (w2 mp-client lane). The IDE BACKEND connects out to a room server over WSS
 * using Node's global WebSocket (Node 22+), speaks room-wire-protocol.ts, and exposes the result to
 * the browser as OmoRemoteRoomService (RPC). One client per browser connection, like local presence.
 *
 * Safety: member tokens live only in RemoteRoomTokenStore (config dir, 0600). Owner tokens are
 * used for one handshake and dropped. Nothing here reads or writes terminals or starts agents.
 */
import { randomUUID } from 'crypto';
import type { PlayerPose } from '../common/player-state';
import { PLAYER_HOME } from '../common/player-state';
import type { ChatMessage, ChatSay, PresenceColour, RoomMember, RoomSnapshot, VoiceSignal, VoiceSignalEnvelope, VoiceStatus } from '../common/presence-protocol';
import { CHAT_INBOX_MAX, VOICE_INBOX_MAX, chatSay, presenceColour, voiceSignal, voiceStatus } from '../common/presence-protocol';
import type { OmoRemoteRoomService, RemoteHostRequest, RemoteJoinRequest, RemoteRoomStatus, RemoteWorldResult, SavedRemoteRoom } from '../common/remote-room-protocol';
import type { AgentStatusSummary, RemoteRoomMember, RoomAuth, RoomClientFrame, RoomServerFrame, RoomRole } from '../common/room-wire-protocol';
import {
    ROOM_CLOSE, ROOM_CLOSE_FINAL, ROOM_ID_RE, ROOM_PING_INTERVAL_MS, ROOM_POSE_MAX_HZ, ROOM_SECRET_RE, ROOM_WIRE_VERSION,
    agentSummaries, encodeFrame, parseInviteLink, parseServerFrame, roomDisplayName, roomServerOrigin, roomSocketUrl, wirePose
} from '../common/room-wire-protocol';
import type { WorldOp, WorldSpec } from '../common/world-model';
import { applyWorldOps, validateWorld } from '../common/world-model';
import type { RemoteRoomTokenStore } from './remote-room-token-store';

/** Minimal WebSocket surface (WHATWG). Node 22's global WebSocket satisfies it; tests can inject one. */
export interface RoomSocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'open', fn: () => void): void;
    addEventListener(type: 'message', fn: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', fn: (event: { code: number; reason: string }) => void): void;
    addEventListener(type: 'error', fn: (event: unknown) => void): void;
}
export type RoomSocketFactory = (url: string) => RoomSocket;
const OPEN = 1;

export interface RemoteRoomClientOptions {
    store: RemoteRoomTokenStore;
    socket?: RoomSocketFactory;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
    clientVersion?: string;
    /** Connect/handshake timeout (ms). */
    handshakeMs?: number;
    requestMs?: number;
    log?: (message: string) => void;
}

interface Target { server: string; socketUrl: string; roomId: string; join: RemoteJoinRequest; auth: RoomAuth; memberId?: string }
interface Pending { resolve(frame: RoomServerFrame): void; reject(error: Error): void; timer: unknown }

/** Exponential backoff with jitter: 1s, 2s, 4s … capped at 30s. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
    return Math.round(base * (0.8 + random() * 0.4));
}

function defaultSocket(url: string): RoomSocket {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => RoomSocket }).WebSocket;
    if (!Ctor) throw new Error('This Omo backend has no WebSocket support. Node 22 or newer is required for remote rooms.');
    return new Ctor(url);
}

export class RemoteRoomClient {
    private target?: Target;
    private ws?: RoomSocket;
    private epoch = 0;
    private phase: RemoteRoomStatus['phase'] = 'idle';
    private error = '';
    private attempt = 0;
    private retryAt?: number;
    private retryTimer?: unknown;
    private pingTimer?: unknown;
    private poseTimer?: unknown;
    private roomName = '';
    private role?: RoomRole;
    private selfId?: string;
    private members: RemoteRoomMember[] = [];
    private worldSpec?: WorldSpec;
    private pending = new Map<string, Pending>();
    private signals: VoiceSignalEnvelope[] = [];
    private chat: ChatMessage[] = [];
    private pose: PlayerPose = { ...PLAYER_HOME };
    private poseSentAt = 0;
    private poseDirty = false;
    private voice: VoiceStatus | null = null;
    private colour?: PresenceColour;
    private agents: AgentStatusSummary[] = [];
    private disposed = false;
    /** Identity of this connection for membership claims in the shared token store. */
    private readonly claimId = Symbol('remote-room-connection');
    private readonly now: () => number;
    private readonly schedule: (fn: () => void, ms: number) => unknown;
    private readonly cancel: (handle: unknown) => void;
    private readonly socket: RoomSocketFactory;
    private readonly log: (message: string) => void;

    constructor(private readonly options: RemoteRoomClientOptions) {
        this.now = options.now ?? Date.now;
        this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        this.cancel = options.cancel ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
        this.socket = options.socket ?? defaultSocket;
        this.log = options.log ?? (() => undefined);
    }

    // ------------------------------------------------------------------ public: connection
    status(): RemoteRoomStatus {
        const s: RemoteRoomStatus = { phase: this.phase, attempt: this.attempt, error: this.error, members: this.members.map(m => ({ ...m })) };
        if (this.target) { s.server = this.target.server; s.roomId = this.target.roomId; }
        if (this.roomName) s.roomName = this.roomName;
        if (this.role) s.role = this.role;
        if (this.selfId) s.selfId = this.selfId;
        if (this.retryAt !== undefined) s.retryAt = this.retryAt;
        if (this.worldSpec) s.worldRevision = this.worldSpec.revision;
        return s;
    }

    async joinInvite(link: string, join: RemoteJoinRequest): Promise<RemoteRoomStatus> {
        const invite = parseInviteLink(link);
        const clean = this.cleanJoin(join);
        // Already a member of that room? Reuse the stored token instead of burning the invite.
        const saved = await this.options.store.token(invite.server, invite.roomId, this.claimId);
        const auth: RoomAuth = saved ? { kind: 'member', roomId: invite.roomId, token: saved.token } : { kind: 'invite', roomId: invite.roomId, invite: invite.invite };
        return this.start({ server: invite.server, socketUrl: invite.socketUrl, roomId: invite.roomId, join: clean, auth, memberId: saved?.memberId });
    }

    async host(input: RemoteHostRequest, join: RemoteJoinRequest): Promise<RemoteRoomStatus> {
        const server = roomServerOrigin(input.server);
        if (!ROOM_ID_RE.test(input.roomId)) throw new Error('Room code must be 3–32 lowercase letters, numbers or hyphens.');
        if (typeof input.ownerToken !== 'string' || !ROOM_SECRET_RE.test(input.ownerToken.trim())) throw new Error('Paste the owner token from the room server (16+ letters, numbers, - or _).');
        const auth: RoomAuth = { kind: 'owner', roomId: input.roomId, ownerToken: input.ownerToken.trim() };
        if (input.roomName?.trim()) auth.roomName = input.roomName.trim().slice(0, 120);
        if (input.seedWorld) { const v = validateWorld(input.seedWorld); if (!v.ok) throw new Error(`Starting world: ${v.error}`); auth.seedWorld = v.world; }
        return this.start({ server, socketUrl: roomSocketUrl(server), roomId: input.roomId, join: this.cleanJoin(join), auth });
    }

    async rejoin(serverUrl: string, roomId: string, join: RemoteJoinRequest): Promise<RemoteRoomStatus> {
        const server = roomServerOrigin(serverUrl);
        const saved = await this.options.store.token(server, roomId, this.claimId);
        if (!saved) throw new Error('This IDE has no free saved membership for that room (another tab may be using it). Use an invite link.');
        return this.start({ server, socketUrl: roomSocketUrl(server), roomId, join: this.cleanJoin(join), auth: { kind: 'member', roomId, token: saved.token }, memberId: saved.memberId });
    }

    async reconnectNow(): Promise<RemoteRoomStatus> {
        if (!this.target) throw new Error('Not in a remote room.');
        if (this.phase === 'joined') return this.status();
        if (this.retryTimer !== undefined) this.cancel(this.retryTimer);
        this.retryTimer = undefined; this.retryAt = undefined;
        await this.connectOnce(this.epoch).catch(() => undefined);
        return this.status();
    }

    async leave(): Promise<void> {
        const ws = this.ws;
        this.epoch++;
        if (ws && ws.readyState === OPEN) { try { ws.send(encodeFrame({ t: 'leave' })); } catch { /* closing anyway */ } }
        this.teardown('Left the room.');
        try { ws?.close(ROOM_CLOSE.normal, 'leave'); } catch { /* ignore */ }
        this.target = undefined; this.phase = 'idle'; this.error = ''; this.attempt = 0; this.retryAt = undefined;
        this.members = []; this.worldSpec = undefined; this.selfId = undefined; this.role = undefined; this.roomName = '';
        this.voice = null; this.signals = []; this.chat = [];
        this.options.store.release(this.claimId);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        // A closed browser connection is transient for the server (no leave frame): a reload rejoins.
        const ws = this.ws; this.epoch++; this.teardown('Disconnected.');
        try { ws?.close(ROOM_CLOSE.normal, 'client closed'); } catch { /* ignore */ }
        this.target = undefined; this.phase = 'idle';
        this.options.store.release(this.claimId);
    }

    saved(): Promise<SavedRemoteRoom[]> { return this.options.store.list(); }
    async forget(serverUrl: string, roomId: string): Promise<void> {
        const server = roomServerOrigin(serverUrl);
        if (this.target?.server === server && this.target.roomId === roomId) await this.leave();
        await this.options.store.remove(server, roomId);
    }

    async createInvite(options: { ttlMinutes?: number; maxUses?: number } = {}): Promise<{ link: string; expiresAt: number }> {
        if (this.role !== 'owner') throw new Error('Only the room owner can create invite links.');
        const reply = await this.request({ t: 'invite-create', rid: this.rid(), ...options });
        if (reply.t !== 'invite') throw new Error('The room server did not return an invite.');
        return { link: reply.link, expiresAt: reply.expiresAt };
    }

    // ------------------------------------------------------------------ public: presence/voice/chat
    snapshot(): RoomSnapshot {
        if (!this.selfId || !this.worldSpec || this.phase === 'idle' || this.phase === 'failed') throw new Error('Join a room first. Presence expired or disconnected.');
        const members: RoomMember[] = this.members.map(m => {
            const out: RoomMember = { id: m.id, name: m.name, pose: m.id === this.selfId ? { ...this.pose } : { ...m.pose } };
            if (m.voice) out.voice = { ...m.voice };
            if (m.colour) out.colour = m.colour;
            return out;
        });
        return { roomId: this.target!.roomId, theme: this.worldSpec.shell.theme, selfId: this.selfId, members };
    }

    update(raw: PlayerPose): RoomSnapshot {
        this.pose = wirePose(raw);
        this.poseDirty = true;
        this.flushPose();
        return this.snapshot();
    }

    setVoice(raw: VoiceStatus | null): void {
        const status = voiceStatus(raw);
        this.requireJoined('Join a room before turning on voice.');
        if (status?.session !== this.voice?.session) this.signals = [];
        this.voice = status;
        this.send({ t: 'voice-status', status });
    }
    signal(raw: VoiceSignal): void {
        const message = voiceSignal(raw);
        this.requireJoined('Turn on voice in a room first.');
        if (!this.voice || this.voice.session !== message.session) throw new Error('Turn on voice in a room first.');
        this.send({ t: 'signal', signal: message });
    }
    takeSignals(): VoiceSignalEnvelope[] { const out = this.signals; this.signals = []; return out; }
    setColour(raw: PresenceColour): void {
        const colour = presenceColour(raw);
        this.requireJoined('Join a room before choosing a colour.');
        this.colour = colour;
        this.send({ t: 'colour', colour });
    }
    async say(raw: ChatSay): Promise<ChatMessage> {
        const said = chatSay(raw);
        this.requireJoined('Join a room before chatting.');
        const rid = this.rid();
        const reply = await this.request(said.kind === 'text' ? { t: 'chat', rid, text: said.text } : { t: 'emote', rid, emote: said.emote });
        if (reply.t !== 'chat-ack') throw new Error('The room server did not accept the message.');
        return reply.message;
    }
    takeChat(): ChatMessage[] { const out = this.chat; this.chat = []; return out; }
    setAgents(raw: AgentStatusSummary[]): void {
        const agents = agentSummaries(raw);
        const same = JSON.stringify(agents) === JSON.stringify(this.agents);
        this.agents = agents;
        if (!same && this.phase === 'joined') this.send({ t: 'agents', agents });
    }

    // ------------------------------------------------------------------ public: shared world
    world(): WorldSpec | undefined { return this.worldSpec ? JSON.parse(JSON.stringify(this.worldSpec)) : undefined; }
    async refreshWorld(): Promise<WorldSpec> {
        this.requireJoined('Join a room first.');
        const reply = await this.request({ t: 'world-get', rid: this.rid() });
        if (reply.t !== 'world') throw new Error('The room server did not return the world.');
        this.worldSpec = reply.world;
        return this.world()!;
    }
    async applyWorldOps(baseRevision: number, ops: WorldOp[]): Promise<RemoteWorldResult> {
        this.requireJoined('Join a room first.');
        if (!this.worldSpec) throw new Error('The room world has not loaded yet.');
        // Pre-check locally so obvious mistakes never leave the IDE.
        if (baseRevision === this.worldSpec.revision) { const local = applyWorldOps(this.worldSpec, ops); if (!local.ok) return { ok: false, conflict: false, error: local.error }; }
        try {
            const reply = await this.request({ t: 'world-ops', rid: this.rid(), baseRevision, ops });
            if (reply.t !== 'world-ack') throw new Error('Unexpected reply.');
            if (this.worldSpec.revision < reply.revision) {
                const applied = this.worldSpec.revision === baseRevision ? applyWorldOps(this.worldSpec, ops) : undefined;
                if (applied?.ok && applied.world.revision === reply.revision) this.worldSpec = applied.world;
                else await this.refreshWorld();
            }
            return { ok: true, revision: reply.revision, world: this.world()! };
        } catch (error) {
            const e = error as Error & { code?: string };
            if (e.code === 'conflict') {
                const world = await this.refreshWorld().catch(() => this.world());
                return world ? { ok: false, conflict: true, error: 'Someone changed the room first. Your change was re-applied on top of theirs: check the preview and apply again.', world }
                    : { ok: false, conflict: false, error: e.message };
            }
            return { ok: false, conflict: false, error: e.message };
        }
    }

    // ------------------------------------------------------------------ internals
    private cleanJoin(join: RemoteJoinRequest): RemoteJoinRequest {
        const out: RemoteJoinRequest = { name: roomDisplayName(join?.name) };
        if (join?.colour !== undefined) out.colour = presenceColour(join.colour);
        return out;
    }
    private requireJoined(message: string): void {
        if (this.phase !== 'joined' && this.phase !== 'reconnecting') throw new Error(message);
    }
    private rid(): string { return randomUUID().replace(/-/g, '').slice(0, 20); }

    private send(frame: RoomClientFrame): boolean {
        const ws = this.ws;
        if (!ws || ws.readyState !== OPEN || this.phase !== 'joined') return false; // state is replayed on reconnect
        try { ws.send(encodeFrame(frame)); return true; } catch (error) { this.log(`remote room send failed: ${String(error)}`); return false; }
    }

    private request(frame: RoomClientFrame & { rid?: string }, raw = false): Promise<RoomServerFrame> {
        const ws = this.ws;
        if (!ws || ws.readyState !== OPEN || (!raw && this.phase !== 'joined')) return Promise.reject(new Error('The room connection is down. Wait for it to reconnect.'));
        const rid = frame.rid!;
        return new Promise<RoomServerFrame>((resolve, reject) => {
            const timer = this.schedule(() => { this.pending.delete(rid); reject(new Error('The room server did not answer in time.')); }, this.options.requestMs ?? 10_000);
            this.pending.set(rid, { resolve, reject, timer });
            try { ws.send(encodeFrame(frame)); } catch (error) { this.cancel(timer); this.pending.delete(rid); reject(error as Error); }
        });
    }

    private flushPose(): void {
        if (!this.poseDirty || this.phase !== 'joined') return;
        const gap = 1000 / ROOM_POSE_MAX_HZ, wait = this.poseSentAt + gap - this.now();
        if (wait > 0) { if (this.poseTimer === undefined) this.poseTimer = this.schedule(() => { this.poseTimer = undefined; this.flushPose(); }, wait); return; }
        if (this.send({ t: 'pose', pose: this.pose })) { this.poseSentAt = this.now(); this.poseDirty = false; }
    }

    private async start(target: Target): Promise<RemoteRoomStatus> {
        if (this.disposed) throw new Error('This remote room connection is closed.');
        if (this.target || this.ws) await this.leave();
        const epoch = ++this.epoch;
        this.target = target; this.phase = 'connecting'; this.error = ''; this.attempt = 0;
        try { await this.connectOnce(epoch); }
        catch (error) {
            if (epoch === this.epoch) {
                // A failed FIRST connection is reported, never retried silently with an invite or owner token.
                const message = this.error || (error as Error).message;
                this.teardown(message);
                try { this.ws?.close(ROOM_CLOSE.normal, 'failed'); } catch { /* ignore */ }
                this.phase = 'failed'; this.error = message;
            }
            throw error;
        }
        return this.status();
    }

    /** One connection attempt: open → hello → welcome → join → room. Resolves when joined. */
    private connectOnce(epoch: number): Promise<void> {
        const target = this.target;
        if (!target) return Promise.reject(new Error('Not in a remote room.'));
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const done = (error?: Error): void => {
                if (settled) return; settled = true; this.cancel(handshake);
                if (error) reject(error); else resolve();
            };
            const handshake = this.schedule(() => { done(new Error('The room server did not answer. Check the address and try again.')); try { ws.close(ROOM_CLOSE.normal, 'timeout'); } catch { /* ignore */ } }, this.options.handshakeMs ?? 15_000);
            let ws: RoomSocket;
            try { ws = this.socket(target.socketUrl); } catch (error) { done(error as Error); return; }
            this.ws = ws;
            ws.addEventListener('open', () => {
                if (epoch !== this.epoch || this.ws !== ws) return;
                ws.send(encodeFrame({ t: 'hello', rid: 'hello', proto: ROOM_WIRE_VERSION, client: { app: 'omo-ide', version: this.options.clientVersion ?? '0' }, auth: target.auth }));
            });
            ws.addEventListener('message', event => {
                if (epoch !== this.epoch || this.ws !== ws) return;
                let frame: RoomServerFrame | undefined;
                try { frame = parseServerFrame(event.data); } catch (error) { this.log(`remote room: dropped bad frame: ${String(error)}`); return; }
                if (!frame) return;
                if (frame.t === 'welcome') {
                    if (!this.options.store.claim(target.server, target.roomId, frame.memberId, this.claimId)) {
                        // Another tab of this IDE is already this member; joining would kick it out.
                        this.phase = 'failed'; this.error = 'Another tab of this IDE is already in this room as you. Use a new invite link for a second person.';
                        try { ws.close(ROOM_CLOSE.normal, 'duplicate'); } catch { /* ignore */ }
                        done(new Error(this.error)); return;
                    }
                    this.selfId = frame.memberId; this.role = frame.role; this.roomName = frame.roomName;
                    // From now on reconnect with the member token, never the invite/owner token again.
                    target.auth = { kind: 'member', roomId: target.roomId, token: frame.memberToken }; target.memberId = frame.memberId;
                    void this.options.store.save({ server: target.server, roomId: target.roomId, roomName: frame.roomName, role: frame.role, memberId: frame.memberId, token: frame.memberToken })
                        .catch(error => this.log(`remote room: could not save member token: ${String(error)}`));
                    const join: RoomClientFrame = { t: 'join', rid: 'join', name: target.join.name };
                    const colour = this.colour ?? target.join.colour; if (colour) join.colour = colour;
                    if (this.agents.length) join.agents = this.agents;
                    ws.send(encodeFrame(join));
                    return;
                }
                if (frame.t === 'room') {
                    this.selfId = frame.selfId; this.roomName = frame.roomName; this.members = frame.members; this.worldSpec = frame.world;
                    const reconnected = this.attempt > 0;
                    this.phase = 'joined'; this.error = ''; this.attempt = 0; this.retryAt = undefined;
                    const mine = frame.members.find(m => m.id === frame.selfId);
                    if (!reconnected && mine) this.pose = { ...mine.pose };
                    // Replay this member's live state after a reconnect (the server forgot the socket).
                    this.poseDirty = true; this.flushPose();
                    if (this.voice) this.send({ t: 'voice-status', status: this.voice });
                    this.startPing(epoch);
                    done();
                    return;
                }
                if (frame.t === 'error' && (frame.rid === 'hello' || frame.rid === 'join' || frame.fatal)) {
                    if (frame.fatal || frame.rid === 'hello') { this.phase = 'failed'; this.error = frame.message; if (frame.code === 'auth' || frame.code === 'invite-expired') this.dropBadToken(target, frame.code); }
                    done(new Error(frame.message));
                    return;
                }
                this.handle(frame);
            });
            ws.addEventListener('error', () => { /* a close event always follows */ });
            ws.addEventListener('close', event => {
                if (this.ws !== ws) return;
                this.ws = undefined;
                this.stopTimers();
                for (const [, p] of this.pending) { this.cancel(p.timer); p.reject(new Error('The room connection closed.')); }
                this.pending.clear();
                if (epoch !== this.epoch) return done(new Error('Cancelled.'));
                const final = ROOM_CLOSE_FINAL.includes(event.code);
                const why = event.reason || (event.code === ROOM_CLOSE.replaced ? 'This room was opened somewhere else with the same membership.' : event.code === ROOM_CLOSE.removed ? 'The room owner removed you or closed the room.' : `Connection closed (${event.code}).`);
                if (!settled && this.phase === 'connecting') { if (final) this.phase = 'failed'; done(new Error(this.error || why)); return; }
                if (final || this.phase === 'failed') { this.phase = 'failed'; this.error = this.error || why; done(new Error(this.error)); return; }
                // Transient: keep the last snapshot visible and retry with backoff.
                this.phase = 'reconnecting'; this.error = why;
                done(new Error(why));
                this.scheduleReconnect(epoch);
            });
        });
    }

    private dropBadToken(target: Target, code: string): void {
        if (target.auth.kind === 'member' && code === 'auth' && target.memberId) void this.options.store.remove(target.server, target.roomId, target.memberId).catch(() => undefined);
    }

    private scheduleReconnect(epoch: number): void {
        if (epoch !== this.epoch || this.disposed || !this.target) return;
        this.attempt++;
        const delay = reconnectDelay(this.attempt);
        this.retryAt = this.now() + delay;
        this.retryTimer = this.schedule(() => {
            this.retryTimer = undefined; this.retryAt = undefined;
            if (epoch !== this.epoch) return;
            this.connectOnce(epoch).catch(error => {
                this.log(`remote room reconnect ${this.attempt}: ${String(error)}`);
                // Socket could not even be created: keep trying unless something else already scheduled.
                if (epoch === this.epoch && this.phase === 'reconnecting' && !this.ws && this.retryTimer === undefined) this.scheduleReconnect(epoch);
            });
        }, delay);
    }

    private startPing(epoch: number): void {
        const tick = (): void => {
            this.pingTimer = undefined;
            if (epoch !== this.epoch || this.phase !== 'joined') return;
            this.send({ t: 'ping', at: this.now() });
            this.pingTimer = this.schedule(tick, ROOM_PING_INTERVAL_MS);
        };
        if (this.pingTimer !== undefined) this.cancel(this.pingTimer);
        this.pingTimer = this.schedule(tick, ROOM_PING_INTERVAL_MS);
    }
    private stopTimers(): void {
        if (this.pingTimer !== undefined) this.cancel(this.pingTimer);
        if (this.poseTimer !== undefined) this.cancel(this.poseTimer);
        this.pingTimer = undefined; this.poseTimer = undefined;
    }
    private teardown(reason: string): void {
        this.stopTimers();
        if (this.retryTimer !== undefined) this.cancel(this.retryTimer);
        this.retryTimer = undefined; this.retryAt = undefined;
        for (const [, p] of this.pending) { this.cancel(p.timer); p.reject(new Error(reason)); }
        this.pending.clear();
        this.ws = undefined;
    }

    private handle(frame: RoomServerFrame): void {
        const rid = 'rid' in frame ? frame.rid : undefined;
        if (rid && this.pending.has(rid)) {
            const p = this.pending.get(rid)!; this.pending.delete(rid); this.cancel(p.timer);
            if (frame.t === 'error') { const e = new Error(frame.message) as Error & { code?: string; revision?: number }; e.code = frame.code; e.revision = frame.revision; p.reject(e); }
            else p.resolve(frame);
            if (frame.t !== 'world') return; // a world reply also updates local state below
        }
        switch (frame.t) {
            case 'presence': this.members = frame.members; break;
            case 'agents': this.members = this.members.map(m => m.id === frame.memberId ? { ...m, agents: frame.agents } : m); break;
            case 'world': this.worldSpec = frame.world; break;
            case 'world-applied': {
                if (!this.worldSpec || frame.revision <= this.worldSpec.revision) break;
                const next = this.worldSpec.revision === frame.baseRevision ? applyWorldOps(this.worldSpec, frame.ops) : undefined;
                if (next?.ok && next.world.revision === frame.revision) this.worldSpec = next.world;
                else void this.refreshWorld().catch(error => this.log(`remote room: world refresh failed: ${String(error)}`));
                break;
            }
            case 'chat': if (frame.message.from !== this.selfId) { this.chat.push(frame.message); if (this.chat.length > CHAT_INBOX_MAX) this.chat.splice(0, this.chat.length - CHAT_INBOX_MAX); } break;
            case 'signal': if (this.voice) { if (this.signals.length >= VOICE_INBOX_MAX) this.signals.shift(); this.signals.push(frame.envelope); } break;
            case 'error': if (!rid) { this.error = frame.message; this.log(`remote room error ${frame.code}: ${frame.message}`); } break;
            default: break;
        }
    }
}

/** RPC facade: one per browser connection. Methods are async because the RPC layer is. */
export function remoteRoomConnection(store: RemoteRoomTokenStore, options: Omit<RemoteRoomClientOptions, 'store'> = {}): OmoRemoteRoomService & { dispose(): void } {
    const client = new RemoteRoomClient({ ...options, store });
    return {
        joinInvite: (link, join) => client.joinInvite(link, join),
        host: (input, join) => client.host(input, join),
        rejoin: (server, roomId, join) => client.rejoin(server, roomId, join),
        reconnectNow: () => client.reconnectNow(),
        leave: () => client.leave(),
        status: async () => client.status(),
        saved: () => client.saved(),
        forget: (server, roomId) => client.forget(server, roomId),
        createInvite: options2 => client.createInvite(options2),
        snapshot: async () => client.snapshot(),
        update: async pose => client.update(pose),
        setVoice: async status => client.setVoice(status),
        signal: async message => client.signal(message),
        takeSignals: async () => client.takeSignals(),
        setColour: async colour => client.setColour(colour),
        say: input => client.say(input),
        takeChat: async () => client.takeChat(),
        setAgents: async agents => client.setAgents(agents),
        world: async () => client.world(),
        refreshWorld: () => client.refreshWorld(),
        applyWorldOps: (base, ops) => client.applyWorldOps(base, ops),
        dispose: () => client.dispose()
    };
}
