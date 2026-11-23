/**
 * beauty round 2 — room set-dressing. Every runtime room (onboarding home + topic rooms, planner rooms, CSV region rooms)
 * is furnished from the CC0 kit like the hand-made penthouse, by a deterministic DRESSING PRESET picked from the room's
 * purpose (its title words, else its contents):
 *   library  — shelves full of books along a wall, a round table with two chairs on a rug, a reading corner
 *              (lounge chair + side table + desk lamp), a potted plant, a picture
 *   lounge   — sofa + round coffee table on a rug, an armchair, an ottoman, a calathea, a picture over the sofa
 *   work     — (desks exist) a plant, a cabinet, a picture
 *   garden   — several different plants + bench-like seating (two ottomans) with a low table
 *   generic  — a reading corner (chair + side table + lamp) on a rug, a plant, a picture
 *
 * The LAYOUT is pure data (roomDressing: room-local pieces + world collision rects), seeded by the room id, so the same
 * world always gets the same furniture in the same spots. Pieces are wall-aligned (back to the wall, facing in) or
 * centred, and keep clear of: every doorway (a 2.4 m deep entry zone), every thing already standing in the room
 * (desks, boards, screens, decor footprints), each other, and the walls. Hanging pictures avoid tall things (shelves,
 * boards, big plants) and doorways. dressRoom() draws the layout with the kit's real models (async, like decor).
 */
import * as THREE from 'three';
import type { RoomEntity, WallSide, WorldEntity, WorldSpec } from '../common/world-model';
import type { Footprint } from './world-scene-collision';
import { entityRect } from './world-scene-collision';
import { ROOM_DOOR_WIDTH, ROOM_WALL_THICKNESS, roomDoors } from './world-scene-rooms';
import { buildDecor, fitKitDecor, KitPlace, seeded } from './world-scene-decor';
import { lightPool } from './world-look';

export type DressPreset = 'library' | 'lounge' | 'work' | 'garden' | 'generic';

/** Kit model sizes at scale 1 (glTF accessor bounds, metres): width x, height y, depth z. Front faces +z. */
const SIZE: Record<string, [number, number, number]> = {
    steel_frame_shelves_03: [2.35, 2.36, 0.98], book_encyclopedia_set_01: [0.04, 0.24, 0.16], mid_century_lounge_chair: [1.01, 1.17, 1.19],
    side_table_01: [0.55, 0.55, 0.45], desk_lamp_arm_01: [0.2, 0.89, 0.61], round_wooden_table_01: [1.4, 1.01, 1.4], dining_chair_02: [0.43, 0.97, 0.58],
    sofa_02: [1.81, 0.71, 0.82], coffee_table_round_01: [1.3, 0.49, 1.3], modern_arm_chair_01: [0.82, 1.02, 0.99], Ottoman_01: [0.88, 0.62, 0.62],
    calathea_orbifolia_01: [0.6, 0.42, 0.56], pachira_aquatica_01: [1.11, 1.9, 1.0], potted_plant_01: [0.59, 1.34, 0.63], potted_plant_02: [0.73, 0.63, 0.76],
    modern_wooden_cabinet: [2.44, 0.68, 0.68], ceramic_vase_01: [0.2, 0.4, 0.2], brass_vase_01: [0.23, 0.69, 0.23], hanging_picture_frame_02: [0.75, 0.5, 0.03], modern_coffee_table_01: [0.6, 0.39, 1.2]
};

/** One furnished thing: a kit plan (or the woven rug) at a room-local spot. */
export interface DressPiece {
    key: string;
    /** Kit models (fitKitDecor plan); 'rug' = the look-material woven rug. */
    plan: KitPlace[] | 'rug';
    x: number; z: number; rotY: number;
    /** Group scale (the rug only; kit models carry their own scale in the plan). */
    scale?: number;
    /** Half extents on the floor (piece-local, after scale) — collision; undefined: walk over it (rug, picture). */
    half?: [number, number];
    /** Hangs on the wall (hidden in the overview cutaway with the wall tops). */
    hang?: boolean;
    /** A desk lamp: a warm light pool on the floor. */
    lamp?: boolean;
}
export interface RoomDressing { preset: DressPreset; pieces: DressPiece[]; blocks: Footprint[] }

// ------------------------------------------------------------------------------------------------ purpose
const WORDS: Array<[DressPreset, RegExp]> = [
    ['library', /\b(librar\w*|books?|novels?|reading|read|stories|story|poems?|archive)\b/i],
    ['garden', /\b(gardens?|plants?|greenhouse|flowers?|park|botanic\w*|green)\b/i],
    ['lounge', /\b(lounge|living|sofa|cosy|cozy|lobby|cafe|café|chill)\b/i],
    ['work', /\b(office|work\w*|desks?|studio)\b/i]
];
/** The room's preset: its title words first (library/book/novel -> library, garden/plant -> garden, ...), else desks -> work, else generic. */
export function dressPreset(room: Pick<RoomEntity, 'label'>, contents: readonly WorldEntity[] = []): DressPreset {
    const label = room.label ?? '';
    for (const [preset, re] of WORDS) if (re.test(label)) return preset;
    return contents.some(e => e.kind === 'station') ? 'work' : 'generic';
}

// ------------------------------------------------------------------------------------------------ clusters
/** A piece in its cluster frame: x along the wall (to the right when facing into the room), z out from the wall. */
interface CPiece { key: string; plan: KitPlace[] | 'rug'; x: number; z: number; rotY?: number; scale?: number; block?: boolean; lamp?: boolean; hang?: boolean; size?: [number, number] }
interface Cluster { name: string; where: 'wall' | 'corner' | 'centre' | 'hang'; w: number; d: number; tall?: boolean; pieces: CPiece[]; prefer?: WallSide[]; near?: string }
const sz = (id: string, s: number): [number, number] => [SIZE[id][0] * s, SIZE[id][2] * s];
const kit = (id: string, scale: number, extra: Partial<KitPlace> = {}): KitPlace[] => [{ id, scale, ...extra }];

function shelfCluster(): Cluster {
    const s = 0.85, [w, d] = sz('steel_frame_shelves_03', s);
    return { name: 'shelves', where: 'wall', tall: true, w: w + 0.1, d: d + 0.05, prefer: ['back', 'left', 'right'],
        pieces: [{ key: 'shelves', plan: [{ id: 'steel_frame_shelves_03', scale: s }, { id: 'book_encyclopedia_set_01', onShelves: true }], x: 0, z: d / 2 + 0.03, size: [w, d] }] };
}
function readingCluster(rug: boolean): Cluster {
    const cs = 0.9, [cw, cd] = sz('mid_century_lounge_chair', cs), [tw, td] = sz('side_table_01', 1.05);
    const pieces: CPiece[] = [
        { key: 'lounge-chair', plan: kit('mid_century_lounge_chair', cs), x: -0.45, z: cd / 2 + 0.12, rotY: 0.3, size: [cw, cd] },
        { key: 'side-table', plan: [{ id: 'side_table_01', scale: 1.05 }, { id: 'desk_lamp_arm_01', at: [0.04, 0.58, -0.02], rotY: -0.5, scale: 1.1 }], x: 0.55, z: td / 2 + 0.1, size: [tw, td], lamp: true }
    ];
    if (rug) pieces.unshift({ key: 'rug', plan: 'rug', x: 0, z: 1.25, scale: 0.85, block: false });
    return { name: 'reading', where: 'wall', w: 1.95, d: rug ? 2.05 : 1.3, pieces, prefer: ['left', 'right', 'back'] };
}
function tableCluster(): Cluster {
    const ts = 0.75, [tw] = sz('round_wooden_table_01', ts), [chw, chd] = sz('dining_chair_02', 1);
    return { name: 'table', where: 'centre', w: tw + 2 * chd + 0.3, d: tw + 0.3, pieces: [
        { key: 'rug', plan: 'rug', x: 0, z: (tw + 0.3) / 2, scale: 1.05, block: false },
        { key: 'table', plan: kit('round_wooden_table_01', ts), x: 0, z: (tw + 0.3) / 2, size: [tw, tw] },
        { key: 'chair-a', plan: kit('dining_chair_02', 1), x: -(tw / 2 + chd / 2 - 0.05), z: (tw + 0.3) / 2, rotY: Math.PI / 2, size: [chw, chd] },
        { key: 'chair-b', plan: kit('dining_chair_02', 1), x: tw / 2 + chd / 2 - 0.05, z: (tw + 0.3) / 2, rotY: -Math.PI / 2, size: [chw, chd] }
    ] };
}
function loungeCluster(): Cluster {
    const ss = 1.2, [sw, sd] = sz('sofa_02', ss), cs = 0.7, [cw] = sz('coffee_table_round_01', cs), [aw, ad] = sz('modern_arm_chair_01', 0.95), [ow, od] = sz('Ottoman_01', 0.8);
    const tz = sd + 0.45 + cw / 2;
    return { name: 'lounge', where: 'wall', w: sw + 1.9, d: tz + cw / 2 + 0.4, prefer: ['back', 'left', 'right'], pieces: [
        { key: 'rug', plan: 'rug', x: 0, z: tz - 0.1, scale: 1.15, block: false },
        { key: 'sofa', plan: kit('sofa_02', ss), x: 0, z: sd / 2 + 0.04, size: [sw, sd] },
        { key: 'coffee-table', plan: kit('coffee_table_round_01', cs), x: 0, z: tz, size: [cw, cw] },
        { key: 'armchair', plan: kit('modern_arm_chair_01', 0.95), x: sw / 2 + 0.45, z: tz, rotY: -Math.PI / 2 + 0.25, size: [aw, ad] },
        { key: 'ottoman', plan: kit('Ottoman_01', 0.8), x: -(sw / 2 + 0.35), z: tz + 0.2, rotY: Math.PI / 2, size: [ow, od] }
    ] };
}
function plantCluster(id: string, scale: number, name = `plant-${id}`): Cluster {
    const [w, d] = sz(id, scale);
    return { name, where: 'corner', tall: SIZE[id][1] * scale > 1.2, w: Math.max(w, 0.6) + 0.1, d: Math.max(d, 0.6) + 0.1, pieces: [{ key: name, plan: kit(id, scale), x: 0, z: Math.max(d, 0.6) / 2 + 0.05, rotY: 0.6, size: [Math.max(w, 0.5) * 0.8, Math.max(d, 0.5) * 0.8] }] };
}
function cabinetCluster(): Cluster {
    const s = 0.7, [w, d] = sz('modern_wooden_cabinet', s), top = SIZE.modern_wooden_cabinet[1] * s;
    return { name: 'cabinet', where: 'wall', w: w + 0.1, d: d + 0.05, pieces: [{ key: 'cabinet', plan: [{ id: 'modern_wooden_cabinet', scale: s }, { id: 'ceramic_vase_01', at: [-w * 0.28, top, 0], scale: 1 }, { id: 'brass_vase_01', at: [w * 0.3, top, 0.02], scale: 0.6 }], x: 0, z: d / 2 + 0.03, size: [w, d] }] };
}
function benchCluster(): Cluster {
    const [ow, od] = sz('Ottoman_01', 0.85), [tw, td] = sz('modern_coffee_table_01', 0.9);
    return { name: 'bench', where: 'wall', w: 2 * ow + 0.2, d: od + 0.35 + tw + 0.3, pieces: [
        { key: 'bench-a', plan: kit('Ottoman_01', 0.85), x: -ow / 2 - 0.02, z: od / 2 + 0.08, size: [ow, od] },
        { key: 'bench-b', plan: kit('Ottoman_01', 0.85), x: ow / 2 + 0.02, z: od / 2 + 0.08, size: [ow, od] },
        { key: 'bench-table', plan: kit('modern_coffee_table_01', 0.9), x: 0, z: od + 0.35 + tw / 2, rotY: Math.PI / 2, size: [tw, td] }
    ] };
}
function pictureCluster(near?: string): Cluster {
    const s = 1.2, [w] = sz('hanging_picture_frame_02', s);
    return { name: 'picture', where: 'hang', w: w + 0.3, d: 0.05, near, pieces: [{ key: 'picture', plan: kit('hanging_picture_frame_02', s, { at: [0, 1.3, 0] }), x: 0, z: 0.03, hang: true }] };
}

function presetClusters(preset: DressPreset, rnd: () => number): Cluster[] {
    const plants = ['potted_plant_01', 'pachira_aquatica_01', 'potted_plant_02', 'calathea_orbifolia_01'];
    const plantScale: Record<string, number> = { potted_plant_01: 1.2, pachira_aquatica_01: 0.95, potted_plant_02: 1.6, calathea_orbifolia_01: 2.0 };
    const pick = (): string => plants[Math.floor(rnd() * plants.length) % plants.length];
    const plant = (id = pick()): Cluster => plantCluster(id, plantScale[id]);
    switch (preset) {
        case 'library': return [shelfCluster(), readingCluster(false), tableCluster(), plant(), pictureCluster('reading')];
        case 'lounge': return [loungeCluster(), plantCluster('calathea_orbifolia_01', 2.0), pictureCluster('lounge'), plant()];
        case 'work': return [cabinetCluster(), plant(), pictureCluster('cabinet')];
        case 'garden': {
            const order = [...plants].sort(() => rnd() - 0.5);
            return [benchCluster(), ...order.map((id, i) => plantCluster(id, plantScale[id], `plant-${i}`)), plantCluster(order[0], plantScale[order[0]] * 0.9, 'plant-4'), pictureCluster('bench')];
        }
        default: return [readingCluster(true), plant(), pictureCluster('reading'), cabinetCluster(), plant()];
    }
}

// ------------------------------------------------------------------------------------------------ layout
interface Box { minX: number; maxX: number; minZ: number; maxZ: number }
const INWARD: Record<WallSide, [number, number]> = { back: [0, 1], front: [0, -1], left: [1, 0], right: [-1, 0] };
const overlaps = (a: Box, b: Box, pad = 0): boolean => a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad;
function rectBox(x: number, z: number, rot: number, hx: number, hz: number): Box {
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot)), ex = c * hx + s * hz, ez = s * hx + c * hz;
    return { minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez };
}
/** Things standing in the room (room-local boxes), from their collision rects (desks, boards, screens, decor). */
function contentsOf(room: RoomEntity, world: WorldSpec): { entities: WorldEntity[]; boxes: Array<Box & { tall: boolean }> } {
    const r = room.transform.rotation, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r)), W = room.width, D = room.depth;
    const entities: WorldEntity[] = [], boxes: Array<Box & { tall: boolean }> = [];
    for (const e of world.entities) {
        if (e.kind === 'room' || e.id === room.id) continue;
        const dx = e.transform.x - room.transform.x, dz = e.transform.z - room.transform.z, lx = c * dx - s * dz, lz = s * dx + c * dz;
        if (Math.abs(lx) > W / 2 + 0.5 || Math.abs(lz) > D / 2 + 0.5) continue;
        entities.push(e);
        const rect = entityRect(e); if (!rect) continue;
        const rot = e.transform.rotation - r, cx = (rect.left + rect.right) / 2, cz = (rect.front + rect.back) / 2;
        const co = Math.cos(rot), si = Math.sin(rot);
        const b = rectBox(lx + co * cx + si * cz, lz - si * cx + co * cz, rot, (rect.right - rect.left) / 2, (rect.back - rect.front) / 2);
        boxes.push({ ...b, tall: e.kind !== 'decor' || e.decor === 'whiteboard' || e.decor === 'bookshelf' || e.decor === 'plant' });
    }
    return { entities, boxes };
}

/** The deterministic dressing of one room (room-local pieces) and its walking colliders (world space). */
export function roomDressing(room: RoomEntity, world: WorldSpec): RoomDressing {
    const W = room.width, D = room.depth, t = ROOM_WALL_THICKNESS, rnd = seeded(`dress:${room.id}`);
    const { entities, boxes } = contentsOf(room, world);
    const preset = dressPreset(room, entities);
    const inner: Box = { minX: -W / 2 + t / 2 + 0.04, maxX: W / 2 - t / 2 - 0.04, minZ: -D / 2 + t / 2 + 0.04, maxZ: D / 2 - t / 2 - 0.04 };
    const doors = roomDoors(room), half = ROOM_DOOR_WIDTH / 2 + 0.45, entry = 2.4;
    const doorZones: Box[] = [...doors].map(side => side === 'back' ? { minX: -half, maxX: half, minZ: inner.minZ - 1, maxZ: inner.minZ + entry }
        : side === 'front' ? { minX: -half, maxX: half, minZ: inner.maxZ - entry, maxZ: inner.maxZ + 1 }
        : side === 'left' ? { minX: inner.minX - 1, maxX: inner.minX + entry, minZ: -half, maxZ: half }
        : { minX: inner.maxX - entry, maxX: inner.maxX + 1, minZ: -half, maxZ: half });
    const solid: Array<Box & { tall: boolean }> = [...boxes];
    const placed = new Map<string, Box>();
    const pieces: DressPiece[] = [];
    const sides: WallSide[] = (['back', 'left', 'right', 'front'] as WallSide[]).sort(() => rnd() - 0.5);
    for (const cl of presetClusters(preset, rnd)) {
        const cands: Array<{ ox: number; oz: number; th: number; box: Box; side?: WallSide; score: number }> = [];
        const wallSides = cl.prefer ? [...cl.prefer, ...sides.filter(s => !cl.prefer!.includes(s))] : sides;
        if (cl.where === 'centre') {
            for (const th of rnd() < 0.5 ? [0, Math.PI / 2] : [Math.PI / 2, 0]) for (let gx = -2; gx <= 2; gx++) for (let gz = -2; gz <= 2; gz++) {
                const ox = gx * 0.5 + (rnd() - 0.5) * 0.2, oz = gz * 0.5;
                const box = rectBox(ox, oz, th, cl.w / 2, cl.d / 2);
                cands.push({ ox: ox - Math.sin(th) * cl.d / 2, oz: oz - Math.cos(th) * cl.d / 2, th, box, score: Math.hypot(gx, gz) + rnd() * 0.3 });
            }
        } else {
            wallSides.forEach((side, si) => {
                const [nx, nz] = INWARD[side], th = Math.atan2(nx, nz), along = side === 'back' || side === 'front';
                const L = along ? inner.maxX - inner.minX : inner.maxZ - inner.minZ, wallAt = along ? (side === 'back' ? inner.minZ : inner.maxZ) : (side === 'left' ? inner.minX : inner.maxX);
                const n = Math.max(0, Math.floor((L - cl.w) / 0.25));
                for (let k = 0; k <= n; k++) {
                    const a = -L / 2 + cl.w / 2 + k * 0.25, ox = along ? a : wallAt, oz = along ? wallAt : a;
                    const box = rectBox(ox + nx * cl.d / 2, oz + nz * cl.d / 2, th, cl.w / 2, cl.d / 2);
                    const toCorner = L / 2 - Math.abs(a) - cl.w / 2;
                    let score = si * 3 + (cl.where === 'corner' ? toCorner : cl.where === 'hang' ? 0 : Math.abs(a) * 0.4) + rnd() * 0.4;
                    if (cl.near && placed.has(cl.near)) { const p = placed.get(cl.near)!; score = Math.hypot((p.minX + p.maxX) / 2 - (box.minX + box.maxX) / 2, (p.minZ + p.maxZ) / 2 - (box.minZ + box.maxZ) / 2) + rnd() * 0.2; }
                    cands.push({ ox, oz, th, box, side, score });
                }
            });
        }
        cands.sort((p, q) => p.score - q.score);
        const fits = (b: Box): boolean => {
            if (b.minX < inner.minX - 1e-6 || b.maxX > inner.maxX + 1e-6 || b.minZ < inner.minZ - 1e-6 || b.maxZ > inner.maxZ + 1e-6) return false;
            if (doorZones.some(z => overlaps(b, z))) return false;
            if (cl.where === 'hang') { const probe = { ...b, minX: b.minX - 0.05, maxX: b.maxX + 0.05 }, deep = growIn(probe, b, 0.7); return !solid.some(s => s.tall && overlaps(deep, s)) && ![...placed.entries()].some(([k, p]) => k === 'picture' && overlaps(deep, p, 1.2)); }
            return !solid.some(s => overlaps(b, s, cl.where === 'centre' ? 0.75 : 0.3));
        };
        const pick = cands.find(cd => fits(cd.box));
        if (!pick) continue;
        placed.set(cl.name, pick.box);
        if (cl.where !== 'hang') solid.push({ ...pick.box, tall: !!cl.tall });
        const co = Math.cos(pick.th), si = Math.sin(pick.th);
        for (const p of cl.pieces) {
            const x = pick.ox + co * p.x + si * p.z, z = pick.oz - si * p.x + co * p.z, rotY = pick.th + (p.rotY ?? 0);
            pieces.push({ key: `${cl.name}:${p.key}`, plan: p.plan, x: +x.toFixed(3), z: +z.toFixed(3), rotY: +rotY.toFixed(4), ...(p.scale ? { scale: p.scale } : {}),
                ...(p.size && p.block !== false ? { half: [p.size[0] / 2, p.size[1] / 2] as [number, number] } : {}), ...(p.hang ? { hang: true } : {}), ...(p.lamp ? { lamp: true } : {}) });
        }
    }
    // Walking colliders (world space, axis aligned in the world for quarter-turn rooms; 0.2 m clearance).
    const r = room.transform.rotation, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
    const blocks: Footprint[] = pieces.filter(p => p.half).map(p => {
        const b = rectBox(p.x, p.z, p.rotY, p.half![0], p.half![1]), cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
        const hx = (b.maxX - b.minX) / 2 + 0.2, hz = (b.maxZ - b.minZ) / 2 + 0.2, turned = Math.abs(s) === 1;
        return { id: `dress:${room.id}:${p.key}`, x: room.transform.x + c * cx + s * cz, z: room.transform.z - s * cx + c * cz, rotation: 0,
            rect: { left: -(turned ? hz : hx), right: turned ? hz : hx, front: -(turned ? hx : hz), back: turned ? hx : hz } };
    });
    return { preset, pieces, blocks };
}
/** A wall-hung box grown `by` metres into the room (the wall side is where it touches the inner bounds). */
function growIn(probe: Box, b: Box, by: number): Box {
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    if (w >= d) return { ...probe, minZ: probe.minZ - by, maxZ: probe.maxZ + by };
    return { ...probe, minX: probe.minX - by, maxX: probe.maxX + by };
}

/** Collision rects of every room's dressing (for the walker). */
export function dressingBlocks(world: WorldSpec): Footprint[] {
    return world.entities.filter((e): e is RoomEntity => e.kind === 'room').flatMap(room => roomDressing(room, world).blocks);
}

// ------------------------------------------------------------------------------------------------ drawing
/** Kit model loader (RoomScene's shared CC0 prop loader). */
export interface PropSource { prop(id: string): Promise<THREE.Object3D> }
/**
 * Draw a room's dressing into its root (room-local), with the real kit models; resolves when every model is in. The rug is
 * the look-material woven rug (an approved fallback). Pictures carry part 'wall-art' (hidden in the overview cutaway).
 */
export async function dressRoom(root: THREE.Object3D, dressing: RoomDressing, props: PropSource, jungle: boolean, alive: () => boolean): Promise<number> {
    const group = new THREE.Group(); group.name = 'omo-room-dressing'; group.userData.preset = dressing.preset;
    let n = 0;
    await Promise.all(dressing.pieces.map(async p => {
        const holder = new THREE.Group(); holder.position.set(p.x, 0.06, p.z); holder.rotation.y = p.rotY; holder.name = `omo-dress:${p.key}`;
        if (p.plan === 'rug') {
            const rug = buildDecor('rug', `${root.name}:${p.key}`, jungle); rug.position.y = 0.002; if (p.scale) rug.scale.setScalar(p.scale); holder.add(rug);
        } else {
            const plan = p.plan, models = await Promise.all(plan.map(k => props.prop(k.id)));
            fitKitDecor(holder, plan, models); n += plan.length;
            if (p.lamp) { const pool = lightPool(0.9); pool.position.set(0.55, 0, 0); holder.add(pool); }
        }
        if (p.hang) holder.userData.part = 'wall-art';
        holder.traverse(o => { o.raycast = () => undefined; });
        group.add(holder);
    }));
    if (!alive()) return 0;
    root.add(group); root.userData.dressing = group;
    return n;
}
