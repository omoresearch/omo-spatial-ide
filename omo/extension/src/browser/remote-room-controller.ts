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
import type { AgentStatusSummary } from '../common/room-wire-protocol';
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
    clear(): void { this.latest = undefined; }
    private set(world: WorldSpec): void {
        if (this.latest && this.latest.revision === world.revision && JSON.stringify(this.latest) === JSON.stringify(world)) return;
        this.latest = world;
        for (const l of this.listeners) { try { l(world); } catch { /* listener errors stay local */ } }
    }
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
}

export interface RemoteRoomView {
    status: RemoteRoomStatus;
    route: RoomRoute;
    busy: boolean;
    error: string;
    saved: SavedRemoteRoom[];
    invite?: { link: string; expiresAt: number };
    /** Seconds until the next automatic retry (reconnecting only). */
    retryIn?: number;
}

const DESK_LABEL: Record<string, string> = { terminal: 'Desk one', 'terminal-2': 'Desk two' };
const KIND_LABEL: Record<string, string> = { hermes: 'Hermes', claude: 'Claude', codex: 'Codex' };

/** Closed-vocabulary summary of local agent tabs. Never tab names, terminal text or output. */
export function agentSummary(agents: AgentPresence[]): AgentStatusSummary[] {
    return agents.slice(0, 16).map(a => ({
        key: `${a.desk}:${a.key.replace(/[^A-Za-z0-9:_-]/g, '-')}`.slice(0, 80),
        desk: a.desk,
        kind: a.kind,
        label: `${KIND_LABEL[a.kind] ?? 'Agent'} · ${DESK_LABEL[a.desk] ?? 'Desk'}`,
        activity: a.activity
    }));
}

export class RemoteRoomController {
    readonly world: RemoteWorldSource;
    private view: RemoteRoomView = { status: { phase: 'idle', attempt: 0, error: '', members: [] }, route: 'local', busy: false, error: '', saved: [] };
    private timer?: unknown;
    private agentsSent = '';
    private disposed = false;
    private name = 'Builder';

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
        return this.connect(name, () => this.service.host({ server: input.server, ownerToken: input.ownerToken, roomId: input.roomId, roomName: input.roomName, seedWorld }, { name: name.trim() }));
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
    async createInvite(): Promise<void> {
        try { this.emit({ invite: await this.service.createInvite({ ttlMinutes: 60 * 24, maxUses: 10 }), error: '' }); }
        catch (error) { this.emit({ error: String((error as Error).message ?? error) }); }
    }
    /** Leave the remote room. PresenceController goes solo; terminals keep running locally. */
    leave(): void {
        if (this.router.route === 'remote' && this.host.presence().phase !== 'solo') this.host.leavePresence(); // routes to remote.leave()
        else void this.service.leave().catch(() => undefined);
        this.router.route = 'local';
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
        } else if (status.phase === 'joined') {
            if (this.router.route !== 'remote') this.router.route = 'remote';
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
        if (this.timer !== undefined) this.host.cancel(this.timer);
        this.timer = undefined;
    }
}
