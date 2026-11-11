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
/**
 * w3:look — readable rooms: light plaster walls with a dark cap line (they stand out from the floor, the ground
 * and the desks inside), a darker floor, and doorways framed in the theme's accent colour.
 */
interface LookColors { wall: number; cap: number; floor: number; accent: number; plateInk: string; plateBg: string }
function lookColors(jungle: boolean): LookColors {
    return jungle
        ? { wall: 0xe6e1cc, cap: 0x4b6150, floor: 0x5d7461, accent: 0xb9dc8f, plateInk: '#eef7dc', plateBg: 'rgba(37, 56, 44, 0.86)' }
        : { wall: 0xdfe5ec, cap: 0x3a4a5f, floor: 0x46566a, accent: 0x6fd3e0, plateInk: '#eaf6fb', plateBg: 'rgba(22, 34, 50, 0.86)' };
}
/** A flat name plate texture (null outside a browser: tests build rooms in Node). */
function nameTexture(text: string, colors: LookColors): THREE.CanvasTexture | undefined {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 224;
    const c = canvas.getContext('2d'); if (!c) return undefined;
    c.fillStyle = colors.plateBg; c.beginPath(); c.roundRect?.(8, 8, 1008, 208, 40); c.fill();
    c.fillStyle = colors.plateInk; c.font = '600 112px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text.toUpperCase(), 512, 118, 960);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
    return texture;
}

/** Inward normal (room-local) of a wall side: the light strip sits on the inner face. */
const INWARD: Record<WallSide, [number, number]> = { back: [0, 1], front: [0, -1], left: [1, 0], right: [-1, 0] };

/** Build a room. `shellJungle` is the world's theme; the room's own theme wins when set. */
export function buildRoom(entity: RoomEntity, shellJungle: boolean): BuiltEntity {
    const jungle = entity.theme ? entity.theme === 'jungle' : shellJungle;
    const colors = roomColors(jungle), look = lookColors(jungle);
    const root = new THREE.Group(); root.name = `omo-entity:${entity.id}`;
    // Selectable in build mode (userData.entity) but not a workstation: clicking a wall never opens anything.
    root.userData.entity = entity.id; root.userData.kind = 'room';
    placeRoot(root, entity);
    const H = ROOM_WALL_HEIGHT, t = ROOM_WALL_THICKNESS;
    // Shared materials per room: a room is ~20 meshes, not 20 materials.
    const wallMat = new THREE.MeshStandardMaterial({ color: look.wall, roughness: 0.86, metalness: 0.02 }); // w3:look — light walls
    const capMat = new THREE.MeshStandardMaterial({ color: look.cap, roughness: 0.7, metalness: 0.1 });
    const stripMat = new THREE.MeshStandardMaterial({ color: colors.strip, emissive: colors.strip, emissiveIntensity: 0.9, roughness: 0.5 });
    const glassMat = new THREE.MeshStandardMaterial({ color: jungle ? 0x2f4a45 : 0x2c3e52, emissive: jungle ? 0x3d6b5a : 0x35587a, emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.4 }); // w3:look (7)
    const accentMat = new THREE.MeshStandardMaterial({ color: look.accent, emissive: look.accent, emissiveIntensity: 0.35, roughness: 0.55 });
    const add = (parent: THREE.Object3D, size: [number, number, number], at: [number, number, number], mat: THREE.Material, cast = true, part?: string): THREE.Mesh => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
        m.position.set(at[0], at[1], at[2]); m.castShadow = cast; m.receiveShadow = true; if (part) m.userData.part = part; parent.add(m); return m;
    };
    // Floor slab with a dark trim band, so the room reads as a place from far away.
    add(root, [entity.width + t, 0.05, entity.depth + t], [0, 0.025, 0], new THREE.MeshStandardMaterial({ color: look.cap, roughness: 0.8, metalness: 0.05 }), false, 'trim');
    add(root, [entity.width - 0.3, 0.06, entity.depth - 0.3], [0, 0.03, 0], new THREE.MeshStandardMaterial({ color: look.floor, roughness: 0.74, metalness: 0.05 }), false, 'floor');
    const walls = new THREE.Group(); walls.name = 'omo-room-walls'; root.add(walls);
    for (const seg of roomWallSegments(entity)) {
        add(walls, [seg.sx, H, seg.sz], [seg.x, H / 2, seg.z], wallMat, true, 'wall');
        add(walls, [seg.sx + 0.02, 0.06, seg.sz + 0.02], [seg.x, H + 0.03, seg.z], capMat, false, 'cap');
        // Soft light strip on the inner face, just under the top edge.
        const [nx, nz] = INWARD[seg.side];
        const along = seg.sx > seg.sz;
        add(walls, [along ? seg.sx - 0.04 : 0.03, 0.045, along ? 0.03 : seg.sz - 0.04], [seg.x + nx * (t / 2 + 0.016), H - 0.2, seg.z + nz * (t / 2 + 0.016)], stripMat, false);
        // w3:look (7) — outer face detail: a dark base trim and a window band on long wall pieces.
        const ox = -nx * (t / 2 + 0.012), oz = -nz * (t / 2 + 0.012), len = along ? seg.sx : seg.sz;
        add(walls, [along ? seg.sx : 0.02, 0.28, along ? 0.02 : seg.sz], [seg.x + ox, 0.14, seg.z + oz], capMat, false, 'base-trim');
        if (len >= 2.2) {
            const n = Math.max(1, Math.floor((len - 0.6) / 2.2)), pane = Math.min(1.7, (len - 0.6) / n - 0.4);
            for (let i = 0; i < n; i++) {
                const off = -len / 2 + 0.3 + (len - 0.6) * (i + 0.5) / n;
                add(walls, [along ? pane : 0.02, 0.9, along ? 0.02 : pane], [seg.x + ox * 1.4 + (along ? off : 0), 1.55, seg.z + oz * 1.4 + (along ? 0 : off)], glassMat, false, 'window');
            }
        }
    }
    const lintels = new THREE.Group(); lintels.name = 'omo-room-lintels'; root.add(lintels);
    const doors = roomDoors(entity);
    const lh = H - ROOM_LINTEL_BOTTOM, ly = ROOM_LINTEL_BOTTOM + lh / 2;
    // w3:look — every doorway: accent jamb posts either side (they scale with the cutaway walls) and a threshold strip.
    const J = 0.12, half = ROOM_DOOR_WIDTH / 2;
    const doorAt: Record<WallSide, { x: number; z: number; alongX: boolean }> = {
        back: { x: 0, z: -entity.depth / 2, alongX: true }, front: { x: 0, z: entity.depth / 2, alongX: true },
        left: { x: -entity.width / 2, z: 0, alongX: false }, right: { x: entity.width / 2, z: 0, alongX: false }
    };
    for (const side of WALL_ORDER) {
        if (!doors.has(side)) continue;
        const d = doorAt[side];
        add(lintels, d.alongX ? [ROOM_DOOR_WIDTH, lh, t] : [t, lh, ROOM_DOOR_WIDTH], [d.x, ly, d.z], wallMat);
        // w3:look (5) — the dark cap continues over the doorway (lintel + both jamb tops): no step in the cap line.
        const span = ROOM_DOOR_WIDTH + 2 * J, deep = t + 0.08;
        add(lintels, d.alongX ? [span, 0.06, deep] : [deep, 0.06, span], [d.x, H + 0.03, d.z], capMat, false, 'door-cap');
        for (const s of [-1, 1]) {
            const o = s * (half + J / 2 - 0.02); // over the wall end: the walkable gap stays exactly as wide as collision says
            add(walls, d.alongX ? [J, H, t + 0.06] : [t + 0.06, H, J], [d.x + (d.alongX ? o : 0), H / 2, d.z + (d.alongX ? 0 : o)], accentMat, true, 'jamb');
        }
        // w3:look (5) — the threshold stays within the jamb depth (it used to stick 0.25 m out of both wall faces: a light wedge on the ground).
        add(root, d.alongX ? [ROOM_DOOR_WIDTH - 2 * J, 0.02, t + 0.06] : [t + 0.06, 0.02, ROOM_DOOR_WIDTH - 2 * J], [d.x, 0.07, d.z], accentMat, false, 'threshold');
    }
    // w3:look — the room's name on a floor plate just outside its main doorway; it always reads from the +z side
    // (the overview camera), whatever the room's quarter turn.
    const main = doors.has('front') ? 'front' : WALL_ORDER.find(s => doors.has(s));
    if (main) {
        const name = (entity.label ?? 'Room').slice(0, 40), d = doorAt[main];
        const out = 0.85, nx = main === 'left' ? -out : main === 'right' ? out : 0, nz = main === 'back' ? -out : main === 'front' ? out : 0;
        const map = nameTexture(name, look);
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.44), new THREE.MeshBasicMaterial({ color: map ? 0xffffff : look.cap, map, transparent: true, depthWrite: false }));
        plate.rotation.set(-Math.PI / 2, -entity.transform.rotation, 0, 'YXZ'); // flat on the floor, text upright for a +z viewer
        plate.position.set(d.x + nx, 0.06, d.z + nz); plate.renderOrder = 1; (plate.material as THREE.MeshBasicMaterial).polygonOffset = true; (plate.material as THREE.MeshBasicMaterial).polygonOffsetFactor = -2;
        plate.userData.part = 'name-plate'; plate.userData.roomName = name; plate.userData.ownsMap = true; plate.raycast = () => undefined;
        root.add(plate);
        // w3:look (7) — a floating, camera-facing room title above the room: readable in overview and from afar.
        const title = nameTexture(name, look);
        if (title) {
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: title, transparent: true, depthWrite: false, fog: false }));
            const w = Math.min(9, Math.max(4.4, entity.width * 0.7)); sprite.scale.set(w, w * 224 / 1024, 1);
            sprite.position.set(0, H + 1.1, -entity.depth / 2 + 0.2); // over the back wall: clear of the desk chips sprite.renderOrder = 2; sprite.userData.part = 'room-title'; sprite.userData.ownsMap = true; sprite.raycast = () => undefined;
            root.add(sprite);
        }
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
    return true;
}
