/**
 * promise:share (L10) — "point at the same screen": a shared pointer.
 *
 * Hold Q while walking: a soft beam goes from your avatar to the spot you aim at, ending in a dot.
 * The ONLY thing shared is that spot: an optional `point: { x, y, z }` (room metres, cm precision) on
 * the pose that presence already sends ~5-10 times a second. No screen content, no text, no ids of
 * what you aim at — just a position. Others draw the beam from your avatar in your name colour.
 *
 * Pure module (no DOM / three) so the presence validators, the room server and the tests share it.
 */
import type { PlayerPose } from './player-state';

export interface SharedPoint { x: number; y: number; z: number }
/** A pose that may carry a pointer spot. */
export type PointingPose = PlayerPose & { point?: SharedPoint };

/** Bounds for a pointer spot: inside the largest world (200 m open ground), floor to a tall wall. */
export const POINT_LIMIT = { xz: 100, yMin: 0, yMax: 8 } as const;
/** A spot further than this from the avatar is not "pointing at a screen": it is refused. */
export const POINT_MAX_REACH = 30;
/** Hold this key (canvas focused, walking) to point. */
export const POINT_KEY = 'q';

const cm = (n: number): number => Math.round(n * 100) / 100;

/** A clean spot (rounded to cm) or undefined when the input is not a valid spot. Never throws. */
export function sharedPoint(input: unknown): SharedPoint | undefined {
    const p = input as SharedPoint;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
    if (![p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isFinite(n))) return undefined;
    if (Math.abs(p.x) > POINT_LIMIT.xz || Math.abs(p.z) > POINT_LIMIT.xz || p.y < POINT_LIMIT.yMin || p.y > POINT_LIMIT.yMax) return undefined;
    return { x: cm(p.x), y: cm(p.y), z: cm(p.z) };
}

/** Attach a validated spot to a clean pose (only when it is within reach of that pose). */
export function withPoint<T extends PlayerPose>(pose: T, point: unknown): T & { point?: SharedPoint } {
    const clean = sharedPoint(point);
    const out: T & { point?: SharedPoint } = { ...pose };
    delete out.point;
    if (clean && Math.hypot(clean.x - pose.x, clean.z - pose.z) <= POINT_MAX_REACH) out.point = clean;
    return out;
}

/** The exact pose message that goes on the wire: x, z, yaw, pitch and (when pointing) point{x,y,z}. Nothing else. */
export function pointerPoseMessage(pose: PlayerPose, point?: SharedPoint): PointingPose {
    const base: PointingPose = { x: pose.x, z: pose.z, yaw: pose.yaw, pitch: pose.pitch };
    return point ? withPoint(base, point) : base;
}

/** What a viewer draws for each OTHER member who is pointing: a beam from their chest to the spot, in their colour. */
export interface PointerBeam { id: string; name: string; colour?: string; from: SharedPoint; to: SharedPoint }
export const BEAM_CHEST_HEIGHT = 1.3;
export function pointerBeams(members: ReadonlyArray<{ id: string; name: string; colour?: string; pose: PointingPose }>, selfId?: string): PointerBeam[] {
    const out: PointerBeam[] = [];
    for (const m of members) {
        if (m.id === selfId || !m.pose) continue;
        const to = sharedPoint(m.pose.point);
        if (!to || Math.hypot(to.x - m.pose.x, to.z - m.pose.z) > POINT_MAX_REACH) continue;
        out.push({ id: m.id, name: m.name, ...(m.colour ? { colour: m.colour } : {}), from: { x: m.pose.x, y: BEAM_CHEST_HEIGHT, z: m.pose.z }, to });
    }
    return out;
}
