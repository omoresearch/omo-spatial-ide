/**
 * sky:merge — style kits. A style kit is DATA: the look a room theme is drawn with.
 *
 *   - a shell: a baked interior (glTF + Cycles lightmaps + AO + an HDR reflection probe + a city panorama with
 *     depth) that fits a fixed floor size, served by the backend from `omo/kits/<kit>/` (see
 *     scripts/fetch-style-kits.cjs and style-kits.lock.json). Bigger floors fall back to the procedural shell
 *     of the same theme, so a grown world never breaks;
 *   - anchors: where the kit's desks and web wall stand. The IDE's own stations / web wall are placed there,
 *     so the tmux runtime drives the desk monitors unchanged;
 *   - a prop catalogue: CC0 glTF models by id. A decor entity names one with `prop` (world-model.ts);
 *   - lighting / post settings.
 *
 * Pure data, no THREE: the planner (world-admin-rules.ts, Hermes) reads the catalogue to pick kits and props.
 */
import type { DecorKind, Transform, WorldEntity, WorldSpec } from './world-model';
import type { RoomTheme } from './room-state';

export type StyleKitId = 'skyline-penthouse';
export type PropCategory = 'plant' | 'seat' | 'table' | 'lamp' | 'shelf' | 'art' | 'storage';

export interface StyleKitProp {
    id: string;
    label: string;
    category: PropCategory;
    /** Words a person might use for it (planner). */
    words: readonly string[];
    /** Floor footprint half-size in metres at scale 1 (collision + placement). */
    half: { x: number; z: number };
    /** Scale the prop is drawn at by default (Poly Haven models are real size; plants are drawn a bit larger). */
    scale?: number;
    /** The decor kind used when the kit assets are not installed (and for its collision rectangle). */
    fallback: DecorKind;
}

export interface StyleKit {
    id: StyleKitId;
    label: string;
    description: string;
    theme: RoomTheme;
    /** Floor size the baked shell fits exactly (metres). The world shell must not be larger to use it. */
    shell: { width: number; depth: number; ceiling: number };
    /** Baked-file origin -> world: world = baked + offset (baked rooms are modelled from a corner). */
    offset: { x: number; z: number };
    /** Station anchors (world space, rotation 0 = facing -z). */
    desks: readonly Transform[];
    /** Web wall anchor and size. */
    webWall: { transform: Transform; width: number; height: number; elevation: number };
    /** Spawn point (world space). */
    spawn: { x: number; z: number; yaw: number };
    /** A low lounge dais (real step-up surface for walking physics). */
    dais: { x: number; z: number; width: number; depth: number; height: number };
    props: readonly StyleKitProp[];
    render: { exposure: number; bloom: { strength: number; radius: number; threshold: number }; eye: number };
}

const P = (id: string, label: string, category: PropCategory, words: string[], hx: number, hz: number, fallback: DecorKind, scale?: number): StyleKitProp =>
    ({ id, label, category, words, half: { x: hx, z: hz }, fallback, ...(scale !== undefined ? { scale } : {}) });

/** CC0 Poly Haven models (https://polyhaven.com/license), copied from the sky lab by scripts/fetch-style-kits.cjs. */
export const KIT_PROPS: readonly StyleKitProp[] = [
    P('pachira_aquatica_01', 'Money tree', 'plant', ['money tree', 'pachira', 'tree', 'big plant', 'tall plant'], 0.35, 0.35, 'plant', 1.4),
    P('potted_plant_01', 'Potted plant', 'plant', ['potted plant', 'plant', 'pot plant', 'house plant'], 0.3, 0.3, 'plant', 1.6),
    P('potted_plant_02', 'Leafy plant', 'plant', ['leafy plant', 'fern'], 0.3, 0.3, 'plant', 1.6),
    P('potted_plant_04', 'Small plant', 'plant', ['small plant', 'succulent', 'desk plant'], 0.15, 0.15, 'plant'),
    P('calathea_orbifolia_01', 'Calathea', 'plant', ['calathea', 'prayer plant'], 0.3, 0.3, 'plant', 1.8),
    P('sofa_02', 'Sofa', 'seat', ['sofa', 'couch', 'settee'], 1.15, 0.55, 'sofa'),
    P('mid_century_lounge_chair', 'Lounge chair', 'seat', ['lounge chair', 'eames chair', 'reading chair'], 0.6, 0.6, 'sofa'),
    P('modern_arm_chair_01', 'Armchair', 'seat', ['armchair', 'arm chair', 'easy chair'], 0.55, 0.5, 'sofa'),
    P('Ottoman_01', 'Ottoman', 'seat', ['ottoman', 'pouf', 'footstool'], 0.45, 0.35, 'rug'),
    P('bar_chair_round_01', 'Bar stool', 'seat', ['bar stool', 'stool', 'bar chair'], 0.25, 0.25, 'lamp'),
    P('dining_chair_02', 'Chair', 'seat', ['dining chair', 'chair'], 0.25, 0.3, 'lamp'),
    P('coffee_table_round_01', 'Coffee table', 'table', ['coffee table', 'round table', 'low table'], 0.55, 0.55, 'rug'),
    P('round_wooden_table_01', 'Round table', 'table', ['wooden table', 'meeting table', 'cafe table'], 0.6, 0.6, 'rug'),
    P('side_table_01', 'Side table', 'table', ['side table', 'end table'], 0.28, 0.25, 'lamp'),
    P('modern_coffee_table_01', 'Modern coffee table', 'table', ['modern coffee table', 'marble table'], 0.6, 0.4, 'rug'),
    P('metal_office_desk', 'Office desk', 'table', ['office desk', 'metal desk'], 1.0, 0.48, 'bookshelf'),
    P('desk_lamp_arm_01', 'Desk lamp', 'lamp', ['desk lamp', 'arm lamp', 'reading lamp'], 0.15, 0.15, 'lamp'),
    P('modern_ceiling_lamp_01', 'Pendant lamp', 'lamp', ['pendant', 'ceiling lamp', 'hanging lamp'], 0.2, 0.2, 'lamp'),
    P('steel_frame_shelves_03', 'Shelves', 'shelf', ['shelves', 'shelf', 'shelving', 'bookcase', 'bookshelf'], 0.5, 0.2, 'bookshelf'),
    P('book_encyclopedia_set_01', 'Book set', 'shelf', ['books', 'book set', 'encyclopedia'], 0.3, 0.12, 'bookshelf'),
    P('modern_wooden_cabinet', 'Cabinet', 'storage', ['cabinet', 'sideboard', 'credenza'], 1.2, 0.25, 'bookshelf'),
    P('brass_vase_01', 'Brass vase', 'art', ['brass vase', 'vase'], 0.1, 0.1, 'lamp'),
    P('ceramic_vase_01', 'Ceramic vase', 'art', ['ceramic vase', 'pottery'], 0.1, 0.1, 'lamp'),
    P('hanging_picture_frame_02', 'Picture', 'art', ['picture', 'painting', 'artwork', 'frame'], 0.6, 0.05, 'whiteboard'),
    P('standing_picture_frame_01', 'Standing frame', 'art', ['standing frame', 'photo frame', 'photo'], 0.15, 0.08, 'lamp')
];

export const STYLE_KITS: readonly StyleKit[] = [{
    id: 'skyline-penthouse',
    label: 'Skyline penthouse',
    description: 'A baked glass penthouse floor above the city at dusk: three desks facing the glass, a lounge, a docs wall.',
    theme: 'skyline',
    shell: { width: 18, depth: 12, ceiling: 3.4 },
    offset: { x: -9, z: 6 },
    // Baked desks at blender x 4.2 / 7.6 / 11.0, y 5.0 (three z -5.0) facing south: world (x - 9, z + 6).
    desks: [{ x: -4.8, z: 1, rotation: 0 }, { x: -1.4, z: 1, rotation: 0 }, { x: 2, z: 1, rotation: 0 }],
    // The baked file's `webwall_anchor` empty sits on the south wall (three 9.2, -0.03), facing into the room.
    webWall: { transform: { x: -0.4, z: 5.86, rotation: Math.PI }, width: 4, height: 2.25, elevation: 0.5 },
    spawn: { x: -6, z: 4.4, yaw: -0.5 },
    dais: { x: 6.3, z: 3.6, width: 3.2, depth: 2.4, height: 0.18 },
    props: KIT_PROPS,
    render: { exposure: 1, bloom: { strength: 0.28, radius: 0.55, threshold: 1.6 }, eye: 1.65 }
}];

export const PROP_ID_RE = /^[A-Za-z0-9_]{1,48}$/;
export function styleKit(id: string | undefined): StyleKit | undefined { return STYLE_KITS.find(k => k.id === id); }
/** The kit a theme is drawn with (undefined: the theme's procedural look only). */
export function kitForTheme(theme: RoomTheme | undefined): StyleKit | undefined { return STYLE_KITS.find(k => k.theme === theme); }
export function kitProp(id: string | undefined): StyleKitProp | undefined { return KIT_PROPS.find(p => p.id === id); }
/** True when the baked shell of `kit` can draw this world (closed shell no larger than the bake). */
export function kitShellFits(kit: StyleKit, world: Pick<WorldSpec, 'shell'>): boolean {
    return !world.shell.open && world.shell.width <= kit.shell.width + 1e-6 && world.shell.depth <= kit.shell.depth + 1e-6;
}
/** Best catalogue prop for a phrase ('a money tree', 'two armchairs'), longest word match first. */
export function propForPhrase(text: string): StyleKitProp | undefined {
    const lower = text.toLowerCase();
    let best: { prop: StyleKitProp; len: number; at: number } | undefined;
    for (const prop of KIT_PROPS) for (const w of [prop.id.toLowerCase(), ...prop.words]) {
        const at = lower.search(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`));
        if (at >= 0 && (!best || w.length > best.len)) best = { prop, len: w.length, at };
    }
    return best?.prop;
}
/** A decor entity for a catalogue prop. */
export function propEntity(id: string, prop: StyleKitProp, transform: Transform, label?: string): WorldEntity {
    return { id, kind: 'decor', decor: prop.fallback, prop: prop.id, transform, label: label ?? prop.label, ...(prop.scale !== undefined ? { scale: prop.scale } : {}) };
}
/** Asset URL (served by the backend StyleKitAssets contribution). */
export function kitAssetUrl(kit: StyleKitId, file: string): string { return `/omo-kits/${kit}/${file}`; }
export function propAssetUrl(kit: StyleKitId, prop: string): string { return kitAssetUrl(kit, `cc0/${prop}/${prop}.gltf`); }
