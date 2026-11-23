/**
 * foundation:v3 — the ASSET CATALOGUE. Every model a world can name is an entry with an id, a licence, its real
 * size, a floor footprint, what it is good for (affordances) and how it is placed. Kits are versioned packs of
 * entries plus materials, lighting and architecture. A world names assets by id only (PropEntity.asset in
 * world-model.ts), so an old world keeps working when a kit updates, and a world never holds a file path.
 *
 * Sources:
 *   - the World Director lab kits (omo-sky-lab/world-director/kits/<kit>/kit.json + tools/bounds.json or
 *     measured.json + manifest.json): `catalogueFromKitJson` converts them, with the same rules as the lab's
 *     director/kitlib.py (mount -> placement, exterior flags, lights, the CORE built-in bookcase and rug);
 *   - the skyline penthouse style kit (world-style-kits.ts KIT_PROPS): `SKYLINE_PACK`, so the ids that old decor
 *     entities name in `prop` resolve here too (`findAsset` matches them case-insensitively).
 *
 * Pure data and pure functions (no DOM / Node / THREE): the planner, the compiler (world-compiler.ts), the bake
 * worker and the tests share it.
 */
import type { RoomTheme } from './room-state';
import { ASSET_ID_RE } from './world-model';
import { KIT_PROPS, STYLE_KITS } from './world-style-kits';
import type { StyleKitProp } from './world-style-kits';

export type AssetLicense = 'CC0' | 'CC-BY' | 'generated';
export type Affordance = 'sit' | 'work' | 'display' | 'light' | 'storage' | 'surface' | 'decor';
export type AssetPlacement = 'floor' | 'wall' | 'surface' | 'ceiling';
export type AssetCategory = 'seat' | 'table' | 'desk' | 'shelf' | 'storage' | 'lamp' | 'plant' | 'art' | 'rug' | 'screen' | 'outdoor' | 'decor';
export const AFFORDANCES: readonly Affordance[] = ['sit', 'work', 'display', 'light', 'storage', 'surface', 'decor'];
export const ASSET_CATEGORIES: readonly AssetCategory[] = ['seat', 'table', 'desk', 'shelf', 'storage', 'lamp', 'plant', 'art', 'rug', 'screen', 'outdoor', 'decor'];
const PLACEMENTS: readonly AssetPlacement[] = ['floor', 'wall', 'surface', 'ceiling'];

export interface Vec3 { x: number; y: number; z: number }

export interface AssetEntry {
    /** Catalogue id (ASSET_ID_RE): lowercase. */
    id: string;
    label: string;
    category: AssetCategory;
    /** Words a person might use for it (planner). */
    words: string[];
    license: AssetLicense;
    /** Where it came from: a source URL, or the kit file a generated prop is built from. */
    source: string;
    /** sha256 of the model file when the catalogue was installed (content address). */
    sha256?: string;
    /** Real size in metres at scale 1: x across its front, y up, z front-to-back. */
    size: Vec3;
    /** Floor footprint HALF size in metres at scale 1 (x across its front, z front-to-back). */
    footprint: { x: number; z: number };
    affordances: Affordance[];
    placement: AssetPlacement;
    /** The model's native front axis (Poly Haven models face -Y in Blender, glTF +Z). */
    front: '-y' | '+y';
    /** Extra yaw (radians, counter-clockwise seen from above) that turns a model whose front is another axis to `front`. */
    frontYaw?: number;
    lods?: string[];
    collider?: 'box' | 'mesh';
    // ---- solver data (from the lab kit format; all optional) ----
    /** Kit tags ('shelf', 'books', 'desk_dressing' ...): the solver's vocabulary. */
    tags?: string[];
    /** The zone the kit author put it in: wall | nook | center | corner | desks | window | floor. */
    zone?: string;
    /** How many the solver may place in one room [min, max]. */
    count?: [number, number];
    /** placement 'surface': the parent tag it stands on ('table', 'desk', 'shelf' ...). */
    on?: string;
    /** placement 'wall': the height of its centre (metres). */
    mountY?: number;
    /** Lives outside (garden, regolith): never inside a room. */
    exterior?: boolean;
    /** Gives light (a lamp, lantern or pendant). */
    emits?: boolean;
    /** Built from code, not a model file ('bookcase' fills a wall run in ~1 m modules; 'rug' is a slab). */
    procedural?: 'bookcase' | 'rug';
    /** Model file inside the kit (relative, forward slashes). Never an absolute path. */
    model?: string;
    /** Multi-part model file: the part this entry uses. */
    part?: string;
    /** The kit no longer uses it (kept so old worlds still resolve). */
    deprecated?: boolean;
    /** Other ids that resolve to this entry (the original mixed-case Poly Haven id). */
    aliases?: string[];
}

export interface KitMaterial { tex?: string; tile?: number; color?: string; rough?: number }
export interface KitLighting {
    hdri: string;
    sun: { elevation: number; azimuth?: number; color: string; strength: number };
    /** Exposure in stops. */
    exposure: number;
    hdriStrength?: number;
    /** HDRI rotation, degrees. */
    hdriRotation?: number;
}
export interface KitArchitecture { ceiling: number; wall: number; window: string; column?: boolean; columnSpacing?: number; roof?: string; floorRaise?: number }

export interface KitPack {
    id: string;
    /** Content version: the kit's own version, else a hash of its source JSON (same kit file = same version). */
    version: string;
    label: string;
    /** The procedural shell theme the kit falls back to when its baked shell is not installed. */
    theme: RoomTheme;
    assets: AssetEntry[];
    materials: Record<string, KitMaterial>;
    lighting: KitLighting;
    architecture: KitArchitecture;
    /** Solver recipes per room purpose: 'library' -> ['wall:shelf', 'nook:reading', ...]. */
    zones?: Record<string, string[]>;
    /** Hero asset ids (one per view). */
    hero?: string[];
    keywords?: string[];
}

// ------------------------------------------------------------------------------------------------ validation
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const relPath = (v: unknown): boolean => str(v, 256) && !/^([/\\]|[A-Za-z]:|~)/.test(v as string) && !(v as string).split(/[/\\]/).includes('..');

/** True when `a` is a well-formed catalogue entry (sizes in metres, known words, no absolute paths). */
export function validAsset(a: unknown): a is AssetEntry {
    const v = a as AssetEntry;
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !ASSET_ID_RE.test(v.id) || !str(v.label, 80)) return false;
    if (!ASSET_CATEGORIES.includes(v.category) || !['CC0', 'CC-BY', 'generated'].includes(v.license) || !str(v.source, 512)) return false;
    if (!Array.isArray(v.words) || v.words.length > 48 || !v.words.every(w => str(w, 48))) return false;
    if (v.sha256 !== undefined && !(typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256))) return false;
    if (!v.size || !num(v.size.x, 0.001, 60) || !num(v.size.y, 0.001, 60) || !num(v.size.z, 0.001, 60)) return false;
    if (!v.footprint || !num(v.footprint.x, 0.0005, 30) || !num(v.footprint.z, 0.0005, 30)) return false;
    if (!Array.isArray(v.affordances) || v.affordances.length < 1 || !v.affordances.every(x => AFFORDANCES.includes(x)) || new Set(v.affordances).size !== v.affordances.length) return false;
    if (!PLACEMENTS.includes(v.placement) || (v.front !== '-y' && v.front !== '+y')) return false;
    if (v.frontYaw !== undefined && !num(v.frontYaw, -Math.PI * 2, Math.PI * 2)) return false;
    if (v.lods !== undefined && !(Array.isArray(v.lods) && v.lods.length <= 4 && v.lods.every(relPath))) return false;
    if (v.collider !== undefined && v.collider !== 'box' && v.collider !== 'mesh') return false;
    if (v.tags !== undefined && !(Array.isArray(v.tags) && v.tags.every(t => typeof t === 'string' && /^[a-z0-9_]{1,32}$/.test(t)))) return false;
    if (v.zone !== undefined && !(typeof v.zone === 'string' && /^[a-z_]{1,16}$/.test(v.zone))) return false;
    if (v.count !== undefined && !(Array.isArray(v.count) && v.count.length === 2 && Number.isInteger(v.count[0]) && Number.isInteger(v.count[1]) && v.count[0] >= 0 && v.count[1] >= v.count[0] && v.count[1] <= 64)) return false;
    if (v.on !== undefined && !(typeof v.on === 'string' && /^[a-z0-9_]{1,32}$/.test(v.on))) return false;
    if (v.mountY !== undefined && !num(v.mountY, 0, 10)) return false;
    if (v.procedural !== undefined && v.procedural !== 'bookcase' && v.procedural !== 'rug') return false;
    if (v.model !== undefined && !relPath(v.model)) return false;
    if (v.part !== undefined && !str(v.part, 64)) return false;
    if (v.aliases !== undefined && !(Array.isArray(v.aliases) && v.aliases.every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(x)))) return false;
    return true;
}

/** Problems with a pack: bad entries and duplicate ids (empty = valid). */
export function packProblems(pack: KitPack): string[] {
    const out: string[] = [], seen = new Set<string>();
    if (!ASSET_ID_RE.test(pack.id)) out.push(`kit id ${pack.id}`);
    for (const a of pack.assets) {
        if (!validAsset(a)) out.push(`asset ${String((a as { id?: unknown })?.id)}`);
        if (seen.has(a.id)) out.push(`duplicate ${a.id}`);
        seen.add(a.id);
    }
    return out;
}

// ------------------------------------------------------------------------------------------------ lab kit format
/** One prop as the lab's kit.json writes it (coastal: height/place/model; kyoto, mars: h/mount/front/part/light). */
export interface LabKitProp {
    id: string; tags?: string[]; zone?: string; footprint?: [number, number]; height?: number; h?: number;
    facing?: string; front?: string; count?: [number, number]; place?: string; mount?: string; model?: string;
    part?: string; light?: unknown; note?: string; procedural?: string; on?: string;
}
export interface LabKitJson {
    id: string; name?: string; version?: string; keywords?: string[]; palette?: Record<string, string>;
    materials?: Record<string, Record<string, unknown>>; architecture?: Record<string, unknown>;
    lighting?: Record<string, unknown>; props: LabKitProp[]; zones?: Record<string, string[]>;
    hero?: Array<string | { id: string }>;
}
/** coastal tools/bounds.json: size/min/max per model (Blender metres, z up). */
export type LabBounds = Record<string, { size: [number, number, number]; parts?: Record<string, { x: number; y: number; z: number }> }>;
/** kyoto/mars measured.json: x/y/z per model, plus parts. */
export type LabMeasured = Record<string, { x: number; y: number; z: number; parts?: Record<string, { x: number; y: number; z: number }> }>;
/** kyoto/mars manifest.json, coastal tools/fetch_manifest.json: { models: { id: { path, src } } }. */
export interface LabManifest { models?: Record<string, { path?: string; src?: string }> }
export interface KitSources {
    bounds?: LabBounds;
    measured?: LabMeasured;
    manifest?: LabManifest;
    /** Ids built by the kit's own tools (tools/specs/simple_props.json): licence 'generated'. */
    generated?: readonly string[];
    /** Add the lab's CORE props (built-in bookcase, rug) like director/kitlib.py does. Default true. */
    core?: boolean;
    /** The procedural theme the kit falls back to. Default: from the kit's keywords. */
    theme?: RoomTheme;
}

/** director/kitlib.py CORE_PROPS: built from code, injected unless the kit has its own (no rug on tatami, no bookcase with shoji). */
const CORE_PROPS: LabKitProp[] = [
    { id: 'builtin_bookcase', procedural: 'bookcase', tags: ['shelf', 'books'], zone: 'wall', footprint: [1.0, 0.38], height: 2.9, place: 'floor' },
    { id: 'rug', procedural: 'rug', tags: ['rug'], zone: 'floor', footprint: [2.0, 1.6], height: 0.012, place: 'floor' }
];
const EXT_TAGS = new Set(['garden', 'outside', 'vista', 'groundcover', 'scatter', 'boulder', 'moss', 'specimen']);
const has = (tags: ReadonlySet<string>, ...words: string[]): boolean => words.some(w => tags.has(w));

function categoryOf(tags: ReadonlySet<string>, placement: AssetPlacement, exterior: boolean): AssetCategory {
    if (has(tags, 'rug', 'floor_cover')) return 'rug';
    if (has(tags, 'desk', 'workstation')) return 'desk';
    if (has(tags, 'divider', 'byobu')) return 'decor';
    if (has(tags, 'seat', 'sofa', 'chair', 'stool', 'cushion', 'daybed', 'footrest', 'zabuton')) return 'seat';
    if (has(tags, 'lamp', 'light', 'lantern', 'pendant', 'sconce', 'candle')) return 'lamp';
    if (exterior || has(tags, 'rock', 'boulder', 'stone', 'moss', 'pebble', 'garden', 'outside')) return 'outdoor';
    if (has(tags, 'plant', 'fern', 'shrub', 'tree', 'pine', 'bonsai')) return 'plant';
    if (has(tags, 'tabletop', 'desk_dressing', 'dressing', 'shelf_item', 'shelf_fill')) return 'decor';
    if (has(tags, 'screen', 'presentation') || (tags.has('display') && placement === 'wall')) return 'screen';
    if (has(tags, 'shelf', 'rack', 'books')) return 'shelf';
    if (has(tags, 'cabinet', 'storage', 'drawers', 'tansu', 'sideboard')) return 'storage';
    if (has(tags, 'table', 'low_table', 'console', 'coffee', 'side', 'map_table', 'tea', 'zataku', 'altar')) return 'table';
    if (has(tags, 'art', 'painting', 'frame', 'scroll', 'kakejiku', 'sculpture', 'clock', 'tokonoma')) return 'art';
    return 'decor';
}
function affordancesOf(tags: ReadonlySet<string>, category: AssetCategory, emits: boolean): Affordance[] {
    const out: Affordance[] = [];
    if (category === 'seat') out.push('sit');
    if (has(tags, 'desk', 'workstation')) out.push('work');
    if (category === 'screen') out.push('display');
    if (emits) out.push('light');
    if (has(tags, 'shelf', 'storage', 'cabinet', 'drawers', 'tansu', 'rack', 'bin', 'crate', 'sideboard')) out.push('storage');
    if (has(tags, 'table', 'desk', 'low_table', 'console', 'shelf', 'cabinet', 'sideboard', 'tansu', 'altar', 'zataku', 'platform')) out.push('surface');
    if (!out.length || category === 'art' || category === 'plant' || category === 'decor') out.push('decor');
    return [...new Set(out)];
}
function labelOf(id: string): string {
    const words = id.replace(/_/g, ' ').replace(/\s+0*(\d+)$/, ' $1').trim().toLowerCase();
    return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 80);
}
/** FNV-1a 32-bit of a string, as 8 hex digits (stable content version). */
export function fnv1a(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function themeFor(kit: LabKitJson): RoomTheme {
    const text = `${kit.id} ${(kit.keywords ?? []).join(' ')}`.toLowerCase();
    if (/mars|space|station|orbit|moon|lab/.test(text)) return 'station';
    if (/kyoto|garden|moss|forest|jungle|tea/.test(text)) return 'jungle';
    return 'skyline';
}

/** One lab kit prop -> a catalogue entry (director/kitlib.py load_kit rules). */
export function assetFromLabProp(kitId: string, p: LabKitProp, src: KitSources = {}): AssetEntry {
    const tags = (p.tags ?? []).map(t => t.toLowerCase());
    const tagSet = new Set(tags);
    const measured = src.measured?.[p.id], bound = src.bounds?.[p.id];
    const partSize = p.part ? (measured?.parts?.[p.part] ?? bound?.parts?.[p.part]) : undefined;
    const fromFile = partSize ? { x: partSize.x, y: partSize.y, z: partSize.z }
        : measured ? { x: measured.x, y: measured.y, z: measured.z }
            : bound ? { x: bound.size[0], y: bound.size[1], z: bound.size[2] } : undefined;
    // footprint [width, depth] along the model's own front wins (kit author measured it); else the file bounds (Blender x, y).
    const fw = p.footprint?.[0] ?? fromFile?.x ?? 0.5, fd = p.footprint?.[1] ?? fromFile?.y ?? 0.5;
    const height = p.height ?? p.h ?? fromFile?.z ?? 0.5;
    // mount -> placement (kitlib: 'ceiling' | 'on:<tag>' | 'wall[:<z>]'); coastal writes 'place' itself.
    let placement: AssetPlacement = 'floor', on = p.on, mountY: number | undefined;
    const place = p.place, mount = p.mount;
    if (place === 'surface') placement = 'surface';
    else if (place === 'ceiling') placement = 'ceiling';
    else if (place === 'wall_mount' || place === 'wall') placement = 'wall';
    else if (!place && mount) {
        if (mount === 'ceiling') placement = 'ceiling';
        else if (mount.startsWith('on:')) { placement = 'surface'; on = mount.slice(3); }
        else if (mount.startsWith('wall')) { placement = 'wall'; const y = Number(mount.split(':')[1]); if (Number.isFinite(y)) mountY = y; }
    }
    const exterior = has(tagSet, 'garden', 'outside') || (p.zone === 'window' && tags.some(t => EXT_TAGS.has(t)));
    const emits = (!!p.light && typeof p.light === 'object') || tagSet.has('light');
    const category = categoryOf(tagSet, placement, exterior);
    const front = p.front === '+y' ? '+y' : '-y';
    // '-x' front (kyoto wooden_display_shelves_01): +90° about up turns -X to -Y; '+x': -90°.
    const frontYaw = p.front === '-x' ? Math.PI / 2 : p.front === '+x' ? -Math.PI / 2 : undefined;
    const id = p.id.toLowerCase();
    const generated = !!p.procedural || (src.generated ?? []).includes(p.id);
    const manifestSrc = src.manifest?.models?.[p.id]?.src;
    const source = p.procedural ? `omo:core/${p.procedural}` : generated ? `kit:${kitId}/tools/specs/simple_props.json#${p.id}` : (manifestSrc ?? `https://polyhaven.com/a/${p.id}`);
    const words = [...new Set([labelOf(p.id).toLowerCase(), ...tags.filter(t => t !== 'deprecated').map(t => t.replace(/_/g, ' '))])].slice(0, 48);
    const entry: AssetEntry = {
        id, label: labelOf(p.id), category, words, license: generated ? 'generated' : 'CC0', source,
        size: { x: r3(Math.max(fw, 0.001)), y: r3(Math.max(height, 0.001)), z: r3(Math.max(fd, 0.001)) },
        footprint: { x: r3(Math.max(fw, 0.001) / 2), z: r3(Math.max(fd, 0.001) / 2) },
        affordances: affordancesOf(tagSet, category, emits), placement, front, collider: 'box', tags
    };
    if (frontYaw !== undefined) entry.frontYaw = frontYaw;
    if (p.zone) entry.zone = p.zone;
    if (p.count) entry.count = [p.count[0], p.count[1]];
    if (on) entry.on = on;
    if (mountY !== undefined) entry.mountY = mountY;
    if (exterior) entry.exterior = true;
    if (emits) entry.emits = true;
    if (p.procedural === 'bookcase' || p.procedural === 'rug') entry.procedural = p.procedural;
    if (!p.procedural) entry.model = (p.model ?? src.manifest?.models?.[p.id]?.path ?? `models/${p.id}/${p.id}.gltf`).replace(/\\/g, '/');
    if (p.part) entry.part = p.part;
    if (tagSet.has('deprecated') || (p.count && p.count[1] === 0 && tagSet.has('deprecated'))) entry.deprecated = true;
    if (id !== p.id) entry.aliases = [p.id];
    return entry;
}

/** A lab kit (kit.json + its bounds / measured / manifest files) -> a KitPack. Deterministic: same files, same pack. */
export function catalogueFromKitJson(kit: LabKitJson, src: KitSources = {}): KitPack {
    if (!kit || typeof kit.id !== 'string' || !Array.isArray(kit.props)) throw new Error('Not a kit.json (needs id and props).');
    const id = kit.id.toLowerCase();
    const props = kit.props.map(p => ({ ...p }));
    const ids = new Set(props.map(p => p.id));
    const floorTex = String((kit.materials?.floor as { tex?: unknown } | undefined)?.tex ?? '');
    if (src.core !== false) for (const c of CORE_PROPS) {
        if (ids.has(c.id)) continue;
        if (c.id === 'rug' && floorTex.includes('tatami')) continue;
        if (c.id === 'builtin_bookcase' && kit.architecture?.window === 'shoji') continue;
        props.push({ ...c });
    }
    const L = (kit.lighting ?? {}) as Record<string, unknown>;
    const sun = (L.sun ?? {}) as Record<string, unknown>;
    const n = (v: unknown, d: number): number => typeof v === 'number' && Number.isFinite(v) ? v : d;
    const A = (kit.architecture ?? {}) as Record<string, unknown>;
    const materials: Record<string, KitMaterial> = {};
    for (const [k, m] of Object.entries(kit.materials ?? {})) {
        const out: KitMaterial = {};
        if (typeof m.tex === 'string') out.tex = m.tex;
        if (typeof m.tile === 'number') out.tile = m.tile;
        if (typeof m.color === 'string') out.color = m.color;
        if (typeof m.rough === 'number') out.rough = m.rough;
        materials[k] = out;
    }
    const pack: KitPack = {
        id, version: kit.version ?? `lab-${fnv1a(JSON.stringify(kit))}`, label: (kit.name ?? labelOf(kit.id)).slice(0, 80), theme: src.theme ?? themeFor(kit),
        assets: props.map(p => assetFromLabProp(id, p, src)),
        materials,
        lighting: {
            hdri: String(L.hdri ?? ''),
            sun: { elevation: n(sun.elev, 8), ...(typeof sun.azim === 'number' ? { azimuth: sun.azim } : typeof sun.azim_from_sea === 'number' ? { azimuth: sun.azim_from_sea } : {}), color: String(sun.color ?? '#ffffff'), strength: n(sun.strength, 3) },
            exposure: n(L.exposure, 0),
            ...(typeof L.hdri_strength === 'number' ? { hdriStrength: L.hdri_strength } : {}),
            ...(typeof L.hdri_rotation === 'number' ? { hdriRotation: L.hdri_rotation } : {})
        },
        architecture: {
            ceiling: n(A.ceiling, 3), wall: n(A.wall, 0.18), window: String(A.window ?? 'full_height'),
            ...(typeof A.column === 'boolean' ? { column: A.column } : {}), ...(typeof A.column_spacing === 'number' ? { columnSpacing: A.column_spacing } : {}),
            ...(typeof A.roof === 'string' ? { roof: A.roof } : {}), ...(typeof A.floor_raise === 'number' ? { floorRaise: A.floor_raise } : {})
        },
        ...(kit.zones ? { zones: JSON.parse(JSON.stringify(kit.zones)) as Record<string, string[]> } : {}),
        ...(kit.hero ? { hero: kit.hero.map(h => (typeof h === 'string' ? h : h.id).toLowerCase()) } : {}),
        ...(kit.keywords ? { keywords: [...kit.keywords] } : {})
    };
    return pack;
}

// ------------------------------------------------------------------------------------------------ skyline penthouse
/** Heights for the style-kit props (KIT_PROPS records only a floor footprint). Approximate, by category. */
const SKYLINE_HEIGHT: Record<string, number> = { plant: 1.3, seat: 0.85, table: 0.6, lamp: 0.55, shelf: 1.9, art: 0.7, storage: 0.8 };
function assetFromStyleProp(p: StyleKitProp): AssetEntry {
    const tags = new Set(p.words.flatMap(w => w.split(/\s+/)));
    const category: AssetCategory = p.category === 'seat' ? 'seat' : p.category === 'table' ? (p.id === 'metal_office_desk' ? 'desk' : 'table') : p.category;
    const placement: AssetPlacement = p.id === 'modern_ceiling_lamp_01' ? 'ceiling' : p.id === 'hanging_picture_frame_02' ? 'wall' : p.id.includes('vase') || p.id === 'desk_lamp_arm_01' || p.id === 'book_encyclopedia_set_01' || p.id === 'standing_picture_frame_01' ? 'surface' : 'floor';
    const emits = category === 'lamp';
    const aff: Affordance[] = [];
    if (category === 'seat') aff.push('sit');
    if (category === 'desk') aff.push('work', 'surface');
    if (emits) aff.push('light');
    if (category === 'shelf' || category === 'storage') aff.push('storage', 'surface');
    if (category === 'table') aff.push('surface');
    if (!aff.length || category === 'art' || category === 'plant') aff.push('decor');
    const id = p.id.toLowerCase(), s = p.scale ?? 1;
    const entry: AssetEntry = {
        id, label: p.label, category, words: [...p.words], license: 'CC0', source: `https://polyhaven.com/a/${p.id}`,
        size: { x: r3(p.half.x * 2), y: r3((SKYLINE_HEIGHT[p.category] ?? 0.8) * s), z: r3(p.half.z * 2) },
        footprint: { x: p.half.x, z: p.half.z }, affordances: [...new Set(aff)], placement, front: '-y', collider: 'box',
        tags: [...tags].filter(t => /^[a-z0-9_]{1,32}$/.test(t)), model: `cc0/${p.id}/${p.id}.gltf`
    };
    if (emits) entry.emits = true;
    if (id !== p.id) entry.aliases = [p.id];
    return entry;
}
const skyline = STYLE_KITS.find(k => k.id === 'skyline-penthouse')!;
/** The skyline penthouse style kit as a pack: every KIT_PROPS id (old decor `prop` values) resolves through it. */
export const SKYLINE_PACK: KitPack = {
    id: 'skyline-penthouse', version: `style-${fnv1a(JSON.stringify(KIT_PROPS))}`, label: skyline.label, theme: skyline.theme,
    assets: KIT_PROPS.map(assetFromStyleProp),
    materials: {},
    lighting: { hdri: 'probe.exr', sun: { elevation: 6, color: '#ffb878', strength: 2 }, exposure: Math.log2(skyline.render.exposure || 1) },
    architecture: { ceiling: skyline.shell.ceiling, wall: 0.2, window: 'full_height' },
    keywords: ['skyline', 'penthouse', 'city', 'manhattan']
};

// ------------------------------------------------------------------------------------------------ lookup
/** Packs known without installing anything (the lab kits are installed separately and passed in). */
export const BUILT_IN_PACKS: readonly KitPack[] = [SKYLINE_PACK];

/**
 * The entry an id names: the preferred kit first (the world's site.kit), then every other pack in order. Matches
 * the catalogue id, or an alias (the mixed-case style-kit ids old decor entities use, e.g. 'Ottoman_01').
 */
export function findAsset(id: string | undefined, packs: readonly KitPack[] = BUILT_IN_PACKS, preferKit?: string): AssetEntry | undefined {
    if (!id) return undefined;
    const lower = id.toLowerCase();
    const ordered = preferKit ? [...packs.filter(p => p.id === preferKit), ...packs.filter(p => p.id !== preferKit)] : packs;
    for (const pack of ordered) {
        const hit = pack.assets.find(a => a.id === lower || a.aliases?.includes(id));
        if (hit) return hit;
    }
    return undefined;
}
export function findPack(id: string | undefined, packs: readonly KitPack[] = BUILT_IN_PACKS): KitPack | undefined {
    return id ? packs.find(p => p.id === id.toLowerCase()) : undefined;
}
