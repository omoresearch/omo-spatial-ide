/**
 * room modules — the three baked rooms (kits/modules/<id>: library, lounge, studio). Each is an 8 x 6 m box with
 * ONE doorway, front-centre (local +z wall), glass on the back wall. The planner (onboarding zones, Shape "add a room",
 * the mind world, CSV / repo worlds) gives every room it makes a `module` (RoomEntity.module) picked from the room's
 * purpose words, snaps it to the module footprint and puts its things on the module's anchors:
 *
 *   library — lighthouse / book / read / library / notes ...   (no desk slots)
 *   lounge  — chat / lounge / social / talk / friends ...      (no desk slots; also the fallback)
 *   studio  — desks / code / work / build / dev ...            (3 desk slots: more desks -> another studio)
 *
 * Rooms are set out on a tidy grid (moduleGrid): two rows facing a central path along x, 2 m between rooms in a row,
 * every doorway opening onto the path. Pure data; no rendering here.
 */
import type { Transform } from './world-model';

// ------------------------------------------------------------------------------------------------ purpose words
/** The set-dressing presets (browser/world-scene-dressing.ts re-exports these). */
export type DressPreset = 'library' | 'observatory' | 'dining' | 'lounge' | 'work' | 'garden' | 'generic';
/** Purpose words of a room title, checked in this order (first match wins). Shared by set-dressing and modules. */
export const PURPOSE_WORDS: ReadonlyArray<readonly [DressPreset, RegExp]> = [
    ['library', /\b(librar\w*|books?|novels?|reading|read|stories|story|poems?|poetry|archives?|lighthouses?|writing|writers?|authors?|literature|journals?)\b/i],
    ['observatory', /\b(moon\w*|space|stars?|starry|astro\w*|planets?|rockets?|galax\w*|cosmos|cosmic|orbit\w*|observatory|telescopes?|night sky|mars|lunar|solar)\b/i],
    ['dining', /\b(recipes?|food|foods|kitchen|cook\w*|meals?|bak(e|es|ing|ery)|dinners?|lunch|breakfast|dining|eat\w*|menu|chef|pantry)\b/i],
    ['garden', /\b(gardens?|plants?|greenhouse|flowers?|park|botanic\w*|green)\b/i],
    ['lounge', /\b(lounge|living|sofa|cosy|cozy|lobby|cafe|café|chill|chats?|chatting|other|misc\w*|messages?|talk\w*|social|friends?|family|hangout|inbox)\b/i],
    ['work', /\b(office|work\w*|desks?|studio)\b/i]
];
const presetWords = (p: DressPreset): RegExp => PURPOSE_WORDS.find(([k]) => k === p)![1];

export type RoomModuleId = 'library' | 'lounge' | 'studio';
/** Module words: the shared purpose words plus a few module-only ones (notes; code / build / dev). */
export const MODULE_WORDS: ReadonlyArray<readonly [RoomModuleId, RegExp]> = [
    ['library', new RegExp(`${presetWords('library').source}|\\b(notes?|notebooks?|docs|documentation|wiki|study)\\b`, 'i')],
    ['lounge', new RegExp(`${presetWords('lounge').source}|\\b(break|relax\\w*|community|people|team ?chat)\\b`, 'i')],
    ['studio', new RegExp(`${presetWords('work').source}|\\b(code|coding|coders?|build\\w*|dev|devs|develop\\w*|engineer\\w*|programming|software|src|apps?|api|labs?|agents?|terminals?|stations?|ops)\\b|(?:^|\\s)\\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|rb|php|cs|sh)\\b`, 'i')]
];
/** The module whose words appear first in `text` (ties: library, lounge, studio); undefined when none match. */
function firstModuleIn(text: string): RoomModuleId | undefined {
    let best: { id: RoomModuleId; at: number } | undefined;
    for (const [id, re] of MODULE_WORDS) {
        const at = text.search(re);
        if (at >= 0 && (!best || at < best.at)) best = { id, at };
    }
    return best?.id;
}

// ------------------------------------------------------------------------------------------------ modules
export interface RoomModule {
    id: RoomModuleId;
    label: string;
    /** Footprint, metres (local x across, local z front-back). */
    width: number;
    depth: number;
    /** The one doorway: front wall, centred, 1.6 m wide. */
    door: { side: 'front'; x: number; width: number };
    /**
     * Desk spots (room-local; x right, z towards the door; `rotation` = module.json desk rotY). The studio's bench has
     * four seats in the bake; the planner uses three of them (a cap of 3 desks per studio).
     */
    desks: readonly Transform[];
    /** Note boards on the inside of the front wall, either side of the door (module.json anchors.boards). */
    boards: readonly Transform[];
    /** The big screen on the right wall (module.json anchors.screens[0]); width x height metres. */
    screen: Transform & { width: number; height: number };
    /** Baked furniture on the floor (module.json blocks): room-local centre + half extents. */
    blocks: ReadonlyArray<{ x: number; z: number; hx: number; hz: number }>;
}
/**
 * Free floor spots for extra decor (plants, lamps, shelves ...), room-local: clear of every module's baked furniture
 * (radius 0.45 m) and of the doorway, at least 1.5 m out from the door centre line so a sofa still leaves it clear.
 */
export const MODULE_DECOR_SPOTS: readonly Transform[] = [{ x: -2.3, z: 2.1, rotation: 0 }, { x: 2.2, z: 2.1, rotation: 0 }, { x: -1.6, z: 1.15, rotation: 0 }, { x: 1.6, z: 1.15, rotation: 0 }];
/**
 * Wall spots for screens, mirrors and review screens: the big screen on the right wall first, then a free stretch of the
 * left wall (the library's left wall is all shelves: one spot only).
 */
export const MODULE_WALL_SPOTS: Readonly<Record<RoomModuleId, ReadonlyArray<Transform & { width: number; height: number }>>> = {
    library: [SCREEN_SPOT()],
    lounge: [SCREEN_SPOT(), { x: -3.87, z: 0, rotation: Math.PI / 2, width: 2.4, height: 1.35 }],
    studio: [SCREEN_SPOT(), { x: -3.87, z: 1.9, rotation: Math.PI / 2, width: 1.4, height: 1.0 }]
};
function SCREEN_SPOT(): Transform & { width: number; height: number } { return { x: 3.87, z: 0, rotation: -Math.PI / 2, width: 3.6, height: 2.0 }; }
/** Height of a wall screen's centre (module.json anchors.screens[0].y). */
export const SCREEN_CENTRE_Y = 1.65;
/** The doorway's clear entry zone (room-local): the door width, 2 m in from the front wall (the studio bench ends 2.05 m in). */
export const DOOR_CLEAR = { minX: -0.8, maxX: 0.8, minZ: 3 - 2, maxZ: 3 } as const;

const BOARDS: readonly Transform[] = [-3.05, -1.65, 1.65, 3.05].map(x => ({ x, z: 2.87, rotation: Math.PI }));
const SCREEN = { x: 3.87, z: 0, rotation: -Math.PI / 2, width: 3.6, height: 2.0 };
const DOOR = { side: 'front' as const, x: 0, width: 1.6 };
export const MODULE_WIDTH = 8, MODULE_DEPTH = 6;

export const MODULES: Readonly<Record<RoomModuleId, RoomModule>> = {
    library: {
        id: 'library', label: 'Library', width: MODULE_WIDTH, depth: MODULE_DEPTH, door: DOOR, desks: [], boards: BOARDS, screen: SCREEN,
        blocks: [{ x: -3.7, z: 0.29, hx: 0.2, hz: 2.4 }, { x: 1.35, z: -0.85, hx: 1.0, hz: 1.0 }, { x: -2.25, z: -1.75, hx: 0.8, hz: 0.75 }, { x: 3.68, z: -1.7, hx: 0.22, hz: 0.85 }, { x: 2.7, z: -2.55, hx: 0.28, hz: 0.28 }, { x: 3.45, z: 2.38, hx: 0.2, hz: 0.2 }]
    },
    lounge: {
        id: 'lounge', label: 'Lounge', width: MODULE_WIDTH, depth: MODULE_DEPTH, door: DOOR, desks: [], boards: BOARDS, screen: SCREEN,
        blocks: [{ x: -0.45, z: -2.11, hx: 1.5, hz: 0.5 }, { x: -0.45, z: -0.95, hx: 0.47, hz: 0.47 }, { x: -1.75, z: -0.4, hx: 0.42, hz: 0.42 }, { x: 0.85, z: -0.4, hx: 0.42, hz: 0.42 }, { x: -2.4, z: -2.01, hx: 0.28, hz: 0.28 }, { x: 3.66, z: 0.25, hx: 0.22, hz: 1.2 }, { x: 2.6, z: -1.35, hx: 0.75, hz: 0.7 }, { x: -3.25, z: -2.4, hx: 0.3, hz: 0.3 }, { x: 3.45, z: 2.38, hx: 0.2, hz: 0.2 }]
    },
    studio: {
        id: 'studio', label: 'Studio', width: MODULE_WIDTH, depth: MODULE_DEPTH, door: DOOR, boards: BOARDS, screen: SCREEN,
        desks: [{ x: -0.55, z: 0.27, rotation: -Math.PI / 2 }, { x: -0.55, z: -1.17, rotation: -Math.PI / 2 }, { x: 0.55, z: 0.27, rotation: Math.PI / 2 }],
        blocks: [{ x: 0, z: -0.45, hx: 0.8, hz: 1.4 }, { x: -3.7, z: -0.65, hx: 0.2, hz: 1.55 }, { x: 3.66, z: 0.45, hx: 0.22, hz: 1.2 }, { x: -3.25, z: -2.5, hx: 0.28, hz: 0.28 }, { x: 3.35, z: 2.0, hx: 0.2, hz: 0.2 }, { x: 3.3, z: -2.55, hx: 0.3, hz: 0.3 }]
    }
};
/** Most desks one studio holds. */
export const STUDIO_DESKS = MODULES.studio.desks.length;

export function isRoomModule(v: unknown): v is RoomModuleId { return v === 'library' || v === 'lounge' || v === 'studio'; }
/** Desks a room of this module holds (0 for library / lounge). */
export function moduleDeskSlots(id: RoomModuleId | undefined): number { return id ? MODULES[id].desks.length : Infinity; }

/**
 * The module for a room: its title words first, then its purpose words (topic text, README / file types, the part of
 * the onboarding sentence about the room ...); in each, the module whose word comes FIRST wins; else desks -> studio;
 * else lounge.
 */
export function pickModule(title: string | undefined, purposeWords: string | readonly string[] = [], hasDesks = false): RoomModuleId {
    const purpose = typeof purposeWords === 'string' ? purposeWords : purposeWords.join(' ');
    for (const text of [title ?? '', purpose]) {
        const found = text.trim() ? firstModuleIn(text) : undefined;
        if (found) return found;
    }
    return hasDesks ? 'studio' : 'lounge';
}

/** What one module room holds: desks on its desk anchors, wall things on its wall spots, boards, other decor. */
export function moduleCapacity(id: RoomModuleId): { desks: number; walls: number; boards: number; decor: number } {
    return { desks: MODULES[id].desks.length, walls: MODULE_WALL_SPOTS[id].length, boards: MODULES[id].boards.length, decor: MODULE_DECOR_SPOTS.length };
}

/** Split `desks` desks over studios of STUDIO_DESKS: [3, 3, 1] for 7. 0 desks -> []. */
export function studioSplit(desks: number): number[] {
    const out: number[] = [];
    for (let left = desks; left > 0; left -= STUDIO_DESKS) out.push(Math.min(STUDIO_DESKS, left));
    return out;
}

// ------------------------------------------------------------------------------------------------ tidy grid
/** Metres between neighbouring rooms in a row. */
export const GRID_GAP = 2;
/** Width of the central path between the two rows of doorways (7 m: the spawn stands 4 m out from a doorway, clear of the far row). */
export const GRID_PATH = 7;
/** Open ground kept around the rooms' bounding box. */
export const GRID_MARGIN = 4;
/** Centre-to-centre step along a row. */
export const GRID_PITCH = MODULE_WIDTH + GRID_GAP;

export interface GridSlot extends Transform { row: 0 | 1; col: number }
/**
 * Rooms of the given sizes on an even grid around a path along x. Up to 3 rooms stand in ONE row with their doorways on
 * z = 0 (the path in front, z > 0). More rooms fill TWO rows facing a central path (z = 0, GRID_PATH wide): row 0
 * behind it (doors facing +z), row 1 in front, turned round (rotation PI) so its doors face the path too; row 0 gets
 * the odd one. Every front wall sits on the path edge; centres are an even pitch apart (widest room + GRID_GAP) and
 * each row is centred on x = 0.
 */
export function gridSlots(sizes: ReadonlyArray<{ width: number; depth: number }>): GridSlot[] {
    const n = sizes.length;
    if (!n) return [];
    const two = n > 3, perRow = two ? Math.ceil(n / 2) : n;
    const pitch = Math.max(...sizes.map(s => s.width)) + GRID_GAP;
    return sizes.map((size, i): GridSlot => {
        const row = i < perRow ? 0 : 1, col = row ? i - perRow : i, inRow = row ? n - perRow : perRow;
        const front = two ? GRID_PATH / 2 : 0;
        return { row, col, x: r3((col - (inRow - 1) / 2) * pitch), z: r3(row ? front + size.depth / 2 : -front - size.depth / 2), rotation: row ? Math.PI : 0 };
    });
}
/** `n` module rooms (8 x 6) on the tidy grid. */
export function moduleGrid(n: number): GridSlot[] { return gridSlots(Array.from({ length: Math.max(0, n) }, () => ({ width: MODULE_WIDTH, depth: MODULE_DEPTH }))); }
/** z of the path's centre line for a grid of `n` rooms (one row: the middle of the GRID_PATH strip in front of the doors). */
export function gridPathZ(n: number): number { return n > 3 ? 0 : GRID_PATH / 2; }

/** Half extents of the open ground for things in `rects` (shell centred on the origin): bounding box + margin, whole even metres. */
export function groundFor(rects: ReadonlyArray<{ minX: number; maxX: number; minZ: number; maxZ: number }>, margin = GRID_MARGIN): { width: number; depth: number } {
    let hx = 0, hz = 0;
    for (const r of rects) { hx = Math.max(hx, Math.abs(r.minX), Math.abs(r.maxX)); hz = Math.max(hz, Math.abs(r.minZ), Math.abs(r.maxZ)); }
    const even = (v: number): number => Math.ceil((v - 1e-9) / 2) * 2;
    return { width: even(2 * (hx + margin)), depth: even(2 * (hz + margin)) };
}

/** Room-local -> world for a room at `at` (rotation in 90° steps). */
export function toWorld(at: Transform, local: Transform): Transform {
    const c = Math.cos(at.rotation), s = Math.sin(at.rotation);
    let rot = local.rotation + at.rotation;
    while (rot > Math.PI + 1e-9) rot -= 2 * Math.PI;
    while (rot < -Math.PI - 1e-9) rot += 2 * Math.PI;
    return { x: r3(at.x + local.x * c + local.z * s), z: r3(at.z - local.x * s + local.z * c), rotation: r3(rot) };
}

function r3(v: number): number { const r = Math.round(v * 1000) / 1000; return r === 0 ? 0 : r; }
