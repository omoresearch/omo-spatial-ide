/**
 * w3:render — real rooms inside the world (RoomEntity, kind 'room').
 *
 * A room is a floor slab, four walls (3.2 m high, 0.2 m thick) and a 1.6 m doorway gap centred in every
 * side listed in `doors` (default ['front']). A lintel spans each doorway above head height; the look
 * (architecture and materials) is beauty:foundation's, from world-look.ts. Rotation is a quarter turn (contract), so wall rectangles stay axis-aligned in the
 * world and collision stays a cheap rectangle test.
 *
 * The same wall segments drive rendering (buildRoom) and walking collision (roomWallRects), so what you
 * see is exactly what blocks you.
 */
import * as THREE from 'three';
import type { Rect, RoomEntity, WallSide } from '../common/world-model';
import type { BuiltEntity } from './world-scene-entities';
import { placeRoot } from './world-scene-entities';
import { refreeze, slab } from './world-scene-kit';
import type { LookName } from './world-look';
import { aoDecal, look, lookPlate, paintSignPlate, roomFloor } from './world-look';

/** beauty:foundation — penthouse-like proportions (was 2.8 m); the lintel stays at 2.3 m, the cutaway at ~1.1 m. */
export const ROOM_WALL_HEIGHT = 3.2;
export const ROOM_WALL_THICKNESS = 0.2;
export const ROOM_DOOR_WIDTH = 1.6;
/** Underside of the doorway lintel (the camera is at 1.75 m). */
export const ROOM_LINTEL_BOTTOM = 2.3;
/** Walls are lowered to this fraction in the overview (cutaway), so desks inside a room stay visible. */
export const ROOM_CUTAWAY_SCALE = 0.35;

/** One straight wall piece in room-local floor space: centre and size along local x / z. */
export interface WallSegment { side: WallSide; x: number; z: number; sx: number; sz: number }

/** The room's doorway sides (default: front only). */
export function roomDoors(room: Pick<RoomEntity, 'doors'>): ReadonlySet<WallSide> {
    return new Set(room.doors ?? ['front']);
}

/**
 * Room-local wall pieces. Back and front walls span the full width plus the corners; left and right walls
 * fit between them. A side with a doorway is split into two pieces around a centred 1.6 m gap.
 */
export function roomWallSegments(room: Pick<RoomEntity, 'width' | 'depth' | 'doors'>): WallSegment[] {
    const W = room.width, D = room.depth, t = ROOM_WALL_THICKNESS, doors = roomDoors(room), out: WallSegment[] = [];
    const run = (side: WallSide, alongX: boolean, length: number, fixed: number): void => {
        const pieces: Array<[number, number]> = doors.has(side)
            ? [[-length / 2, -ROOM_DOOR_WIDTH / 2], [ROOM_DOOR_WIDTH / 2, length / 2]]
            : [[-length / 2, length / 2]];
        for (const [a, b] of pieces) {
            if (b - a <= 1e-6) continue;
            const c = (a + b) / 2, len = b - a;
            out.push(alongX ? { side, x: c, z: fixed, sx: len, sz: t } : { side, x: fixed, z: c, sx: t, sz: len });
        }
    };
    run('back', true, W + t, -D / 2);
    run('front', true, W + t, D / 2);
    run('left', false, D - t, -W / 2);
    run('right', false, D - t, W / 2);
    return out;
}

/** Room-local point -> world point for a quarter-turn room (THREE rotation.y convention). */
function toWorld(room: Pick<RoomEntity, 'transform'>, lx: number, lz: number): { x: number; z: number } {
    const r = room.transform.rotation, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
    return { x: room.transform.x + c * lx + s * lz, z: room.transform.z - s * lx + c * lz };
}

/** World-space wall rectangles of a room, each grown by `pad` metres on every side (walking clearance). */
export function roomWallRects(room: Pick<RoomEntity, 'transform' | 'width' | 'depth' | 'doors'>, pad = 0): Rect[] {
    const turned = Math.abs(Math.round(room.transform.rotation / (Math.PI / 2))) % 2 === 1;
    return roomWallSegments(room).map(seg => {
        const c = toWorld(room, seg.x, seg.z);
        const hx = (turned ? seg.sz : seg.sx) / 2 + pad, hz = (turned ? seg.sx : seg.sz) / 2 + pad;
        return { minX: c.x - hx, maxX: c.x + hx, minZ: c.z - hz, maxZ: c.z + hz };
    });
}

/** Inward normal (room-local) of a wall side: the cove and the skirting sit on the inner face. */
const INWARD: Record<WallSide, [number, number]> = { back: [0, 1], front: [0, -1], left: [1, 0], right: [-1, 0] };

/**
 * beauty:foundation — a soft contact shadow along a wall base (dark side against the wall), on the room floor.
 * `nx, nz` = the inward normal of that wall face.
 */
function edgeShadow(parent: THREE.Object3D, len: number, x: number, z: number, nx: number, nz: number, y: number, width = 0.55): void {
    const d = aoDecal(len, width, 'edge');
    d.rotation.set(-Math.PI / 2, 0, 0); d.rotation.order = 'YXZ'; d.rotation.y = Math.atan2(-nx, -nz);
    d.position.set(x + nx * width / 2, y, z + nz * width / 2); parent.add(d);
}

/**
 * Build a room. `shellJungle` is the world's theme; the room's own theme wins when set.
 *
 * beauty:foundation — rooms are architecture, on world-look materials only:
 *   - a stone plinth slab with an oak (jungle) or herringbone (others) floor inset framed by a walnut inlay,
 *   - plaster walls with real thickness, a walnut skirting inside, a stone base plinth outside and a walnut top trim,
 *   - door frames: walnut casings either side (the jambs), a casing head over the opening, a brass threshold,
 *   - a ceiling band (a plaster soffit round the inner edge) with a warm cove light strip under it,
 *   - framed glass windows on the long outer faces, soft contact shadows along every inner wall base.
 * Collision and doorway data are unchanged (roomWallSegments drives both).
 */
export function buildRoom(entity: RoomEntity, shellJungle: boolean): BuiltEntity {
    const jungle = entity.theme ? entity.theme === 'jungle' : shellJungle;
    const root = new THREE.Group(); root.name = `omo-entity:${entity.id}`;
    // Selectable in build mode (userData.entity) but not a workstation: clicking a wall never opens anything.
    root.userData.entity = entity.id; root.userData.kind = 'room';
    placeRoot(root, entity);
    const H = ROOM_WALL_HEIGHT, t = ROOM_WALL_THICKNESS, W = entity.width, D = entity.depth;
    const add = (parent: THREE.Object3D, size: [number, number, number], at: [number, number, number], name: LookName, cast = true, tag?: string): THREE.Mesh => {
        const m = slab(parent, size, at, name, cast); m.castShadow = cast; m.receiveShadow = true; if (tag) m.userData.part = tag; return m;
    };
    // Floor: a stone plinth (reads as a place from far away), a walnut inlay frame and the wood floor inset.
    const FY = 0.06;
    add(root, [W + t, 0.05, D + t], [0, 0.025, 0], 'stone.dark', false, 'trim');
    add(root, [W - 0.12, 0.055, D - 0.12], [0, 0.0275, 0], 'trim', false, 'inlay');
    add(root, [W - 0.3, FY, D - 0.3], [0, FY / 2, 0], roomFloor(jungle ? 'jungle' : 'station'), false, 'floor');
    const walls = new THREE.Group(); walls.name = 'omo-room-walls'; root.add(walls);
    const lintels = new THREE.Group(); lintels.name = 'omo-room-lintels'; root.add(lintels);
    const SK = 0.12, SKD = 0.02, CAP = 0.06, SOFFIT = 0.42, COVE_Y = H - 0.34;
    for (const seg of roomWallSegments(entity)) {
        const [nx, nz] = INWARD[seg.side], along = seg.sx > seg.sz, len = along ? seg.sx : seg.sz;
        add(walls, [seg.sx, H, seg.sz], [seg.x, H / 2, seg.z], 'wall', true, 'wall');
        add(walls, [seg.sx + 0.03, CAP, seg.sz + 0.03], [seg.x, H + CAP / 2, seg.z], 'trim', false, 'cap');
        // Inner face: walnut skirting + contact shadow on the floor.
        const ix = nx * (t / 2 + SKD / 2), iz = nz * (t / 2 + SKD / 2), inner = Math.max(0.05, len - (seg.side === 'left' || seg.side === 'right' ? 0 : 2 * t));
        add(walls, [along ? inner : SKD, SK, along ? SKD : inner], [seg.x + ix, FY + SK / 2, seg.z + iz], 'trim', false, 'skirting');
        edgeShadow(root, inner, seg.x + nx * t / 2, seg.z + nz * t / 2, nx, nz, FY + 0.003);
        // Ceiling band: a plaster soffit along the inner top edge with a warm cove strip under its edge (walking view only).
        add(lintels, [along ? inner : SOFFIT, 0.1, along ? SOFFIT : inner], [seg.x + nx * (t / 2 + SOFFIT / 2), H - 0.05, seg.z + nz * (t / 2 + SOFFIT / 2)], 'wall', false, 'soffit');
        add(lintels, [along ? inner : 0.03, 0.025, along ? 0.03 : inner], [seg.x + nx * (t / 2 + SOFFIT - 0.03), H - 0.11, seg.z + nz * (t / 2 + SOFFIT - 0.03)], 'emissive.cove', false, 'cove');
        // A slim walnut picture rail with its own cove glow on the wall (also seen in the cutaway's walls).
        add(walls, [along ? inner : 0.03, 0.03, along ? 0.03 : inner], [seg.x + nx * (t / 2 + 0.015), COVE_Y, seg.z + nz * (t / 2 + 0.015)], 'trim', false, 'rail');
        add(walls, [along ? inner : 0.02, 0.02, along ? 0.02 : inner], [seg.x + nx * (t / 2 + 0.035), COVE_Y + 0.025, seg.z + nz * (t / 2 + 0.035)], 'emissive.cove', false, 'cove-strip');
        // Outer face: a stone base plinth and framed glass windows on long pieces.
        const ox = -nx * (t / 2 + 0.012), oz = -nz * (t / 2 + 0.012);
        add(walls, [along ? seg.sx : 0.024, 0.28, along ? 0.024 : seg.sz], [seg.x + ox, 0.14, seg.z + oz], 'stone.dark', false, 'base-trim');
        if (len >= 2.2) {
            const n = Math.max(1, Math.floor((len - 0.6) / 2.2)), pane = Math.min(1.7, (len - 0.6) / n - 0.4);
            for (let i = 0; i < n; i++) {
                const off = -len / 2 + 0.3 + (len - 0.6) * (i + 0.5) / n, cx = seg.x + (along ? off : 0), cz = seg.z + (along ? 0 : off);
                const fx = -nx * (t / 2 + 0.02), fz = -nz * (t / 2 + 0.02);
                add(walls, [along ? pane + 0.12 : 0.04, 1.32, along ? 0.04 : pane + 0.12], [cx + fx, 1.55, cz + fz], 'trim.graphite', false, 'window-frame');
                add(walls, [along ? pane : 0.02, 1.2, along ? 0.02 : pane], [cx + fx * 1.6, 1.55, cz + fz * 1.6], 'glass', false, 'window');
                add(walls, [along ? pane + 0.2 : 0.12, 0.04, along ? 0.12 : pane + 0.2], [cx - nx * (t / 2 + 0.06), 0.93, cz - nz * (t / 2 + 0.06)], 'stone', false, 'sill');
            }
        }
    }
    const doors = roomDoors(entity);
    const lh = H - ROOM_LINTEL_BOTTOM, ly = ROOM_LINTEL_BOTTOM + lh / 2;
    // Every doorway: walnut casings either side (the jambs; they scale with the cutaway walls), a casing head, a brass threshold.
    const J = 0.12, half = ROOM_DOOR_WIDTH / 2;
    const doorAt: Record<WallSide, { x: number; z: number; alongX: boolean }> = {
        back: { x: 0, z: -D / 2, alongX: true }, front: { x: 0, z: D / 2, alongX: true },
        left: { x: -W / 2, z: 0, alongX: false }, right: { x: W / 2, z: 0, alongX: false }
    };
    for (const side of WALL_ORDER) {
        if (!doors.has(side)) continue;
        const d = doorAt[side];
        add(lintels, d.alongX ? [ROOM_DOOR_WIDTH, lh, t] : [t, lh, ROOM_DOOR_WIDTH], [d.x, ly, d.z], 'wall', true, 'lintel');
        add(lintels, d.alongX ? [ROOM_DOOR_WIDTH + 2 * J, 0.1, t + 0.06] : [t + 0.06, 0.1, ROOM_DOOR_WIDTH + 2 * J], [d.x, ROOM_LINTEL_BOTTOM + 0.05, d.z], 'trim', false, 'door-head');
        // The top trim continues over the doorway (lintel + both jamb tops): no step in the cap line.
        const span = ROOM_DOOR_WIDTH + 2 * J, deep = t + 0.08;
        add(lintels, d.alongX ? [span, CAP, deep] : [deep, CAP, span], [d.x, H + CAP / 2, d.z], 'trim', false, 'door-cap');
        for (const s of [-1, 1]) {
            const o = s * (half + J / 2 - 0.02); // over the wall end: the walkable gap stays exactly as wide as collision says
            add(walls, d.alongX ? [J, H, t + 0.06] : [t + 0.06, H, J], [d.x + (d.alongX ? o : 0), H / 2, d.z + (d.alongX ? 0 : o)], 'trim', true, 'jamb');
        }
        // The threshold stays within the jamb depth (no light wedge sticking out of the wall faces).
        add(root, d.alongX ? [ROOM_DOOR_WIDTH - 2 * J, 0.02, t + 0.06] : [t + 0.06, 0.02, ROOM_DOOR_WIDTH - 2 * J], [d.x, 0.07, d.z], 'metal.brass', false, 'threshold');
    }
    // promise:onboarding (6) — ONE name sign per room: a plaque standing on the wall right above the main doorway, facing
    // the path. Both big faces carry the name (BoxGeometry face UVs read un-mirrored from either side), so the street
    // side and the overview camera (which sees turned rooms from behind) both read it. beauty:foundation — the
    // penthouse plate: graphite, a brass hairline, warm letter-spaced capitals (world-look paintSignPlate).
    const main = doors.has('front') ? 'front' : WALL_ORDER.find(s => doors.has(s));
    if (main) {
        const name = (entity.label ?? 'Room').slice(0, 40), d = doorAt[main];
        const map = paintSignPlate(name);
        const w = Math.min(W - 1.2, 6, Math.max(4, W * 0.6)), h = w * 224 / 1024;
        const face = lookPlate(map, true), rim = look('trim.graphite');
        const sign = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), [rim, rim, rim, rim, face, face]);
        sign.rotation.y = main === 'left' ? -Math.PI / 2 : main === 'right' ? Math.PI / 2 : main === 'back' ? Math.PI : 0;
        sign.position.set(d.x, 0, d.z); sign.userData.signHeight = h; placeRoomSign(sign, false); // on the doorway's wall top
        sign.renderOrder = 2; sign.userData.part = 'room-sign'; sign.userData.roomName = name; sign.userData.ownsMap = true; sign.userData.size = [w, h];
        sign.raycast = () => undefined;
        root.add(sign); root.userData.roomSign = sign;
    }
    root.userData.roomWalls = walls; root.userData.roomLintels = lintels;
    return { root };
}
const WALL_ORDER: readonly WallSide[] = ['front', 'back', 'left', 'right'];

/**
 * Overview cutaway: lower a room's walls and hide its lintels so the desks inside stay visible from above;
 * full height again when walking. Returns whether anything changed (the caller redraws shadows).
 * `frozen` = the subtree is already frozen in the scene (matrices are recomputed once); false while building.
 */
export function setRoomCutaway(root: THREE.Object3D, cut: boolean, frozen = true): boolean {
    const walls = root.userData.roomWalls as THREE.Object3D | undefined, lintels = root.userData.roomLintels as THREE.Object3D | undefined;
    if (!walls) return false;
    const scale = cut ? ROOM_CUTAWAY_SCALE : 1;
    if (walls.scale.y === scale && (!lintels || lintels.visible === !cut)) return false;
    walls.scale.y = scale; if (frozen) refreeze(walls);
    if (lintels) lintels.visible = !cut;
    const sign = root.userData.roomSign as THREE.Object3D | undefined;
    if (sign) { placeRoomSign(sign, cut); if (frozen) refreeze(sign); }
    return true;
}
/**
 * promise:onboarding (6) — the doorway sign stands on the wall top: full height while walking, on the lowered wall in the
 * overview cutaway (it moves down with the wall, so from above it stays in front of the desks and never covers their
 * 01/02/03 markers).
 */
function placeRoomSign(sign: THREE.Object3D, cut: boolean): void {
    sign.position.y = ROOM_WALL_HEIGHT * (cut ? ROOM_CUTAWAY_SCALE : 1) + 0.06 + (sign.userData.signHeight as number) / 2;
}
