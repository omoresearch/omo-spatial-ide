/**
 * World v2 room kits (lane: templates). Insertable groups of entities, like Minecraft room kits.
 *
 * A kit is a small, kit-local layout (positions relative to an anchor, ids local to the kit). To insert
 * it, `kitOps` turns it into a batch of `add` WorldOps for a given world and anchor: ids get a unique
 * prefix, links are remapped to the new ids, positions are rotated around the anchor and kept inside
 * the room. The batch goes through `applyWorldOps`, so it is atomic and validated like any other edit.
 * Kits never start an agent: a station only lists the tabs it WOULD open.
 */
import type { StationConfig, TabKind, Transform, WorldEntity, WorldOp, WorldResult, WorldSpec } from './world-model';
import { applyWorldOps, WORLD_ID_RE, WORLD_MAX_ENTITIES, WORLD_MAX_STATIONS } from './world-model';
import { isDevBuild } from './world-templates';

export type WorldKitId = 'hermes-desk-kit' | 'pair-programming-kit' | 'review-corner' | 'research-nook' | 'lounge-corner';

/** Kit-local entity: same shape as a WorldEntity, with a kit-local id and kit-local transform. */
export type KitPiece = WorldEntity;

export interface WorldKit {
    id: WorldKitId;
    label: string;
    description: string;
    /** Footprint in metres (width along x, depth along z) around the anchor, for placement hints. */
    footprint: { width: number; depth: number };
    pieces: readonly KitPiece[];
}

const HALF_PI = Math.PI / 2;
const TAB_LABEL: Record<TabKind, string> = { hermes: 'Hermes', claude: 'Claude', codex: 'Codex', shell: 'Shell' };
function setup(name: string, main: TabKind): StationConfig {
    const kinds: TabKind[] = main === 'shell' ? ['shell'] : [main, 'shell'];
    return { name, kind: main === 'hermes' ? 'hermes' : 'shell', tabs: kinds.map(kind => ({ name: TAB_LABEL[kind], kind })), locked: false };
}
const at = (x: number, z: number, rotation = 0): Transform => ({ x, z, rotation });

/**
 * Kit layout convention: the anchor is where the main desk stands; -z is "in front" (the wall the desk
 * faces). A 3x2 monitor wall is 3 screens wide and 2 high: about 3.6 m by 1.8 m.
 */
export const WORLD_KITS: readonly WorldKit[] = [
    {
        id: 'hermes-desk-kit',
        label: 'Hermes desk kit',
        description: 'A Hermes desk, a 3×2 monitor wall linked to it, and a lamp.',
        footprint: { width: 4, depth: 3 },
        pieces: [
            { id: 'desk', kind: 'station', label: 'Hermes desk', transform: at(0, 0), station: setup('Hermes desk', 'hermes') },
            { id: 'wall', kind: 'monitor-wall', label: 'Monitor wall · Hermes desk', transform: at(0, -1.6), width: 3.6, height: 1.8, elevation: 0.7, link: 'desk' },
            { id: 'lamp', kind: 'decor', decor: 'lamp', transform: at(1.3, 0.1) }
        ]
    },
    {
        id: 'pair-programming-kit',
        label: 'Pair programming kit',
        description: 'Hermes and Claude desks side by side, sharing one wall linked to the Hermes desk.',
        footprint: { width: 5, depth: 3 },
        pieces: [
            { id: 'driver', kind: 'station', label: 'Driver · Hermes', transform: at(-1.2, 0), station: setup('Driver · Hermes', 'hermes') },
            { id: 'navigator', kind: 'station', label: 'Navigator · Claude', transform: at(1.2, 0), station: setup('Navigator · Claude', 'claude') },
            { id: 'wall', kind: 'monitor-wall', label: 'Shared wall · Driver', transform: at(0, -1.6), width: 4.4, height: 2, elevation: 0.6, link: 'driver' },
            { id: 'rug', kind: 'decor', decor: 'rug', transform: at(0, 0.6), scale: 1.2 }
        ]
    },
    {
        id: 'review-corner',
        label: 'Review corner',
        description: 'A code review screen, a reviewer desk, and a mirror of that desk.',
        footprint: { width: 4, depth: 3 },
        pieces: [
            { id: 'screen', kind: 'review-screen', label: 'Code review', transform: at(0, -1.4) },
            { id: 'reviewer', kind: 'station', label: 'Reviewer', transform: at(0, 0), station: setup('Reviewer', 'claude') },
            { id: 'mirror', kind: 'mirror', label: 'Mirror · Reviewer', link: 'reviewer', transform: at(-1.8, -0.4, HALF_PI) },
            { id: 'plant', kind: 'decor', decor: 'plant', transform: at(1.7, -1.2) }
        ]
    },
    {
        id: 'research-nook',
        label: 'Research nook',
        description: 'A Hermes desk with a web wall for sources and a bookshelf.',
        footprint: { width: 4, depth: 3 },
        pieces: [
            { id: 'desk', kind: 'station', label: 'Researcher', transform: at(0, 0), station: setup('Researcher', 'hermes') },
            { id: 'web', kind: 'web-wall', label: 'Sources', transform: at(0, -1.6), width: 3.2, height: 1.9, elevation: 0.7 },
            { id: 'shelf', kind: 'decor', decor: 'bookshelf', transform: at(-1.8, -0.2, HALF_PI) }
        ]
    },
    {
        id: 'lounge-corner',
        label: 'Lounge corner',
        description: 'A sofa, rug, plant and lamp. No screens.',
        footprint: { width: 3, depth: 2.5 },
        pieces: [
            { id: 'sofa', kind: 'decor', decor: 'sofa', transform: at(0, 0) },
            { id: 'rug', kind: 'decor', decor: 'rug', transform: at(0, -0.9) },
            { id: 'plant', kind: 'decor', decor: 'plant', transform: at(-1.3, 0.2) },
            { id: 'lamp', kind: 'decor', decor: 'lamp', transform: at(1.3, 0.2) }
        ]
    }
];

export function worldKit(id: string): WorldKit | undefined { return WORLD_KITS.find(k => k.id === id); }

/** Dev assert at module load: every kit must insert cleanly into an empty room (dev: throw, prod: warn). */
function checkKits(): void {
    const strict = isDevBuild();
    const empty: WorldSpec = { version: 2, name: 'Kit check', shell: { theme: 'station', width: 12, depth: 10 }, entities: [], revision: 0 };
    for (const kit of WORLD_KITS) {
        const result = insertKit(empty, kit.id, { x: 0, z: 0, rotation: 0 });
        if (result.ok) continue;
        const message = `[omo world-kits] kit "${kit.id}" is invalid: ${result.error}`;
        if (strict) throw new Error(message);
        console.warn(message);
    }
}

const MARGIN = 0.3;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number): number => Math.round(v * 1000) / 1000;

/** Smallest `${kitId}-${n}` prefix whose generated ids are all free in `world`. */
function freePrefix(world: WorldSpec, kit: WorldKit): string {
    const taken = new Set(world.entities.map(e => e.id));
    for (let n = 1; n < 1000; n++) {
        const prefix = `${kit.id.replace(/-kit$/, '')}-${n}`;
        if (kit.pieces.every(p => !taken.has(`${prefix}-${p.id}`))) return prefix;
    }
    throw new Error('No free id for this kit.');
}

export type KitOpsResult = { ok: true; ops: WorldOp[]; ids: string[] } | { ok: false; error: string };

/**
 * Turn a kit into `add` ops for `world`, placed at `anchor` (rotation turns the whole kit).
 * Checks room capacity up front so the user gets a clear message; applyWorldOps re-validates.
 */
export function kitOps(world: WorldSpec, kitId: string, anchor: Transform): KitOpsResult {
    const kit = worldKit(kitId);
    if (!kit) return { ok: false, error: 'Unknown room kit.' };
    if (![anchor.x, anchor.z, anchor.rotation].every(Number.isFinite)) return { ok: false, error: 'The kit position is invalid.' };
    if (world.entities.length + kit.pieces.length > WORLD_MAX_ENTITIES) return { ok: false, error: `This room is full (at most ${WORLD_MAX_ENTITIES} things).` };
    const newStations = kit.pieces.filter(p => p.kind === 'station').length;
    if (world.entities.filter(e => e.kind === 'station').length + newStations > WORLD_MAX_STATIONS) return { ok: false, error: `This room already has the most desks it can hold (${WORLD_MAX_STATIONS}).` };
    let prefix: string;
    try { prefix = freePrefix(world, kit); } catch (error) { return { ok: false, error: (error as Error).message }; }
    const idOf = (local: string): string => `${prefix}-${local}`;
    const cos = Math.cos(anchor.rotation), sin = Math.sin(anchor.rotation);
    const hw = world.shell.width / 2 - MARGIN, hd = world.shell.depth / 2 - MARGIN;
    const ops: WorldOp[] = [];
    const ids: string[] = [];
    for (const piece of kit.pieces) {
        const entity: WorldEntity = JSON.parse(JSON.stringify(piece));
        entity.id = idOf(piece.id);
        if (!WORLD_ID_RE.test(entity.id)) return { ok: false, error: `Generated id ${entity.id} is invalid.` };
        const t = piece.transform;
        entity.transform = {
            x: round(clamp(anchor.x + t.x * cos + t.z * sin, -hw, hw)),
            z: round(clamp(anchor.z - t.x * sin + t.z * cos, -hd, hd)),
            rotation: round(t.rotation + anchor.rotation)
        };
        if ((entity.kind === 'monitor-wall' || entity.kind === 'mirror') && entity.link !== undefined) entity.link = idOf(entity.link);
        ops.push({ op: 'add', entity });
        ids.push(entity.id);
    }
    return { ok: true, ops, ids };
}

/** Insert a kit: kitOps + applyWorldOps (atomic). Use the result as a preview before saving. */
export function insertKit(world: WorldSpec, kitId: string, anchor: Transform): WorldResult & { ids?: string[] } {
    const batch = kitOps(world, kitId, anchor);
    if (!batch.ok) return batch;
    const result = applyWorldOps(world, batch.ops);
    return result.ok ? { ...result, ids: batch.ids } : result;
}

/** A sensible default anchor: the free spot nearest the room centre on a coarse grid, facing -z. */
export function suggestKitAnchor(world: WorldSpec, kitId: string): Transform {
    const kit = worldKit(kitId);
    const fw = kit?.footprint.width ?? 3, fd = kit?.footprint.depth ?? 3;
    const hw = world.shell.width / 2 - fw / 2, hd = world.shell.depth / 2 - fd / 2;
    const clear = (x: number, z: number): boolean => world.entities.every(e => Math.abs(e.transform.x - x) > fw / 2 + 0.4 || Math.abs(e.transform.z - z) > fd / 2 + 0.4);
    const spots: Array<{ x: number; z: number }> = [];
    for (let x = -hw; x <= hw + 1e-9; x += 1) for (let z = -hd + fd / 2; z <= hd + 1e-9; z += 1) spots.push({ x: round(x), z: round(z) });
    spots.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
    const spot = spots.find(s => clear(s.x, s.z)) ?? { x: 0, z: 0 };
    return { x: spot.x, z: spot.z, rotation: 0 };
}

checkKits();
