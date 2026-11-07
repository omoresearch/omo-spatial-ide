/**
 * Remote room controller (w2 mp-client lane, browser side).
 *
 * `RoutedPresenceService` implements the existing OmoPresenceService and sends each call to the
 * LOCAL room-presence backend or to the REMOTE room client (via OmoRemoteRoomService). The widget
 * gives this one object to PresenceController, VoiceHub and HudHub, so avatars, the HUD, chat,
 * @mentions and voice work unchanged whether the room is local or remote.
 *
 * `RemoteRoomController` owns the remote connection lifecycle for the UI: join from invite link,
 * host with server URL + owner token, connection chip, reconnect (backend backoff + "retry now"),
 * leave, saved rooms, invite links, and agent status summaries. Terminals stay local per person:
 * nothing here opens, reads or types into a terminal, and nothing starts an agent.
 */
import type { PlayerPose } from '../common/player-state';
import type { ChatMessage, ChatSay, OmoPresenceService, PresenceColour, PresenceJoin, RoomSnapshot, VoiceSignal, VoiceSignalEnvelope, VoiceStatus } from '../common/presence-protocol';
import type { OmoRemoteRoomService, RemoteRoomStatus, SavedRemoteRoom } from '../common/remote-room-protocol';
import type { AgentStatusSummary, RoomInviteRole } from '../common/room-wire-protocol';
import { remoteRoomVoiceTransport } from '../common/voice-transport'; // t3:mp2
import type { VoiceSignalTransport, VoiceWireChannel, VoiceWireIn } from '../common/voice-transport'; // t3:mp2
import type { WorldOp, WorldProposal, WorldSpec } from '../common/world-model';
import { applyWorldOps } from '../common/world-model';
import type { AgentPresence } from './agent-avatars';
import type { PresenceState } from './presence-controller';

/** DI symbol for the raw LOCAL presence proxy; OmoPresenceService itself is the routed service. */
export const OmoLocalPresenceService = Symbol('OmoLocalPresenceService');

// =================================================================================================
// Presence routing
// =================================================================================================

export type RoomRoute = 'local' | 'remote';

export class RoutedPresenceService implements OmoPresenceService {
    route: RoomRoute = 'local';
    constructor(private readonly local: OmoPresenceService, private readonly remote: OmoRemoteRoomService) {}
    private get r(): boolean { return this.route === 'remote'; }
    /** Remote: the backend is already connected by RemoteRoomController; join just reads the snapshot. */
    join(input: PresenceJoin): Promise<RoomSnapshot> { return this.r ? this.remote.snapshot() : this.local.join(input); }
    update(pose: PlayerPose): Promise<RoomSnapshot> { return this.r ? this.remote.update(pose) : this.local.update(pose); }
    async leave(): Promise<void> {
        if (this.r) { this.route = 'local'; await this.remote.leave(); }
        else await this.local.leave();
    }
    setVoice(status: VoiceStatus | null): Promise<void> { return this.r ? this.remote.setVoice(status) : this.local.setVoice(status); }
    signal(message: VoiceSignal): Promise<void> { return this.r ? this.remote.signal(message) : this.local.signal(message); }
    takeSignals(): Promise<VoiceSignalEnvelope[]> { return this.r ? this.remote.takeSignals() : this.local.takeSignals(); }
    setColour(colour: PresenceColour): Promise<void> { return this.r ? this.remote.setColour(colour) : this.local.setColour(colour); }
    say(input: ChatSay): Promise<ChatMessage> { return this.r ? this.remote.say(input) : this.local.say(input); }
    takeChat(): Promise<ChatMessage[]> { return this.r ? this.remote.takeChat() : this.local.takeChat(); }
}

// =================================================================================================
// Shared world adapter (for the build lane's WorldStore)
// =================================================================================================

export type WorldApplyOutcome =
    | { ok: true; world: WorldSpec }
    /**
     * Someone else changed the room first. `world` is the fresh room world. `rebased` is the same
     * proposal re-applied on top of it (new baseRevision) for a fresh preview — show it and ask the
     * user to Apply again. Undefined when the proposal no longer applies.
     */
    | { ok: false; conflict: true; error: string; world: WorldSpec; rebased?: WorldProposal; preview?: WorldSpec }
    | { ok: false; conflict: false; error: string };

/**
 * Where the WorldStore reads and writes the WorldSpec. The build lane's WorldStore is not in this
 * branch, so this is the adapter it should accept: a local source (its own storage) or this remote
 * source while connected. Contract: `apply` never changes the world unless the user pressed Apply.
 */
export interface WorldSource {
    readonly kind: 'local' | 'remote';
    current(): WorldSpec | undefined;
    refresh(): Promise<WorldSpec | undefined>;
    apply(proposal: WorldProposal): Promise<WorldApplyOutcome>;
    /** Called with the new world whenever it changes (other members' edits included). */
    onChange(listener: (world: WorldSpec) => void): () => void;
}

export class RemoteWorldSource implements WorldSource {
    readonly kind = 'remote' as const;
    private latest?: WorldSpec;
    private listeners = new Set<(world: WorldSpec) => void>();
    /** t3:mp2 — WorldStore's RemoteWorldLink: fired on every world change AND when the connection ends (current() undefined). */
    private statusListeners = new Set<() => void>();
    onStatus(listener: () => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
    private status(): void { for (const l of [...this.statusListeners]) { try { l(); } catch { /* listener errors stay local */ } } }
    constructor(private readonly service: OmoRemoteRoomService) {}
    current(): WorldSpec | undefined { return this.latest; }
    /** Called by the controller's poll with the revision the backend reports. */
    async sync(revision: number | undefined): Promise<void> {
        if (revision === undefined || revision === this.latest?.revision) return;
        const world = await this.service.world();
        if (world) this.set(world);
    }
    async refresh(): Promise<WorldSpec | undefined> { const w = await this.service.refreshWorld(); this.set(w); return w; }
    async apply(proposal: WorldProposal): Promise<WorldApplyOutcome> {
        const result = await this.service.applyWorldOps(proposal.baseRevision, proposal.ops);
        if (result.ok) { this.set(result.world); return { ok: true, world: result.world }; }
        if (!result.conflict) return { ok: false, conflict: false, error: result.error };
        this.set(result.world);
        const preview = applyWorldOps(result.world, proposal.ops);
        return preview.ok
            ? { ok: false, conflict: true, error: result.error, world: result.world, rebased: { ...proposal, baseRevision: result.world.revision }, preview: preview.world }
            : { ok: false, conflict: true, error: `Someone changed the room first, and your change no longer fits: ${preview.error}`, world: result.world };
    }
    onChange(listener: (world: WorldSpec) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    clear(): void { if (this.latest === undefined) return; this.latest = undefined; this.status(); }
    private set(world: WorldSpec): void {
        if (this.latest && this.latest.revision === world.revision && JSON.stringify(this.latest) === JSON.stringify(world)) return;
        this.latest = world;
        for (const l of this.listeners) { try { l(world); } catch { /* listener errors stay local */ } }
        this.status();
    }
}

// =================================================================================================
// t3:mp2 — room voice over the remote room server (VoiceHub.useTransport)
// =================================================================================================

/**
 * VoiceWireChannel over the IDE backend's remote room client. The backend owns the socket; the browser
 * polls it for relayed signals (fast) and the roster (slower) only while voice listens.
 */
export function remoteVoiceChannel(service: OmoRemoteRoomService, timers: { every(fn: () => void, ms: number): unknown; stop(handle: unknown): void }): VoiceWireChannel & { dispose(): void } {
    const listeners = new Set<(message: VoiceWireIn) => void>();
    const deliver = (message: VoiceWireIn): void => { for (const l of [...listeners]) { try { l(message); } catch { /* listener errors stay local */ } } };
    let busySignals = false, busyRoster = false, handles: unknown[] = [];
    const start = (): void => {
        if (handles.length) return;
        handles = [
            timers.every(() => {
                if (busySignals) return; busySignals = true;
                service.takeSignals().then(list => { for (const envelope of list) deliver({ type: 'voice.signal', envelope }); }, () => undefined).finally(() => { busySignals = false; });
            }, 100),
            timers.every(() => {
                if (busyRoster) return; busyRoster = true;
                service.snapshot().then(snap => deliver({ type: 'voice.roster', roster: { selfId: snap.selfId, members: snap.members.map(m => ({ id: m.id, name: m.name, pose: m.pose, ...(m.voice ? { voice: m.voice } : {}) })) } }), () => undefined)
                    .finally(() => { busyRoster = false; });
            }, 300)
        ];
    };
    const stop = (): void => { for (const h of handles) timers.stop(h); handles = []; };
    return {
        send: message => message.type === 'voice.status' ? service.setVoice(message.status) : service.signal(message.signal),
        onMessage: listener => { listeners.add(listener); start(); return () => { listeners.delete(listener); if (!listeners.size) stop(); }; },
        dispose: () => { listeners.clear(); stop(); }
    };
}

/** t3:mp2 — the room code inside an owner key printed by `omo-room-server create-room` (omo1.<room>.<member>.<secret>). */
export function roomIdFromOwnerKey(key: string): string | undefined {
    const m = /^omo1\.([a-z0-9][a-z0-9-]{2,31})\.[A-Za-z0-9_-]{6,64}\.[A-Za-z0-9_-]{16,}$/.exec(key.trim());
    return m?.[1];
}

/** Convenience for callers holding raw ops. */
export function remoteProposal(ops: WorldOp[], baseRevision: number, summary: string): WorldProposal {
    return { id: `remote-${Date.now().toString(36)}`, source: 'build-mode', summary, ops, baseRevision };
}

// =================================================================================================
// Connection lifecycle for the UI
// =================================================================================================

export interface RemoteRoomHost {
    /** Joins PresenceController through the widget's existing join path (roomId, display name). */
    joinPresence(roomId: string, name: string): void;
    /** Leaves PresenceController (which calls RoutedPresenceService.leave). */
    leavePresence(): void;
    presence(): PresenceState;
    /** Local agent tabs (voice lane roster), summarised for the other members. */
    agents(): AgentPresence[];
    /** The host's current world, offered as the starting world when hosting a new room. */
    seedWorld(): WorldSpec | undefined;
    schedule(fn: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
    onChange(): void;
    /** t3:mp2 — switch room voice signalling: a remote-room transport while connected, undefined = local presence again. */
    voiceTransport?(transport: VoiceSignalTransport | undefined): void;
}

export interface RemoteRoomView {
    status: RemoteRoomStatus;
    route: RoomRoute;
    busy: boolean;
    error: string;
    saved: SavedRemoteRoom[];
    invite?: { link: string; expiresAt: number; role?: RoomInviteRole };
    /** Seconds until the next automatic retry (reconnecting only). */
    retryIn?: number;
}

const DESK_LABEL: Record<string, string> = { terminal: 'Desk one', 'terminal-2': 'Desk two' };
const KIND_LABEL: Record<string, string> = { hermes: 'Hermes', claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness' };

/** Closed-vocabulary summary of local agent tabs. Never tab names, terminal text or output. */
export function agentSummary(agents: AgentPresence[]): AgentStatusSummary[] {
    return agents.slice(0, 16).map(a => ({
        key: `${a.desk}:${a.key.replace(/[^A-Za-z0-9:_-]/g, '-')}`.slice(0, 80),
        desk: a.desk,
        kind: a.kind,
        label: `${KIND_LABEL[a.kind] ?? 'Agent'} · ${DESK_LABEL[a.desk] ?? 'Desk'}`,
        activity: a.activity === 'approval' ? 'idle' : a.activity // t2:agents: the wire vocabulary is closed; approval is local only
    }));
}

export class RemoteRoomController {
    readonly world: RemoteWorldSource;
    private view: RemoteRoomView = { status: { phase: 'idle', attempt: 0, error: '', members: [] }, route: 'local', busy: false, error: '', saved: [] };
    private timer?: unknown;
    private agentsSent = '';
    private disposed = false;
    private name = 'Builder';
    private voice?: { channel: ReturnType<typeof remoteVoiceChannel> }; // t3:mp2

    constructor(private readonly service: OmoRemoteRoomService, private readonly router: RoutedPresenceService, private readonly host: RemoteRoomHost) {
        this.world = new RemoteWorldSource(service);
        // A page reload keeps the backend connection only if the RPC channel survived; otherwise idle.
        void this.poll().then(() => { if (this.view.status.phase !== 'idle') this.reschedule(); });
        void this.loadSaved();
    }

    get state(): RemoteRoomView { return this.view; }

    private emit(patch: Partial<RemoteRoomView>): void {
        this.view = { ...this.view, ...patch, route: this.router.route };
        this.host.onChange();
    }

    async loadSaved(): Promise<void> {
        try { this.emit({ saved: await this.service.saved() }); } catch { /* backend without remote rooms */ }
    }

    /** Paste an invite link. */
    joinInvite(link: string, name: string): Promise<void> {
        return this.connect(name, () => this.service.joinInvite(link, { name: name.trim() }));
    }
    /** Server URL + owner token. The owner token goes to the IDE backend once and is not stored. */
    hostRoom(input: { server: string; ownerToken: string; roomId: string; roomName?: string; seedCurrent: boolean }, name: string): Promise<void> {
        const seedWorld = input.seedCurrent ? this.host.seedWorld() : undefined;
        // t3:mp2: the owner key from `create-room` names its room; the room code field may stay empty.
        const fromKey = roomIdFromOwnerKey(input.ownerToken);
        const roomId = input.roomId.trim() || fromKey || '';
        if (fromKey && input.roomId.trim() && fromKey !== input.roomId.trim()) { this.emit({ error: `This owner key is for room “${fromKey}”, not “${input.roomId.trim()}”. Clear the room code or paste the right key.` }); return Promise.resolve(); }
        if (!roomId) { this.emit({ error: 'Paste the owner key that “omo-room-server create-room” printed. It names the room.' }); return Promise.resolve(); }
        return this.connect(name, () => this.service.host({ server: input.server, ownerToken: input.ownerToken.trim(), roomId, roomName: input.roomName, seedWorld }, { name: name.trim() }));
    }
    rejoin(room: SavedRemoteRoom, name: string): Promise<void> {
        return this.connect(name, () => this.service.rejoin(room.server, room.roomId, { name: name.trim() }));
    }
    async forget(room: SavedRemoteRoom): Promise<void> {
        try { await this.service.forget(room.server, room.roomId); } catch (error) { this.emit({ error: String((error as Error).message ?? error) }); }
        await this.loadSaved();
        await this.poll();
    }
    async reconnectNow(): Promise<void> {
        try { this.emit({ status: await this.service.reconnectNow(), error: '' }); }
        catch (error) { this.emit({ error: String((error as Error).message ?? error) }); }
        this.reschedule();
    }
    /** Owner only. t3:mp2: single-use invite with a role (the server's invites are always single use). */
    async createInvite(role: RoomInviteRole = 'member'): Promise<void> {
        try { this.emit({ invite: await this.service.createInvite({ ttlMinutes: 60 * 24, role }), error: '' }); }
        catch (error) { this.emit({ error: String((error as Error).message ?? error) }); }
    }
    /** t3:mp2 — owner only: change someone's role. */
    async setMemberRole(memberId: string, role: RoomInviteRole): Promise<void> {
        try { await this.service.setMemberRole(memberId, role); this.emit({ error: '' }); await this.poll(); }
        catch (error) { this.emit({ error: String((error as Error).message ?? error) }); }
    }
    /** t3:mp2 — voice runs over the room server while connected, over local presence otherwise. */
    private setVoice(on: boolean): void {
        if (on === !!this.voice || !this.host.voiceTransport) return;
        if (on) {
            const channel = remoteVoiceChannel(this.service, { every: (fn, ms) => setInterval(fn, ms), stop: h => clearInterval(h as ReturnType<typeof setInterval>) });
            this.voice = { channel };
            this.host.voiceTransport(remoteRoomVoiceTransport(channel));
        } else {
            const old = this.voice; this.voice = undefined;
            this.host.voiceTransport(undefined);
            old?.channel.dispose();
        }
    }
    /** Leave the remote room. PresenceController goes solo; terminals keep running locally. */
    leave(): void {
        // Switch the route first and tell the backend directly; PresenceController's queued leave then
        // lands on the local service (a no-op there), so the order of queued calls cannot leak.
        this.router.route = 'local';
        this.setVoice(false); // t3:mp2
        void this.service.leave().catch(() => undefined);
        if (this.host.presence().phase !== 'solo') this.host.leavePresence();
        this.world.clear();
        this.emit({ status: { phase: 'idle', attempt: 0, error: '', members: [] }, invite: undefined, error: '' });
        void this.loadSaved();
    }

    private async connect(name: string, open: () => Promise<RemoteRoomStatus>): Promise<void> {
        if (this.view.busy) return;
        this.name = name.trim() || 'Builder';
        this.emit({ busy: true, error: '', invite: undefined });
        try {
            // Leave any LOCAL room first, so local and remote presence never mix.
            if (this.router.route === 'local' && this.host.presence().phase !== 'solo') this.host.leavePresence();
            const status = await open();
            this.router.route = 'remote';
            this.agentsSent = '';
            this.emit({ status, busy: false });
            await this.world.sync(status.worldRevision);
            this.setVoice(true); // t3:mp2
            if (status.roomId) this.host.joinPresence(status.roomId, this.name);
            await this.loadSaved();
        } catch (error) {
            let status = this.view.status;
            try { status = await this.service.status(); } catch { /* keep last */ }
            this.emit({ busy: false, error: String((error as Error).message ?? error), status });
        }
        this.reschedule();
    }

    private reschedule(): void {
        if (this.disposed) return;
        if (this.timer !== undefined) this.host.cancel(this.timer);
        this.timer = this.host.schedule(() => { this.timer = undefined; void this.poll().finally(() => { if (this.view.status.phase !== 'idle') this.reschedule(); }); }, 1000);
    }

    private async poll(): Promise<void> {
        if (this.disposed) return;
        let status: RemoteRoomStatus;
        try { status = await this.service.status(); } catch { return; }
        const was = this.view.status.phase;
        if (status.phase === 'idle' || status.phase === 'failed') {
            if (this.router.route === 'remote') {
                this.router.route = 'local';
                this.world.clear();
            }
            this.setVoice(false); // t3:mp2
        } else if (status.phase === 'joined') {
            if (this.router.route !== 'remote') this.router.route = 'remote';
            this.setVoice(true); // t3:mp2
            // After a reconnect, rejoin PresenceController if it dropped to solo meanwhile.
            if (this.host.presence().phase === 'solo' && status.roomId && was !== 'idle') this.host.joinPresence(status.roomId, this.name);
            await this.world.sync(status.worldRevision).catch(() => undefined);
            const agents = agentSummary(this.host.agents()), sig = JSON.stringify(agents);
            if (sig !== this.agentsSent) { this.agentsSent = sig; void this.service.setAgents(agents).catch(() => { this.agentsSent = ''; }); }
        }
        const retryIn = status.phase === 'reconnecting' && status.retryAt ? Math.max(0, Math.ceil((status.retryAt - Date.now()) / 1000)) : undefined;
        this.emit({ status, retryIn });
        if (status.phase === 'idle' && was !== 'idle') void this.loadSaved();
    }

    dispose(): void {
        this.disposed = true;
        this.voice?.channel.dispose(); this.voice = undefined; // t3:mp2
        if (this.timer !== undefined) this.host.cancel(this.timer);
        this.timer = undefined;
    }
}
