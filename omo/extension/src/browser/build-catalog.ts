/**
 * Build catalog (w2 build lane): what the build palette can place, how big each thing is on the
 * floor, how new ids are made, and how wall items snap to the room shell. Pure data + maths.
 */
import type { WorldSpec, WorldEntity, DecorKind, Transform, StationKind } from '../common/world-model';
import { WORLD_ID_RE, SHELL_MAX, ROOM_MIN, defaultStation, stations } from '../common/world-model';

export type PaletteId =
    | 'agent-desk' | 'shell-desk' | 'monitor-wall' | 'web-wall' | 'mirror' | 'review-screen'
    | 'room' // w3:build
    | `decor-${DecorKind}`;

export interface PaletteItem {
    id: PaletteId;
    group: 'Spaces' | 'Stations' | 'Screens' | 'Decor'; // w3:build: + Spaces (rooms)
    title: string;
    hint: string;
    /** Glyph name in build-icons.tsx. */
    glyph: string;
    /** Snaps to the nearest room wall when placed near it. */
    wallMounted: boolean;
}

export const DECOR_KINDS: DecorKind[] = ['plant', 'lamp', 'crystal', 'sofa', 'bookshelf', 'whiteboard', 'rug', 'window'];

export const PALETTE: PaletteItem[] = [
    { id: 'room', group: 'Spaces', title: 'Room', hint: 'Drag a floor plan', glyph: 'room', wallMounted: false }, // w3:build
    { id: 'agent-desk', group: 'Stations', title: 'Agent desk', hint: 'Hermes + shell tabs', glyph: 'desk-agent', wallMounted: false },
    { id: 'shell-desk', group: 'Stations', title: 'Shell desk', hint: 'One plain shell', glyph: 'desk-shell', wallMounted: false },
    { id: 'monitor-wall', group: 'Screens', title: 'Monitor wall', hint: 'Mirror a desk, big', glyph: 'monitor-wall', wallMounted: true },
    { id: 'web-wall', group: 'Screens', title: 'Web wall', hint: 'A real browser page', glyph: 'web-wall', wallMounted: true },
    { id: 'mirror', group: 'Screens', title: 'Mirror', hint: 'Follows one desk', glyph: 'mirror', wallMounted: true },
    { id: 'review-screen', group: 'Screens', title: 'Review screen', hint: 'Git changes, read-only', glyph: 'review', wallMounted: true },
    { id: 'decor-plant', group: 'Decor', title: 'Plant', hint: 'Green, quiet', glyph: 'plant', wallMounted: false },
    { id: 'decor-lamp', group: 'Decor', title: 'Lamp', hint: 'Warm light', glyph: 'lamp', wallMounted: false },
    { id: 'decor-crystal', group: 'Decor', title: 'Crystal', hint: 'Soft glow', glyph: 'crystal', wallMounted: false },
    { id: 'decor-sofa', group: 'Decor', title: 'Sofa', hint: 'Think here', glyph: 'sofa', wallMounted: false },
    { id: 'decor-bookshelf', group: 'Decor', title: 'Bookshelf', hint: 'Against a wall', glyph: 'bookshelf', wallMounted: true },
    { id: 'decor-whiteboard', group: 'Decor', title: 'Whiteboard', hint: 'Plan it out', glyph: 'whiteboard', wallMounted: false },
    { id: 'decor-rug', group: 'Decor', title: 'Rug', hint: 'Define a zone', glyph: 'rug', wallMounted: false },
    { id: 'decor-window', group: 'Decor', title: 'Window', hint: 'A view out', glyph: 'window', wallMounted: true }
];
export const paletteItem = (id: PaletteId): PaletteItem => PALETTE.find(item => item.id === id) ?? PALETTE[0];

/** Floor footprint in the entity's local frame (x right, z towards its front). */
export interface Footprint { width: number; depth: number; /** local z offset of the rectangle centre */ offsetZ: number; height: number; elevation: number }

const DECOR_SIZE: Record<DecorKind, [number, number, number]> = {
    plant: [0.8, 0.8, 1.3], lamp: [0.5, 0.5, 1.8], crystal: [0.7, 0.7, 1.4], sofa: [2.2, 0.95, 0.9],
    bookshelf: [1.6, 0.45, 2.1], whiteboard: [2.0, 0.5, 2.0], rug: [2.6, 1.8, 0.04], window: [2.2, 0.15, 1.5]
};

export function footprint(entity: WorldEntity): Footprint {
    switch (entity.kind) {
        case 'station': return { width: 3.3, depth: 2.7, offsetZ: 0.45, height: 2.6, elevation: 0 };
        case 'monitor-wall': case 'web-wall': return { width: entity.width + 0.2, depth: 0.3, offsetZ: 0, height: entity.height + 0.2, elevation: Math.max(0, entity.elevation - 0.1) };
        case 'mirror': return { width: 2.55, depth: 0.3, offsetZ: 0, height: 2.0, elevation: 0.75 };
        case 'review-screen': return { width: 2.3, depth: 0.3, offsetZ: 0, height: 1.6, elevation: 1.0 };
        case 'decor': {
            const [w, d, h] = DECOR_SIZE[entity.decor], s = entity.scale ?? 1;
            return { width: w * s, depth: d * s, offsetZ: 0, height: h * s, elevation: entity.decor === 'window' ? 1.0 : 0 };
        }
        // w3:build — a room is a floor: a thin slab (its walls are drawn and checked separately, see build-room.ts roomWalls).
        case 'room': return { width: entity.width, depth: entity.depth, offsetZ: 0, height: 0.06, elevation: 0 };
    }
}

/** A new id like `desk-3` that is free in the world and matches WORLD_ID_RE. */
export function nextId(world: WorldSpec, prefix: string, taken: Iterable<string> = []): string {
    const used = new Set([...world.entities.map(e => e.id), ...taken]);
    for (let n = 1; n < 1000; n++) {
        const id = `${prefix}-${n}`;
        if (!used.has(id) && WORLD_ID_RE.test(id)) return id;
    }
    return `${prefix}-${Date.now().toString(36)}`;
}

/** The next free desk name: Desk three, Desk four … (then Desk 13). */
export function nextDeskName(world: WorldSpec): string {
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
    const names = new Set(stations(world).map(s => s.station.name.toLowerCase()));
    for (let i = 0; i < 40; i++) { const name = `Desk ${words[i] ?? String(i + 1)}`; if (!names.has(name.toLowerCase())) return name; }
    return 'New desk';
}

/** w3:build — the next free room name: Room 1, Room 2 … */
export function nextRoomName(world: WorldSpec): string {
    const names = new Set(world.entities.map(e => (e.label ?? '').toLowerCase()));
    for (let n = 1; n < 1000; n++) if (!names.has(`room ${n}`)) return `Room ${n}`;
    return 'Room';
}

/** Build the entity a palette item places. `link` is the station a mirror follows. */
export function makeEntity(item: PaletteId, world: WorldSpec, transform: Transform, link?: string): WorldEntity | undefined {
    const t = { ...transform };
    if (item === 'agent-desk' || item === 'shell-desk') {
        const kind: StationKind = item === 'agent-desk' ? 'hermes' : 'shell';
        const name = nextDeskName(world);
        return { id: nextId(world, 'desk'), kind: 'station', label: name, transform: t, station: defaultStation(name, kind) };
    }
    if (item === 'monitor-wall') return { id: nextId(world, 'monitors'), kind: 'monitor-wall', label: 'Monitor wall', transform: t, width: 3, height: 1.7, elevation: 0.9 };
    if (item === 'web-wall') return { id: nextId(world, 'web-wall'), kind: 'web-wall', label: 'Web wall', transform: t, width: 3.9, height: 2.44, elevation: 0.68 };
    if (item === 'mirror') {
        if (!link) return undefined;
        const target = world.entities.find(e => e.id === link);
        return { id: nextId(world, 'mirror'), kind: 'mirror', label: `Mirror · ${target?.label ?? 'desk'}`.slice(0, 60), link, transform: t };
    }
    if (item === 'room') return { id: nextId(world, 'room'), kind: 'room', label: nextRoomName(world), transform: t, width: ROOM_MIN, depth: ROOM_MIN, doors: ['front'] }; // w3:build
    if (item === 'review-screen') return { id: nextId(world, 'review'), kind: 'review-screen', label: 'Code review', transform: t };
    const decor = item.slice('decor-'.length) as DecorKind;
    return { id: nextId(world, decor), kind: 'decor', decor, transform: t };
}

const GRID = 0.25;
export const snapGrid = (n: number): number => Math.round(n / GRID) * GRID;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
export const normalizeRotation = (r: number): number => {
    const two = Math.PI * 2; let v = r % two; if (v > Math.PI) v -= two; if (v < -Math.PI) v += two;
    // t3:polish2 — snap near-quarter turns to the exact quarter so rounding never builds up (four turns = 0, not 0.001).
    const q = Math.round(v / (Math.PI / 2)); if (Math.abs(v - q * Math.PI / 2) < 0.01) v = q * Math.PI / 2;
    if (v > Math.PI - 1e-9) v -= two; // +π and -π are one direction: keep one value
    return round3(v) + 0; // + 0 turns -0 into 0
};

/** w3:build — how far past the current shell edge a point may go; the world grows to fit on Apply. */
export const GROW_REACH = 6;

/**
 * Where a palette item goes for a floor point: grid-snapped, kept within GROW_REACH metres of the shell
 * (w3:build: past the edge the world grows to fit, see growOpsFor) and never past SHELL_MAX, and (wall items)
 * snapped flat against the nearest wall, facing into the room, when within 1.6 m of it (walled worlds only).
 */
export function placement(world: WorldSpec, point: { x: number; z: number }, rotation: number, wallMounted: boolean, size: { width: number; depth: number }): { transform: Transform; snapped: 'wall' | 'grid' } {
    const hw = world.shell.width / 2, hd = world.shell.depth / 2;
    const inset = 0.45;
    if (wallMounted && !world.shell.open) { // w3:build: an open world has no outer walls
        const d = [
            { wall: 'back', dist: point.z + hd, rot: 0 },
            { wall: 'front', dist: hd - point.z, rot: Math.PI },
            { wall: 'left', dist: point.x + hw, rot: Math.PI / 2 },
            { wall: 'right', dist: hw - point.x, rot: -Math.PI / 2 }
        ].sort((a, b) => a.dist - b.dist)[0];
        if (d.dist < 1.6 && d.dist > -1) { // w3:build: aimed well past the wall = place it out there (the world grows)
            const along = d.wall === 'back' || d.wall === 'front';
            const half = size.width / 2 + 0.1;
            const x = along ? clamp(snapGrid(point.x), -hw + half, hw - half) : (d.wall === 'left' ? -hw + inset : hw - inset);
            const z = along ? (d.wall === 'back' ? -hd + inset : hd - inset) : clamp(snapGrid(point.z), -hd + half, hd - half);
            return { transform: { x: round3(x), z: round3(z), rotation: normalizeRotation(d.rot) }, snapped: 'wall' };
        }
    }
    const margin = 0.3;
    const rx = Math.min(hw + GROW_REACH, SHELL_MAX / 2 - margin), rz = Math.min(hd + GROW_REACH, SHELL_MAX / 2 - margin); // w3:build
    return { transform: { x: round3(clamp(snapGrid(point.x), -rx, rx)), z: round3(clamp(snapGrid(point.z), -rz, rz)), rotation: normalizeRotation(rotation) }, snapped: 'grid' };
}
const clamp = (n: number, lo: number, hi: number): number => lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, n));

/** Station a new mirror should follow: the selected one, else the nearest, else the first. */
export function defaultLinkTarget(world: WorldSpec, near: { x: number; z: number }, selected?: string): string | undefined {
    const list = stations(world);
    if (selected && list.some(s => s.id === selected)) return selected;
    let best: string | undefined, bestD = Infinity;
    for (const s of list) { const d = Math.hypot(s.transform.x - near.x, s.transform.z - near.z); if (d < bestD) { bestD = d; best = s.id; } }
    return best;
}
