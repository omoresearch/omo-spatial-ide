/**
 * w3:render — numbers that make big worlds draw well: fog, camera clip planes, the sun's shadow box and
 * the "far terminal" rule. Pure functions (no THREE state), so RoomScene stays a thin caller.
 *
 * A classic 12 x 10 room keeps every v1 number: fog 33..65, shadow box ±12 around the origin with the sun at
 * (-5, 12, 8). Bigger worlds scale fog with the world size and make the shadow box follow the player.
 */
import type { WorldShell } from '../common/world-model';

/** Overview distance scale: 1 for the v1 12 x 10 room, larger for bigger shells. */
export function worldScale(shell: Pick<WorldShell, 'width' | 'depth'>): number {
    return Math.max(1, shell.width / 12, shell.depth / 10);
}

/** v1 fog: starts at 33 m, solid at 65 m (the room backdrop). */
export const V1_FOG = { near: 33, far: 65 } as const;
/** Walking fog in big worlds never gets thinner than this many times v1 (a Minecraft-like view distance ~170 m). */
const WALK_FOG_MAX_SCALE = 2.6;

/** Fog for a shell and navigation mode. The overview stands far back, so its fog scales with the full world. */
export function worldFog(shell: Pick<WorldShell, 'width' | 'depth'>, mode: 'walk' | 'overview'): { near: number; far: number } {
    const s = worldScale(shell), k = mode === 'walk' ? Math.min(s, WALK_FOG_MAX_SCALE) : s;
    return { near: V1_FOG.near * k, far: V1_FOG.far * k };
}

/** Camera clip planes: far always >= 400 m and past the fog; near grows a little with far overview cameras (depth precision). */
export function cameraClip(shell: Pick<WorldShell, 'width' | 'depth'>, mode: 'walk' | 'overview'): { near: number; far: number } {
    const fog = worldFog(shell, mode), s = worldScale(shell);
    return { near: mode === 'walk' ? 0.1 : 0.1 * s, far: Math.max(400, Math.ceil(fog.far * 1.25)) };
}

/** The v1 sun: offset from the shadow centre, and the shadow box half size. */
export const V1_SUN = { x: -5, y: 12, z: 8, extent: 12 } as const;
/** Shadow box half size around the player when walking in a big world (~30 m), and at most this in the overview. */
export const FOLLOW_EXTENT = 30, OVERVIEW_EXTENT_MAX = 60;
/** The shadow centre moves in steps of this many metres: the shadow map is redrawn only on a step (no per-frame redraw, no shimmer). */
export const SHADOW_STEP = 4;

export interface ShadowFrame { cx: number; cz: number; extent: number }
/**
 * Where the sun's shadow box sits. A shell whose v1-style box (max(12, 0.75 x size)) is within the follow
 * size keeps the fixed v1 box around the origin (classic rooms, small worlds). Bigger worlds: walking = a ±30 m
 * box around the player, snapped to SHADOW_STEP; overview = a box around the origin, at most ±60 m.
 */
export function shadowFrame(shell: Pick<WorldShell, 'width' | 'depth'>, mode: 'walk' | 'overview', player: { x: number; z: number }): ShadowFrame {
    const fixed = Math.max(V1_SUN.extent, Math.max(shell.width, shell.depth) * 0.75);
    if (fixed <= FOLLOW_EXTENT) return { cx: 0, cz: 0, extent: fixed };
    if (mode === 'overview') return { cx: 0, cz: 0, extent: Math.min(fixed, OVERVIEW_EXTENT_MAX) };
    const snap = (v: number): number => Math.round(v / SHADOW_STEP) * SHADOW_STEP;
    return { cx: snap(player.x), cz: snap(player.z), extent: FOLLOW_EXTENT };
}
