/**
 * w2:render — decor kinds. beauty:foundation — a decor kind is drawn with REAL CC0 kit furniture whenever the kit has
 * a model for it (plant, sofa, lamp, bookshelf; any catalogue `prop`); the procedural shape below is only the stand-in
 * while the model loads, and the final look for the kinds without a model (crystal, whiteboard, rug, window). Every
 * stand-in uses world-look materials, so even the fallback matches the penthouse.
 *
 * Builders draw at the local origin, front towards +z (rotation 0 faces the back wall from the player's side).
 * Variety (which plant, leaf tilt) comes from the entity id, so the same world always looks the same. No lights are
 * added: glowing parts use emissive look materials and decals, so adding decor never recompiles the room's shaders.
 */
import * as THREE from 'three';
import type { DecorKind } from '../common/world-model';
import { kitProp } from '../common/world-style-kits';
import { mesh, part, rod, slab } from './world-scene-kit';
import { aoDecal, lampGlow, lampLight, lightPool, look, lookInk, lookPaper, lookPlate, paintNote, paintWindowView } from './world-look';

/** Small deterministic PRNG from an id. */
export function seeded(id: string): () => number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------------------------------------ kit plans
/** One CC0 model placed in a decor group (decor-local metres; the model is centred on x/z and stands on y). */
export interface KitPlace { id: string; at?: [number, number, number]; rotY?: number; scale?: number; /** fill each shelf of the previous model */ onShelves?: boolean }
const PLANTS: readonly KitPlace[] = [
    { id: 'potted_plant_01', scale: 1.2 }, { id: 'pachira_aquatica_01', scale: 0.95 }, { id: 'potted_plant_02', scale: 1.7 }, { id: 'calathea_orbifolia_01', scale: 2.2 }
];
/** Decor kinds with no kit model: their look-material shape is the approved final look. */
export const APPROVED_FALLBACK: ReadonlySet<DecorKind> = new Set(['crystal', 'whiteboard', 'rug', 'window']);
/**
 * The kit models a decor entity is drawn with: its own catalogue `prop`, else the model(s) for its kind. Undefined:
 * no model (an approved fallback kind, or note/sign boards that carry text).
 */
export function decorKitPlan(kind: DecorKind, id: string, prop?: string): KitPlace[] | undefined {
    if (/^(note|sign)-/.test(id)) return undefined;
    if (prop && kitProp(prop)) return [{ id: prop }];
    const rnd = seeded(id);
    switch (kind) {
        case 'plant': { const p = PLANTS[Math.floor(rnd() * PLANTS.length) % PLANTS.length]; return [{ ...p, rotY: rnd() * Math.PI * 2 }]; }
        case 'sofa': return [{ id: 'sofa_02', scale: 1.2 }];
        case 'lamp': return [{ id: 'side_table_01', scale: 1.05 }, { id: 'desk_lamp_arm_01', at: [0.04, 0.58, -0.02], rotY: -0.5, scale: 1.1 }];
        case 'bookshelf': return [{ id: 'steel_frame_shelves_03', scale: 0.9 }, { id: 'book_encyclopedia_set_01', onShelves: true }];
        default: return undefined;
    }
}
/**
 * Put loaded kit models (same order as the plan) into a decor group: centred, standing on the floor, books on every
 * shelf. Keeps the decals (contact shadow, light pool) and drops the procedural stand-in.
 */
export function fitKitDecor(group: THREE.Object3D, plan: readonly KitPlace[], models: readonly THREE.Object3D[]): void {
    for (const child of [...group.children]) if (child.userData.fallback) group.remove(child);
    const box = new THREE.Box3(), size = new THREE.Vector3(), centre = new THREE.Vector3();
    let shelf: THREE.Object3D | undefined;
    plan.forEach((p, i) => {
        const model = models[i]; if (!model) return;
        if (p.onShelves && shelf) { shelveBooks(group, shelf, model); return; }
        const holder = new THREE.Group(); holder.name = `omo-kit-prop:${p.id}`; holder.userData.kitProp = p.id;
        model.scale.setScalar(p.scale ?? 1); model.rotation.y = p.rotY ?? 0; model.position.set(0, 0, 0); model.updateMatrixWorld(true);
        box.setFromObject(model); box.getCenter(centre);
        model.position.set(-centre.x, -box.min.y, -centre.z);
        holder.position.set(...(p.at ?? [0, 0, 0])); holder.add(model); group.add(holder);
        box.getSize(size);
        if (!p.at) group.add(aoDecal(size.x * 1.25, size.z * 1.25));
        shelf = holder;
    });
    group.userData.kitProps = plan.map(p => p.id);
    lampGlow(group);
}
/** Book sets on every shelf board of a shelving unit (found by casting rays down through it). */
function shelveBooks(group: THREE.Object3D, shelf: THREE.Object3D, books: THREE.Object3D): void {
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const b = new THREE.Box3().setFromObject(shelf).applyMatrix4(inv);
    const ray = new THREE.Raycaster(), levels: number[] = [];
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    for (const fx of [-0.3, 0, 0.3]) {
        const o = new THREE.Vector3(cx + fx * (b.max.x - b.min.x), b.max.y + 0.2, cz).applyMatrix4(group.matrixWorld);
        ray.set(o, new THREE.Vector3(0, -1, 0).transformDirection(group.matrixWorld));
        for (const hit of ray.intersectObject(shelf, true)) {
            const y = hit.point.clone().applyMatrix4(inv).y;
            if (y > b.min.y + 0.15 && y < b.max.y - 0.25 && !levels.some(l => Math.abs(l - y) < 0.12)) levels.push(y);
        }
    }
    levels.sort((a, c) => a - c);
    const rnd = seeded(`${group.name}${levels.length}`);
    const bb = new THREE.Box3().setFromObject(books), bc = new THREE.Vector3(); bb.getCenter(bc);
    levels.forEach((y, i) => {
        for (const side of i % 2 ? [-1] : [-1, 1]) {
            const set = books.clone(true);
            set.position.set(cx + side * (b.max.x - b.min.x) * (0.18 + rnd() * 0.08) - bc.x, y - bb.min.y + 0.005, cz - bc.z + 0.02);
            set.userData.kitProp = 'book_encyclopedia_set_01';
            group.add(set);
        }
    });
    group.userData.shelfLevels = levels.length;
}

// ------------------------------------------------------------------------------------------------ stand-ins
export function buildDecor(kind: DecorKind, id: string, jungle: boolean, note?: string): THREE.Group {
    const g = new THREE.Group(); const rnd = seeded(id);
    // The procedural shape lives in its own group (dropped when the kit model arrives); decals stay.
    const f = new THREE.Group(); f.userData.fallback = !APPROVED_FALLBACK.has(kind); f.name = 'omo-decor-standin'; g.add(f);
    switch (kind) {
        case 'plant': plant(f, rnd); g.add(aoDecal(1.0, 1.0)); break;
        case 'lamp': { lamp(f); g.add(lightPool(0.9)); const l = lampLight(); l.position.set(0.05, 1.3, 0.12); g.add(l); break; } // beauty r3 (1): the lamp emits
        case 'crystal': crystal(f, rnd); g.add(aoDecal(1.1, 1.0)); break;
        case 'sofa': sofa(f); g.add(aoDecal(2.8, 1.4)); break;
        case 'bookshelf': bookshelf(f, rnd); g.add(aoDecal(2.0, 0.8)); break;
        case 'whiteboard': whiteboard(f, rnd, note); g.add(aoDecal(2.2, 0.8)); break; // promise:share: a labelled board shows its note
        case 'rug': rug(f); break;
        case 'window': windowPane(f, jungle); break;
    }
    g.userData.decorKind = kind; g.name = 'omo-decor-look';
    return g;
}

function plant(g: THREE.Group, rnd: () => number): void {
    rod(g, 0.26, 0.48, [0, 0.24, 0], 'ceramic', 0.2, 20);
    rod(g, 0.24, 0.02, [0, 0.47, 0], 'soil', 0.24, 20).castShadow = false;
    const leaves: Array<'foliage' | 'foliage.light' | 'foliage.dark'> = ['foliage', 'foliage.light', 'foliage.dark'];
    for (let i = 0; i < 11; i++) {
        const a = i / 11 * Math.PI * 2 + rnd() * 0.3, tilt = 0.35 + rnd() * 0.45, h = 0.6 + rnd() * 0.5;
        const leaf = new THREE.SphereGeometry(0.11, 8, 6); leaf.scale(0.7, h / 0.22, 0.25);
        const blade = part(g, leaf, leaves[i % 3], [Math.sin(a) * (0.08 + h * 0.22), 0.5 + h / 2 * Math.cos(tilt), Math.cos(a) * (0.08 + h * 0.22)]);
        blade.rotation.set(Math.cos(a) * tilt, a, -Math.sin(a) * tilt);
    }
}

function lamp(g: THREE.Group): void {
    rod(g, 0.18, 0.03, [0, 0.015, 0], 'metal.brass', 0.2, 24);
    rod(g, 0.016, 1.45, [0, 0.74, 0], 'metal.brass', 0.016, 10);
    const shade = part(g, new THREE.CylinderGeometry(0.2, 0.26, 0.34, 28, 1, true), 'fabric.linen', [0, 1.55, 0]);
    shade.userData.part = 'lamp-shade';
    part(g, new THREE.SphereGeometry(0.06, 12, 8), 'emissive.warm', [0, 1.48, 0], false);
}

function crystal(g: THREE.Group, rnd: () => number): void {
    // A geode on a walnut plinth: a stone base and a cluster of glassy shards.
    slab(g, [0.62, 0.36, 0.62], [0, 0.18, 0], 'wood.dark');
    slab(g, [0.66, 0.025, 0.66], [0, 0.37, 0], 'metal.brass', false);
    const rock = part(g, new THREE.DodecahedronGeometry(0.24, 1), 'stone.dark', [0, 0.46, 0]); rock.scale.set(1, 0.45, 0.9);
    const shard = (x: number, z: number, h: number, lean: number, turn: number): void => {
        const s = part(g, new THREE.OctahedronGeometry(0.09, 0), 'crystal', [x, 0.5 + h / 2, z]);
        s.scale.set(0.7, h / 0.18, 0.7); s.rotation.set(Math.cos(turn) * lean, turn, Math.sin(turn) * lean);
    };
    shard(0, 0, 0.55, 0, 0);
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2 + rnd(); shard(Math.sin(a) * 0.1, Math.cos(a) * 0.09, 0.2 + rnd() * 0.2, 0.35 + rnd() * 0.2, a); }
}

function sofa(g: THREE.Group): void {
    for (const x of [-1.0, 1.0]) for (const z of [-0.36, 0.36]) rod(g, 0.025, 0.12, [x, 0.06, z], 'metal.brass', 0.018, 8);
    slab(g, [2.3, 0.24, 0.95], [0, 0.24, 0], 'fabric');
    for (const x of [-0.56, 0.56]) slab(g, [1.08, 0.16, 0.74], [x, 0.44, 0.08], 'fabric.linen');
    slab(g, [2.3, 0.54, 0.22], [0, 0.63, -0.37], 'fabric');
    for (const x of [-1.2, 1.2]) slab(g, [0.18, 0.46, 0.95], [x, 0.47, 0], 'fabric');
    const pillow = slab(g, [0.4, 0.34, 0.12], [0.82, 0.66, -0.16], 'fabric.accent'); pillow.rotation.set(-0.2, -0.3, 0.12);
}

function bookshelf(g: THREE.Group, rnd: () => number): void {
    const W = 1.5, H = 2.0, D = 0.38;
    for (const x of [-W / 2, W / 2]) slab(g, [0.035, H, D], [x, H / 2, 0], 'metal.graphite');
    const spines: Array<'fabric.accent' | 'fabric.sage' | 'fabric.linen' | 'leather' | 'fabric'> = ['fabric.accent', 'fabric.sage', 'fabric.linen', 'leather', 'fabric'];
    for (let s = 0; s < 5; s++) {
        const y = 0.08 + s * 0.46;
        slab(g, [W, 0.03, D], [0, y, 0], 'wood');
        if (s === 4) break;
        let x = -W / 2 + 0.08;
        while (x < W / 2 - 0.2) {
            const w = 0.035 + rnd() * 0.04, h = 0.24 + rnd() * 0.12;
            if (rnd() < 0.18) { x += 0.14; continue; }
            slab(g, [w, h, 0.24], [x + w / 2, y + 0.015 + h / 2, 0.02], spines[Math.floor(rnd() * spines.length)]);
            x += w + 0.006;
        }
    }
}

function whiteboard(g: THREE.Group, rnd: () => number, note?: string): void {
    // An easel board: brass-capped graphite legs, a thin frame and a warm paper face.
    // beauty r2 (6): the posts stand on a base — a dark stone plinth with a brass edge joining both feet.
    slab(g, [2.02, 0.05, 0.6], [0, 0.025, 0], 'stone.dark');
    slab(g, [2.04, 0.012, 0.012], [0, 0.05, 0.3], 'metal.brass', false);
    for (const x of [-0.92, 0.92]) {
        slab(g, [0.04, 1.86, 0.04], [x, 0.98, 0], 'metal.graphite');
        slab(g, [0.1, 0.05, 0.4], [x, 0.075, 0], 'metal.graphite');
        slab(g, [0.05, 0.02, 0.05], [x, 1.91, 0], 'metal.brass', false);
    }
    slab(g, [1.86, 1.1, 0.04], [0, 1.3, 0], 'board.frame');
    // promise:onboarding (5): the writing surface has a real 2 cm thickness (a zero-thickness plane reads as a black line edge-on).
    const map = note ? paintNote(note) : undefined;
    const board = mesh(g, new THREE.BoxGeometry(1.76, 1.0, 0.02), map ? lookPaper(map) : look('board'), [0, 1.3, 0.03], false);
    board.receiveShadow = true;
    slab(g, [1.2, 0.025, 0.07], [0, 0.78, 0.05], 'metal.brass');
    if (map) { board.userData.note = note; board.userData.ownsMap = true; return; }
    // A few marker strokes: a box diagram and two lines of "writing".
    const stroke = (w: number, h: number, x: number, y: number, ink: 'accent' | 'cool' | 'dark'): void => { mesh(g, new THREE.BoxGeometry(w, h, 0.002), lookInk(ink), [x, y, 0.041], false).userData.part = 'stroke'; };
    stroke(0.42, 0.012, -0.45, 1.6, 'cool'); stroke(0.42, 0.012, -0.45, 1.36, 'cool'); stroke(0.012, 0.24, -0.66, 1.48, 'cool'); stroke(0.012, 0.24, -0.24, 1.48, 'cool');
    stroke(0.28, 0.012, 0.0, 1.48, 'accent');
    stroke(0.42, 0.012, 0.38, 1.6, 'cool'); stroke(0.42, 0.012, 0.38, 1.36, 'cool'); stroke(0.012, 0.24, 0.17, 1.48, 'cool'); stroke(0.012, 0.24, 0.59, 1.48, 'cool');
    for (let i = 0; i < 3; i++) stroke(0.5 + rnd() * 0.7, 0.01, -0.15 + rnd() * 0.2, 1.1 - i * 0.12, 'dark');
}

function rug(g: THREE.Group): void {
    // A woven rug: soft rounded rectangle, 1 cm proud of the floor.
    const shape = new THREE.Shape(), w = 1.3, d = 0.9, r = 0.12;
    shape.moveTo(-w + r, -d); shape.lineTo(w - r, -d); shape.quadraticCurveTo(w, -d, w, -d + r); shape.lineTo(w, d - r); shape.quadraticCurveTo(w, d, w - r, d);
    shape.lineTo(-w + r, d); shape.quadraticCurveTo(-w, d, -w, d - r); shape.lineTo(-w, -d + r); shape.quadraticCurveTo(-w, -d, -w + r, -d);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false, curveSegments: 4 });
    geo.rotateX(-Math.PI / 2);
    const uv = geo.getAttribute('uv'), pos = geo.getAttribute('position');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + w) / (2 * w), (pos.getZ(i) + d) / (2 * d));
    const m = mesh(g, geo, look('rug'), [0, 0.002, 0], false); m.receiveShadow = true; m.userData.part = 'rug';
}

function windowPane(g: THREE.Group, jungle: boolean): void {
    const W = 2.0, H = 1.5, y = 1.85;
    const map = paintWindowView(jungle);
    const view = mesh(g, new THREE.PlaneGeometry(W, H), lookPlate(map), [0, y, 0.0], false);
    view.userData.ownsMap = true;
    mesh(g, new THREE.PlaneGeometry(W, H), look('glass'), [0, y, 0.02], false).raycast = () => undefined;
    slab(g, [W + 0.12, 0.06, 0.08], [0, y + H / 2 + 0.03, 0.02], 'metal.graphite');
    slab(g, [W + 0.12, 0.06, 0.08], [0, y - H / 2 - 0.03, 0.02], 'metal.graphite');
    for (const x of [-W / 2 - 0.03, W / 2 + 0.03]) slab(g, [0.06, H + 0.12, 0.08], [x, y, 0.02], 'metal.graphite');
    slab(g, [0.03, H, 0.05], [0, y, 0.03], 'metal.graphite');
    slab(g, [W + 0.3, 0.04, 0.2], [0, y - H / 2 - 0.08, 0.1], 'wood.dark');
}
