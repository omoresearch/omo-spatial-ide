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
export const WORLD_MAX_ENTITIES = 64;
export const WORLD_MAX_STATIONS = 16;
export const WORLD_MAX_BYTES = 64 * 1024;
export const WORLD_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type StationKind = 'hermes' | 'shell';
export type TabKind = 'shell' | 'hermes' | 'claude' | 'codex' | 'dsh'; // w2:agents
export type EntityKind = 'station' | 'monitor-wall' | 'web-wall' | 'mirror' | 'review-screen' | 'decor';
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
export type WorldEntity = StationEntity | MonitorWallEntity | WebWallEntity | MirrorEntity | ReviewScreenEntity | DecorEntity;

export interface WorldShell {
    theme: RoomTheme;
    /** Floor size in metres (centred on x=0; z from -depth/2 to +depth/2). */
    width: number;
    depth: number;
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
        default: return false;
    }
}
export function validateWorld(w: unknown): WorldResult {
    const v = w as WorldSpec;
    if (!v || v.version !== WORLD_VERSION || !text(v.name, 120) || !Number.isInteger(v.revision) || v.revision < 0) return { ok: false, error: 'Not a version 2 world.' };
    if (!v.shell || !['station', 'jungle'].includes(v.shell.theme) || !finite(v.shell.width, 8, 40) || !finite(v.shell.depth, 8, 40)) return { ok: false, error: 'The room shell is invalid.' };
    if (!Array.isArray(v.entities) || v.entities.length > WORLD_MAX_ENTITIES) return { ok: false, error: `A world holds at most ${WORLD_MAX_ENTITIES} things.` };
    const ids = new Set<string>();
    for (const e of v.entities) {
        if (!validEntity(e, v.shell)) return { ok: false, error: `Entity ${String((e as WorldEntity)?.id)} is invalid.` };
        if (ids.has(e.id)) return { ok: false, error: `Duplicate id ${e.id}.` };
        ids.add(e.id);
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
            case 'shell': next.shell = { ...next.shell, ...o.shell }; break;
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
