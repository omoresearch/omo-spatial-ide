export interface PlayerPose { x: number; z: number; yaw: number; pitch: number; }
export const PLAYER_HOME: PlayerPose = { x: 0, z: 4.1, yaw: 0, pitch: 0 };
export function advancePlayer(player: PlayerPose, input: { forward: number; right: number }, seconds: number): PlayerPose {
    const length = Math.hypot(input.forward, input.right) || 1;
    const step = 2.7 * Math.max(0, Math.min(seconds, 0.1));
    const dx = (-Math.sin(player.yaw) * input.forward + Math.cos(player.yaw) * input.right) / length * step;
    const dz = (-Math.cos(player.yaw) * input.forward - Math.sin(player.yaw) * input.right) / length * step;
    const blocked = (x: number, z: number): boolean =>
        (x > -4.45 && x < -0.85 && z > -0.6 && z < 1.48)
        || (x > 0.45 && x < 4.05 && z > -1.55 && z < 0.53);
    let x = Math.max(-5.5, Math.min(5.5, player.x + dx));
    if (blocked(x, player.z)) x = player.x;
    let z = Math.max(-3.8, Math.min(4.45, player.z + dz));
    if (blocked(x, z)) z = player.z;
    return { ...player, x, z };
}
