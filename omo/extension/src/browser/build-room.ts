/**
 * w3:build — the "grow the world" maths for build mode: auto-grow when something is placed near or past
 * the edge, the World size controls, the Room tool and room walls. Pure data + maths; every change still
 * goes through WorldOp proposals and an explicit Apply (world-store.ts). Nothing here starts an agent.
 */
import type { WorldSpec, WorldEntity, WorldOp, WallSide, RoomEntity } from '../common/world-model';
import { SHELL_MAX, SHELL_MIN, growOpsFor, roomRect } from '../common/world-model';

/** Floor margin (m) an entity's reach must keep from the shell edge before the world grows. */
const FIT_MARGIN = 0.3;
const sizeText = (w: number, d: number): string => `${w} × ${d} m`;

export interface GrowPlan {
    /** Ops to prepend to the add/move op (empty: it already fits). */
    ops: WorldOp[];
    /** The new shell size when the world grows. */
    size?: { width: number; depth: number };
    /** Set when even a 200 x 200 m world cannot hold it (readable, for the ghost). */
    refused?: string;
}

/**
 * Does `entity` need a bigger world? It grows only when the thing would poke past the current edge;
 * then it grows with the contract's normal 2 m of spare floor (growOpsFor), or just enough near SHELL_MAX.
 * Things snapped flat against a wall are inside by definition.
 */
export function growFor(world: WorldSpec, entity: WorldEntity, snappedToWall = false): GrowPlan {
    if (snappedToWall) return { ops: [] };
    const tight = growOpsFor(world, entity, entity.transform, FIT_MARGIN);
    if (tight === undefined) return { ops: [], refused: `The world is at its biggest (${sizeText(SHELL_MAX, SHELL_MAX)}). Put it a little closer in.` };
    if (!tight.length) return { ops: [] };
    const roomy = growOpsFor(world, entity, entity.transform) ?? tight;
    const shellOp = roomy.find((o): o is Extract<WorldOp, { op: 'shell' }> => o.op === 'shell');
    const width = shellOp?.shell.width ?? world.shell.width, depth = shellOp?.shell.depth ?? world.shell.depth;
    return { ops: roomy, size: { width, depth } };
}

/** The pending-panel line for a shell change (replaces the plain "Room size" line). */
export function growLine(before: WorldSpec, after: WorldSpec): string | undefined {
    const a = before.shell, b = after.shell;
    if (a.width === b.width && a.depth === b.depth) return undefined;
    // "to fit this" only when the change also places or moves something (auto-grow); a plain resize says its size.
    const old = new Map(before.entities.map(e => [e.id, JSON.stringify(e.transform)]));
    const placed = after.entities.some(e => old.get(e.id) !== JSON.stringify(e.transform) || (e.kind === 'room' && JSON.stringify(before.entities.find(x => x.id === e.id)) !== JSON.stringify(e)));
    if (placed && b.width >= a.width && b.depth >= a.depth) return `The world grows to ${sizeText(b.width, b.depth)} to fit this`;
    return `World size ${sizeText(b.width, b.depth)}`;
}

// ------------------------------------------------------------------ World size controls (part 3)

export const SHELL_STEP = 4;

/** Why the shell cannot shrink to width x depth ('' = it can): names the first thing it would cut off. */
export function shrinkProblem(world: WorldSpec, width: number, depth: number, title: (e: WorldEntity) => string): string {
    if (width < SHELL_MIN || depth < SHELL_MIN) return `The world is at its smallest (${sizeText(SHELL_MIN, SHELL_MIN)}).`;
    if (width > SHELL_MAX || depth > SHELL_MAX) return `The world is at its biggest (${sizeText(SHELL_MAX, SHELL_MAX)}).`;
    const hw = width / 2, hd = depth / 2;
    for (const e of world.entities) {
        const r = e.kind === 'room' ? roomRect(e) : { minX: e.transform.x - FIT_MARGIN, maxX: e.transform.x + FIT_MARGIN, minZ: e.transform.z - FIT_MARGIN, maxZ: e.transform.z + FIT_MARGIN };
        if (r.minX < -hw - 1e-6 || r.maxX > hw + 1e-6 || r.minZ < -hd - 1e-6 || r.maxZ > hd + 1e-6) return `It would cut off ${title(e)}. Move it in first.`;
    }
    return '';
}

/** Ops for a World size change (shell only). */
export function shellSizeOps(width: number, depth: number): WorldOp[] { return [{ op: 'shell', shell: { width, depth } }]; }

// ------------------------------------------------------------------ Room tool (part 2)

export const ROOM_SNAP = 0.5;
export const DOOR_WIDTH = 1.6;
const WALL_THICK = 0.2;
const snapHalf = (n: number): number => Math.round(n / ROOM_SNAP) * ROOM_SNAP;

/** A dragged rectangle (two floor points) as a room centre + size: snapped to 0.5 m, at least `min` metres. */
export function roomFromDrag(a: { x: number; z: number }, b: { x: number; z: number }, min: number, max: number): { x: number; z: number; width: number; depth: number } {
    let x0 = snapHalf(Math.min(a.x, b.x)), x1 = snapHalf(Math.max(a.x, b.x)), z0 = snapHalf(Math.min(a.z, b.z)), z1 = snapHalf(Math.max(a.z, b.z));
    // Grow from the anchor point towards the drag direction so a short drag still makes a minimum room.
    const grow = (lo: number, hi: number, anchorLow: boolean): [number, number] => {
        const size = Math.min(max, Math.max(min, hi - lo));
        return anchorLow ? [lo, lo + size] : [hi - size, hi];
    };
    [x0, x1] = grow(x0, x1, b.x >= a.x);
    [z0, z1] = grow(z0, z1, b.z >= a.z);
    return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, width: x1 - x0, depth: z1 - z0 };
}

/** Local wall side -> world side after a quarter-turn rotation (THREE rotation.y, 0 = facing -z). */
export interface WallSegment { a: { x: number; z: number }; b: { x: number; z: number } }

/**
 * The room's wall segments in world coordinates, with a centred DOOR_WIDTH gap in every doorway side.
 * Rooms are floors: only these walls block placement.
 */
export function roomWalls(room: Pick<RoomEntity, 'transform' | 'width' | 'depth' | 'doors'>): WallSegment[] {
    const hw = room.width / 2, hd = room.depth / 2, doors = new Set<WallSide>(room.doors ?? ['front']);
    const local: Array<{ side: WallSide; a: [number, number]; b: [number, number] }> = [
        { side: 'back', a: [-hw, -hd], b: [hw, -hd] }, { side: 'front', a: [-hw, hd], b: [hw, hd] },
        { side: 'left', a: [-hw, -hd], b: [-hw, hd] }, { side: 'right', a: [hw, -hd], b: [hw, hd] }
    ];
    const out: WallSegment[] = [];
    const c = Math.cos(room.transform.rotation), s = Math.sin(room.transform.rotation);
    const world = ([x, z]: [number, number]): { x: number; z: number } => ({ x: room.transform.x + x * c + z * s, z: room.transform.z - x * s + z * c });
    for (const w of local) {
        if (!doors.has(w.side)) { out.push({ a: world(w.a), b: world(w.b) }); continue; }
        const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), gap = Math.min(DOOR_WIDTH, len - 0.4) / 2;
        const ux = (w.b[0] - w.a[0]) / len, uz = (w.b[1] - w.a[1]) / len, mx = (w.a[0] + w.b[0]) / 2, mz = (w.a[1] + w.b[1]) / 2;
        out.push({ a: world(w.a), b: world([mx - ux * gap, mz - uz * gap]) }, { a: world([mx + ux * gap, mz + uz * gap]), b: world(w.b) });
    }
    return out;
}

/** Does a convex polygon (footprint corners) touch a wall segment thickened to WALL_THICK? */
export function polygonHitsWalls(poly: Array<{ x: number; z: number }>, walls: WallSegment[]): boolean {
    for (const w of walls) {
        const dx = w.b.x - w.a.x, dz = w.b.z - w.a.z, len = Math.hypot(dx, dz); if (len < 1e-6) continue;
        const nx = -dz / len * WALL_THICK / 2, nz = dx / len * WALL_THICK / 2;
        const wall = [{ x: w.a.x + nx, z: w.a.z + nz }, { x: w.b.x + nx, z: w.b.z + nz }, { x: w.b.x - nx, z: w.b.z - nz }, { x: w.a.x - nx, z: w.a.z - nz }];
        if (convexOverlap(poly, wall)) return true;
    }
    return false;
}

function convexOverlap(p: Array<{ x: number; z: number }>, q: Array<{ x: number; z: number }>): boolean {
    for (const poly of [p, q]) for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], ax = -(b.z - a.z), az = b.x - a.x;
        let lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
        for (const c of p) { const d = c.x * ax + c.z * az; lo1 = Math.min(lo1, d); hi1 = Math.max(hi1, d); }
        for (const c of q) { const d = c.x * ax + c.z * az; lo2 = Math.min(lo2, d); hi2 = Math.max(hi2, d); }
        if (hi1 <= lo2 + 1e-6 || hi2 <= lo1 + 1e-6) return false;
    }
    return true;
}

/**
 * Pending-panel lines: the store's diff with the plain shell-size line replaced by
 * "The world grows to W × D m to fit this" (first), plus lines the store does not describe yet
 * (open world, room size / doorways / theme).
 */
export function proposalLines(before: WorldSpec, after: WorldSpec, diff: string[]): string[] {
    const lines = diff.filter(l => !/^Room size /.test(l));
    const grow = growLine(before, after);
    if (grow) lines.unshift(grow);
    if (!!before.shell.open !== !!after.shell.open) lines.unshift(after.shell.open ? 'Open world: no outer walls' : 'Walled world: outer walls back');
    const old = new Map(before.entities.map(e => [e.id, e]));
    for (const e of after.entities) {
        const o = old.get(e.id);
        if (e.kind !== 'room' || o?.kind !== 'room') continue;
        const parts: string[] = [];
        if (o.width !== e.width || o.depth !== e.depth) parts.push(`${e.width} × ${e.depth} m`);
        if (JSON.stringify(o.doors ?? ['front']) !== JSON.stringify(e.doors ?? ['front'])) parts.push(e.doors?.length ? `doorways ${e.doors.join(', ')}` : 'no doorways');
        if (o.theme !== e.theme) parts.push(`${e.theme ?? 'world'} theme`);
        if (parts.length) lines.push(`Reshape ${e.label ?? 'room'}: ${parts.join(', ')}`);
    }
    return lines;
}

/** An exact quarter-turn rotation in (-PI, PI] (the contract requires rooms within 1e-6 of a quarter). */
export function quarterTurn(r: number): number {
    let q = Math.round(r / (Math.PI / 2)) % 4; if (q < 0) q += 4;
    return [0, Math.PI / 2, Math.PI, -Math.PI / 2][q];
}
