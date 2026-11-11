/**
 * w3:render — numbers that make big worlds draw well: fog, camera clip planes, the sun's shadow box and
 * the "far terminal" rule. Pure functions (no THREE state), so RoomScene stays a thin caller.
 *
 * A classic 12 x 10 room keeps every v1 number: fog 33..65, shadow box ±12 around the origin with the sun at
 * (-5, 12, 8). Bigger worlds scale fog with the world size and make the shadow box follow the player.
 */
import type { WorldShell, WorldSpec } from '../common/world-model';
import { entityRadius, roomRect } from '../common/world-model';

/**
 * w3:look — the overview camera of an OPEN world frames its content (rooms + entities, plus the spawn street),
 * not the whole ground (which can be 200 x 200 m). Returns the look-at point and the camera distance at the
 * default zoom (RoomScene scales it with the user's zoom). Closed shells keep the v1 camera (undefined).
 */
export interface OverviewView { azimuth: number; elevation: number; aspect: number; fov: number }
export interface OverviewFrame { target: { x: number; y: number; z: number }; distance: number }
/** Content may reach this fraction of half the screen (a little air for labels and the HUD). */
const FIT_MARGIN = 0.86;
/** Content height that must stay in view (room walls). */
const CONTENT_TOP = 2.8;
export function overviewFrame(world: Pick<WorldSpec, 'shell' | 'entities'>, view: OverviewView): OverviewFrame | undefined {
    if (!world.shell.open) return undefined;
    // The spawn street (worldHome) is always part of the picture: the player starts there.
    let minX = -3, maxX = 3, minZ = -2, maxZ = 4.5;
    for (const e of world.entities) {
        if (e.kind === 'room') { const r = roomRect(e); minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX); minZ = Math.min(minZ, r.minZ); maxZ = Math.max(maxZ, r.maxZ); continue; }
        const k = entityRadius(e), { x, z } = e.transform;
        minX = Math.min(minX, x - k); maxX = Math.max(maxX, x + k); minZ = Math.min(minZ, z - k); maxZ = Math.max(maxZ, z + k);
    }
    const target = { x: (minX + maxX) / 2, y: 0.7, z: (minZ + maxZ) / 2 };
    const corners: Array<[number, number, number]> = [];
    for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) for (const y of [0, CONTENT_TOP]) corners.push([x, y, z]);
    // Camera basis for this azimuth / elevation (same as RoomScene: position = target + dir * d, lookAt target).
    const { azimuth: a, elevation: el } = view;
    const dir = [Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)];
    const f = [-dir[0], -dir[1], -dir[2]];
    const rl = Math.hypot(f[2], f[0]) || 1, r = [-f[2] / rl, 0, f[0] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const t = Math.tan(view.fov * Math.PI / 360), aspect = Math.max(0.2, view.aspect);
    const fits = (d: number): boolean => corners.every(([x, y, z]) => {
        const v = [x - (target.x + dir[0] * d), y - (target.y + dir[1] * d), z - (target.z + dir[2] * d)];
        const depth = v[0] * f[0] + v[1] * f[1] + v[2] * f[2]; if (depth <= 0.5) return false;
        const sx = (v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) / (depth * t * aspect), sy = (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / (depth * t);
        return Math.abs(sx) <= FIT_MARGIN && Math.abs(sy) <= FIT_MARGIN;
    });
    let lo = 4, hi = 4000;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    return { target, distance: Math.max(10, hi) };
}

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

/** A station monitor farther than this from the player keeps its last painted frame (no canvas repaint, no upload). */
export const FAR_TERMINAL_M = 25;
/** Hysteresis: a parked monitor resumes painting only once the player is this much nearer (no flicker on the edge). */
export const FAR_TERMINAL_RESUME_M = 23;
export function terminalFar(player: { x: number; z: number }, at: { x: number; z: number }, parked: boolean): boolean {
    return Math.hypot(player.x - at.x, player.z - at.z) > (parked ? FAR_TERMINAL_RESUME_M : FAR_TERMINAL_M);
}
