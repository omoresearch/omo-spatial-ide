/**
 * w3:render — real rooms inside the world (RoomEntity, kind 'room').
 *
 * A room is a floor slab, four walls (2.8 m high, 0.2 m thick) and a 1.6 m doorway gap centred in every
 * side listed in `doors` (default ['front']). A lintel spans each doorway above head height and a soft
 * light strip runs along the inner top edge of every wall. Colours follow the room's own theme, else
 * the shell theme. Rotation is a quarter turn (contract), so wall rectangles stay axis-aligned in the
 * world and collision stays a cheap rectangle test.
 *
 * The same wall segments drive rendering (buildRoom) and walking collision (roomWallRects), so what you
 * see is exactly what blocks you.
 */
import * as THREE from 'three';
import type { Rect, RoomEntity, WallSide } from '../common/world-model';
import type { BuiltEntity } from './world-scene-entities';
import { placeRoot } from './world-scene-entities';
import { refreeze } from './world-scene-kit';

export const ROOM_WALL_HEIGHT = 2.8;
export const ROOM_WALL_THICKNESS = 0.2;
export const ROOM_DOOR_WIDTH = 1.6;
/** Underside of the doorway lintel (the camera is at 1.75 m). */
export const ROOM_LINTEL_BOTTOM = 2.3;
/** Walls are lowered to this fraction in the overview (cutaway), so desks inside a room stay visible. */
export const ROOM_CUTAWAY_SCALE = 0.4;

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

interface RoomColors { floor: number; trim: number; wall: number; cap: number; strip: number }
function roomColors(jungle: boolean): RoomColors {
    return jungle
        ? { floor: 0x6f8a72, trim: 0x4b6150, wall: 0x5a7561, cap: 0x46604e, strip: 0xc6e5a7 }
        : { floor: 0x58697b, trim: 0x2f3d4f, wall: 0x2f405a, cap: 0x23324a, strip: 0x77deef };
}

/** Inward normal (room-local) of a wall side: the light strip sits on the inner face. */
const INWARD: Record<WallSide, [number, number]> = { back: [0, 1], front: [0, -1], left: [1, 0], right: [-1, 0] };

/** Build a room. `shellJungle` is the world's theme; the room's own theme wins when set. */
export function buildRoom(entity: RoomEntity, shellJungle: boolean): BuiltEntity {
    const jungle = entity.theme ? entity.theme === 'jungle' : shellJungle;
    const colors = roomColors(jungle);
    const root = new THREE.Group(); root.name = `omo-entity:${entity.id}`;
    // Selectable in build mode (userData.entity) but not a workstation: clicking a wall never opens anything.
    root.userData.entity = entity.id; root.userData.kind = 'room';
    placeRoot(root, entity);
    const H = ROOM_WALL_HEIGHT, t = ROOM_WALL_THICKNESS;
    // Shared materials per room: a room is ~20 meshes, not 20 materials.
    const wallMat = new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.78, metalness: 0.06 });
    const capMat = new THREE.MeshStandardMaterial({ color: colors.cap, roughness: 0.7, metalness: 0.1 });
    const stripMat = new THREE.MeshStandardMaterial({ color: colors.strip, emissive: colors.strip, emissiveIntensity: 0.9, roughness: 0.5 });
    const add = (parent: THREE.Object3D, size: [number, number, number], at: [number, number, number], mat: THREE.Material, cast = true): THREE.Mesh => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
        m.position.set(at[0], at[1], at[2]); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m;
    };
    // Floor slab with a darker trim band, so the room reads as a place from far away.
    add(root, [entity.width + t, 0.05, entity.depth + t], [0, 0.025, 0], new THREE.MeshStandardMaterial({ color: colors.trim, roughness: 0.8, metalness: 0.05 }), false);
    add(root, [entity.width - 0.3, 0.06, entity.depth - 0.3], [0, 0.03, 0], new THREE.MeshStandardMaterial({ color: colors.floor, roughness: 0.74, metalness: 0.05 }), false);
    const walls = new THREE.Group(); walls.name = 'omo-room-walls'; root.add(walls);
    for (const seg of roomWallSegments(entity)) {
        add(walls, [seg.sx, H, seg.sz], [seg.x, H / 2, seg.z], wallMat);
        add(walls, [seg.sx + 0.02, 0.06, seg.sz + 0.02], [seg.x, H + 0.03, seg.z], capMat, false);
        // Soft light strip on the inner face, just under the top edge.
        const [nx, nz] = INWARD[seg.side];
        const along = seg.sx > seg.sz;
        add(walls, [along ? seg.sx - 0.04 : 0.03, 0.045, along ? 0.03 : seg.sz - 0.04], [seg.x + nx * (t / 2 + 0.016), H - 0.2, seg.z + nz * (t / 2 + 0.016)], stripMat, false);
    }
    const lintels = new THREE.Group(); lintels.name = 'omo-room-lintels'; root.add(lintels);
    const doors = roomDoors(entity);
    const lh = H - ROOM_LINTEL_BOTTOM, ly = ROOM_LINTEL_BOTTOM + lh / 2;
    if (doors.has('back')) add(lintels, [ROOM_DOOR_WIDTH, lh, t], [0, ly, -entity.depth / 2], wallMat);
    if (doors.has('front')) add(lintels, [ROOM_DOOR_WIDTH, lh, t], [0, ly, entity.depth / 2], wallMat);
    if (doors.has('left')) add(lintels, [t, lh, ROOM_DOOR_WIDTH], [-entity.width / 2, ly, 0], wallMat);
    if (doors.has('right')) add(lintels, [t, lh, ROOM_DOOR_WIDTH], [entity.width / 2, ly, 0], wallMat);
    root.userData.roomWalls = walls; root.userData.roomLintels = lintels;
    return { root };
}

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
    return true;
}
