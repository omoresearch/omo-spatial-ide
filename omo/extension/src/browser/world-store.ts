/**
 * WorldStore (w2 build lane) — the one place a browser session keeps a project's WorldSpec.
 *
 * - Loads/saves the world per project in local storage under `worldStorageKey(projectUri)`.
 *   The first load of a project with no v2 world migrates its v1 RoomState via `worldFromRoomV1`
 *   (ids terminal / terminal-2 / web / mirror / code are kept) and saves it.
 * - Every change is a proposal: `propose()` / `amend()` build a PREVIEW world (the applied world
 *   plus the pending ops) with a human diff summary. Nothing is saved until `apply()`;
 *   `discard()` drops it.
 * - Applied batches form an undo/redo stack. Undo applies the inverse patch through
 *   `applyWorldOps`, so locks and validation still hold (a station locked later refuses undo).
 * - Emits a change event for every state change. It never starts an agent and never stores
 *   secrets: WorldSpec validation is the shared contract's.
 */
import {
    WorldSpec, WorldOp, WorldProposal, WorldResult, WorldEntity, StationConfig, WorldShell,
    applyWorldOps, validateWorld, worldFromRoomV1, worldStorageKey
} from '../common/world-model';
import { parseRoomState } from '../common/room-state';
import type { RoomState } from '../common/room-state';

/**
 * t3:mp2 — a shared room world (RemoteWorldSource in remote-room-controller.ts) that replaces local storage while connected.
 * `current()` undefined = not connected. `apply` sends ops with the proposal's baseRevision to the room server.
 */
export interface RemoteWorldLink {
    current(): WorldSpec | undefined;
    apply(proposal: WorldProposal): Promise<
        | { ok: true; world: WorldSpec }
        | { ok: false; conflict: true; error: string; world: WorldSpec; rebased?: WorldProposal; preview?: WorldSpec }
        | { ok: false; conflict: false; error: string }>;
    /** Fired when the room world changes or the connection starts/ends. Returns unsubscribe. */
    onStatus(listener: () => void): () => void;
}

export interface WorldStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** The v1 room a first load migrates from. */
export type RoomV1 = Pick<RoomState, 'theme' | 'projectName' | 'layout' | 'kit'>;

export interface WorldStoreOptions {
    storage: WorldStorage | undefined;
    projectUri: string;
    /** v1 room to migrate from when no v2 world is saved. Default: read `omo.room.v1:<projectUri>` from storage. */
    roomV1?: RoomV1;
    /** Max applied batches kept for undo. */
    maxHistory?: number;
}

/** One user action inside a pending proposal (Ctrl+Z inside a draft drops the last step). */
export interface ProposalStep { label: string; ops: WorldOp[] }

export interface PendingProposal extends WorldProposal {
    steps: ProposalStep[];
    /** Human lines describing world -> preview (coalesced: a desk moved three times is one line). */
    diff: string[];
}

export type WorldStoreEvent = 'load' | 'propose' | 'apply' | 'discard' | 'undo' | 'redo' | 'external' | 'error';
export interface WorldStoreChange { reason: WorldStoreEvent; world: WorldSpec; preview: WorldSpec; proposal?: PendingProposal; error?: string }

interface HistoryEntry { label: string; before: WorldSpec; after: WorldSpec; ops: WorldOp[] }

const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
/** Ops keep explicit `undefined` keys (`{ profile: undefined }` clears a profile in the contract's merge). */
const cloneOps = (ops: readonly WorldOp[]): WorldOp[] => typeof structuredClone === 'function' ? structuredClone(ops) as WorldOp[] : ops.map(o => ({ ...o, ...('station' in o ? { station: { ...o.station, ...(o.station.tabs ? { tabs: o.station.tabs.map(t => ({ ...t })) } : {}) } } : {}) }) as WorldOp);
let proposalCounter = 0;
const proposalId = (): string => `p-${Date.now().toString(36)}-${(++proposalCounter).toString(36)}`;

export class WorldStore {
    readonly key: string;
    private current?: WorldSpec;
    private pending?: PendingProposal;
    private previewWorld?: WorldSpec;
    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];
    private listeners = new Set<(change: WorldStoreChange) => void>();
    private readonly maxHistory: number;
    /** Set when the saved world could not be read (it is kept under `<key>:unreadable`). */
    loadError = '';
    /** Last save/apply/undo error, for the UI. */
    lastError = '';
    // t3:mp2 — remote room source (only while connected): the room's world replaces local storage.
    private remote?: RemoteWorldLink;
    private offRemote?: () => void;
    private remoteOn = false;
    private remoteBusy = false;

    constructor(private readonly options: WorldStoreOptions) {
        this.key = worldStorageKey(options.projectUri);
        this.maxHistory = Math.max(1, options.maxHistory ?? 50);
    }

    get projectUri(): string { return this.options.projectUri; }
    get loaded(): boolean { return !!this.current; }
    /** The applied (saved) world. */
    get world(): WorldSpec { return this.current ?? this.load(); }
    /** The applied world plus the pending proposal; the applied world when nothing is pending. */
    get preview(): WorldSpec { return this.previewWorld ?? this.world; }
    get proposal(): PendingProposal | undefined { return this.pending; }
    get canUndo(): boolean { return this.undoStack.length > 0; }
    get canRedo(): boolean { return this.redoStack.length > 0; }
    /** t3:mp2 — true while the shared room world (not local storage) is the world. */
    get remoteActive(): boolean { return this.remoteOn; }
    /** t3:mp2 — true while a change is on its way to the room server. */
    get sending(): boolean { return this.remoteBusy; }

    /**
     * t3:mp2 — use a remote room as the world source. While `link.current()` gives a world, it REPLACES the local
     * world (nothing is written to local storage) and Apply/Undo/Redo send ops to the room server. When the link
     * ends (leave/disconnect), the local saved world comes back unchanged.
     */
    attachRemote(link: RemoteWorldLink | undefined): void {
        if (link === this.remote) return;
        this.offRemote?.(); this.offRemote = undefined; this.remote = link;
        if (link) this.offRemote = link.onStatus(() => this.remoteChanged());
        this.remoteChanged();
    }
    private remoteChanged(): void {
        if (this.remoteBusy) return; // the in-flight apply reconciles when it returns
        const world = this.remote?.current();
        if (world) {
            const entering = !this.remoteOn;
            if (!entering && this.current && this.current.revision === world.revision && sameWorld(this.current, world)) return;
            if (entering) { this.remoteOn = true; this.pending = undefined; this.previewWorld = undefined; this.undoStack = []; this.redoStack = []; }
            this.current = clone(world);
            this.rebase();
            this.emit('external');
        } else if (this.remoteOn) {
            this.remoteOn = false; this.pending = undefined; this.previewWorld = undefined; this.undoStack = []; this.redoStack = [];
            this.current = undefined;
            this.load();
        }
    }
    /** t3:mp2 — send ops to the room. The local world changes only when the server accepts them. */
    private applyRemote(ops: WorldOp[], label: string, kind: 'apply' | 'undo' | 'redo', entry?: HistoryEntry): WorldResult {
        const link = this.remote!;
        if (this.remoteBusy) return this.fail('Your last change is still on its way to the room. Wait a moment.');
        const before = this.world;
        const local = applyWorldOps(before, ops);
        if (!local.ok) return this.fail(local.error);
        const proposal: WorldProposal = { id: this.pending?.id ?? proposalId(), source: this.pending?.source ?? 'build-mode', summary: label, ops: cloneOps(ops), baseRevision: before.revision };
        this.remoteBusy = true;
        void link.apply(proposal).then(outcome => {
            this.remoteBusy = false;
            if (!this.remoteOn) return;
            if (outcome.ok) {
                this.current = clone(outcome.world);
                if (kind === 'apply') { this.pending = undefined; this.previewWorld = undefined; this.push(this.undoStack, { label, before, after: this.current, ops: proposal.ops }); this.redoStack = []; }
                else if (kind === 'undo' && entry) { this.undoStack.pop(); this.redoStack.push(entry); }
                else if (kind === 'redo' && entry) { this.redoStack.pop(); this.push(this.undoStack, { ...entry, before, after: this.current }); }
                this.lastError = '';
                this.emit(kind);
            } else if (outcome.conflict) {
                // Someone changed the room first: take their world, re-propose this change on top of it, ask again.
                this.current = clone(outcome.world);
                if (kind === 'apply' && this.pending) {
                    this.rebase();
                    this.fail(this.pending
                        ? 'Someone changed the room first. Your change is shown again on top of theirs. Check it and press Apply again.'
                        : `Someone changed the room first, and your change no longer fits. ${this.lastError}`);
                } else { this.undoStack = []; this.redoStack = []; this.fail('Someone changed the room first, so undo history was cleared. You see the latest room.'); }
            } else this.fail(outcome.error);
            this.remoteChanged(); // catch up with pushes that arrived while sending
        }, error => { this.remoteBusy = false; this.fail(`The room server did not take the change: ${error instanceof Error ? error.message : String(error)}`); });
        return local;
    }
    get undoLabel(): string | undefined { return this.undoStack[this.undoStack.length - 1]?.label; }
    get redoLabel(): string | undefined { return this.redoStack[this.redoStack.length - 1]?.label; }

    onChange(listener: (change: WorldStoreChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

    /** Read the saved v2 world, or migrate the v1 room on first load. Safe to call again (re-reads). */
    load(): WorldSpec {
        this.loadError = '';
        const shared = this.remoteOn ? this.remote?.current() : undefined; // t3:mp2
        if (shared) { this.current = clone(shared); this.rebase(); this.emit('load'); return this.current; }
        const raw = this.read(this.key);
        if (raw) {
            const parsed = parseWorld(raw);
            if (parsed.ok) { this.current = parsed.world; this.rebase(); this.emit('load'); return parsed.world; }
            // Keep the unreadable copy; never silently overwrite the user's data.
            this.write(`${this.key}:unreadable`, raw);
            this.loadError = `The saved world could not be read (${parsed.error}) A copy was kept; the room was rebuilt from its v1 settings.`;
        }
        const room = this.options.roomV1 ?? parseRoomState(this.read(`omo.room.v1:${this.options.projectUri}`), this.options.projectUri);
        const migrated = worldFromRoomV1(room ?? { theme: 'station', projectName: projectNameOf(this.options.projectUri) });
        this.current = migrated;
        if (!this.loadError) this.write(this.key, JSON.stringify(migrated));
        this.rebase(); this.emit('load');
        return migrated;
    }

    /** Replace the pending proposal. Returns the preview world, or why the ops are refused (nothing changes then). */
    propose(proposal: Omit<WorldProposal, 'id' | 'baseRevision'> & Partial<Pick<WorldProposal, 'id' | 'baseRevision'>>): WorldResult {
        const base = this.world;
        const steps: ProposalStep[] = [{ label: proposal.summary, ops: cloneOps(proposal.ops) }];
        const result = applyWorldOps(base, steps[0].ops);
        if (!result.ok) { this.fail(result.error); return result; }
        this.pending = { id: proposal.id ?? proposalId(), source: proposal.source, summary: proposal.summary, ops: cloneOps(proposal.ops), baseRevision: base.revision, steps, diff: [] };
        this.previewWorld = result.world;
        this.pending.diff = describeChange(base, result.world);
        this.lastError = '';
        this.emit('propose');
        return result;
    }

    /** Add one step to the pending proposal (creates it when none). Build mode uses this for each click. */
    amend(ops: WorldOp[], label: string, source: WorldProposal['source'] = 'build-mode'): WorldResult {
        if (!this.pending) return this.propose({ source, summary: label, ops });
        const base = this.world;
        const steps = [...this.pending.steps, { label, ops: cloneOps(ops) }];
        const all = steps.flatMap(step => step.ops);
        const result = applyWorldOps(base, all);
        if (!result.ok) { this.fail(result.error); return result; }
        this.pending = { ...this.pending, steps, ops: all, summary: summarize(steps), diff: describeChange(base, result.world) };
        this.previewWorld = result.world;
        this.lastError = '';
        this.emit('propose');
        return result;
    }

    /** Drop the last step of the pending proposal (Ctrl+Z while a draft is open). False when nothing is pending. */
    dropLastStep(): boolean {
        if (!this.pending) return false;
        const steps = this.pending.steps.slice(0, -1);
        if (!steps.length) { this.discard(); return true; }
        const all = steps.flatMap(step => step.ops);
        const result = applyWorldOps(this.world, all);
        if (!result.ok) { this.discard(); return true; }
        this.pending = { ...this.pending, steps, ops: all, summary: summarize(steps), diff: describeChange(this.world, result.world) };
        this.previewWorld = result.world;
        this.emit('propose');
        return true;
    }

    /** Apply the pending proposal atomically, save it and push it on the undo stack. */
    apply(): WorldResult {
        const pending = this.pending;
        if (!pending) return { ok: false, error: 'There is no change to apply.' };
        if (this.remoteOn) return this.applyRemote(pending.ops, pending.summary, 'apply'); // t3:mp2
        const before = this.world;
        const result = applyWorldOps(before, pending.ops);
        if (!result.ok) { this.fail(result.error); return result; }
        if (!this.write(this.key, JSON.stringify(result.world))) { const error = 'The world could not be saved. Check browser storage.'; this.fail(error); return { ok: false, error }; }
        this.current = result.world; this.pending = undefined; this.previewWorld = undefined;
        this.push(this.undoStack, { label: pending.summary, before, after: result.world, ops: pending.ops });
        this.redoStack = [];
        this.lastError = '';
        this.emit('apply');
        return result;
    }

    discard(): void {
        if (!this.pending) return;
        this.pending = undefined; this.previewWorld = undefined; this.lastError = '';
        this.emit('discard');
    }

    /** Undo the last applied batch with its inverse patch (validated; locks still hold). */
    undo(): WorldResult {
        if (this.pending) return this.fail('Apply or discard the pending change first.');
        const entry = this.undoStack[this.undoStack.length - 1];
        if (!entry) return this.fail('Nothing to undo.');
        const inverse = diffWorlds(entry.after, entry.before);
        if (this.remoteOn) return this.applyRemote(inverse, `Undo ${entry.label}`, 'undo', entry); // t3:mp2
        const result = applyWorldOps(this.world, inverse);
        if (!result.ok) return this.fail(`Could not undo “${entry.label}”: ${result.error}`);
        if (!this.write(this.key, JSON.stringify(result.world))) return this.fail('The world could not be saved. Check browser storage.');
        this.undoStack.pop(); this.redoStack.push(entry);
        this.current = result.world; this.lastError = '';
        this.emit('undo');
        return result;
    }

    redo(): WorldResult {
        if (this.pending) return this.fail('Apply or discard the pending change first.');
        const entry = this.redoStack[this.redoStack.length - 1];
        if (!entry) return this.fail('Nothing to redo.');
        if (this.remoteOn) return this.applyRemote(entry.ops, entry.label, 'redo', entry); // t3:mp2
        const result = applyWorldOps(this.world, entry.ops);
        if (!result.ok) return this.fail(`Could not redo “${entry.label}”: ${result.error}`);
        if (!this.write(this.key, JSON.stringify(result.world))) return this.fail('The world could not be saved. Check browser storage.');
        this.redoStack.pop(); this.push(this.undoStack, { ...entry, before: this.world, after: result.world });
        this.current = result.world; this.lastError = '';
        this.emit('redo');
        return result;
    }

    /** Another tab or lane saved this project's world. Re-read it; a pending draft is rebased or dropped. */
    reloadExternal(raw?: string | null): void {
        if (this.remoteOn) return; // t3:mp2: local storage is not the world while in a remote room
        const text = raw === undefined ? this.read(this.key) : raw;
        if (!text) return;
        const parsed = parseWorld(text);
        if (!parsed.ok || (this.current && parsed.world.revision === this.current.revision && sameWorld(parsed.world, this.current))) return;
        this.current = parsed.world;
        // Undo entries were recorded against the old world; their inverse patches still apply where they can.
        this.rebase();
        this.emit('external');
    }

    private rebase(): void {
        if (!this.pending || !this.current) { this.previewWorld = undefined; return; }
        const result = applyWorldOps(this.current, this.pending.ops);
        if (!result.ok) { this.pending = undefined; this.previewWorld = undefined; this.lastError = `The pending change no longer fits the world and was dropped: ${result.error}`; return; }
        this.pending = { ...this.pending, baseRevision: this.current.revision, diff: describeChange(this.current, result.world) };
        this.previewWorld = result.world;
    }
    private push(stack: HistoryEntry[], entry: HistoryEntry): void { stack.push(entry); if (stack.length > this.maxHistory) stack.shift(); }
    private fail(error: string): { ok: false; error: string } { this.lastError = error; this.emit('error', error); return { ok: false, error }; }
    private emit(reason: WorldStoreEvent, error?: string): void {
        if (!this.current) return;
        const change: WorldStoreChange = { reason, world: this.current, preview: this.preview, proposal: this.pending, error };
        for (const listener of [...this.listeners]) { try { listener(change); } catch { /* a listener never breaks the store */ } }
    }
    private read(key: string): string | null { try { return this.options.storage?.getItem(key) ?? null; } catch { return null; } }
    private write(key: string, value: string): boolean { try { if (!this.options.storage) return false; this.options.storage.setItem(key, value); return true; } catch { return false; } }
}

function projectNameOf(uri: string): string {
    const base = decodeURIComponent(uri.replace(/\/+$/, '').split('/').pop() ?? '').trim();
    return (base || 'My workspace').slice(0, 120);
}
function summarize(steps: ProposalStep[]): string {
    if (steps.length === 1) return steps[0].label;
    return `${steps[steps.length - 1].label} (+${steps.length - 1} more)`;
}
export function parseWorld(raw: string): WorldResult {
    try { return validateWorld(JSON.parse(raw)); } catch { return { ok: false, error: 'Not JSON.' }; }
}

// ---------------------------------------------------------------- diff + description helpers

const ENTITY_NOUN: Record<WorldEntity['kind'], string> = {
    station: 'desk', 'monitor-wall': 'monitor wall', 'web-wall': 'web wall', mirror: 'mirror', 'review-screen': 'review screen', decor: 'decor', room: 'room'
};
/** The name a person reads for an entity. */
export function entityTitle(entity: WorldEntity | undefined, fallbackId = ''): string {
    if (!entity) return fallbackId || 'something';
    if (entity.label) return entity.label;
    if (entity.kind === 'station') return entity.station.name;
    if (entity.kind === 'decor') return cap(entity.decor);
    return cap(ENTITY_NOUN[entity.kind]);
}
export function entityNoun(entity: WorldEntity): string {
    if (entity.kind === 'station') return entity.station.kind === 'hermes' ? 'agent desk' : 'shell desk';
    if (entity.kind === 'decor') return entity.decor;
    return ENTITY_NOUN[entity.kind];
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const m = (n: number): string => `${Math.round(n * 100) / 100}`;

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) { const bb = b as unknown[]; return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i])); }
    const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
/** Same content (entity order and revision ignored). */
export function sameWorld(a: WorldSpec, b: WorldSpec): boolean {
    if (a.name !== b.name || !deepEqual(a.shell, b.shell) || a.entities.length !== b.entities.length) return false;
    const map = new Map(b.entities.map(e => [e.id, e]));
    return a.entities.every(e => deepEqual(e, map.get(e.id)));
}

/**
 * Ops that turn world `a` into world `b` (plan text excluded). Order: unlocks, replacements,
 * adds, edits, removes (non-stations first), locks. Verified: if replaying them on `a` does not
 * give `b`, it falls back to remove + re-add of every differing entity.
 */
export function diffWorlds(a: WorldSpec, b: WorldSpec): WorldOp[] {
    const unlocks: WorldOp[] = [], replaceRemoves: WorldOp[] = [], adds: WorldOp[] = [], edits: WorldOp[] = [], removes: WorldOp[] = [], stationRemoves: WorldOp[] = [], locks: WorldOp[] = [];
    if (a.name !== b.name) edits.push({ op: 'name', name: b.name });
    if (!deepEqual(a.shell, b.shell)) {
        const shell: Partial<WorldShell> = {};
        (Object.keys(b.shell) as Array<keyof WorldShell>).forEach(k => { if (a.shell[k] !== b.shell[k]) (shell as Record<string, unknown>)[k] = b.shell[k]; });
        edits.push({ op: 'shell', shell });
    }
    const inB = new Map(b.entities.map(e => [e.id, e]));
    const inA = new Map(a.entities.map(e => [e.id, e]));
    for (const ea of a.entities) {
        const eb = inB.get(ea.id);
        if (!eb) {
            if (ea.kind === 'station' && ea.station.locked) unlocks.push({ op: 'update-station', id: ea.id, station: { locked: false } });
            (ea.kind === 'station' ? stationRemoves : removes).push({ op: 'remove', id: ea.id }); continue;
        }
        if (deepEqual(ea, eb)) continue;
        if (!editable(ea, eb)) {
            if (ea.kind === 'station' && ea.station.locked) unlocks.push({ op: 'update-station', id: ea.id, station: { locked: false } });
            replaceRemoves.push({ op: 'remove', id: ea.id }); adds.push({ op: 'add', entity: clone(eb) }); continue;
        }
        if (ea.kind === 'station' && eb.kind === 'station') {
            if (ea.station.locked && !eb.station.locked) unlocks.push({ op: 'update-station', id: ea.id, station: { locked: false } });
            const change: Partial<StationConfig> = {};
            for (const k of ['name', 'kind', 'profile', 'tabs'] as const) if (!deepEqual(ea.station[k], eb.station[k])) (change as Record<string, unknown>)[k] = clone(eb.station[k]);
            // An explicit `profile: undefined` key clears the profile in the contract's spread merge.
            if (Object.keys(change).length) edits.push({ op: 'update-station', id: ea.id, station: change });
            if (!ea.station.locked && eb.station.locked) locks.push({ op: 'update-station', id: ea.id, station: { locked: true } });
        }
        if (!deepEqual(ea.transform, eb.transform)) edits.push({ op: 'move', id: ea.id, transform: { ...eb.transform } });
        if (ea.label !== eb.label && eb.label) edits.push({ op: 'rename', id: ea.id, label: eb.label });
        if ((ea.kind === 'monitor-wall' || ea.kind === 'web-wall') && (eb.kind === ea.kind) && (ea.width !== eb.width || ea.height !== eb.height || ea.elevation !== eb.elevation)) edits.push({ op: 'resize', id: ea.id, width: eb.width, height: eb.height, elevation: eb.elevation });
        if ((ea.kind === 'monitor-wall' && eb.kind === 'monitor-wall') || (ea.kind === 'mirror' && eb.kind === 'mirror')) if (ea.link !== eb.link) edits.push({ op: 'link', id: ea.id, to: eb.link });
    }
    for (const eb of b.entities) if (!inA.has(eb.id)) adds.push({ op: 'add', entity: clone(eb) });
    // Edits on a station that is locked in both worlds are refused by applyWorldOps — that is the lock working.
    const ops = [...unlocks, ...replaceRemoves, ...adds, ...edits, ...removes, ...stationRemoves, ...locks];
    const check = applyWorldOps(a, ops);
    if (check.ok && sameWorld(check.world, b)) return ops;
    // Fallback: rebuild every differing entity. Still validated by the caller's applyWorldOps.
    const rebuild: WorldOp[] = [...unlocks];
    if (a.name !== b.name) rebuild.push({ op: 'name', name: b.name });
    if (!deepEqual(a.shell, b.shell)) rebuild.push({ op: 'shell', shell: clone(b.shell) });
    for (const ea of a.entities) if (!deepEqual(ea, inB.get(ea.id)) && !(ea.kind === 'mirror' && inB.get(ea.id) === undefined && removedWithStation(ea, b))) rebuild.push({ op: 'remove', id: ea.id });
    for (const eb of b.entities) if (!deepEqual(eb, inA.get(eb.id))) rebuild.push({ op: 'add', entity: clone(eb) });
    return rebuild;
}
function removedWithStation(mirror: WorldEntity, b: WorldSpec): boolean { return mirror.kind === 'mirror' && !b.entities.some(e => e.id === mirror.link); }
/** Can `a` become `b` with edit ops (no op exists for web-wall home or decor kind/scale, or for clearing a label). */
function editable(a: WorldEntity, b: WorldEntity): boolean {
    if (a.kind !== b.kind) return false;
    if (a.label !== undefined && b.label === undefined) return false;
    if (a.kind === 'web-wall' && b.kind === 'web-wall' && a.home !== b.home) return false;
    if (a.kind === 'decor' && b.kind === 'decor' && (a.decor !== b.decor || a.scale !== b.scale)) return false;
    return true;
}

/** Human summary of the change from `a` to `b` (the diff a person approves). */
export function describeChange(a: WorldSpec, b: WorldSpec): string[] {
    const lines: string[] = [];
    if (a.name !== b.name) lines.push(`Rename world to “${b.name}”`);
    if (a.shell.theme !== b.shell.theme) lines.push(`Theme: ${b.shell.theme}`);
    if (a.shell.width !== b.shell.width || a.shell.depth !== b.shell.depth) lines.push(`Room size ${m(b.shell.width)} × ${m(b.shell.depth)} m`);
    const inA = new Map(a.entities.map(e => [e.id, e]));
    const inB = new Map(b.entities.map(e => [e.id, e]));
    const title = (id: string | undefined): string => entityTitle(inB.get(id ?? '') ?? inA.get(id ?? ''), id);
    for (const eb of b.entities) {
        const ea = inA.get(eb.id);
        if (!ea) {
            const link = (eb.kind === 'mirror' || eb.kind === 'monitor-wall') && eb.link ? ` linked to ${title(eb.link)}` : '';
            const size = eb.kind === 'monitor-wall' || eb.kind === 'web-wall' ? ` (${m(eb.width)} × ${m(eb.height)} m)` : '';
            lines.push(`Add ${entityNoun(eb)} “${entityTitle(eb)}”${size}${link}${eb.kind === 'station' && eb.station.locked ? ', locked' : ''}`);
            continue;
        }
        if (deepEqual(ea, eb)) continue;
        const name = entityTitle(ea);
        const moved = ea.transform.x !== eb.transform.x || ea.transform.z !== eb.transform.z;
        const turned = ea.transform.rotation !== eb.transform.rotation;
        if (moved && turned) lines.push(`Move and turn ${name}`);
        else if (moved) lines.push(`Move ${name}`);
        else if (turned) lines.push(`Turn ${name} to ${Math.round(((eb.transform.rotation * 180 / Math.PI) % 360 + 360) % 360)}°`);
        if (ea.label !== eb.label) lines.push(eb.label ? `Rename ${name} to “${eb.label}”` : `Clear the label of ${name}`);
        if (ea.kind === 'station' && eb.kind === 'station') {
            const s = ea.station, t = eb.station, parts: string[] = [];
            if (s.name !== t.name) parts.push(`name “${t.name}”`);
            if (s.kind !== t.kind) parts.push(t.kind === 'hermes' ? 'agent desk' : 'shell desk');
            if (s.profile !== t.profile) parts.push(t.profile ? `profile “${t.profile}”` : 'workspace default profile');
            if (!deepEqual(s.tabs, t.tabs)) parts.push(`starting tabs: ${t.tabs.map(tab => tab.name).join(', ')}`);
            if (parts.length) lines.push(`Station Setup · ${name}: ${parts.join(', ')}`);
            if (s.locked !== t.locked) lines.push(`${t.locked ? 'Lock' : 'Unlock'} ${name}`);
        }
        if ((ea.kind === 'monitor-wall' || ea.kind === 'web-wall') && ea.kind === eb.kind && (ea.width !== eb.width || ea.height !== eb.height || ea.elevation !== eb.elevation)) {
            const e = eb as typeof ea;
            lines.push(`Resize ${name} to ${m(e.width)} × ${m(e.height)} m at ${m(e.elevation)} m`);
        }
        if ((ea.kind === 'monitor-wall' || ea.kind === 'mirror') && ea.kind === eb.kind) {
            const from = ea.link, to = (eb as typeof ea).link;
            if (from !== to) lines.push(to ? `Link ${name} → ${title(to)}` : `Unlink ${name}`);
        }
        if (ea.kind === 'web-wall' && eb.kind === 'web-wall' && ea.home !== eb.home) lines.push(`${name} home page: ${eb.home ?? 'none'}`);
        if (ea.kind === 'decor' && eb.kind === 'decor' && (ea.decor !== eb.decor || ea.scale !== eb.scale)) lines.push(`Change ${name} to ${eb.decor}${eb.scale ? ` × ${m(eb.scale)}` : ''}`);
    }
    for (const ea of a.entities) if (!inB.has(ea.id)) lines.push(`Remove ${entityNoun(ea)} “${entityTitle(ea)}”`);
    return lines;
}
