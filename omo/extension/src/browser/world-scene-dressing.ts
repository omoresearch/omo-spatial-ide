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
import { lampLight, lightPool } from './world-look';

import type { DressPreset } from '../common/room-modules';
import { PURPOSE_WORDS } from '../common/room-modules';
export type { DressPreset } from '../common/room-modules'; // room modules: the purpose words moved to common (shared with the planner)
export { PURPOSE_WORDS } from '../common/room-modules';

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
const WORDS = PURPOSE_WORDS;
/** The room's preset: its title words first (library/book/novel/lighthouse -> library, moon/space -> observatory, recipe/food -> dining,
 * garden/plant -> garden, lounge/chats/other -> lounge, office -> work), else desks -> work, else generic. */
export function dressPreset(room: Pick<RoomEntity, 'label'>, contents: readonly WorldEntity[] = []): DressPreset {
    const label = room.label ?? '';
    for (const [preset, re] of WORDS) if (re.test(label)) return preset;
    return contents.some(e => e.kind === 'station') ? 'work' : 'generic';
}

// ------------------------------------------------------------------------------------------------ clusters
/** A piece in its cluster frame: x along the wall (to the right when facing into the room), z out from the wall. */
interface CPiece { key: string; plan: KitPlace[] | 'rug'; x: number; z: number; rotY?: number; scale?: number; block?: boolean; lamp?: boolean; hang?: boolean; size?: [number, number]; face?: boolean }
interface Cluster { name: string; where: 'wall' | 'corner' | 'centre' | 'hang' | 'under'; w: number; d: number; tall?: boolean; pieces: CPiece[]; prefer?: WallSide[]; near?: string; under?: Box & { side: WallSide; id: string } }
const sz = (id: string, s: number): [number, number] => [SIZE[id][0] * s, SIZE[id][2] * s];
const kit = (id: string, scale: number, extra: Partial<KitPlace> = {}): KitPlace[] => [{ id, scale, ...extra }];
/** The woven rug's size at scale 1 (world-scene-decor rug(): 2.6 x 1.8 m). */
const RUG = [2.6, 1.8] as const;

/**
 * beauty r3 (3) — rooms are furnished in ZONES, each anchored on its rug or its wall, like a designer lays out a room:
 *   reading nook  — a rug in a corner, the lounge chair ON the rug turned toward the room's focal point (its boards /
 *                   screens, else its centre), a side table beside it with the lamp (the lamp emits)
 *   media wall    — a low cabinet right under a wall screen
 *   console       — a low cabinet on a wall with the picture hung above it
 *   shelf run     — shelving units side by side as one built-in run along a wall
 *   plant group   — plants in odd numbers (3 or 5) at varied heights (tall at the back, low in front), in a corner
 *   lounge / dining / bench — sofa + coffee table + armchair on a rug; round table + 4 chairs on a rug; ottomans + a low table
 */
function shelfRun(units = 2): Cluster {
    const s = 0.85, [w, d] = sz('steel_frame_shelves_03', s), gap = 0.04, total = units * w + (units - 1) * gap;
    const pieces: CPiece[] = Array.from({ length: units }, (_, i) => ({ key: `shelves-${i}`, plan: [{ id: 'steel_frame_shelves_03', scale: s }, { id: 'book_encyclopedia_set_01', onShelves: true }], x: -total / 2 + w / 2 + i * (w + gap), z: d / 2 + 0.03, size: [w, d] as [number, number] }));
    return { name: 'shelves', where: 'wall', tall: true, w: total + 0.1, d: d + 0.05, prefer: ['back', 'left', 'right'], pieces };
}
function readingNook(extra?: 'ottoman'): Cluster {
    const cs = 0.9, [cw, cd] = sz('mid_century_lounge_chair', cs), [tw, td] = sz('side_table_01', 1.05), rs = 0.88, rugD = RUG[1] * rs;
    const pieces: CPiece[] = [
        { key: 'rug', plan: 'rug', x: 0, z: rugD / 2 + 0.25, scale: rs, block: false },
        { key: 'lounge-chair', plan: kit('mid_century_lounge_chair', cs), x: -0.3, z: rugD / 2 + 0.05, size: [cw, cd], face: true },
        { key: 'side-table', plan: [{ id: 'side_table_01', scale: 1.05 }, { id: 'desk_lamp_arm_01', at: [0.04, 0.58, -0.02], rotY: -0.5, scale: 1.1 }], x: 0.72, z: td / 2 + 0.3, size: [tw, td], lamp: true }
    ];
    if (extra === 'ottoman') { const [ow, od] = sz('Ottoman_01', 0.7); pieces.push({ key: 'ottoman', plan: kit('Ottoman_01', 0.7), x: -0.15, z: rugD / 2 + 0.95, size: [ow, od], face: true }); }
    return { name: 'nook', where: 'corner', w: RUG[0] * rs + 0.2, d: rugD + 0.45, pieces, prefer: ['left', 'right', 'back'] };
}
function tableZone(chairs: 2 | 4): Cluster {
    const ts = 0.75, [tw] = sz('round_wooden_table_01', ts), [chw, chd] = sz('dining_chair_02', 1), r = tw / 2 + chd / 2 - 0.08;
    const rs = chairs === 4 ? 1.25 : 1.05, w = Math.max(RUG[0] * rs, tw + 2 * chd), d = chairs === 4 ? Math.max(RUG[1] * rs, tw + 2 * chd) : Math.max(RUG[1] * rs, tw + 0.3), cz = d / 2;
    const seat = (key: string, x: number, z: number, rotY: number): CPiece => ({ key, plan: kit('dining_chair_02', 1), x, z: cz + z, rotY, size: [chw, chd] });
    const pieces: CPiece[] = [
        { key: 'rug', plan: 'rug', x: 0, z: cz, scale: rs, block: false },
        { key: 'table', plan: kit('round_wooden_table_01', ts), x: 0, z: cz, size: [tw, tw] },
        seat('chair-a', -r, 0, Math.PI / 2), seat('chair-b', r, 0, -Math.PI / 2)
    ];
    if (chairs === 4) pieces.push(seat('chair-c', 0, -r, 0), seat('chair-d', 0, r, Math.PI));
    return { name: 'table', where: 'centre', w: w + 0.2, d: d + 0.2, pieces };
}
function loungeZone(): Cluster {
    const ss = 1.2, [sw, sd] = sz('sofa_02', ss), cs = 0.7, [cw] = sz('coffee_table_round_01', cs), [aw, ad] = sz('modern_arm_chair_01', 0.95), [ow, od] = sz('Ottoman_01', 0.8);
    const tz = sd + 0.45 + cw / 2;
    return { name: 'lounge', where: 'wall', w: sw + 1.9, d: tz + cw / 2 + 0.4, prefer: ['back', 'left', 'right'], pieces: [
        { key: 'rug', plan: 'rug', x: 0, z: tz - 0.1, scale: 1.15, block: false },
        { key: 'sofa', plan: kit('sofa_02', ss), x: 0, z: sd / 2 + 0.04, size: [sw, sd] },
        { key: 'coffee-table', plan: kit('coffee_table_round_01', cs), x: 0, z: tz, size: [cw, cw] },
        { key: 'armchair', plan: kit('modern_arm_chair_01', 0.95), x: sw / 2 + 0.45, z: tz, rotY: -Math.PI / 2 + 0.35, size: [aw, ad] },
        { key: 'ottoman', plan: kit('Ottoman_01', 0.8), x: -(sw / 2 + 0.35), z: tz + 0.2, rotY: Math.PI / 2, size: [ow, od] }
    ] };
}
/** Plants in an odd-numbered group at varied heights: tall at the back, medium beside it, low in front. */
function plantGroup(rnd: () => number, n: 3 | 5, name = 'plants'): Cluster {
    const P: Array<[string, number]> = [['pachira_aquatica_01', 0.95], ['potted_plant_01', 1.2], [rnd() < 0.5 ? 'potted_plant_02' : 'calathea_orbifolia_01', rnd() < 0.5 ? 1.5 : 1.9], ['calathea_orbifolia_01', 1.6], ['potted_plant_02', 1.3]];
    const at: Array<[number, number]> = [[-0.22, 0.45], [0.34, 0.36], [0.08, 0.9], [-0.72, 0.92], [0.82, 0.86]];
    const pieces: CPiece[] = P.slice(0, n).map(([id, s], i) => { const [w, d] = sz(id, s); return { key: `plant-${i}`, plan: kit(id, s), x: at[i][0], z: at[i][1], rotY: 0.6 + i * 1.3, size: [Math.max(w, 0.45) * 0.75, Math.max(d, 0.45) * 0.75] as [number, number] }; });
    return { name, where: 'corner', tall: true, w: n === 5 ? 2.2 : 1.35, d: 1.3, pieces };
}
function consoleZone(name = 'console', under?: Cluster['under']): Cluster {
    const s = 0.7, [w, d] = sz('modern_wooden_cabinet', s), top = SIZE.modern_wooden_cabinet[1] * s;
    return { name, where: under ? 'under' : 'wall', under, w: w + 0.1, d: d + 0.05, prefer: ['left', 'right', 'back'], pieces: [{ key: 'cabinet', plan: [{ id: 'modern_wooden_cabinet', scale: s }, { id: 'ceramic_vase_01', at: [-w * 0.28, top, 0], scale: 1 }, { id: 'brass_vase_01', at: [w * 0.3, top, 0.02], scale: 0.6 }], x: 0, z: d / 2 + 0.03, size: [w, d] }] };
}
function benchZone(): Cluster {
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

function presetClusters(preset: DressPreset, rnd: () => number, screen?: Cluster['under']): Cluster[] {
    const media = screen ? [consoleZone('media', screen)] : [];
    switch (preset) {
        case 'library': return [...media, shelfRun(2), readingNook(), plantGroup(rnd, 3), pictureCluster('nook'), tableZone(2)];
        case 'observatory': return [...media, readingNook('ottoman'), plantGroup(rnd, 3), pictureCluster('nook'), consoleZone()];
        case 'dining': return [...media, tableZone(4), consoleZone(), pictureCluster('console'), plantGroup(rnd, 3)];
        case 'lounge': return [...media, loungeZone(), plantGroup(rnd, 3), pictureCluster('lounge')];
        case 'work': return [...media, consoleZone(), plantGroup(rnd, 3), pictureCluster('console')];
        case 'garden': return [benchZone(), plantGroup(rnd, 5), plantGroup(rnd, 3, 'plants-b'), pictureCluster('bench')];
        default: return [...media, readingNook(), consoleZone(), pictureCluster('console'), plantGroup(rnd, 3)];
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
type Thing = Box & { tall: boolean; id: string; focal: boolean; screen: boolean };
function contentsOf(room: RoomEntity, world: WorldSpec): { entities: WorldEntity[]; boxes: Thing[] } {
    const r = room.transform.rotation, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r)), W = room.width, D = room.depth;
    const entities: WorldEntity[] = [], boxes: Thing[] = [];
    for (const e of world.entities) {
        if (e.kind === 'room' || e.id === room.id) continue;
        const dx = e.transform.x - room.transform.x, dz = e.transform.z - room.transform.z, lx = c * dx - s * dz, lz = s * dx + c * dz;
        if (Math.abs(lx) > W / 2 + 0.5 || Math.abs(lz) > D / 2 + 0.5) continue;
        entities.push(e);
        const rect = entityRect(e); if (!rect) continue;
        const rot = e.transform.rotation - r, cx = (rect.left + rect.right) / 2, cz = (rect.front + rect.back) / 2;
        const co = Math.cos(rot), si = Math.sin(rot);
        const b = rectBox(lx + co * cx + si * cz, lz - si * cx + co * cz, rot, (rect.right - rect.left) / 2, (rect.back - rect.front) / 2);
        const screen = e.kind === 'web-wall' || e.kind === 'monitor-wall' || e.kind === 'review-screen' || e.kind === 'mirror';
        boxes.push({ ...b, id: e.id, screen, focal: screen || e.kind === 'station' || (e.kind === 'decor' && e.decor === 'whiteboard'), tall: e.kind !== 'decor' || e.decor === 'whiteboard' || e.decor === 'bookshelf' || e.decor === 'plant' });
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
    const solid: Array<Box & { tall: boolean; id?: string }> = [...boxes];
    const placed = new Map<string, Box>();
    const pieces: DressPiece[] = [];
    const sides: WallSide[] = (['back', 'left', 'right', 'front'] as WallSide[]).sort(() => rnd() - 0.5);
    // beauty r3 (3): the room's FOCAL POINT (its boards / screens / desks, else its centre) — seating turns toward it.
    const focal = boxes.filter(b => b.focal), fx = focal.length ? focal.reduce((a, b) => a + (b.minX + b.maxX) / 2, 0) / focal.length : 0, fz = focal.length ? focal.reduce((a, b) => a + (b.minZ + b.maxZ) / 2, 0) / focal.length : 0;
    // A wall screen (web wall, monitor wall, review screen, mirror) gets the media cabinet right under it.
    const near = (v: number, w: number): boolean => Math.abs(v - w) < 0.6;
    const scr = boxes.find(b => b.screen && (near(b.minZ, inner.minZ) || near(b.maxZ, inner.maxZ) || near(b.minX, inner.minX) || near(b.maxX, inner.maxX)));
    const screen = scr ? { ...scr, side: (near(scr.minZ, inner.minZ) ? 'back' : near(scr.maxZ, inner.maxZ) ? 'front' : near(scr.minX, inner.minX) ? 'left' : 'right') as WallSide } : undefined;
    for (const cl of presetClusters(preset, rnd, screen)) {
        const cands: Array<{ ox: number; oz: number; th: number; box: Box; side?: WallSide; score: number }> = [];
        const wallSides = cl.prefer ? [...cl.prefer, ...sides.filter(s => !cl.prefer!.includes(s))] : sides;
        if (cl.where === 'under' && cl.under) {
            const u = cl.under, side = u.side, [nx, nz] = INWARD[side], th = Math.atan2(nx, nz), along = side === 'back' || side === 'front';
            const ox = along ? (u.minX + u.maxX) / 2 : side === 'left' ? inner.minX : inner.maxX, oz = along ? (side === 'back' ? inner.minZ : inner.maxZ) : (u.minZ + u.maxZ) / 2;
            cands.push({ ox, oz, th, side, box: rectBox(ox + nx * cl.d / 2, oz + nz * cl.d / 2, th, cl.w / 2, cl.d / 2), score: 0 });
        } else if (cl.where === 'centre') {
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
            return !solid.some(s => (cl.where !== 'under' || s.id !== cl.under?.id) && overlaps(b, s, cl.where === 'centre' ? 0.75 : cl.where === 'under' ? 0.05 : 0.3));
        };
        const pick = cands.find(cd => fits(cd.box));
        if (!pick) continue;
        placed.set(cl.name, pick.box);
        if (cl.where !== 'hang') solid.push({ ...pick.box, tall: !!cl.tall });
        const co = Math.cos(pick.th), si = Math.sin(pick.th);
        for (const p of cl.pieces) {
            const x = pick.ox + co * p.x + si * p.z, z = pick.oz - si * p.x + co * p.z;
            // A 'face' piece (the nook's chair, its ottoman) turns toward the focal point, at most 70 degrees off the zone's axis.
            let rotY = pick.th + (p.rotY ?? 0);
            if (p.face) { let d = Math.atan2(fx - x, fz - z) - pick.th; d = Math.atan2(Math.sin(d), Math.cos(d)); rotY = pick.th + Math.max(-1.22, Math.min(1.22, d)); }
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
            if (p.lamp) { const pool = lightPool(0.9); pool.position.set(0.1, 0, 0.15); holder.add(pool); const l = lampLight(); l.position.set(0.05, 1.25, 0.15); holder.add(l); } // beauty r3 (1): the lamp emits
        }
        if (p.hang) holder.userData.part = 'wall-art';
        holder.traverse(o => { o.raycast = () => undefined; });
        group.add(holder);
    }));
    if (!alive()) return 0;
    root.add(group); root.userData.dressing = group;
    return n;
}
