/**
 * World model v2 — the SHARED CONTRACT for the expandable world.
 *
 * A world is data: a room shell plus any number of entities (agent stations/desks, monitor walls,
 * web walls, mirrors, code-review screens, decor). Everything that builds the world (onboarding,
 * the in-world build mode, the Hermes admin, multiplayer sync) changes it ONLY through WorldOp
 * patches validated and applied by `applyWorldOps`. The renderer, runtime bindings and HUD only
 * READ a WorldSpec. Version 1 rooms (theme + layout + kit) migrate losslessly via `worldFromRoomV1`.
 *
 * Rules (all lanes): no secrets, tokens or host paths in a WorldSpec (it is shared and exported);
 * no op ever starts an agent; positions are metres in room space (x right, z towards the door, y up);
 * ids are stable, lowercase [a-z0-9-], unique per world.
 */
import type { RoomLayoutId, RoomKitId } from './player-state';
import { ROOM_LAYOUTS } from './player-state';
import type { RoomTheme } from './room-state';

export const WORLD_VERSION = 2 as const;
export const WORLD_MAX_ENTITIES = 256; // w3:expand (was 64)
export const WORLD_MAX_STATIONS = 48; // w3:expand (was 16)
export const WORLD_MAX_BYTES = 192 * 1024; // w3:expand (was 64 KiB)
/** w3:expand — shell (ground) size limits in metres. 12 x 10 is the classic room; w4:big — 1000 x 1000 (1 km) is the open-world maximum. */
export const SHELL_MIN = 8;
export const SHELL_MAX = 1000;
/** w3:expand — a room placed inside the world (its own floor, walls and doorways). */
export const ROOM_MIN = 3;
export const ROOM_MAX = 60;
export type WallSide = 'back' | 'front' | 'left' | 'right';
export const WALL_SIDES: readonly WallSide[] = ['back', 'front', 'left', 'right'];
export const WORLD_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type StationKind = 'hermes' | 'shell';
export type TabKind = 'shell' | 'hermes' | 'claude' | 'codex' | 'dsh'; // w2:agents
export type EntityKind = 'station' | 'monitor-wall' | 'web-wall' | 'mirror' | 'review-screen' | 'decor' | 'room'; // w3:expand: + room
export type DecorKind = 'plant' | 'lamp' | 'crystal' | 'sofa' | 'bookshelf' | 'whiteboard' | 'rug' | 'window';

export interface Transform { x: number; z: number; /** radians, 0 = facing -z (towards the back wall) */ rotation: number; }

/** Mirrors Harry's Minecraft "Station Setup": name, kind, profile, starting tabs, lock. */
export interface StationConfig {
    name: string;
    kind: StationKind;
    /** Hermes profile name; omitted = workspace default. Never a path. */
    profile?: string;
    tabs: Array<{ name: string; kind: TabKind }>;
    locked: boolean;
}

interface EntityBase { id: string; kind: EntityKind; transform: Transform; label?: string }
export interface StationEntity extends EntityBase { kind: 'station'; station: StationConfig }
/** A wall of monitors. `link` = station id it mirrors (Minecraft Linker); none = its own shell view. */
export interface MonitorWallEntity extends EntityBase { kind: 'monitor-wall'; width: number; height: number; elevation: number; link?: string }
export interface WebWallEntity extends EntityBase { kind: 'web-wall'; width: number; height: number; elevation: number; home?: string }
export interface MirrorEntity extends EntityBase { kind: 'mirror'; link: string }
export interface ReviewScreenEntity extends EntityBase { kind: 'review-screen' }
export interface DecorEntity extends EntityBase { kind: 'decor'; decor: DecorKind; scale?: number }
/**
 * w3:expand — a room inside the world: its own floor, walls on all four sides and a doorway (a 1.6 m gap,
 * centred) in every side listed in `doors` (default ['front']). The transform is the room centre; rotation
 * is 0 or ±PI/2 (90° steps only). `theme` defaults to the world shell's theme. Stations and other
 * entities are NOT children of a room: they are placed in world coordinates like everything else.
 */
export interface RoomEntity extends EntityBase { kind: 'room'; width: number; depth: number; theme?: RoomTheme; doors?: WallSide[] }
export type WorldEntity = StationEntity | MonitorWallEntity | WebWallEntity | MirrorEntity | ReviewScreenEntity | DecorEntity | RoomEntity;

export interface WorldShell {
    theme: RoomTheme;
    /** Floor size in metres (centred on x=0; z from -depth/2 to +depth/2). SHELL_MIN..SHELL_MAX. */
    width: number;
    depth: number;
    /**
     * w3:expand — open world: no outer walls; the shell is open ground of width x depth (up to 200 x 200 m)
     * with rooms (RoomEntity) placed on it. Absent/false = the classic walled room.
     */
    open?: boolean;
}

export interface WorldSpec {
    version: typeof WORLD_VERSION;
    name: string;
    shell: WorldShell;
    entities: WorldEntity[];
    /** Free text the world was built from (onboarding prompt). Informational only. */
    plan?: string;
    revision: number;
}

/** Patch operations. The ONLY way any lane changes a world. */
export type WorldOp =
    | { op: 'add'; entity: WorldEntity }
    | { op: 'remove'; id: string }
    | { op: 'move'; id: string; transform: Transform }
    | { op: 'update-station'; id: string; station: Partial<StationConfig> }
    | { op: 'resize'; id: string; width: number; height: number; elevation?: number }
    | { op: 'link'; id: string; to?: string }
    | { op: 'rename'; id: string; label: string }
    | { op: 'shell'; shell: Partial<WorldShell> }
    /** w3:expand — resize a room entity (width x depth, metres) and optionally set its doorways / theme. */
    | { op: 'reshape'; id: string; width: number; depth: number; doors?: WallSide[]; theme?: RoomTheme }
    | { op: 'name'; name: string };

/** A proposed change (from the build mode, onboarding or the Hermes admin) awaiting explicit Apply. */
export interface WorldProposal {
    id: string;
    source: 'onboarding' | 'build-mode' | 'admin' | 'template';
    summary: string;
    ops: WorldOp[];
    baseRevision: number;
}

export type WorldResult = { ok: true; world: WorldSpec } | { ok: false; error: string };

const finite = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\u0000-\u001f]/.test(s);
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validTransform(t: unknown, shell: WorldShell): t is Transform {
    const v = t as Transform;
    return !!v && finite(v.x, -shell.width / 2, shell.width / 2) && finite(v.z, -shell.depth / 2, shell.depth / 2) && finite(v.rotation, -Math.PI * 4, Math.PI * 4);
}
export function validStation(s: unknown): s is StationConfig {
    const v = s as StationConfig;
    return !!v && text(v.name, 60) && (v.kind === 'hermes' || v.kind === 'shell') && typeof v.locked === 'boolean'
        && (v.profile === undefined || PROFILE_RE.test(v.profile))
        && Array.isArray(v.tabs) && v.tabs.length >= 1 && v.tabs.length <= 8
        && v.tabs.every(t => !!t && text(t.name, 40) && ['shell', 'hermes', 'claude', 'codex', 'dsh'].includes(t.kind)); // w2:agents
}
export function validEntity(e: unknown, shell: WorldShell): e is WorldEntity {
    const v = e as WorldEntity;
    if (!v || typeof v.id !== 'string' || !WORLD_ID_RE.test(v.id) || !validTransform(v.transform, shell)) return false;
    if (v.label !== undefined && !text(v.label, 60)) return false;
    switch (v.kind) {
        case 'station': return validStation(v.station);
        case 'monitor-wall': return finite(v.width, 0.6, 8) && finite(v.height, 0.4, 4) && finite(v.elevation, 0, 3) && (v.link === undefined || WORLD_ID_RE.test(v.link));
        case 'web-wall': return finite(v.width, 0.8, 8) && finite(v.height, 0.6, 4) && finite(v.elevation, 0, 3) && (v.home === undefined || (typeof v.home === 'string' && /^https?:\/\//.test(v.home) && v.home.length <= 2048));
        case 'mirror': return WORLD_ID_RE.test(v.link);
        case 'review-screen': return true;
        case 'decor': return ['plant', 'lamp', 'crystal', 'sofa', 'bookshelf', 'whiteboard', 'rug', 'window'].includes(v.decor) && (v.scale === undefined || finite(v.scale, 0.25, 4));
        case 'room': return validRoom(v);
        default: return false;
    }
}
/** w3:expand — a room entity: size within ROOM_MIN..ROOM_MAX, rotation in 90° steps, known doorway sides (no repeats). */
export function validRoom(v: RoomEntity): boolean {
    const quarter = Math.abs(Math.round(v.transform.rotation / (Math.PI / 2)) * (Math.PI / 2) - v.transform.rotation) < 1e-6;
    const doors = v.doors === undefined || (Array.isArray(v.doors) && v.doors.length <= 4 && new Set(v.doors).size === v.doors.length && v.doors.every(d => WALL_SIDES.includes(d)));
    return finite(v.width, ROOM_MIN, ROOM_MAX) && finite(v.depth, ROOM_MIN, ROOM_MAX) && quarter && doors && (v.theme === undefined || v.theme === 'station' || v.theme === 'jungle');
}

export function validateWorld(w: unknown): WorldResult {
    const v = w as WorldSpec;
    if (!v || v.version !== WORLD_VERSION || !text(v.name, 120) || !Number.isInteger(v.revision) || v.revision < 0) return { ok: false, error: 'Not a version 2 world.' };
    if (!v.shell || !['station', 'jungle'].includes(v.shell.theme) || !finite(v.shell.width, SHELL_MIN, SHELL_MAX) || !finite(v.shell.depth, SHELL_MIN, SHELL_MAX)
        || (v.shell.open !== undefined && typeof v.shell.open !== 'boolean')) return { ok: false, error: 'The room shell is invalid.' };
    if (!Array.isArray(v.entities) || v.entities.length > WORLD_MAX_ENTITIES) return { ok: false, error: `A world holds at most ${WORLD_MAX_ENTITIES} things.` };
    const ids = new Set<string>();
    for (const e of v.entities) {
        if (!validEntity(e, v.shell)) return { ok: false, error: `Entity ${String((e as WorldEntity)?.id)} is invalid.` };
        if (ids.has(e.id)) return { ok: false, error: `Duplicate id ${e.id}.` };
        ids.add(e.id);
    }
    for (const e of v.entities) if (e.kind === 'room') {
        const r = roomRect(e);
        if (r.minX < -v.shell.width / 2 - 1e-6 || r.maxX > v.shell.width / 2 + 1e-6 || r.minZ < -v.shell.depth / 2 - 1e-6 || r.maxZ > v.shell.depth / 2 + 1e-6) return { ok: false, error: `Room ${e.id} does not fit inside the world.` };
    }
    if (v.entities.filter(e => e.kind === 'station').length > WORLD_MAX_STATIONS) return { ok: false, error: `A world holds at most ${WORLD_MAX_STATIONS} stations.` };
    for (const e of v.entities) {
        const link = e.kind === 'mirror' || e.kind === 'monitor-wall' ? e.link : undefined;
        if (link !== undefined && v.entities.find(x => x.id === link)?.kind !== 'station') return { ok: false, error: `${e.id} links to ${link}, which is not a station.` };
    }
    if (v.plan !== undefined && (typeof v.plan !== 'string' || v.plan.length > 4000)) return { ok: false, error: 'The plan text is too long.' };
    if (JSON.stringify(v).length > WORLD_MAX_BYTES) return { ok: false, error: 'The world is too large.' };
    return { ok: true, world: v };
}

/** Apply ops atomically: all succeed or the world is unchanged. Locked stations refuse edits except unlock. */
export function applyWorldOps(world: WorldSpec, ops: readonly WorldOp[]): WorldResult {
    const next: WorldSpec = JSON.parse(JSON.stringify(world));
    const find = (id: string): WorldEntity | undefined => next.entities.find(e => e.id === id);
    const locked = (e: WorldEntity | undefined): boolean => e?.kind === 'station' && e.station.locked;
    for (const o of ops) {
        switch (o.op) {
            case 'add': if (find(o.entity.id)) return { ok: false, error: `${o.entity.id} already exists.` }; next.entities.push(JSON.parse(JSON.stringify(o.entity))); break;
            case 'remove': {
                const e = find(o.id); if (!e) return { ok: false, error: `${o.id} does not exist.` };
                if (locked(e)) return { ok: false, error: `${o.id} is locked.` };
                next.entities = next.entities.filter(x => x.id !== o.id);
                for (const x of next.entities) if ((x.kind === 'monitor-wall') && x.link === o.id) delete x.link;
                next.entities = next.entities.filter(x => !(x.kind === 'mirror' && x.link === o.id));
                break;
            }
            case 'move': { const e = find(o.id); if (!e) return { ok: false, error: `${o.id} does not exist.` }; if (locked(e)) return { ok: false, error: `${o.id} is locked.` }; e.transform = { ...o.transform }; break; }
            case 'update-station': {
                const e = find(o.id); if (e?.kind !== 'station') return { ok: false, error: `${o.id} is not a station.` };
                const onlyUnlock = Object.keys(o.station).length === 1 && o.station.locked === false;
                if (e.station.locked && !onlyUnlock) return { ok: false, error: `${o.id} is locked.` };
                e.station = { ...e.station, ...o.station, tabs: o.station.tabs ? o.station.tabs.map(t => ({ ...t })) : e.station.tabs };
                break;
            }
            case 'resize': { const e = find(o.id); if (e?.kind !== 'monitor-wall' && e?.kind !== 'web-wall') return { ok: false, error: `${o.id} cannot be resized.` }; e.width = o.width; e.height = o.height; if (o.elevation !== undefined) e.elevation = o.elevation; break; }
            case 'link': { const e = find(o.id); if (e?.kind !== 'monitor-wall' && e?.kind !== 'mirror') return { ok: false, error: `${o.id} cannot be linked.` }; if (e.kind === 'mirror' && !o.to) return { ok: false, error: 'A mirror must link to a station.' }; if (o.to) e.link = o.to; else if (e.kind === 'monitor-wall') delete e.link; break; }
            case 'rename': { const e = find(o.id); if (!e) return { ok: false, error: `${o.id} does not exist.` }; if (locked(e)) return { ok: false, error: `${o.id} is locked.` }; e.label = o.label; break; }
            case 'shell': next.shell = { ...next.shell, ...o.shell }; if (next.shell.open === false) delete next.shell.open; break;
            case 'reshape': {
                const e = find(o.id); if (e?.kind !== 'room') return { ok: false, error: `${o.id} is not a room.` };
                e.width = o.width; e.depth = o.depth;
                if (o.doors !== undefined) e.doors = [...o.doors];
                if (o.theme !== undefined) e.theme = o.theme;
                break;
            }
            case 'name': next.name = o.name; break;
            default: return { ok: false, error: 'Unknown operation.' };
        }
    }
    next.revision = world.revision + 1;
    return validateWorld(next);
}

export function stations(world: WorldSpec): StationEntity[] { return world.entities.filter((e): e is StationEntity => e.kind === 'station'); }

/** Default station config for a new desk. Starting an agent tab still asks the user first. */
export function defaultStation(name: string, kind: StationKind = 'hermes'): StationConfig {
    return { name, kind, tabs: kind === 'hermes' ? [{ name: 'Hermes', kind: 'hermes' }, { name: 'Shell', kind: 'shell' }] : [{ name: 'Shell', kind: 'shell' }], locked: false };
}

/**
 * Lossless migration of a v1 room. Station ids 'terminal' and 'terminal-2' are KEPT so existing
 * runtime bindings, workspaces and saved state keep working; the web wall keeps id 'web', the mirror
 * 'mirror', the code review screen 'code'.
 */
export function worldFromRoomV1(room: { theme: RoomTheme; projectName: string; layout?: RoomLayoutId; kit?: RoomKitId }): WorldSpec {
    const layout = ROOM_LAYOUTS[room.layout ?? 'classic'];
    const kit = room.kit ?? 'hermes-desk';
    const d1 = layout.desks.terminal, d2 = layout.desks['terminal-2'];
    const entities: WorldEntity[] = [
        { id: 'terminal', kind: 'station', label: 'Desk one', transform: { x: d1.x, z: d1.z, rotation: 0 }, station: defaultStation('Desk one') },
        { id: 'terminal-2', kind: 'station', label: 'Desk two', transform: { x: d2.x, z: d2.z, rotation: 0 }, station: defaultStation('Desk two', 'shell') },
        { id: 'code', kind: 'review-screen', label: 'Code review', transform: { x: -4.8, z: -3.9, rotation: 0 } } // t2:regress: exact v1 back-left spot (CHANGE-REVIEW.md)
    ];
    if (kit !== 'terminal-nook') entities.push({ id: 'web', kind: 'web-wall', label: 'Web wall', transform: { x: 0, z: -4.12, rotation: 0 }, width: 3.9, height: 2.44, elevation: 0.68 });
    entities.push({ id: 'mirror', kind: 'mirror', label: 'Mirror · Desk one', link: 'terminal', transform: { x: 4.7, z: -3.98, rotation: 0 } }); // t2:regress: exact v1 back-right spot
    return { version: WORLD_VERSION, name: room.projectName, shell: { theme: room.theme, width: 12, depth: 10 }, entities, revision: 0 };
}

/** Storage key per project, next to the v1 room key. */
export const worldStorageKey = (projectUri: string): string => `omo.world.v2:${projectUri}`;


// ----------------------------------------------------------------------------------------------- w3:expand
/** Axis-aligned rectangle (world metres). */
export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

/** The floor rectangle a room covers (a 90° or 270° rotation swaps width and depth). */
export function roomRect(e: Pick<RoomEntity, 'transform' | 'width' | 'depth'>): Rect {
    const sideways = Math.abs(Math.round(e.transform.rotation / (Math.PI / 2))) % 2 === 1;
    const hw = (sideways ? e.depth : e.width) / 2, hd = (sideways ? e.width : e.depth) / 2;
    return { minX: e.transform.x - hw, maxX: e.transform.x + hw, minZ: e.transform.z - hd, maxZ: e.transform.z + hd };
}

/** Rough half-size of an entity's footprint, for "does the world need to grow" checks (not collision). */
export function entityRadius(e: WorldEntity): number {
    switch (e.kind) {
        case 'room': return Math.hypot(e.width, e.depth) / 2;
        case 'monitor-wall': case 'web-wall': return e.width / 2 + 0.3;
        case 'station': return 1.3;
        case 'decor': return 0.8 * (e.scale ?? 1);
        default: return 0.9;
    }
}

/**
 * The shell size needed so a point (plus `margin` metres of floor around it) lies inside the world.
 * The shell is centred on the origin, so it grows symmetrically. Returns undefined when it already fits.
 * Sizes are rounded up to whole metres and capped at SHELL_MAX; `capped` says the point still does not fit.
 */
export function shellToFit(shell: WorldShell, point: { x: number; z: number }, margin = 2): { width: number; depth: number; capped: boolean } | undefined {
    const needW = Math.ceil(2 * (Math.abs(point.x) + margin)), needD = Math.ceil(2 * (Math.abs(point.z) + margin));
    if (needW <= shell.width && needD <= shell.depth) return undefined;
    const width = Math.min(SHELL_MAX, Math.max(shell.width, needW)), depth = Math.min(SHELL_MAX, Math.max(shell.depth, needD));
    return { width, depth, capped: width < needW || depth < needD };
}

/**
 * The ONE shared "make room for this" rule (build mode, Hermes admin, onboarding, templates): ops that grow
 * the shell so `entity` at `transform` fits with `margin` metres to spare. Empty when nothing needs to change;
 * undefined when the world cannot grow enough (SHELL_MAX). Prepend the result to the add/move op.
 */
export function growOpsFor(world: WorldSpec, entity: WorldEntity, transform: Transform = entity.transform, margin = 2): WorldOp[] | undefined {
    const r = entity.kind === 'room' ? roomRect({ ...entity, transform }) : undefined;
    const reach = entity.kind === 'room' ? 0 : entityRadius(entity);
    const corners = r ? [{ x: r.minX, z: r.minZ }, { x: r.maxX, z: r.maxZ }, { x: r.minX, z: r.maxZ }, { x: r.maxX, z: r.minZ }]
        : [{ x: transform.x + Math.sign(transform.x || 1) * reach, z: transform.z + Math.sign(transform.z || 1) * reach }];
    let shell = { ...world.shell }, changed = false;
    for (const c of corners) {
        const fit = shellToFit(shell, c, r ? 1 : margin);
        if (!fit) continue;
        if (fit.capped) return undefined;
        shell = { ...shell, width: fit.width, depth: fit.depth }; changed = true;
    }
    return changed ? [{ op: 'shell', shell: { width: shell.width, depth: shell.depth } }] : [];
}

/** Rooms in a world. */
export function rooms(world: WorldSpec): RoomEntity[] { return world.entities.filter((e): e is RoomEntity => e.kind === 'room'); }
