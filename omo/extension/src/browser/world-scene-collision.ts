/**
 * w2:render — walking collision built from a WorldSpec.
 *
 * Every entity has a footprint (an oriented rectangle on the floor). The player is a point; footprints
 * are padded instead. The rules match `advancePlayer` exactly for a v1 room: the room bounds of a
 * 12 x 10 shell are x ±5.5, z -3.8..4.45, and a desk blocks x ±1.8, z -1.1..+0.98 around its centre.
 * Movement slides along each axis separately, so walking into a desk at an angle glides along it.
 */
import type { PlayerPose } from '../common/player-state';
import type { WorldEntity, WorldShell, WorldSpec, DecorKind, Rect } from '../common/world-model';
import { roomRect, rooms } from '../common/world-model';
import { roomWallRects } from './world-scene-rooms'; // w3:render

/** A rectangle in entity-local floor space, before rotation and decor scale. */
export interface LocalRect { left: number; right: number; front: number; back: number }
/** A footprint in room space: centre, half extents along the entity's own axes, and its rotation. */
export interface Footprint { id: string; x: number; z: number; rotation: number; rect: LocalRect }

const DECOR_RECTS: Record<DecorKind, LocalRect | undefined> = {
    plant: { left: -0.42, right: 0.42, front: -0.42, back: 0.42 },
    lamp: { left: -0.28, right: 0.28, front: -0.28, back: 0.28 },
    crystal: { left: -0.5, right: 0.5, front: -0.5, back: 0.5 },
    sofa: { left: -1.3, right: 1.3, front: -0.6, back: 0.6 },
    bookshelf: { left: -0.9, right: 0.9, front: -0.32, back: 0.32 },
    whiteboard: { left: -1, right: 1, front: -0.34, back: 0.34 },
    rug: undefined,
    window: undefined
};
/** Padding around thin screens so the camera never clips into them. */
const WALL_PAD = 0.3;

/** The local floor rectangle an entity blocks, or undefined when the player may walk over it. */
export function entityRect(entity: WorldEntity): LocalRect | undefined {
    switch (entity.kind) {
        // v1 desk block (player-state deskBlocks): desk, chair and the space between.
        case 'station': return { left: -1.8, right: 1.8, front: -1.1, back: 0.98 };
        case 'monitor-wall': return { left: -entity.width / 2 - 0.1, right: entity.width / 2 + 0.1, front: -WALL_PAD, back: WALL_PAD };
        case 'web-wall': return { left: -entity.width / 2 - 0.11, right: entity.width / 2 + 0.11, front: -WALL_PAD, back: WALL_PAD };
        case 'mirror': return { left: -1.3, right: 1.3, front: -WALL_PAD, back: WALL_PAD };
        case 'review-screen': return { left: -1.08, right: 1.08, front: -WALL_PAD, back: WALL_PAD };
        case 'decor': {
            const rect = DECOR_RECTS[entity.decor]; if (!rect) return undefined;
            const s = entity.scale ?? 1;
            return { left: rect.left * s, right: rect.right * s, front: rect.front * s, back: rect.back * s };
        }
    }
}
export function footprints(world: WorldSpec): Footprint[] {
    const out: Footprint[] = [];
    for (const entity of world.entities) {
        const rect = entityRect(entity);
        if (rect) out.push({ id: entity.id, x: entity.transform.x, z: entity.transform.z, rotation: entity.transform.rotation, rect });
    }
    return out;
}
/** Room-space point -> entity-local floor point (THREE rotation.y convention). */
function local(f: Footprint, x: number, z: number): { lx: number; lz: number } {
    const dx = x - f.x, dz = z - f.z, c = Math.cos(f.rotation), s = Math.sin(f.rotation);
    return { lx: c * dx - s * dz, lz: s * dx + c * dz };
}
function round8(value: number): number { return Math.round(value * 100000000) / 100000000; }
export function inside(f: Footprint, x: number, z: number, pad = 0): boolean {
    const r = f.rect;
    if (f.rotation === 0) {
        // Exactly the v1 comparison (rounded bounds, strict interior) for unrotated footprints.
        return x > round8(f.x + r.left - pad) && x < round8(f.x + r.right + pad) && z > round8(f.z + r.front - pad) && z < round8(f.z + r.back + pad);
    }
    const { lx, lz } = local(f, x, z);
    return lx > r.left - pad && lx < r.right + pad && lz > r.front - pad && lz < r.back + pad;
}
/** Walkable bounds of a shell. A 12 x 10 shell gives the v1 bounds x ±5.5, z -3.8..4.45. */
export function walkBounds(shell: WorldShell): { minX: number; maxX: number; minZ: number; maxZ: number } {
    if (shell.open) return { minX: -shell.width / 2 + 0.4, maxX: shell.width / 2 - 0.4, minZ: -shell.depth / 2 + 0.4, maxZ: shell.depth / 2 - 0.4 }; // w3:render — open ground: walk to its edge
    return { minX: -shell.width / 2 + 0.5, maxX: shell.width / 2 - 0.5, minZ: -shell.depth / 2 + 1.2, maxZ: shell.depth / 2 - 0.55 };
}
/** Where the player stands on reset in this shell (PLAYER_HOME for a v1 room). */
export function worldHome(shell: WorldShell): PlayerPose {
    return { x: 0, z: Math.min(4.1, shell.depth / 2 - 0.9), yaw: 0, pitch: 0 };
}

/** A walking function bound to one world: same signature as advancePlayer without the layout. */
export type WorldMover = (player: PlayerPose, input: { forward: number; right: number }, seconds: number) => PlayerPose;
export function worldMover(world: WorldSpec): WorldMover {
    const blocks = footprints(world), b = walkBounds(world.shell);
    const walls = roomWalls(world); // w3:render — room walls block, doorways do not (empty for a classic world: exact v1 rules)
    const blocked = (x: number, z: number): boolean => blocks.some(f => inside(f, x, z)) || walls.some(r => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ);
    return (player, input, seconds) => {
        const length = Math.hypot(input.forward, input.right) || 1;
        const step = 2.7 * Math.max(0, Math.min(seconds, 0.1));
        const dx = (-Math.sin(player.yaw) * input.forward + Math.cos(player.yaw) * input.right) / length * step;
        const dz = (-Math.cos(player.yaw) * input.forward - Math.sin(player.yaw) * input.right) / length * step;
        let x = Math.max(b.minX, Math.min(b.maxX, player.x + dx));
        if (blocked(x, player.z)) x = player.x;
        let z = Math.max(b.minZ, Math.min(b.maxZ, player.z + dz));
        if (blocked(x, z)) z = player.z;
        return { ...player, x, z };
    };
}
/** Does a circle on the floor (a room prop) touch any footprint? Used to skip ambient props under entities. */
export function circleHits(blocks: readonly Footprint[], x: number, z: number, radius: number): boolean {
    return blocks.some(f => {
        const { lx, lz } = local(f, x, z), r = f.rect;
        const cx = Math.max(r.left, Math.min(r.right, lx)), cz = Math.max(r.front, Math.min(r.back, lz));
        return Math.hypot(lx - cx, lz - cz) < radius;
    });
}

// ----------------------------------------------------------------------------------------------- w3:render
/** The player keeps this far from a room wall (the camera never clips into it). */
export const ROOM_WALL_CLEARANCE = 0.25;
/** Every room wall piece in the world as a padded world rectangle (doorway gaps stay open: 1.6 - 2 x 0.25 = 1.1 m). */
export function roomWalls(world: WorldSpec): Rect[] {
    return rooms(world).flatMap(room => roomWallRects(room, ROOM_WALL_CLEARANCE));
}
/** Room floors as footprints: ambient shell props never grow inside a room. Not used for collision. */
export function roomFootprints(world: WorldSpec): Footprint[] {
    return rooms(world).map(room => {
        const r = roomRect(room), x = (r.minX + r.maxX) / 2, z = (r.minZ + r.maxZ) / 2;
        return { id: room.id, x, z, rotation: 0, rect: { left: r.minX - x - 0.3, right: r.maxX - x + 0.3, front: r.minZ - z - 0.3, back: r.maxZ - z + 0.3 } };
    });
}
