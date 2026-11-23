/**
 * foundation:v3 — the WORLD COMPILER (milestone 2). A deterministic TypeScript port of the World Director lab's layout
 * grammar and prop solver (omo-sky-lab/world-director/director/layout.py + solver.py, grammar v2 "vista enfilade"):
 *
 *   spec (rooms with purpose / size / desks, links, site)  +  KitPack (asset-catalogue.ts)   ->   WorldOps
 *
 *   - layout: rooms side by side west -> east in link order (BFS from the entry), north edges on one line (the vista
 *     front, full-height glass), walls on a 0.5 m grid, doors on the shared walls at the circulation line, the
 *     entrance in the first room's south wall; reserved zones (door clearance, circulation band, glass viewpoint);
 *   - solver: kit zone recipes ('wall:shelf', 'nook:reading', 'center:table', 'corner:plant', 'desks:desk' ...)
 *     placed as oriented rectangles that never overlap each other, a reserved zone or the room walls;
 *   - world mode adds what the IDE needs: ONE station per requested desk (the station draws its own desk and
 *     chair, so no desk model is placed under it), ONE web wall per main room on a solid wall facing the seating,
 *     `purpose` on every room and `module` where a room module fits (common/room-modules.ts).
 *
 * Same spec + same pack + same seed = identical ops (seeded PRNG, no Date / Math.random, stable sorts).
 * Parity mode (`mode: 'lab'`) runs the lab's own recipes (desks as kit models, max 2) for the parity test.
 *
 * Coordinates: the solver works in lab (Blender) metres, x east, y north (the glass / vista), z up. The world gets
 * Omo room space, the standard Blender -> glTF axes: x = lab x, z = -lab y, y up, centred on the building. A prop's
 * transform.rotation is the lab yaw: the three.js rotation.y of a model whose front is glTF +z (Poly Haven -Y).
 *
 * Not ported (rendering only): glass mullions, the exterior (deck, garden, landmark, exterior props), the camera tour.
 */
import type { AssetEntry, KitPack } from './asset-catalogue';
import { fnv1a } from './asset-catalogue';
import type { PropEntity, RoomEntity, Site, SiteTime, SiteVista, SiteWeather, StationEntity, WallSide, WebWallEntity, WorldEntity, WorldOp, WorldResult, WorldSpec } from './world-model';
import { ASSET_ID_RE, PURPOSE_RE, SITE_TIMES, SITE_VISTAS, SITE_WEATHERS, WORLD_ID_RE, WORLD_MAX_ENTITIES, WORLD_VERSION, applyWorldOps, defaultStation } from './world-model';
import type { RoomModuleId } from './room-modules';
import { MODULES, MODULE_DEPTH, MODULE_WIDTH, MODULE_WORDS, SCREEN_CENTRE_Y, groundFor } from './room-modules';

// ------------------------------------------------------------------------------------------------ spec
export type RoomSize = 'S' | 'M' | 'L';
export interface CompileRoom {
    id: string;
    purpose: string;
    size?: RoomSize;
    /** Explicit size in metres (overrides `size`). */
    width?: number;
    depth?: number;
    desks?: number;
    name?: string;
    /** Explicit solver recipe (else the kit's zones for the purpose). */
    recipe?: string[];
}
export interface CompileSpec {
    prompt?: string;
    name?: string;
    kit?: string;
    time?: string;
    weather?: string;
    vista?: string;
    seed?: number;
    rooms: CompileRoom[];
    links?: Array<[string, string]>;
    hero?: string[];
}
export interface CompileOptions {
    /** 'world' (default): stations, web walls, modules. 'lab': the lab's own solver output (parity). */
    mode?: 'world' | 'lab';
    /** Room modules: 'fit' (default) = only rooms already the module footprint; 'snap' = size module rooms to it; 'off'. */
    modules?: 'fit' | 'snap' | 'off';
}

// ------------------------------------------------------------------------------------------------ constants (layout.py)
export const SIZES: Readonly<Record<RoomSize, [number, number]>> = { S: [6.0, 5.0], M: [7.5, 6.0], L: [9.0, 7.0] };
const DOOR_W = 1.1, DOOR_H = 2.3;
const CIRC_IN = 2.7, CIRC_W = 1.2;
export const MAX_ROOMS = 4;
/** Omo station footprint (world-scene-collision.ts entityRect 'station': desk, chair and the space between). */
const STATION_W = 3.6, STATION_D = 2.1;
/** A station on a room module's desk anchor (the baked bench is the desk). */
const ANCHOR_SIZE = 1.0;
/** Widest a room grows to seat its desks (metres). */
const GROW_MAX = 30;
/** world-scene-collision.ts entityRect('station'): front -1.1, back 0.98 -> the rectangle centre is 0.06 m in front of the transform. */
const STATION_CENTRE_SHIFT = (1.1 - 0.98) / 2;
const MINOR_PURPOSES = new Set(['entry', 'entrance', 'storage', 'hall', 'corridor', 'bath', 'bathroom']);
const DEFAULT_SEED = 7;

// ------------------------------------------------------------------------------------------------ plan types (lab coords)
export type LabRect = [number, number, number, number];
export interface WallSegment { side: 'S' | 'W' | 'E'; axis: 'x' | 'y'; at: number; a: number; b: number; normal: [number, number] }
export interface PlanDoor { id: string; rooms: [string, string | null]; pos: [number, number]; axis: 'x' | 'y'; w: number; h: number; kind: 'interior' | 'entrance' }
export interface PlanRoom {
    id: string; purpose: string; name: string; size: RoomSize; desks: number; rect: LabRect; h: number;
    glass_sides: string[]; glass: 'N'; inner: LabRect; wall_segments: WallSegment[];
    reserved: Array<{ rect: LabRect; why: string }>; focal: [number, number]; center_target: [number, number];
    recipe?: string[]; module?: RoomModuleId;
}
export interface Placement {
    id: string; room: string; pos: [number, number, number]; rot: number; footprint: [number, number]; height: number;
    zone: string; tag: string; on?: string; collide: boolean; module?: [number, number]; station?: boolean;
}
export interface Plan { grammar: 'vista_enfilade'; kit: string; north: number; circulation_y: number; bounds: LabRect; wall_t: number; ceiling: number; rooms: PlanRoom[]; doors: PlanDoor[] }

// ------------------------------------------------------------------------------------------------ helpers
/** Python round(): half to even (layout.py snap / solver round(L / 1.0)). */
export function pyRound(x: number): number {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
}
const r3 = (v: number): number => { const r = Math.round(v * 1000) / 1000; return r === 0 ? 0 : r; };
const r4 = (v: number): number => { const r = Math.round(v * 10000) / 10000; return r === 0 ? 0 : r; };
const snap = (v: number, g = 0.5): number => pyRound(v / g) * g;
/** mulberry32: a small seeded PRNG with Python-random-like helpers (deterministic across runs and machines). */
export class Rng {
    private s: number;
    constructor(seed: number) { this.s = seed >>> 0; }
    random(): number {
        let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    uniform(a: number, b: number): number { return a + (b - a) * this.random(); }
    below(n: number): number { return Math.floor(this.random() * n); }
    choice<T>(xs: readonly T[]): T { return xs[this.below(xs.length)]; }
    shuffle<T>(xs: T[]): void { for (let i = xs.length - 1; i > 0; i--) { const j = this.below(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]]; } }
}

// ------------------------------------------------------------------------------------------------ geometry (solver.py)
type Pt = [number, number];
type Poly = Pt[];
export function obb(cx: number, cy: number, w: number, d: number, rot: number): Poly {
    const c = Math.cos(rot), s = Math.sin(rot), out: Poly = [];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = sx * w / 2, ly = sy * d / 2;
        out.push([cx + lx * c - ly * s, cy + lx * s + ly * c]);
    }
    return out;
}
const rectPts = (r: LabRect): Poly => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
function axes(p: Poly): Pt[] {
    const out: Pt[] = [];
    for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length], ex = b[0] - a[0], ey = b[1] - a[1], n = Math.hypot(ex, ey) || 1;
        out.push([-ey / n, ex / n]);
    }
    return out;
}
/** Separating axis test for two convex polygons (touching = not overlapping). */
export function overlap(p: Poly, q: Poly, eps = 1e-4): boolean {
    for (const ax of [...axes(p), ...axes(q)]) {
        const pa = p.map(([x, y]) => x * ax[0] + y * ax[1]), qa = q.map(([x, y]) => x * ax[0] + y * ax[1]);
        if (Math.max(...pa) <= Math.min(...qa) + eps || Math.max(...qa) <= Math.min(...pa) + eps) return false;
    }
    return true;
}
const inside = (p: Poly, r: LabRect, eps = 1e-3): boolean => p.every(([x, y]) => r[0] - eps <= x && x <= r[2] + eps && r[1] - eps <= y && y <= r[3] + eps);
/** Yaw that points the model front (-Y) toward direction (dx, dy). */
export const yawFacing = (dx: number, dy: number): number => Math.atan2(dx, -dy);
const sorted2 = (r: LabRect): LabRect => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

// ------------------------------------------------------------------------------------------------ kit view for the solver
/** A catalogue entry seen the way the lab solver reads kit props. */
interface KProp { id: string; tags: string[]; zone?: string; footprint: [number, number]; height: number; place: string; on?: string; mount_z?: number; exterior: boolean; procedural?: string; light: boolean; count?: [number, number] }
function kprop(a: AssetEntry): KProp {
    return {
        id: a.id, tags: a.tags ?? [], zone: a.zone, footprint: [a.size.x, a.size.z], height: a.size.y,
        place: a.placement === 'wall' ? 'wall_mount' : a.placement, on: a.on, mount_z: a.mountY, exterior: !!a.exterior,
        procedural: a.procedural, light: !!a.emits, count: a.count
    };
}

const ALIAS: Record<string, string[]> = {
    coffee_table: ['coffee_table', 'coffee'], side_table: ['side_table', 'side'], table_lamp: ['table_lamp', 'lamp', 'lantern'],
    tabletop: ['tabletop', 'desk_dressing', 'dressing'], armchair: ['armchair'], chair: ['chair', 'desk_chair', 'dining', 'stool'],
    seat: ['seat', 'stool', 'chair'], tea: ['tea'], low_table: ['low_table'], extinguisher: ['extinguisher', 'safety'],
    bin: ['bin', 'crate'], tokonoma: ['tokonoma', 'console'], tansu: ['tansu', 'cabinet']
};
const EXCL: Record<string, string[]> = {
    reading: ['footrest'], table_lamp: ['pendant', 'sconce', 'task', 'hanging'], table: ['coffee', 'side', 'console', 'tokonoma'], side_table: ['cabinet'],
    shelf: ['small'], seat: ['footrest'], chair: ['lounge'], plant: ['garden']
};
const NEED_PLACE: Record<string, string> = {
    table_lamp: 'surface', tabletop: 'surface', shelf: 'floor', cabinet: 'floor', seat: 'floor', reading: 'floor', chair: 'floor', table: 'floor',
    desk: 'floor', plant: 'floor', lantern: 'floor', tea: 'floor', low_table: 'floor', screen: 'floor', tokonoma: 'floor', console: 'floor',
    tansu: 'floor', sofa: 'floor', floor_vase: 'floor', bin: 'floor'
};
export const DEFAULT_ZONES: Readonly<Record<string, string[]>> = {
    entry: ['wall:cabinet', 'wall:clock', 'corner:plant', 'wall:art'],
    library: ['wall:shelf', 'nook:reading', 'center:table', 'corner:plant'],
    lounge: ['center:sofa', 'wall:cabinet', 'nook:reading', 'corner:plant', 'wall:art'],
    studio: ['desks:desk', 'wall:shelf', 'corner:plant'],
    gallery: ['wall:art', 'center:sofa', 'corner:plant'],
    tea_room: ['center:tea', 'nook:screen', 'wall:tokonoma', 'corner:lantern', 'center:pendant']
};
const ZONE_ALIAS: Record<string, string[]> = {
    entry: ['entry', 'entrance', 'storage'], library: ['library'], lounge: ['lounge'], studio: ['lab', 'control', 'studio'],
    gallery: ['gallery', 'observatory'], tea_room: ['tea_room']
};
const ZONE_ORDER: Record<string, number> = { center: 0, desks: 0, wall: 1, nook: 2, window: 2, corner: 3, art: 4 };

// ------------------------------------------------------------------------------------------------ the room solver (solver.py Room)
class RoomSolver {
    readonly inner: LabRect;
    readonly blocked: Array<[Poly, string]> = [];
    readonly placed: Placement[] = [];
    readonly polys: Array<[Poly, string]> = [];
    readonly props: Map<string, KProp>;
    centerPt: [number, number, number] | undefined;
    stations: Placement[] = [];

    constructor(readonly r: PlanRoom, readonly kit: KProp[], readonly hero: string[], readonly rng: Rng, readonly mode: 'world' | 'lab') {
        this.inner = r.inner;
        for (const b of r.reserved) this.blocked.push([rectPts(b.rect), b.why]);
        this.props = new Map(kit.map(p => [p.id, p]));
    }

    free(poly: Poly, ignoreReserved = false): boolean {
        if (!inside(poly, this.inner)) return false;
        if (!ignoreReserved) for (const [q] of this.blocked) if (overlap(poly, q)) return false;
        for (const [q] of this.polys) if (overlap(poly, q)) return false;
        return true;
    }
    add(pid: string, x: number, y: number, rot: number, zone: string, tag: string, o: { z?: number; w?: number; d?: number; on?: string; module?: [number, number]; collide?: boolean } = {}): Placement {
        const p = this.props.get(pid);
        const [fw, fd] = o.w !== undefined ? [o.w, o.d!] : (p?.footprint ?? [0.5, 0.5]);
        const collide = o.collide ?? true;
        const rec: Placement = { id: pid, room: this.r.id, pos: [r3(x), r3(y), r3(o.z ?? 0)], rot: r4(rot), footprint: [r3(fw), r3(fd)], height: p?.height ?? 0.5, zone, tag, collide };
        if (o.on) rec.on = o.on;
        if (o.module) rec.module = o.module;
        this.placed.push(rec);
        if (collide) this.polys.push([obb(x, y, fw, fd, rot), pid]);
        return rec;
    }
    tryAdd(pid: string, x: number, y: number, rot: number, zone: string, tag: string, o: { pad?: number; w?: number; d?: number; z?: number; on?: string; ignoreReserved?: boolean } = {}): Placement | undefined {
        const p = this.props.get(pid);
        if (!p) return undefined;
        const fw = o.w || p.footprint[0], fd = o.d || p.footprint[1], pad = o.pad ?? 0;
        if (!this.free(obb(x, y, fw + pad, fd + pad, rot), o.ignoreReserved ?? false)) return undefined;
        return this.add(pid, x, y, rot, zone, tag, { w: fw, d: fd, z: o.z, on: o.on });
    }
    pick(tag: string, zone?: string, prefer?: string[]): KProp[] {
        const tags = ALIAS[tag] ?? [tag], excl = EXCL[tag] ?? [], need = NEED_PLACE[tag];
        const ok = (p: KProp): boolean => p.tags.some(t => tags.includes(t)) && !p.tags.some(t => excl.includes(t)) && (need === undefined || p.place === need) && !p.exterior;
        let c = this.kit.filter(p => ok(p) && (zone === undefined || p.zone === zone));
        if (!c.length) c = this.kit.filter(ok);
        if (prefer) c = c.map((p, i) => ({ p, i })).sort((a, b) => {
            const ka = prefer.includes(a.p.id) ? 0 : 1, kb = prefer.includes(b.p.id) ? 0 : 1;
            if (ka !== kb) return ka - kb;
            const ia = prefer.includes(a.p.id) ? prefer.indexOf(a.p.id) : 0, ib = prefer.includes(b.p.id) ? prefer.indexOf(b.p.id) : 0;
            return ia - ib || a.i - b.i;
        }).map(x => x.p);
        return c;
    }
    private first(...lists: KProp[][]): KProp | undefined { for (const l of lists) if (l.length) return l[0]; return undefined; }

    dress(parent: Placement, kinds: string[], nMax = 3, exclude: string[] = []): number {
        const pdef = this.props.get(parent.id);
        const ptags = new Set([...(pdef?.tags ?? []), parent.tag]);
        const [fw, fd] = parent.footprint, top = pdef?.height || 0.75;
        let items: KProp[] = [];
        for (const p of this.kit) {
            if (p.place !== 'surface' || p.exterior || exclude.includes(p.id)) continue;
            if (p.on && ptags.has(p.on)) { items.push(p); continue; }
            if (!p.on && p.tags.some(t => kinds.includes(t))) items.push(p);
        }
        if (!items.length) return 0;
        this.rng.shuffle(items);
        const lampFirst = kinds.includes('lamp');
        items = items.map((p, i) => ({ p, i })).sort((a, b) => (Number(lampFirst && b.p.light) - Number(lampFirst && a.p.light)) || a.i - b.i).map(x => x.p);
        const used: string[] = [];
        let n = 0;
        const c = Math.cos(parent.rot), s = Math.sin(parent.rot);
        const slots: Pt[] = [[-0.32, 0.05], [0.3, -0.05], [0.02, 0.12], [-0.1, -0.15], [0.38, 0.15]];
        for (const p of items) {
            if (n >= nMax) break;
            if (used.includes(p.id) && items.length > nMax) continue;
            const [w, d] = p.footprint;
            if (w > fw * 0.9 || d > fd * 0.95) continue;
            let [lx, ly] = slots[n % slots.length];
            lx *= Math.max(0, fw - w) / Math.max(fw, 1e-3) * 1.6; ly *= Math.max(0, fd - d) / Math.max(fd, 1e-3) * 1.6;
            const x = parent.pos[0] + lx * c - ly * s, y = parent.pos[1] + lx * s + ly * c;
            this.add(p.id, x, y, parent.rot + this.rng.uniform(-0.25, 0.25), parent.zone, 'dressing', { z: parent.pos[2] + top, on: parent.id, collide: false });
            used.push(p.id); n++;
        }
        return n;
    }

    tableGroup(tag: string): number {
        const t = this.first(this.pick(tag, 'center'), this.pick('table', 'center'));
        if (!t) return 0;
        let ch = this.first(this.pick('chair', 'center'), this.pick('seat'));
        const [fw, fd] = t.footprint, r = Math.max(fw, fd) / 2, cd = ch ? ch.footprint[1] : 0, grp = 2 * (r + cd + 0.1);
        let spot = this.bestSpot(grp, grp, this.r.center_target);
        if (!spot) {
            spot = this.bestSpot(fw + 0.2, fd + 0.2, this.r.center_target);
            if (!spot) return 0;
            ch = undefined;
        }
        const [, cx, cy] = spot;
        const rec = this.add(t.id, cx, cy, 0, 'center', tag);
        let n = 1;
        if (ch) {
            const kN = (t.height || 0.7) < 0.55 || fw > 1.6 ? 2 : 4;
            for (let k = 0; k < kN; k++) {
                const a = (kN === 2 ? 0 : Math.PI / 4) + k * (2 * Math.PI / kN), dist = r + ch.footprint[1] / 2 + 0.02;
                const px = cx + Math.cos(a) * dist, py = cy + Math.sin(a) * dist;
                if (this.tryAdd(ch.id, px, py, yawFacing(cx - px, cy - py), 'center', 'chair')) n++;
            }
        }
        this.dress(rec, ['tabletop', 'tea', 'dishes', 'desk_dressing', 'dressing', 'books', 'lamp'], fw < 1.2 ? 3 : 5);
        this.centerPt = [cx, cy, t.height];
        this.rug(cx, cy, grp + 0.5, grp + 0.3, 0);
        return n;
    }

    wall(tag: string): number {
        let cands = this.pick(tag, 'wall');
        if (!cands.length) return 0;
        const floorC = cands.filter(p => p.place === 'floor');
        if (!floorC.length) return this.art(tag);
        cands = floorC;
        let n = 0;
        const segs = this.r.wall_segments.map((s, i) => ({ s, i })).sort((a, b) => -(a.s.b - a.s.a) + (b.s.b - b.s.a) || a.i - b.i).map(x => x.s);
        const models = cands.filter(p => !p.procedural);
        for (let si = 0; si < segs.length; si++) {
            let seg = segs[si];
            const lib = this.r.purpose === 'library' && (seg.b - seg.a) >= 1.2 && si < 2;
            let segC = cands.filter(p => !p.procedural || lib || !models.length);
            if (lib) segC = segC.map((p, i) => ({ p, i })).sort((a, b) => (Number(!a.p.procedural) - Number(!b.p.procedural)) || a.i - b.i).map(x => x.p);
            let L = seg.b - seg.a;
            const glEnd = seg.axis === 'y' && seg.b >= this.inner[3] - 0.01;
            if (glEnd) { seg = { ...seg, b: seg.b - 0.75 }; L -= 0.75; }
            if (L < 0.6) continue;
            for (const p of segC) {
                const [fw, fd] = p.footprint;
                if (p.procedural === 'bookcase') {
                    const k = Math.max(1, pyRound(L / 1.0)), mw = L / k;
                    if (mw < 0.6) continue;
                    const ok: Array<[number, number, number] | false> = [];
                    for (let i = 0; i < k; i++) {
                        const a = seg.a + (i + 0.5) * mw, [x, y, rot] = this.onWall(seg, a, fd);
                        ok.push(this.free(obb(x, y, mw - 0.004, fd, rot)) && [x, y, rot]);
                    }
                    let best: Array<[number, [number, number, number]]> = [], cur: Array<[number, [number, number, number]]> = [];
                    ok.forEach((v, i) => { if (v) cur.push([i, v]); else { if (cur.length > best.length) best = cur; cur = []; } });
                    if (cur.length > best.length) best = cur;
                    if (best.length >= 1) {
                        best.forEach(([, [x, y, rot]], j) => { this.add(p.id, x, y, rot, 'wall', tag, { w: mw - 0.004, d: fd, module: [j, best.length] }); n++; });
                        break;
                    }
                    continue;
                }
                if (fw > L - 0.1) continue;
                const cntMax = (p.count ?? [1, 1])[1] - this.placed.filter(q => q.id === p.id).length;
                const k = Math.min(cntMax, Math.floor((L + 0.3) / (fw + 0.3)));
                if (k <= 0) continue;
                const gap = (L - k * fw) / (k + 1);
                let here = 0;
                for (let i = 0; i < k; i++) {
                    const a = seg.a + gap * (i + 1) + fw * (i + 0.5), [x, y, rot] = this.onWall(seg, a, fd);
                    const rec = this.tryAdd(p.id, x, y, rot, 'wall', tag);
                    if (rec) {
                        n++; here++;
                        if ((p.height || 2) < 1.3) this.dress(rec, ['vase', 'tabletop', 'ikebana', 'candle', 'books', 'decor', 'lamp', 'shelf_item'], 3);
                        else if (p.tags.includes('shelf') || p.tags.includes('rack')) this.dress(rec, ['shelf_item'], 2);
                    }
                }
                if (here) break;
            }
        }
        return n;
    }
    onWall(seg: WallSegment, a: number, depth: number, gap = 0.01): [number, number, number] {
        const [nx, ny] = seg.normal;
        return seg.axis === 'x' ? [a, seg.at + ny * (depth / 2 + gap), yawFacing(nx, ny)] : [seg.at + nx * (depth / 2 + gap), a, yawFacing(nx, ny)];
    }

    nook(tag: string): number {
        if (tag === 'screen') return this.screen(tag);
        if (tag === 'low_table' || tag === 'lamp') return 0;
        let seats = this.pick('reading', 'nook', ['mid_century_lounge_chair', 'modern_arm_chair_01']);
        if (!seats.length) seats = this.pick('seat', 'nook');
        if (!seats.length) seats = this.pick('seat');
        if (!seats.length) return 0;
        const [fx, fy] = this.r.focal, [x0, y0, x1, y1] = this.inner, g = this.r.glass;
        let n = 0;
        const spots: Pt[] = [];
        for (const fr of [0.22, 0.78, 0.36, 0.64, 0.12, 0.88]) for (const inset of [1.25, 1.6, 2.0]) spots.push([x0 + fr * (x1 - x0), (g as string) === 'S' ? y0 + inset : y1 - inset]);
        const used = new Set<string>();
        for (const [sx, sy] of spots) {
            const side = sx < (x0 + x1) / 2 ? 'L' : 'R';
            if (used.has(side)) continue;
            const seat = seats[used.size % seats.length];
            const rot = yawFacing(fx - sx, fy - sy);
            if (!this.tryAdd(seat.id, sx, sy, rot, 'nook', tag, { pad: 0.1 })) continue;
            used.add(side); n++;
            const st = this.first(this.pick('side_table'), this.pick('low_table', 'nook'));
            const sdir = side === 'L' ? -1 : 1;
            if (st) {
                const c = Math.cos(rot), s = Math.sin(rot), off = seat.footprint[0] / 2 + st.footprint[0] / 2 + 0.08;
                let tx = sx + c * off * (-sdir), ty = sy + s * off * (-sdir);
                let trec = this.tryAdd(st.id, tx, ty, rot, 'nook', 'side_table');
                if (!trec) { tx = sx + c * off * sdir; ty = sy + s * off * sdir; trec = this.tryAdd(st.id, tx, ty, rot, 'nook', 'side_table'); }
                const lamp = this.pick('table_lamp').find(p => p.light);
                if (trec && lamp && lamp.footprint[0] < st.footprint[0] * 1.2) this.add(lamp.id, tx, ty, rot + Math.PI * 0.85, 'nook', 'table_lamp', { z: st.height, on: st.id, collide: false });
                else if (trec) this.dress(trec, ['tabletop', 'books', 'dressing', 'vase'], 1);
            }
            const ot = this.first(this.pick('footrest'));
            if (ot) {
                const fdx = Math.sin(rot), fdy = -Math.cos(rot), dd = seat.footprint[1] / 2 + ot.footprint[1] / 2 + 0.12;
                this.tryAdd(ot.id, sx + fdx * dd, sy + fdy * dd, rot, 'nook', 'footrest');
            }
            this.rug(sx + Math.sin(rot) * 0.4, sy - Math.cos(rot) * 0.4, 2.2, 1.7, rot);
            if (used.size === ((x1 - x0) > 6.5 ? 2 : 1)) break;
        }
        return n;
    }
    screen(tag: string): number {
        const p = this.first(this.pick('screen', 'nook'), this.pick('screen'));
        if (!p) return 0;
        const [x0, y0, x1] = this.inner, [fw, fd] = p.footprint;
        for (const [cx, cy, face] of [[x0, y0, [1, 0.6]], [x1, y0, [-1, 0.6]]] as Array<[number, number, Pt]>) {
            const px = cx + (fw / 2 + 0.25) * (cx === x0 ? 1 : -1), py = cy + fd / 2 + 0.35;
            if (this.tryAdd(p.id, px, py, yawFacing(face[0], face[1]), 'nook', tag)) return 1;
        }
        return 0;
    }
    rug(x: number, y: number, w: number, d: number, rot: number): void {
        if (this.placed.some(q => q.tag === 'rug' && Math.hypot(q.pos[0] - x, q.pos[1] - y) < 1.5)) return;
        const km = this.kit.find(p => p.tags.includes('rug') && !p.procedural);
        if (km) {
            const [kw, kd] = km.footprint;
            if (w < kd * 1.15 && d < kw * 1.15 && w > d) rot = rot + Math.PI / 2;
            if (inside(obb(x, y, kw, kd, rot), this.inner)) { this.add(km.id, x, y, rot, 'floor', 'rug', { w: kw, d: kd, collide: false }); return; }
        }
        if (this.props.has('rug') && inside(obb(x, y, w, d, rot), this.inner)) this.add('rug', x, y, rot, 'floor', 'rug', { w, d, collide: false });
    }
    bestSpot(w: number, d: number, target?: [number, number], step = 0.2): [number, number, number] | undefined {
        const [x0, y0, x1, y1] = this.inner;
        const [tx, ty] = target ?? [(x0 + x1) / 2, (y0 + y1) / 2];
        let best: [number, number, number] | undefined;
        for (let x = x0 + w / 2; x <= x1 - w / 2 + 1e-6; x += step) {
            for (let y = y0 + d / 2; y <= y1 - d / 2 + 1e-6; y += step) {
                if (this.free(rectPts([x - w / 2, y - d / 2, x + w / 2, y + d / 2]))) {
                    const sc = Math.hypot(x - tx, y - ty);
                    if (!best || sc < best[0]) best = [sc, x, y];
                }
            }
        }
        return best;
    }

    center(tag: string): number {
        if (['seat', 'chair', 'stool', 'rug'].includes(tag)) return 0;
        const mapTable = this.pick('map_table');
        if (['tea', 'low_table', 'meeting'].includes(tag) || (['table', 'dining'].includes(tag) && !mapTable.length && this.pick(tag, 'center').length)) return this.tableGroup(tag);
        if (['table', 'dining'].includes(tag) && mapTable.length) {
            const t = mapTable[0], ch = this.first(this.pick('chair'));
            const [fw, fd] = t.footprint;
            const spot = this.bestSpot(fw + 0.4, fd + 2 * (ch ? ch.footprint[1] + 0.1 : 0.4), this.r.center_target);
            if (!spot) return 0;
            const [, cx, cy] = spot;
            this.add(t.id, cx, cy, 0, 'center', 'map_table');
            let n = 1;
            if (ch) for (const sd of [-1, 1]) for (const k of [-1, 1]) {
                const px = cx + k * fw * 0.25, py = cy + sd * (fd / 2 + ch.footprint[1] / 2 - 0.08);
                if (this.tryAdd(ch.id, px, py, yawFacing(0, -sd), 'center', 'chair')) n++;
            }
            const xs = [-0.8, -0.3, 0.25, 0.75, 0.0];
            this.pick('tabletop').slice(0, 5).forEach((b, i) => {
                this.add(b.id, cx + xs[i] * fw / 2.2, cy + (i % 2 ? 0.18 : -0.15), 0.3 + i * 0.9, 'center', 'tabletop', { z: t.height, on: t.id, collide: false });
            });
            this.centerPt = [cx, cy, t.height];
            this.rug(cx, cy, fw + 1.6, fd + 1.9, 0);
            return n;
        }
        if (tag === 'table' || tag === 'dining') {
            const t = this.first(this.pick('table', 'center', ['round_wooden_table_01', 'coffee_table_round_01', 'round_wooden_table_02']));
            const ch = this.first(this.pick('chair', undefined, ['dining_chair_02']));
            if (!t) return 0;
            const r = Math.max(...t.footprint) / 2, grp = 2 * (r + (ch ? ch.footprint[1] : 0) + 0.15);
            const spot = this.bestSpot(grp, grp, this.r.center_target);
            if (!spot) return 0;
            const [, cx, cy] = spot;
            this.add(t.id, cx, cy, 0, 'center', tag, { w: 2 * r, d: 2 * r });
            let n = 1;
            if (ch) for (let k = 0; k < 4; k++) {
                const a = Math.PI / 4 + k * Math.PI / 2, dist = r + ch.footprint[1] / 2 - 0.12;
                const px = cx + Math.cos(a) * dist, py = cy + Math.sin(a) * dist;
                if (this.tryAdd(ch.id, px, py, yawFacing(cx - px, cy - py), 'center', 'chair')) n++;
            }
            const top = this.pick('tabletop')[0];
            if (top) this.add(top.id, cx + 0.18, cy - 0.1, 0.4, 'center', 'tabletop', { z: t.height, on: t.id, collide: false });
            this.centerPt = [cx, cy, t.height];
            this.rug(cx, cy, grp + 0.4, grp + 0.4, 0);
            return n;
        }
        if (tag === 'lamp' || tag === 'pendant') {
            const pend = this.first(this.pick('pendant'));
            if (pend && !this.centerPt) { const [x0, y0, x1, y1] = this.inner; this.centerPt = [(x0 + x1) / 2, (y0 + y1) / 2 - 0.3, 0]; }
            const c = this.centerPt;
            if (!pend || !c) return 0;
            this.add(pend.id, c[0], c[1], 0, 'ceiling', 'pendant', { z: this.r.h - pend.height - 0.3, collide: false });
            return 1;
        }
        if (tag === 'coffee') return 0;
        if (tag === 'sofa' || tag === 'lounge') {
            const s = this.first(this.pick('sofa')), ct = this.first(this.pick('coffee_table')), ac = this.first(this.pick('armchair', undefined, ['modern_arm_chair_01']));
            if (!s) return 0;
            const gw = s.footprint[0] + 0.5, gd = s.footprint[1] + (ct ? ct.footprint[1] : 0) + 0.75;
            const spot = this.bestSpot(gw, gd, this.r.center_target);
            if (!spot) return 0;
            const [, cx, cy] = spot, [, fy] = this.r.focal;
            const face = fy > cy ? 1 : -1, rot = yawFacing(0, face), sy = cy - face * (gd / 2 - s.footprint[1] / 2);
            this.add(s.id, cx, sy, rot, 'center', 'sofa');
            let n = 1, ty = sy;
            if (ct) {
                ty = sy + face * (s.footprint[1] / 2 + 0.45 + ct.footprint[1] / 2);
                this.add(ct.id, cx, ty, rot, 'center', 'coffee_table'); n++;
                const top = this.pick('tabletop')[0];
                if (top) this.add(top.id, cx - 0.1, ty, rot + 0.3, 'center', 'tabletop', { z: ct.height, on: ct.id, collide: false });
                if (ac) for (const sd of [-1, 1]) {
                    const ax = cx + sd * (ct.footprint[0] / 2 + 0.55 + ac.footprint[1] / 2);
                    if (this.tryAdd(ac.id, ax, ty, yawFacing(cx - ax, 0), 'center', 'armchair')) n++;
                }
            }
            this.centerPt = [cx, (sy + ty) / 2, 0.5];
            this.rug(cx, (sy + ty) / 2, gw, gd, 0);
            return n;
        }
        return 0;
    }

    /** Lab desks: kit desk models along the glass (max 2), a chair each, dressing on top. */
    desks(tag: string, count: number): number {
        if (!['desk', 'table', 'workstation'].includes(tag)) return 0;
        const d = this.first(this.pick('desk', 'desks'), this.pick('desk'));
        if (!d || count <= 0) return 0;
        const ch = this.first(this.pick('stool', 'desks'), this.pick('chair', 'desks'));
        const [x0, , x1, y1] = this.inner, [fw, fd] = d.footprint;
        const cands: Array<[number, number, number]> = [];
        for (let x = x0 + 0.35 + fw / 2; x <= x1 - 0.35 - fw / 2 + 1e-6; x += 0.25) cands.push([x, y1 - 0.3 - fd / 2, 0]);
        const mid = (x0 + x1) / 2;
        const sortedC = cands.map((c, i) => ({ c, i })).sort((a, b) => (Math.abs(Math.abs(a.c[0] - mid) - (fw / 2 + 1.4)) - Math.abs(Math.abs(b.c[0] - mid) - (fw / 2 + 1.4))) || a.i - b.i).map(x => x.c);
        let n = 0;
        for (const [x, y, rot] of sortedC) {
            if (n >= Math.min(count, 2)) break;
            const rec = this.tryAdd(d.id, x, y, rot, 'desks', 'desk', { pad: 0.3 });
            if (!rec) continue;
            n++;
            if (ch) { const jx = this.rng.uniform(-0.2, 0.2), jr = this.rng.uniform(-0.3, 0.3); this.tryAdd(ch.id, x + jx, y - fd / 2 - ch.footprint[1] / 2 + 0.05, Math.PI + jr, 'desks', 'chair'); }
            this.dress(rec, ['tabletop', 'electronics', 'instrument', 'computer', 'radio', 'lab', 'paper', 'desk_dressing', 'lamp', 'specimen'], 4);
        }
        return n;
    }
    /**
     * World mode: one Omo station per requested desk (the station draws its own desk, chair and monitor), users facing
     * the vista. Module desk anchors first; then the free floor is scanned from the glass inward (0.25 m steps), each
     * row flanking the viewpoint (the lab desk rule), with 0.2 m clear around every station. Returns how many fit.
     */
    stationDesks(count: number, anchors: Array<[number, number, number]> = []): number {
        let n = 0;
        for (const [x, y, rot] of anchors) {
            if (n >= count) break;
            const poly = obb(x, y, ANCHOR_SIZE, ANCHOR_SIZE, rot); // a module's baked bench is the desk: the station needs its seat only
            if (!inside(poly, this.inner) || this.polys.some(([q]) => overlap(poly, q))) continue;
            this.stations.push(this.add('__station', x, y, rot, 'desks', 'station', { w: ANCHOR_SIZE, d: ANCHOR_SIZE })); n++;
        }
        const [x0, y0, x1, y1] = this.inner, mid = (x0 + x1) / 2;
        const xs: number[] = [];
        for (let x = x0 + 0.2 + STATION_W / 2; x <= x1 - 0.2 - STATION_W / 2 + 1e-6; x += 0.25) xs.push(r3(x));
        xs.sort((a, b) => Math.abs(Math.abs(a - mid) - (STATION_W / 2 + 0.4)) - Math.abs(Math.abs(b - mid) - (STATION_W / 2 + 0.4)) || a - b);
        // Row by row: try every row line (0.25 m steps in from the glass), keep the line that seats the most desks
        // (ties: nearer the glass), commit it, repeat while desks are left and a line still seats one.
        const ys: number[] = [];
        for (let k = 0; ; k++) { const y = r3(y1 - 0.3 - STATION_D / 2 - k * 0.25); if (y - STATION_D / 2 < y0 - 1e-6) break; ys.push(y); }
        const rowAt = (y: number, left: number): number[] => {
            const taken: Poly[] = [], out: number[] = [];
            for (const x of xs) {
                if (out.length >= left) break;
                const poly = obb(x, y, STATION_W + 0.1, STATION_D + 0.1, 0);
                if (!this.free(poly) || taken.some(q => overlap(poly, q))) continue;
                taken.push(poly); out.push(x);
            }
            return out;
        };
        while (n < count) {
            let best: { y: number; xs: number[] } | undefined;
            for (const y of ys) { const row = rowAt(y, count - n); if (row.length && (!best || row.length > best.xs.length)) best = { y, xs: row }; }
            if (!best) break;
            for (const x of best.xs) { this.stations.push(this.add('__station', x, best.y, 0, 'desks', 'station', { w: STATION_W, d: STATION_D })); n++; }
        }
        return n;
    }

    window(tag: string): number {
        let cands = tag === 'hero' ? this.kit.filter(p => this.hero.includes(p.id) && p.zone === 'window' && p.place === 'floor') : this.pick(tag, 'window').filter(p => p.place === 'floor');
        cands = cands.filter(p => !p.exterior);
        if (!cands.length) return 0;
        const [x0, , x1, y1] = this.inner, [fx, fy] = this.r.focal, p = cands[0];
        for (const fr of tag === 'hero' ? [0.68, 0.32, 0.82, 0.18] : [0.3, 0.7, 0.15, 0.85]) for (const inset of [1.0, 1.3, 1.7]) {
            const x = x0 + fr * (x1 - x0), y = y1 - inset, rot = tag !== 'hero' ? yawFacing(fx - x, fy - y) : yawFacing(-0.6, -1);
            if (this.tryAdd(p.id, x, y, rot, 'window', tag, { pad: 0.15 })) return 1;
        }
        return 0;
    }
    corner(tag: string): number {
        let base = this.pick(tag, 'corner');
        if (!base.length) base = this.pick(tag);
        const cands = base.filter(p => p.place === 'floor' && !p.exterior);
        if (!cands.length) return 0;
        const [x0, y0, x1, y1] = this.inner;
        let n = 0;
        const corners: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        for (let i = 0; i < corners.length; i++) {
            const [cx, cy] = corners[i], p = cands[i % cands.length], w = Math.max(...p.footprint) * 0.8, off = w / 2 + 0.08;
            const px = cx === x0 ? cx + off : cx - off, py = cy === y0 ? cy + off : cy - off;
            const rot = this.rng.choice([0.0, 1.5708, 3.1416, 4.7124]);
            if (this.tryAdd(p.id, px, py, rot, 'corner', tag, { w, d: w })) n++;
            if (n >= 2) break;
        }
        return n;
    }
    art(tag: string): number {
        let a: KProp | undefined = this.pick(tag)[0];
        if (a && a.place !== 'wall_mount') a = this.pick(tag).find(p => p.place === 'wall_mount');
        if (!a) return 0;
        let n = 0;
        const segs = this.r.wall_segments.map((s, i) => ({ s, i })).sort((x, y) => -(x.s.b - x.s.a) + (y.s.b - y.s.a) || x.i - y.i).map(x => x.s);
        for (const seg of segs) {
            if (seg.b - seg.a < 1.6) continue;
            const [x, y, rot] = this.onWall(seg, (seg.a + seg.b) / 2, 0.04, 0);
            if (this.placed.some(p => p.zone === 'wall' && (p.height || 0) > 1.2 && Math.hypot(p.pos[0] - x, p.pos[1] - y) < 1.4)) continue;
            if (this.placed.some(q => ['art', 'clock', 'sconce'].includes(q.tag) && Math.hypot(q.pos[0] - x, q.pos[1] - y) < 0.9)) continue;
            if (this.blocked.some(([q, why]) => why === 'web-wall' && overlap(obb(x, y, 1.2, 0.3, rot), q))) continue; // world mode: the web wall's strip
            this.add(a.id, x, y, rot, 'wall', tag, { z: a.mount_z ?? (tag === 'art' ? 1.45 : 1.9), collide: false }); n++;
            if (n >= (tag === 'art' ? 2 : 1)) break;
        }
        return n;
    }
}

// ------------------------------------------------------------------------------------------------ layout (layout.py build_plan)
function roomDims(r: CompileRoom): [number, number] {
    if (r.width !== undefined && r.depth !== undefined) return [r.width, r.depth];
    return SIZES[r.size ?? 'M'] ?? SIZES.M;
}
/** spec -> plan (rooms, doors, wall segments, reserved zones). Deterministic architectural grammar. */
export function layoutPlan(spec: CompileSpec, pack: KitPack): Plan {
    const T = pack.architecture.wall, H = pack.architecture.ceiling;
    const roomsIn = spec.rooms.slice(0, MAX_ROOMS);
    if (!roomsIn.length) throw new Error('A world needs at least one room.');
    const ids = roomsIn.map(r => r.id);
    const adj = new Map<string, string[]>(ids.map(i => [i, []]));
    for (const [a, b] of spec.links ?? []) if (adj.has(a) && adj.has(b)) { adj.get(a)!.push(b); adj.get(b)!.push(a); }
    const order: string[] = [], seen = new Set<string>();
    const queue = [roomsIn.find(r => r.purpose === 'entry')?.id ?? ids[0]];
    while (queue.length) {
        const n = queue.shift()!;
        if (seen.has(n)) continue;
        seen.add(n); order.push(n);
        queue.push(...adj.get(n)!.filter(m => !seen.has(m)));
    }
    order.push(...ids.filter(i => !seen.has(i)));
    const byId = new Map(roomsIn.map(r => [r.id, r]));
    let north = 0;
    for (const r of roomsIn) north = Math.max(north, roomDims(r)[1]);
    let x = 0;
    const rooms: PlanRoom[] = order.map((rid, k) => {
        const r = byId.get(rid)!;
        const [w0, d0] = roomDims(r), w = snap(w0), d = snap(d0);
        const rect: LabRect = [x, north - d, x + w, north];
        x += w;
        return {
            id: rid, purpose: r.purpose, name: r.name ?? (r.purpose.charAt(0).toUpperCase() + r.purpose.slice(1)), size: r.size ?? 'M', desks: r.desks ?? 0,
            rect, h: H, glass_sides: ['N', ...(k === order.length - 1 ? ['E'] : [])], glass: 'N', inner: [0, 0, 0, 0], wall_segments: [], reserved: [],
            focal: [0, 0], center_target: [0, 0], ...(r.recipe ? { recipe: [...r.recipe] } : {})
        };
    });
    const pos = new Map(rooms.map((r, i) => [r.id, i]));
    const links = new Set<string>();
    for (const [a, b] of spec.links ?? []) if (pos.has(a) && pos.has(b) && Math.abs(pos.get(a)! - pos.get(b)!) === 1) links.add([pos.get(a)!, pos.get(b)!].sort((p, q) => p - q).join(','));
    for (let i = 0; i < rooms.length - 1; i++) links.add(`${i},${i + 1}`);
    const circY = north - CIRC_IN;
    const doors: PlanDoor[] = [];
    for (const [i, j] of [...links].map(s => s.split(',').map(Number) as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1])) {
        const A = rooms[i], B = rooms[j];
        const lo = Math.max(A.rect[1], B.rect[1]), hi = Math.min(A.rect[3], B.rect[3]);
        doors.push({ id: `d_${A.id}_${B.id}`, rooms: [A.id, B.id], pos: [A.rect[2], Math.min(Math.max(circY, lo + 0.9), hi - 0.9)], axis: 'y', w: DOOR_W, h: DOOR_H, kind: 'interior' });
    }
    const E = rooms[0];
    doors.push({ id: 'd_entrance', rooms: [E.id, null], pos: [(E.rect[0] + E.rect[2]) / 2, E.rect[1]], axis: 'x', w: DOOR_W + 0.2, h: DOOR_H + 0.1, kind: 'entrance' });

    for (const r of rooms) {
        const [x0, y0, x1, y1] = r.rect, h = T / 2;
        const inner: LabRect = [x0 + h, y0 + h, x1 - h, y1 - h];
        r.inner = inner.map(r3) as LabRect;
        const segs: WallSegment[] = [];
        const seg = (side: WallSegment['side'], axis: 'x' | 'y', at: number, a: number, b: number, normal: [number, number], cuts: Array<[number, number]>): void => {
            let cur = a;
            for (const [c, w] of [...cuts].sort((p, q) => p[0] - q[0] || p[1] - q[1])) {
                if (c - w / 2 - 0.15 > cur + 0.3) segs.push({ side, axis, at, a: r3(cur), b: r3(c - w / 2 - 0.15), normal });
                cur = Math.max(cur, c + w / 2 + 0.15);
            }
            if (b - cur > 0.3) segs.push({ side, axis, at, a: r3(cur), b: r3(b), normal });
        };
        const cutsOn = (axis: 'x' | 'y', at: number, lo: number, hi: number): Array<[number, number]> => {
            const out: Array<[number, number]> = [];
            for (const d of doors) if (d.axis === axis && Math.abs((axis === 'y' ? d.pos[0] : d.pos[1]) - at) < 1e-6) {
                const c = axis === 'y' ? d.pos[1] : d.pos[0];
                if (lo - 0.5 < c && c < hi + 0.5) out.push([c, d.w]);
            }
            return out;
        };
        const [ix0, iy0, ix1, iy1] = inner;
        seg('S', 'x', iy0, ix0, ix1, [0, 1], cutsOn('x', y0, ix0, ix1));
        seg('W', 'y', ix0, iy0, iy1, [1, 0], cutsOn('y', x0, iy0, iy1));
        if (!r.glass_sides.includes('E')) seg('E', 'y', ix1, iy0, iy1, [-1, 0], cutsOn('y', x1, iy0, iy1));
        r.wall_segments = segs;
        const res: Array<{ rect: LabRect; why: string }> = [];
        const rdoors = doors.filter(d => d.rooms.includes(r.id));
        for (const d of rdoors) {
            const [px, py] = d.pos;
            if (d.axis === 'y') {
                const side = Math.abs(px - x0) < 1e-6 ? 1 : -1, xa = px + side * h;
                res.push({ rect: sorted2([xa, py - d.w / 2 - 0.25, xa + side * 1.4, py + d.w / 2 + 0.25]), why: `door:${d.id}` });
            } else res.push({ rect: [px - d.w / 2 - 0.25, py + h, px + d.w / 2 + 0.25, py + h + 1.6], why: `door:${d.id}` });
        }
        const cy = north - CIRC_IN;
        const xsd = [...rdoors.filter(d => d.axis === 'y').map(d => d.pos[0]), (x0 + x1) / 2];
        res.push({ rect: [Math.max(ix0, Math.min(...xsd)), cy - CIRC_W / 2, Math.min(ix1, Math.max(...xsd)), cy + CIRC_W / 2], why: 'circulation' });
        for (const d of rdoors) if (d.axis === 'x') res.push({ rect: [d.pos[0] - CIRC_W / 2, iy0, d.pos[0] + CIRC_W / 2, cy], why: 'circulation:entrance' });
        const mx = (x0 + x1) / 2;
        res.push({ rect: [mx - 1.3, iy1 - 1.5, mx + 1.3, iy1], why: 'viewpoint' });
        r.reserved = res;
        r.focal = [r3(mx), r3(iy1 + 30.0)];
        r.center_target = [r3(mx), r3((iy0 + cy - CIRC_W / 2) / 2)];
    }
    const bounds: LabRect = [rooms[0].rect[0], Math.min(...rooms.map(r => r.rect[1])), rooms[rooms.length - 1].rect[2], north];
    return { grammar: 'vista_enfilade', kit: pack.id, north, circulation_y: circY, bounds, wall_t: T, ceiling: H, rooms, doors };
}

// ------------------------------------------------------------------------------------------------ solve one room (solver.py solve)
function recipeFor(room: PlanRoom, pack: KitPack): string[] {
    const Z = pack.zones ?? {};
    if (room.recipe) return room.recipe;
    for (const a of ZONE_ALIAS[room.purpose] ?? [room.purpose]) if (Z[a]) return Z[a];
    return DEFAULT_ZONES[room.purpose] ?? DEFAULT_ZONES.lounge;
}
export interface SolveResult { placed: Placement[]; stations: Placement[]; log: string[]; unplacedDesks: number; webWall?: WebWallSpot }
export function solveRoom(room: PlanRoom, pack: KitPack, seed = DEFAULT_SEED, mode: 'world' | 'lab' = 'lab', extra: { reserve?: Array<{ rect: LabRect; why: string }>; deskAnchors?: Array<[number, number, number]>; webWall?: boolean } = {}): SolveResult {
    const rng = new Rng(seed + parseInt(fnv1a(room.id), 16) % 1000);
    const kit = pack.assets.map(kprop);
    const R = new RoomSolver({ ...room, reserved: [...room.reserved, ...(extra.reserve ?? [])] }, kit, pack.hero ?? [], rng, mode);
    let recipe = recipeFor(room, pack);
    const log: string[] = [];
    let unplacedDesks = 0;
    if (mode === 'world') {
        // world mode: requested desks are Omo stations, placed first; the kit desk models / chairs are not placed under them.
        recipe = recipe.filter(s => !s.startsWith('desks:'));
        if (room.desks > 0) { const k = R.stationDesks(room.desks, extra.deskAnchors); unplacedDesks = room.desks - k; log.push(`stations=${k}`); }
    }
    // world mode: the web wall goes next, on a solid wall facing the desks (else the room centre, where the seating group
    // goes); its wall strip is then kept clear of furniture and wall art.
    let webWall: WebWallSpot | undefined;
    if (mode === 'world' && extra.webWall) {
        const target: [number, number] = R.stations.length ? [R.stations.reduce((s, p) => s + p.pos[0], 0) / R.stations.length, R.stations.reduce((s, p) => s + p.pos[1], 0) / R.stations.length] : room.center_target;
        webWall = findWebWall(R, room, target);
        if (webWall) { R.blocked.push([webWall.strip, 'web-wall']); log.push('web-wall=1'); } else log.push('web-wall=0');
    }
    const items = recipe.map((s, i) => ({ s, i })).sort((a, b) => (ZONE_ORDER[a.s.split(':')[0]] ?? 5) - (ZONE_ORDER[b.s.split(':')[0]] ?? 5) || a.i - b.i).map(x => x.s);
    for (const item of items) {
        let [kind, tag] = item.split(':') as [string, string];
        if (kind === 'wall' && tag === 'art') kind = 'art';
        const picked = R.pick(tag);
        if ((kind === 'wall' && tag === 'books') || (kind === 'nook' && tag === 'lamp') || (kind === 'window' && tag !== 'hero' && (picked.length ? picked : [{ exterior: true }]).every(p => p.exterior))) { log.push(`${item}=with-parent`); continue; }
        const k = kind === 'wall' ? R.wall(tag) : kind === 'nook' ? R.nook(tag) : kind === 'center' ? R.center(tag) : kind === 'desks' ? R.desks(tag, room.desks || 2)
            : kind === 'corner' ? R.corner(tag) : kind === 'art' ? R.art(tag) : kind === 'window' ? R.window(tag) : 0;
        log.push(`${item}=${k}`);
    }
    if (!R.placed.some(q => R.props.get(q.id)?.light)) log.push(`auto:pendant=${R.center('pendant')}`);
    return { placed: R.placed.filter(p => p.id !== '__station'), stations: R.stations, log, unplacedDesks, ...(webWall ? { webWall } : {}) };
}

/** Independent overlap audit of colliding placements (solver.py check): pairs of ids that overlap in the same room. */
export function auditOverlaps(placements: readonly Placement[]): Array<[string, string]> {
    const col = placements.filter(p => p.zone !== 'ceiling' && p.zone !== 'floor' && !p.on && p.tag !== 'art' && p.collide);
    const bad: Array<[string, string]> = [];
    for (let i = 0; i < col.length; i++) for (let j = i + 1; j < col.length; j++) {
        const a = col[i], b = col[j];
        if (a.room !== b.room) continue;
        if (overlap(obb(a.pos[0], a.pos[1], a.footprint[0], a.footprint[1], a.rot), obb(b.pos[0], b.pos[1], b.footprint[0], b.footprint[1], b.rot), 0.003)) bad.push([a.id, b.id]);
    }
    return bad;
}

// ------------------------------------------------------------------------------------------------ web walls
interface WebWallSpot { x: number; y: number; rot: number; width: number; height: number; elevation: number; strip: Poly; facing: number }
function webWallSize(segLen: number, ceiling: number): { width: number; height: number; elevation: number } {
    const width = r3(Math.min(3.2, Math.max(1.6, segLen - 0.6)));
    const elevation = 0.85, height = r3(Math.min(width * 0.5625, 1.8, ceiling - 0.15 - elevation));
    return { width, height, elevation };
}
/**
 * The best web-wall spot on a SOLID wall segment (never the glass): its 0.8 m floor strip clear of every placed
 * thing and reserved zone (doors, circulation, viewpoint), the screen facing `target` (the seating). Highest score:
 * facing the target squarely, about 3.5 m away, near the middle of its wall run.
 */
function findWebWall(R: RoomSolver, room: PlanRoom, target: [number, number]): WebWallSpot | undefined {
    let best: (WebWallSpot & { score: number }) | undefined;
    for (const seg of room.wall_segments) {
        const L = seg.b - seg.a;
        if (L < 2.0) continue;
        const size = webWallSize(L, room.h);
        const [nx, ny] = seg.normal;
        for (let a = seg.a + size.width / 2 + 0.1; a <= seg.b - size.width / 2 - 0.1 + 1e-6; a += 0.25) {
            const x = seg.axis === 'x' ? a : seg.at + nx * 0.06, y = seg.axis === 'x' ? seg.at + ny * 0.06 : a;
            const sx = seg.axis === 'x' ? x : seg.at + nx * 0.41, sy = seg.axis === 'x' ? seg.at + ny * 0.41 : y;
            const strip = obb(sx, sy, seg.axis === 'x' ? size.width + 0.2 : 0.8, seg.axis === 'x' ? 0.8 : size.width + 0.2, 0);
            if (!R.free(strip)) continue;
            const dx = target[0] - x, dy = target[1] - y, dist = Math.hypot(dx, dy) || 1;
            const facing = (dx * nx + dy * ny) / dist; // 1 = the screen looks straight at the seating
            const score = facing * 10 - Math.abs(dist - 3.5) - Math.abs(a - (seg.a + seg.b) / 2) * 0.2;
            if (facing > 0.2 && (!best || score > best.score + 1e-9)) best = { x: r3(x), y: r3(y), rot: yawFacing(nx, ny), ...size, strip, facing: r3(facing), score };
        }
    }
    if (!best) return undefined;
    const { score: _score, ...spot } = best;
    return spot;
}

/** A room module's big screen spot (room-modules.ts MODULES[id].screen) as a web wall, in lab coordinates. */
function moduleScreen(mod: typeof MODULES[RoomModuleId], cx: number, cy: number): WebWallSpot {
    const s = mod.screen, x = cx + s.x, y = cy - s.z;
    // the screen faces into the room: its normal is the model front, yaw = rotation (see the coordinate note at the top)
    const nx = -Math.sign(s.x) || 1;
    const strip = obb(x + nx * 0.4, y, 0.8, s.width + 0.2, 0);
    return { x: r3(x), y: r3(y), rot: s.rotation, width: s.width, height: s.height, elevation: r3(SCREEN_CENTRE_Y - s.height / 2), strip, facing: 1 };
}
const polyRect = (p: Poly): LabRect => [Math.min(...p.map(q => q[0])), Math.min(...p.map(q => q[1])), Math.max(...p.map(q => q[0])), Math.max(...p.map(q => q[1]))];

// ------------------------------------------------------------------------------------------------ modules
/** The room module whose words match a purpose / name (no fallback: undefined when none match). */
export function moduleForPurpose(purpose: string, name = ''): RoomModuleId | undefined {
    for (const text of [purpose.replace(/_/g, ' '), name]) {
        let best: { id: RoomModuleId; at: number } | undefined;
        for (const [id, re] of MODULE_WORDS) { const at = text.search(re); if (at >= 0 && (!best || at < best.at)) best = { id, at }; }
        if (best) return best.id;
    }
    return undefined;
}

// ------------------------------------------------------------------------------------------------ compile
export interface CompileResult {
    ops: WorldOp[];
    /** The world the ops build from `compilerBaseWorld()` (validated). */
    world: WorldSpec;
    plan: Plan & { props: Placement[]; stations: Placement[]; webWalls: Array<{ room: string } & WebWallSpot>; logs: Record<string, string[]> };
    overlaps: Array<[string, string]>;
    warnings: string[];
}
/** The empty world the compiler's ops apply to. */
export function compilerBaseWorld(name = 'World'): WorldSpec {
    return { version: WORLD_VERSION, name: name.slice(0, 120) || 'World', shell: { theme: 'station', width: 12, depth: 10 }, entities: [], revision: 0 };
}
const idPart = (s: string, max: number): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'x';
const normRot = (r: number): number => { let v = r % (2 * Math.PI); if (v > Math.PI) v -= 2 * Math.PI; if (v <= -Math.PI) v += 2 * Math.PI; return r4(v); };
const ORDINAL = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const deskName = (i: number): string => `Desk ${ORDINAL[i] ?? String(i + 1)}`;

/**
 * spec + kit pack -> WorldOps (shell, site, name, rooms, stations, web walls, props). Deterministic: the same spec,
 * pack and seed give the same ops. The ops apply to `compilerBaseWorld()`; `world` is that result.
 */
export function compileWorld(spec: CompileSpec, pack: KitPack, options: CompileOptions = {}): CompileResult {
    const mode = options.mode ?? 'world', modules = options.modules ?? 'fit';
    const warnings: string[] = [];
    if (spec.rooms.length > MAX_ROOMS) warnings.push(`Only the first ${MAX_ROOMS} rooms are built (the grammar holds ${MAX_ROOMS}).`);
    const seed = Number.isInteger(spec.seed) && spec.seed! >= 0 ? spec.seed! : DEFAULT_SEED;
    // ids the world can hold; purposes as one short word
    const rooms = spec.rooms.slice(0, MAX_ROOMS).map(r => ({ ...r, id: idPart(r.id, 20), purpose: (r.purpose || 'lounge').toLowerCase() }));
    const idMap = new Map(spec.rooms.slice(0, MAX_ROOMS).map((r, i) => [r.id, rooms[i].id]));
    const links = (spec.links ?? []).map(([a, b]) => [idMap.get(a) ?? a, idMap.get(b) ?? b] as [string, string]);
    // modules: which rooms may get one (and, with 'snap', the module footprint)
    const moduleOf = new Map<string, RoomModuleId>();
    if (mode === 'world' && modules !== 'off') for (const r of rooms) {
        const m = moduleForPurpose(r.purpose, r.name);
        if (!m) continue;
        if (modules === 'snap') { r.width = MODULE_WIDTH; r.depth = MODULE_DEPTH; moduleOf.set(r.id, m); continue; }
        const [w, d] = roomDims(r);
        if (Math.abs(snap(w) - MODULE_WIDTH) < 0.01 && Math.abs(snap(d) - MODULE_DEPTH) < 0.01) moduleOf.set(r.id, m);
    }
    // World mode grows a room that cannot seat its desks (one station is 3.6 m wide), in whole station widths, up to
    // GROW_MAX m wide: the same input always grows the same way.
    let plan: Plan;
    let props: Placement[], stations: Placement[], webWalls: Array<{ room: string } & WebWallSpot>, logs: Record<string, string[]>, short: Map<string, number>;
    for (let attempt = 0; ; attempt++) {
        plan = layoutPlan({ ...spec, rooms, links }, pack);
        // a baked module has ONE doorway (front centre): only a room whose only door is its front (south) wall can show it
        for (const r of plan.rooms) {
            const m = moduleOf.get(r.id);
            if (!m) continue;
            if (plan.doors.some(d => d.rooms.includes(r.id) && d.axis === 'y')) continue;
            r.module = m;
        }
        props = []; stations = []; webWalls = []; logs = {}; short = new Map();
        const main = plan.rooms.filter(r => !MINOR_PURPOSES.has(r.purpose));
        const mainIds = new Set((main.length ? main : [plan.rooms.reduce((a, b) => ((b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]) > (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]) ? b : a))]).map(r => r.id));
        for (const room of plan.rooms) {
            const mod = room.module ? MODULES[room.module] : undefined;
            // a module room: its baked furniture is taken; the studio's desks are the module's own desk spots
            const cx = (room.rect[0] + room.rect[2]) / 2, cy = (room.rect[1] + room.rect[3]) / 2;
            const reserve = mod ? mod.blocks.map((b, i) => ({ rect: [cx + b.x - b.hx, cy - b.z - b.hz, cx + b.x + b.hx, cy - b.z + b.hz] as LabRect, why: `module:${i}` })) : [];
            const deskAnchors: Array<[number, number, number]> = mod ? mod.desks.map(d => [cx + d.x, cy - d.z, d.rotation]) : [];
            // a module room's web wall is the module's own big screen (right wall); its strip is kept clear
            const modScreen = mod && mode === 'world' && mainIds.has(room.id) ? moduleScreen(mod, cx, cy) : undefined;
            if (modScreen) reserve.push({ rect: polyRect(modScreen.strip), why: 'web-wall' });
            const res = solveRoom(room, pack, seed, mode, { reserve, deskAnchors, webWall: mainIds.has(room.id) && !modScreen });
            if (modScreen) { webWalls.push({ room: room.id, ...modScreen }); res.log.push('web-wall=module'); }
            if (res.webWall) webWalls.push({ room: room.id, ...res.webWall });
            else if (mode === 'world' && mainIds.has(room.id) && !modScreen) warnings.push(`No free solid wall for a web wall in ${room.name}.`);
            if (res.unplacedDesks > 0) short.set(room.id, res.unplacedDesks);
            props.push(...res.placed); stations.push(...res.stations); logs[room.id] = res.log;
        }
        const grow = [...short.keys()].map(id => rooms.find(r => r.id === id)!).filter(r => roomDims(r)[0] + STATION_W + 0.25 <= GROW_MAX && !plan.rooms.find(p => p.id === r.id)?.module);
        if (mode !== 'world' || !grow.length || attempt >= 8) break;
        for (const r of grow) { const [w, d] = roomDims(r); r.width = snap(w + STATION_W + 0.25); r.depth = d; }
    }
    for (const r of plan.rooms) {
        const left = short.get(r.id);
        if (left) warnings.push(`${r.name}: ${left} of ${r.desks} desks did not fit.`);
        const m = moduleOf.get(r.id);
        if (m && !r.module && modules === 'snap') warnings.push(`${r.name}: no ${m} module (a module has one front door; this room has a side door).`);
    }
    const grown = plan.rooms.filter(r => { const src = spec.rooms.find(x => idMap.get(x.id) === r.id); return src && !r.module && Math.abs((r.rect[2] - r.rect[0]) - snap(roomDims(moduleOf.has(r.id) && modules === 'snap' ? { ...src, width: MODULE_WIDTH, depth: MODULE_DEPTH } : src)[0])) > 0.01; });
    for (const r of grown) warnings.push(`${r.name} grew to ${r3(r.rect[2] - r.rect[0])} m wide to seat ${r.desks} desks.`);
    const overlaps = auditOverlaps([...props, ...stations]);

    // ---- lab -> Omo room space (centred on the building; z = -lab y)
    const [X0, Y0, X1, Y1] = plan.bounds, ox = (X0 + X1) / 2, oy = (Y0 + Y1) / 2;
    const wx = (x: number): number => r3(x - ox), wz = (y: number): number => r3(oy - y);
    const roomRects = plan.rooms.map(r => ({ minX: wx(r.rect[0]), maxX: wx(r.rect[2]), minZ: wz(r.rect[3]), maxZ: wz(r.rect[1]) }));
    const ground = groundFor(roomRects);
    const ops: WorldOp[] = [{ op: 'shell', shell: { theme: pack.theme, width: ground.width, depth: ground.depth, open: true } }];
    const site: Site = { kit: ASSET_ID_RE.test(spec.kit ?? pack.id) ? (spec.kit ?? pack.id) : pack.id, seed };
    if (SITE_TIMES.includes(spec.time as SiteTime)) site.time = spec.time as SiteTime;
    if (SITE_WEATHERS.includes(spec.weather as SiteWeather)) site.weather = spec.weather as SiteWeather;
    if (SITE_VISTAS.includes(spec.vista as SiteVista)) site.vista = spec.vista as SiteVista;
    ops.push({ op: 'site', site });
    const name = (spec.name ?? spec.prompt ?? '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
    if (name) ops.push({ op: 'name', name });
    const entities: WorldEntity[] = [];
    const taken = new Set<string>();
    const uid = (base: string): string => { let id = base.slice(0, 48).replace(/-+$/, ''); for (let k = 2; taken.has(id) || !WORLD_ID_RE.test(id); k++) id = `${base.slice(0, 44).replace(/-+$/, '')}-${k}`; taken.add(id); return id; };
    // rooms: lab sides -> Omo sides (S = front (+z), N = back (glass), W = left, E = right)
    for (const r of plan.rooms) {
        const doors: WallSide[] = [];
        for (const d of plan.doors) if (d.rooms.includes(r.id)) {
            if (d.axis === 'x') doors.push('front');
            else doors.push(Math.abs(d.pos[0] - r.rect[0]) < 1e-6 ? 'left' : 'right');
        }
        const purpose = r.purpose.replace(/_/g, '-').slice(0, 32);
        const e: RoomEntity = {
            id: uid(r.id), kind: 'room', label: r.name.slice(0, 60), transform: { x: wx((r.rect[0] + r.rect[2]) / 2), z: wz((r.rect[1] + r.rect[3]) / 2), rotation: 0 },
            width: r3(r.rect[2] - r.rect[0]), depth: r3(r.rect[3] - r.rect[1]), doors: [...new Set(doors)],
            ...(PURPOSE_RE.test(purpose) ? { purpose } : {}), ...(r.module ? { module: r.module } : {})
        };
        entities.push(e);
    }
    // stations: 'terminal', 'terminal-2', 'desk-3' ... (the runtime's desk ids)
    stations.forEach((s, i) => {
        const id = uid(i === 0 ? 'terminal' : i === 1 ? 'terminal-2' : `desk-${i + 1}`);
        // lab yaw 0 = desk front south, user facing north (the glass) = Omo station rotation 0 (facing -z)
        // the solver's rectangle is centred; an Omo station's own rectangle runs 1.1 m to the front, 0.98 m back (entityRect)
        const onAnchor = s.footprint[0] < STATION_W;
        const sy = onAnchor ? s.pos[1] : s.pos[1] - STATION_CENTRE_SHIFT;
        const e: StationEntity = { id, kind: 'station', label: deskName(i), transform: { x: wx(s.pos[0]), z: wz(sy), rotation: normRot(s.rot) }, station: defaultStation(deskName(i)) };
        entities.push(e);
    });
    webWalls.forEach((w, i) => {
        const room = plan.rooms.find(r => r.id === w.room)!;
        const e: WebWallEntity = { id: uid(i === 0 ? 'web' : `web-${idPart(w.room, 20)}`), kind: 'web-wall', label: `Web wall · ${room.name}`.slice(0, 60), transform: { x: wx(w.x), z: wz(w.y), rotation: normRot(w.rot) }, width: w.width, height: w.height, elevation: w.elevation };
        entities.push(e);
    });
    // props: catalogue entities, room by room in solver order
    const room = new Map(plan.rooms.map(r => [r.id, r]));
    let dropped = 0;
    for (const p of props) {
        if (entities.length >= WORLD_MAX_ENTITIES) { dropped++; continue; }
        const asset = pack.assets.find(a => a.id === p.id);
        if (!asset || !ASSET_ID_RE.test(asset.id)) { warnings.push(`Unknown asset ${p.id} skipped.`); continue; }
        const scale = asset.procedural && Math.abs(p.footprint[0] / asset.size.x - 1) > 0.01 ? r3(p.footprint[0] / asset.size.x) : undefined;
        const slot = `${p.zone}:${p.tag}`.toLowerCase();
        const e: PropEntity = {
            id: uid(`${idPart(room.get(p.room)!.id, 12)}-${idPart(asset.id, 28)}`), kind: 'prop', asset: asset.id, label: asset.label.slice(0, 60),
            transform: { x: wx(p.pos[0]), z: wz(p.pos[1]), rotation: normRot(p.rot) },
            ...(p.pos[2] > 0.001 ? { y: r3(p.pos[2]) } : {}), ...(scale !== undefined && scale >= 0.05 && scale <= 10 ? { scale } : {}),
            ...(/^[a-z0-9][a-z0-9_:.-]{0,47}$/.test(slot) ? { slot } : {})
        };
        entities.push(e);
    }
    if (dropped) warnings.push(`${dropped} props left out: a world holds at most ${WORLD_MAX_ENTITIES} things.`);
    for (const e of entities) ops.push({ op: 'add', entity: e });
    const applied: WorldResult = applyWorldOps(compilerBaseWorld(), ops);
    if (!applied.ok) throw new Error(`The compiled world is invalid: ${applied.error}`);
    return { ops, world: applied.world, plan: { ...plan, props, stations, webWalls, logs }, overlaps, warnings };
}
