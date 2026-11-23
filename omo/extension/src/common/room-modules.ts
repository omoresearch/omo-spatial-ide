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
    ['library', new RegExp(`${presetWords('library').source}|\\b(notes?|notebooks?|docs|documentation|wiki|research|study)\\b`, 'i')],
    ['lounge', new RegExp(`${presetWords('lounge').source}|\\b(break|relax\\w*|community|people|team ?chat)\\b`, 'i')],
    ['studio', new RegExp(`${presetWords('work').source}|\\b(code|coding|coders?|build\\w*|dev|devs|develop\\w*|engineer\\w*|programming|software|src|apps?|labs?|agents?|terminals?|stations?|ops)\\b`, 'i')]
];

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
}

const BOARDS: readonly Transform[] = [-3.05, -1.65, 1.65, 3.05].map(x => ({ x, z: 2.87, rotation: Math.PI }));
const SCREEN = { x: 3.87, z: 0, rotation: -Math.PI / 2, width: 3.6, height: 2.0 };
const DOOR = { side: 'front' as const, x: 0, width: 1.6 };
export const MODULE_WIDTH = 8, MODULE_DEPTH = 6;

export const MODULES: Readonly<Record<RoomModuleId, RoomModule>> = {
    library: { id: 'library', label: 'Library', width: MODULE_WIDTH, depth: MODULE_DEPTH, door: DOOR, desks: [], boards: BOARDS, screen: SCREEN },
    lounge: { id: 'lounge', label: 'Lounge', width: MODULE_WIDTH, depth: MODULE_DEPTH, door: DOOR, desks: [], boards: BOARDS, screen: SCREEN },
    studio: {
        id: 'studio', label: 'Studio', width: MODULE_WIDTH, depth: MODULE_DEPTH, door: DOOR, boards: BOARDS, screen: SCREEN,
        desks: [{ x: -0.55, z: 0.27, rotation: -Math.PI / 2 }, { x: -0.55, z: -1.17, rotation: -Math.PI / 2 }, { x: 0.55, z: 0.27, rotation: Math.PI / 2 }]
    }
};
/** Most desks one studio holds. */
export const STUDIO_DESKS = MODULES.studio.desks.length;

export function isRoomModule(v: unknown): v is RoomModuleId { return v === 'library' || v === 'lounge' || v === 'studio'; }
/** Desks a room of this module holds (0 for library / lounge). */
export function moduleDeskSlots(id: RoomModuleId | undefined): number { return id ? MODULES[id].desks.length : Infinity; }

/**
 * The module for a room: its title words first, then its purpose words (topic text, board lines, the onboarding
 * sentence ...), each in the order library, lounge, studio; else desks -> studio; else lounge.
 */
export function pickModule(title: string | undefined, purposeWords: string | readonly string[] = [], hasDesks = false): RoomModuleId {
    const purpose = typeof purposeWords === 'string' ? purposeWords : purposeWords.join(' ');
    for (const text of [title ?? '', purpose]) {
        if (!text.trim()) continue;
        for (const [id, re] of MODULE_WORDS) if (re.test(text)) return id;
    }
    return hasDesks ? 'studio' : 'lounge';
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
/** Width of the central path between the two rows of doorways. */
export const GRID_PATH = 4;
/** Open ground kept around the rooms' bounding box. */
export const GRID_MARGIN = 4;
/** Centre-to-centre step along a row. */
export const GRID_PITCH = MODULE_WIDTH + GRID_GAP;
/** Distance from the path centre line (z = 0) to a room centre. */
export const GRID_ROW_Z = GRID_PATH / 2 + MODULE_DEPTH / 2;

export interface GridSlot extends Transform { row: 0 | 1; col: number }
/**
 * `n` rooms on an even grid around a central path along x (z = 0): row 0 behind the path (z < 0, doors facing +z),
 * row 1 in front of it, turned round (rotation PI) so its doors face the path too. Up to 3 rooms stand in one row;
 * more fill two rows (row 0 gets the odd one). Columns are GRID_PITCH apart and centred on x = 0.
 */
export function moduleGrid(n: number): GridSlot[] {
    if (n <= 0) return [];
    const perRow = n <= 3 ? n : Math.ceil(n / 2);
    const out: GridSlot[] = [];
    for (let i = 0; i < n; i++) {
        const row = i < perRow ? 0 : 1, col = row ? i - perRow : i, inRow = row ? n - perRow : perRow;
        out.push({ row, col, x: r3((col - (inRow - 1) / 2) * GRID_PITCH), z: row ? GRID_ROW_Z : -GRID_ROW_Z, rotation: row ? Math.PI : 0 });
    }
    return out;
}

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
