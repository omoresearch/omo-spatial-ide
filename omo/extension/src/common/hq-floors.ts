/**
 * HQ floors (HQ-FLOORS.md) — an HQ world is the penthouse kit world plus `floors`: room entities flagged `floor: true`,
 * each its own floor high above the city at floorSpot(i), each showing one baked module (library / lounge / studio).
 * Pure data: the rail list, the seed ops ('Make HQ floors') and where a walker lands on a floor.
 */
import type { RoomEntity, StationEntity, WorldEntity, WorldOp, WorldSpec } from './world-model';
import { defaultStation, floorRooms, roomRect } from './world-model';
import type { RoomModuleId } from './room-modules';
import { MODULES, MODULE_DEPTH, MODULE_WIDTH, floorSpawn, floorSpot, isRoomModule, toWorld } from './room-modules';

/** The id the HQ (the penthouse itself) has in the rail. */
export const HQ_ID = 'hq';

export interface RailEntry {
    /** HQ_ID for the penthouse, else the floor room's id. */
    id: string;
    label: string;
    /** 'hq' for the penthouse, else the floor's module. */
    icon: 'hq' | RoomModuleId;
    /** Desks on this floor (stations standing inside it; for the HQ: stations not on any floor). */
    desks: number;
}

/** True when a point stands inside a room's rectangle. */
function inside(r: RoomEntity, p: { x: number; z: number }): boolean {
    const b = roomRect(r);
    return p.x >= b.minX - 1e-6 && p.x <= b.maxX + 1e-6 && p.z >= b.minZ - 1e-6 && p.z <= b.maxZ + 1e-6;
}

/** The rail: HQ first, then every floor room in entity order. Empty when the world has no floors (no rail). */
export function railEntries(world: Pick<WorldSpec, 'entities' | 'name'>): RailEntry[] {
    const floors = floorRooms(world);
    if (!floors.length) return [];
    const st = world.entities.filter((e): e is StationEntity => e.kind === 'station');
    const on = (r: RoomEntity): number => st.filter(s => inside(r, s.transform)).length;
    const hqDesks = st.filter(s => !floors.some(f => inside(f, s.transform))).length;
    return [
        { id: HQ_ID, label: 'HQ', icon: 'hq', desks: hqDesks },
        ...floors.map(f => ({ id: f.id, label: f.label ?? MODULES[isRoomModule(f.module) ? f.module : 'lounge'].label, icon: isRoomModule(f.module) ? f.module : 'lounge' as RoomModuleId, desks: on(f) }))
    ];
}

/** Where the walker lands on a floor: just inside its door, facing the glass. */
export function floorArrival(room: RoomEntity): { x: number; z: number; yaw: number } { return floorSpawn(room.transform); }

/** The seed floors of the HQ world for this project. */
export const HQ_SEED: ReadonlyArray<{ id: string; label: string; module: RoomModuleId; desks: number }> = [
    { id: 'floor-library', label: 'Library', module: 'library', desks: 0 },
    { id: 'floor-lounge', label: 'Lounge', module: 'lounge', desks: 0 },
    { id: 'floor-studio', label: 'Studio', module: 'studio', desks: 3 }
];

/**
 * 'Make HQ floors': ops that turn a penthouse world into the HQ world: one floor room per HQ_SEED entry at
 * floorSpot(i) (after any floors already there), and the studio's desks as live shell stations on the studio's desk
 * anchors (toWorld). Floors already present (same id) are left alone. Empty when nothing is missing.
 */
export function hqFloorOps(world: WorldSpec): WorldOp[] {
    const ops: WorldOp[] = [];
    const have = new Set(world.entities.map(e => e.id));
    let next = floorRooms(world).length;
    for (const seed of HQ_SEED) {
        if (have.has(seed.id)) continue;
        const at = floorSpot(next++);
        const room: RoomEntity = { id: seed.id, kind: 'room', label: seed.label, transform: at, width: MODULE_WIDTH, depth: MODULE_DEPTH, theme: 'skyline', doors: ['front'], module: seed.module, floor: true };
        ops.push({ op: 'add', entity: room });
        MODULES[seed.module].desks.slice(0, seed.desks).forEach((d, i) => {
            const id = `${seed.id}-desk-${i + 1}`;
            if (have.has(id)) return;
            const station: WorldEntity = { id, kind: 'station', label: `${seed.label} desk ${i + 1}`, transform: toWorld(at, d), station: defaultStation(`${seed.label} desk ${i + 1}`, 'shell') };
            ops.push({ op: 'add', entity: station });
        });
    }
    return ops;
}
