/**
 * w2:runtime — WorldStations: N agent stations instead of two hard-coded desks.
 *
 * Given a WorldSpec (common/world-model.ts) this service owns one RuntimeConsoleController per
 * station id. Controllers are created lazily (first use) and disposed when the station leaves the
 * world. Disposal only detaches views; tabs and processes keep running on the runtime.
 *
 * Compatibility: station ids 'terminal' and 'terminal-2' keep the exact runtime station ids and
 * browser binding keys the two-desk room used ('terminal-1' and 'terminal-2'), so saved workspaces
 * reconnect unchanged. Any other station id maps to runtime station `station-<id>`.
 *
 * Safety: nothing here starts an agent, types, or presses Enter. StationConfig tabs become a
 * "station setup" recipe that is only OFFERED through the controller's explicit confirmation.
 * No secrets, tokens or host paths are read from or written to the WorldSpec.
 */
import type { OmoRuntimeService, RuntimeFrame, SessionWorkspace } from '../common/runtime-protocol';
import type { PresenceJoin } from '../common/presence-protocol';
import { presenceStation } from '../common/presence-protocol';
import type { RoomState } from '../common/room-state';
import type { StationConfig, StationEntity, WorldEntity, WorldOp, WorldResult, WorldSpec } from '../common/world-model';
import { WORLD_ID_RE, applyWorldOps, stations as worldStations, validateWorld, worldFromRoomV1, worldStorageKey } from '../common/world-model';
import { RuntimeConsoleController, bindingKey } from './runtime-console-controller';
import type { RuntimeConsoleState, StationBinding, StorageLike } from './runtime-console-controller';
import type { StationRecipe, StationRecipeTab } from './station-recipe';
import { STATION_RECIPE_VERSION, validateStationRecipe } from './station-recipe';

export type StationId = string;
/** The two desks every v1 room had. Their ids never change. */
export const LEGACY_STATIONS: readonly StationId[] = ['terminal', 'terminal-2'];
export const LEGACY_NAMES: Readonly<Record<string, string>> = { terminal: 'Desk one', 'terminal-2': 'Desk two' };
/** Window event other lanes (build mode, onboarding, admin, multiplayer) fire after a world changes. */
export const WORLD_CHANGED_EVENT = 'omo:world-changed';
export interface WorldChangedDetail { projectUri: string; world: WorldSpec }
/** Quick-switch keys reach this many stations (Ctrl+1..9). Further stations are still in the switcher. */
export const STATION_SLOT_KEYS = 9;

export interface StationInfo {
    id: StationId;
    /** 1-based order in the world (desk switcher, Ctrl+N, @desk-N). */
    slot: number;
    name: string;
    config: StationConfig;
    position?: { x: number; z: number; rotation: number };
}

const ORDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
export function handleSlug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

/** Runtime station id for a world station id (legacy desks keep theirs). */
export function runtimeStationId(id: StationId): string {
    if (id === 'terminal') return 'terminal-1';
    if (id === 'terminal-2') return 'terminal-2';
    return `station-${id}`;
}

/** Every handle that names a station: id, name slug, desk-N / deskN / N, desk-<ordinal> / <ordinal>. */
export function stationAliases(info: Pick<StationInfo, 'id' | 'slot' | 'name'>): string[] {
    const out = new Set<string>([info.id, `desk${info.slot}`, `desk-${info.slot}`, String(info.slot)]);
    const ordinal = ORDINALS[info.slot - 1];
    if (ordinal) { out.add(ordinal); out.add(`desk-${ordinal}`); out.add(`desk${ordinal}`); }
    const name = handleSlug(info.name);
    if (name) { out.add(name); out.add(name.replace(/-/g, '')); }
    return [...out];
}

/**
 * t4:polish — why the room layout cannot change, naming every locked desk (same wording family as the
 * widget's lockedDeskReason). `inSetup` = locked in the world's Station Setup (build mode), else the browser lock.
 */
export function lockedLayoutReason(locked: ReadonlyArray<{ name: string; inSetup: boolean }>): string {
    if (!locked.length) return '';
    const names = locked.map(d => `“${d.name}”`);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const it = locked.length > 1 ? 'them' : 'it';
    const where = locked.some(d => d.inSetup) ? `build mode (Station Setup) or in Station recipes` : 'Station recipes';
    return `${locked.length > 1 ? 'Desks' : 'Desk'} ${list} ${locked.length > 1 ? 'are' : 'is'} locked, so the room layout cannot change. Unlock ${it} in ${where}, or keep this layout.`;
}
/** Stations of a world in a stable order: legacy desks first (keeps Ctrl+1 / Ctrl+2), then world order. */
export function stationInfos(world: WorldSpec | undefined): StationInfo[] {
    if (!world) return LEGACY_STATIONS.map((id, i) => ({ id, slot: i + 1, name: LEGACY_NAMES[id], config: { name: LEGACY_NAMES[id], kind: i ? 'shell' : 'hermes', tabs: [{ name: 'Shell', kind: 'shell' }], locked: false } }));
    const list = worldStations(world);
    const ordered = [...list.filter(s => LEGACY_STATIONS.includes(s.id)).sort((a, b) => LEGACY_STATIONS.indexOf(a.id) - LEGACY_STATIONS.indexOf(b.id)), ...list.filter(s => !LEGACY_STATIONS.includes(s.id))];
    return ordered.map((s: StationEntity, i) => ({ id: s.id, slot: i + 1, name: s.station.name || s.label || s.id, config: s.station, position: { ...s.transform } }));
}

/** Resolve a handle (without @) to one station id. Exact id first, then slot/ordinal, then name. */
export function resolveStation(handle: string, infos: readonly StationInfo[]): StationId | undefined {
    const h = handle.toLowerCase();
    const exact = infos.find(s => s.id === h); if (exact) return exact.id;
    const matches = infos.filter(s => stationAliases(s).includes(h));
    return matches.length === 1 ? matches[0].id : matches[0]?.id;
}

/**
 * Initial tabs of a StationConfig as a recipe. `existing` tabs already in the workspace count against
 * it (a fresh workspace always has one shell), so applying it never duplicates that shell.
 */
export function setupRecipe(info: StationInfo, profileFallback: string, existing: readonly { kind: string }[] = []): StationRecipe | undefined {
    const pool = existing.map(t => t.kind);
    const tabs: StationRecipeTab[] = [];
    for (const tab of info.config.tabs) {
        const at = pool.indexOf(tab.kind);
        if (at >= 0) { pool.splice(at, 1); continue; }
        tabs.push({ kind: tab.kind, name: tab.name.slice(0, 24) });
    }
    if (!tabs.length) return undefined;
    const recipe: StationRecipe = { version: STATION_RECIPE_VERSION, id: `setup-${info.id}`, name: `Station setup · ${info.name}`.slice(0, 48), stationId: info.id,
        profile: (info.config.profile || profileFallback || 'default').slice(0, 80), tabs: tabs.slice(0, 8) };
    return validateStationRecipe(recipe) ? recipe : undefined;
}

/** Read the project's saved v2 world; else migrate the v1 room losslessly. `stored` says which. */
export function loadWorld(storage: StorageLike | undefined, projectUri: string, room: Pick<RoomState, 'theme' | 'projectName' | 'layout' | 'kit'> | undefined): { world?: WorldSpec; stored: boolean } {
    try {
        const raw = storage?.getItem(worldStorageKey(projectUri));
        if (raw && raw.length <= 256 * 1024) {
            const result = validateWorld(JSON.parse(raw));
            if (result.ok) return { world: result.world, stored: true };
        }
    } catch { /* an unreadable world falls back to the v1 room */ }
    return room ? { world: worldFromRoomV1(room), stored: false } : { stored: false };
}

/**
 * Apply ops through the shared contract (applyWorldOps: atomic + validated), save, and tell other lanes.
 * Used only for explicit user actions in this lane (re-linking the mirror). Never starts anything.
 */
export function saveWorldOps(storage: StorageLike | undefined, projectUri: string, world: WorldSpec | undefined, ops: WorldOp[]): WorldResult {
    if (!world || !storage) return { ok: false, error: 'This world is not saved on this device.' };
    const result = applyWorldOps(world, ops);
    if (!result.ok) return result;
    try { storage.setItem(worldStorageKey(projectUri), JSON.stringify(result.world)); } catch { return { ok: false, error: 'Browser storage is unavailable.' }; }
    try { globalThis.dispatchEvent?.(new CustomEvent<WorldChangedDetail>(WORLD_CHANGED_EVENT, { detail: { projectUri, world: result.world } })); } catch { /* no window (tests) */ }
    return result;
}

/** Mirror / monitor-wall entities and the station each shows. */
export function linkedEntities(world: WorldSpec | undefined): Array<{ entity: WorldEntity; station: StationId }> {
    if (!world) return [];
    const out: Array<{ entity: WorldEntity; station: StationId }> = [];
    for (const e of world.entities) {
        const link = e.kind === 'mirror' || e.kind === 'monitor-wall' ? e.link : undefined;
        if (link && world.entities.some(x => x.id === link && x.kind === 'station')) out.push({ entity: e, station: link });
    }
    return out;
}

// ---- Module directory: read-only view for code that has no handle on the service (hud-peers, mentions). ----
let directory: StationInfo[] = stationInfos(undefined);
const directoryListeners = new Set<(list: readonly StationInfo[]) => void>();
export function currentStations(): readonly StationInfo[] { return directory; }
export function stationName(id: string): string { return directory.find(s => s.id === id)?.name ?? LEGACY_NAMES[id] ?? id; }
export function stationPosition(id: string): { x: number; z: number } | undefined { const p = directory.find(s => s.id === id)?.position; return p ? { x: p.x, z: p.z } : undefined; }
export function onStationDirectory(listener: (list: readonly StationInfo[]) => void): () => void { directoryListeners.add(listener); return () => directoryListeners.delete(listener); }
function publishDirectory(list: StationInfo[]): void { directory = list; directoryListeners.forEach(l => { try { l(list); } catch { /* a listener never breaks the world */ } }); }

export interface WorldStationsOptions {
    service: OmoRuntimeService;
    storage?: StorageLike;
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
    onChange: (state: RuntimeConsoleState, station: StationId) => void;
    onMirrorFrame?: (frame: RuntimeFrame | undefined, station: StationId) => void;
    onMirrorError?: (message: string) => void;
    /** Station list changed (added, removed, renamed, re-ordered). */
    onStations?: (list: readonly StationInfo[], removed: StationId[]) => void;
    /** Extra per-station lock (browser Station Lock). Effective lock = world config lock OR this. */
    localLock?: (station: StationId) => boolean;
}

export interface BindingContext { projectUri: string; roomName: string; personal?: PresenceJoin }

export class WorldStations {
    private world?: WorldSpec;
    private list: StationInfo[] = stationInfos(undefined);
    private controllers = new Map<StationId, RuntimeConsoleController>();
    private states = new Map<StationId, RuntimeConsoleState>();
    private offered = new Set<string>();
    private armed = new Set<StationId>(); // t4:polish: desks the user just opened for the first time
    private disposed = false;
    /** True when the world came from storage (not a fresh v1 migration). */
    stored = false;

    private readonly options: WorldStationsOptions;
    constructor(options: WorldStationsOptions) { this.options = options; publishDirectory(this.list); }

    get spec(): WorldSpec | undefined { return this.world; }
    stations(): readonly StationInfo[] { return this.list; }
    ids(): StationId[] { return this.list.map(s => s.id); }
    has(id: string | undefined): id is StationId { return !!id && this.list.some(s => s.id === id); }
    info(id: StationId): StationInfo | undefined { return this.list.find(s => s.id === id); }
    name(id: StationId): string { return this.info(id)?.name ?? LEGACY_NAMES[id] ?? id; }
    slot(id: StationId): number { return this.info(id)?.slot ?? 0; }
    bySlot(slot: number): StationId | undefined { return this.list[slot - 1]?.id; }
    resolve(handle: string): StationId | undefined { return resolveStation(handle, this.list); }
    /** World lock (StationConfig.locked) or the browser Station Lock. */
    locked(id: StationId): boolean { return !!this.info(id)?.config.locked || !!this.options.localLock?.(id); }
    configLocked(id: StationId): boolean { return !!this.info(id)?.config.locked; }

    /** Replace the world. Removed stations' controllers are disposed (detach only). */
    setWorld(world: WorldSpec | undefined, stored = false): { added: StationId[]; removed: StationId[] } {
        const before = new Set(this.ids());
        this.world = world; this.stored = stored;
        this.list = stationInfos(world);
        const after = new Set(this.ids());
        const removed = [...before].filter(id => !after.has(id));
        const added = [...after].filter(id => !before.has(id));
        for (const id of [...this.controllers.keys()]) if (!after.has(id)) { this.controllers.get(id)?.dispose(); this.controllers.delete(id); this.states.delete(id); }
        for (const id of [...this.armed]) if (!after.has(id)) this.armed.delete(id);
        this.pushLocks();
        publishDirectory(this.list);
        this.options.onStations?.(this.list, removed);
        return { added, removed };
    }

    /** Existing controller only. Readers (HUD ticks, mentions) use this so they never create one. */
    peek(id: StationId): RuntimeConsoleController | undefined { return this.controllers.get(id); }
    /** Controller for a station, created on first use. Undefined for an id not in the world. */
    controller(id: StationId): RuntimeConsoleController | undefined {
        if (this.disposed || !this.has(id)) return undefined;
        let c = this.controllers.get(id);
        if (!c) {
            c = new RuntimeConsoleController({ service: this.options.service, storage: this.options.storage, schedule: this.options.schedule, cancel: this.options.cancel,
                preferredProfile: () => this.info(id)?.config.profile,
                onChange: state => { this.states.set(id, state); this.options.onChange(state, id); },
                onMirrorFrame: frame => this.options.onMirrorFrame?.(frame, id), onMirrorError: m => this.options.onMirrorError?.(m) });
            this.controllers.set(id, c);
            c.setStationLocked(this.locked(id));
        }
        return c;
    }
    state(id: StationId): RuntimeConsoleState { return this.states.get(id) ?? this.controllers.get(id)?.state ?? INITIAL; }
    forEach(fn: (controller: RuntimeConsoleController, id: StationId) => void): void { this.controllers.forEach(fn); }
    pushLocks(): void { this.controllers.forEach((c, id) => c.setStationLocked(this.locked(id))); }

    binding(id: StationId, ctx: BindingContext | undefined): StationBinding | undefined {
        if (!ctx || !this.has(id)) return undefined;
        const local = runtimeStationId(id);
        return { stationId: ctx.personal ? presenceStation(ctx.personal, local) : local, projectUri: ctx.projectUri,
            name: `${ctx.roomName}${ctx.personal ? ` · ${ctx.personal.name}` : ''}${id === 'terminal' ? '' : ` · ${this.name(id)}`}` };
    }
    /** True when this browser opened that station's workspace before (so a reconnect is allowed). */
    hasSavedBinding(binding: StationBinding | undefined): boolean {
        if (!binding) return false;
        try { return !!this.options.storage?.getItem(bindingKey(binding)); } catch { return false; }
    }
    /** Refresh / project switch / presence change: reconnect saved stations, release the rest. Never starts anything. */
    reconnectSaved(ctx: BindingContext | undefined): void {
        for (const id of this.ids()) {
            const binding = this.binding(id, ctx);
            if (binding && this.hasSavedBinding(binding)) void this.controller(id)?.reconnect(binding);
            else if (binding) { const c = this.peek(id); if (c) void c.reconnect(binding); }
            else this.peek(id)?.release();
        }
    }
    /** Station whose runtime binding id is `stationId` (agent task panel "continue at desk"). */
    stationForRuntimeId(stationId: string, ctx: BindingContext | undefined): StationId | undefined {
        return this.ids().find(id => this.binding(id, ctx)?.stationId === stationId);
    }

    /** Station shown by a mirror / monitor-wall entity, if linked. */
    linkOf(entityId: string): StationId | undefined { return linkedEntities(this.world).find(l => l.entity.id === entityId)?.station; }
    /** Frames for every linked mirror / monitor wall, keyed by entity id. */
    linkedFrames<F>(frames: Readonly<Record<string, F>>): Record<string, F> {
        const out: Record<string, F> = {};
        for (const { entity, station } of linkedEntities(this.world)) if (frames[station]) out[entity.id] = frames[station];
        return out;
    }

    /**
     * t4:polish — the user explicitly opened this desk for the first time (clicked its monitor, or picked it in the
     * desk switcher). Only an armed desk may be offered its setup; adding a desk to the world never arms one.
     */
    armSetup(id: StationId): void { if (this.has(id)) this.armed.add(id); }
    /** t4:polish — forget pending first-open arms (failed open, project or presence change), so only a fresh explicit open can offer setup. */
    disarmSetup(id?: StationId): void { if (id === undefined) this.armed.clear(); else this.armed.delete(id); }
    isSetupArmed(id: StationId): boolean { return this.armed.has(id); }
    /**
     * Offer the station's StationConfig tabs once per (station, workspace) when the user's first open of a desk
     * goes live. Offering = the controller's pending confirmation; nothing starts until the user confirms.
     */
    maybeOfferSetup(id: StationId, state: RuntimeConsoleState, projectUri: string | undefined): boolean {
        const info = this.info(id), c = this.peek(id), ws: SessionWorkspace | undefined = state.workspace;
        if (!this.armed.has(id)) return false; // t4:polish: never on a world change or a poll of a desk in use
        if (!info || !c || !projectUri || state.phase !== 'live' || !ws || state.pending || state.acting) return false;
        this.armed.delete(id); // one decision per explicit open
        if (!this.stored) return false; // classic room: no StationConfig to offer, and the open does not carry over to a later world
        const key = `omo.station-setup.v1:${JSON.stringify(projectUri)}#${id}`;
        const mark = `${id}:${ws.id}`;
        if (this.offered.has(mark)) return false;
        this.offered.add(mark);
        try { if (this.options.storage?.getItem(key) === ws.id) return false; } catch { /* offer at most once per session then */ }
        const fresh = ws.tabs.length <= 1 && ws.tabs.every(t => t.kind === 'shell');
        if (!fresh) return false;
        const recipe = setupRecipe(info, state.profile, ws.tabs);
        if (!recipe) return false;
        try { this.options.storage?.setItem(key, ws.id); } catch { /* optional */ }
        c.requestRecipeApply(recipe, { setup: true });
        return true;
    }
    /** Setup recipe for the recipe panel (never auto-applied). */
    setupRecipeFor(id: StationId): StationRecipe | undefined {
        const info = this.info(id); if (!info) return undefined;
        return setupRecipe(info, this.state(id).profile, this.state(id).workspace?.tabs ?? []);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.controllers.forEach(c => c.dispose());
        this.controllers.clear(); this.states.clear();
    }
}

const INITIAL: RuntimeConsoleState = RuntimeConsoleController.initial();
export const isStationId = (value: unknown): value is StationId => typeof value === 'string' && WORLD_ID_RE.test(value);
