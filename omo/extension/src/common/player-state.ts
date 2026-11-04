export interface PlayerPose { x: number; z: number; yaw: number; pitch: number; }
export type RoomLayoutId = 'classic' | 'wide';
export interface RoomDeskPosition { x: number; z: number; }
export interface RoomLayout {
    label: string;
    description: string;
    desks: { terminal: RoomDeskPosition; 'terminal-2': RoomDeskPosition };
}
export const ROOM_LAYOUTS: Record<RoomLayoutId, RoomLayout> = {
    classic: {
        label: 'Classic',
        description: 'The familiar room with desks on each side.',
        desks: { terminal: { x: -2.65, z: 0.5 }, 'terminal-2': { x: 2.25, z: -0.45 } }
    },
    wide: {
        label: 'Wide aisle',
        description: 'A wider central aisle between the two desks.',
        desks: { terminal: { x: -3.3, z: -0.4 }, 'terminal-2': { x: 3.3, z: -0.4 } }
    }
};
export const PLAYER_HOME: PlayerPose = { x: 0, z: 4.1, yaw: 0, pitch: 0 };

interface DeskBlock { left: number; right: number; front: number; back: number; }
function round8(value: number): number { return Math.round(value * 100000000) / 100000000; }
function deskBlocks(layout: RoomLayout): DeskBlock[] {
    return Object.values(layout.desks).map(desk => ({
        left: round8(desk.x - 1.8),
        right: round8(desk.x + 1.8),
        front: round8(desk.z - 1.1),
        back: round8(desk.z + 0.98)
    }));
}

export function advancePlayer(
    player: PlayerPose,
    input: { forward: number; right: number },
    seconds: number,
    layout: RoomLayoutId = 'classic'
): PlayerPose {
    const length = Math.hypot(input.forward, input.right) || 1;
    const step = 2.7 * Math.max(0, Math.min(seconds, 0.1));
    const dx = (-Math.sin(player.yaw) * input.forward + Math.cos(player.yaw) * input.right) / length * step;
    const dz = (-Math.cos(player.yaw) * input.forward - Math.sin(player.yaw) * input.right) / length * step;
    const blocks = deskBlocks(ROOM_LAYOUTS[layout]);
    const blocked = (x: number, z: number): boolean =>
        blocks.some(block => x > block.left && x < block.right && z > block.front && z < block.back);
    let x = Math.max(-5.5, Math.min(5.5, player.x + dx));
    if (blocked(x, player.z)) x = player.x;
    let z = Math.max(-3.8, Math.min(4.45, player.z + dz));
    if (blocked(x, z)) z = player.z;
    return { ...player, x, z };
}
