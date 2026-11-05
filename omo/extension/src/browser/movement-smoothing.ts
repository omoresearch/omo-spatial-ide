import type { PlayerPose } from '../common/player-state';

/**
 * Frame-rate independent smoothing for the first-person view.
 *
 * The walker's pose stays the authority (collision, saved position, presence). The camera follows it
 * with a short critically-damped lag, so key-repeat turns and start/stop steps ease in instead of
 * snapping, at any refresh rate. `damp` is exact for any frame time, so 60 Hz and 144 Hz look the same.
 */
export function damp(current: number, target: number, tau: number, seconds: number): number {
    if (tau <= 0 || seconds <= 0) return seconds <= 0 ? current : target;
    return target + (current - target) * Math.exp(-seconds / tau);
}

/** Shortest signed angle from a to b, so smoothing never spins the long way round. */
export function angleDelta(a: number, b: number): number {
    const d = (b - a) % (Math.PI * 2);
    return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d;
}

export interface SmoothingTimes {
    /** Position lag in seconds. ~70 ms reads as acceleration without feeling floaty. */
    move: number;
    /** View lag in seconds. Short, so mouse look stays direct. */
    look: number;
}

export const DEFAULT_SMOOTHING: SmoothingTimes = { move: 0.07, look: 0.035 };
/** Below these the view is treated as arrived; the render loop may go idle. */
const SETTLE_DISTANCE = 0.0005, SETTLE_ANGLE = 0.0002;

export class PoseSmoother {
    private current?: PlayerPose;
    constructor(private readonly times: SmoothingTimes = DEFAULT_SMOOTHING) {}
    /** Jump to a pose (teleport, reset, layout change). */
    snap(pose: PlayerPose): PlayerPose { this.current = { ...pose }; return this.current; }
    /** Advance toward the target pose by `seconds`. Returns the pose to draw. */
    step(target: PlayerPose, seconds: number): PlayerPose {
        const c = this.current;
        // Large jumps are teleports (reset, saved position), not movement: do not glide across the room.
        if (!c || Math.hypot(target.x - c.x, target.z - c.z) > 1.5) return this.snap(target);
        const dt = Math.min(Math.max(seconds, 0), 0.1);
        c.x = damp(c.x, target.x, this.times.move, dt);
        c.z = damp(c.z, target.z, this.times.move, dt);
        c.yaw = target.yaw - damp(angleDelta(c.yaw, target.yaw), 0, this.times.look, dt);
        c.pitch = damp(c.pitch, target.pitch, this.times.look, dt);
        return c;
    }
    /** True when the drawn pose has reached the target: no more frames are needed for motion. */
    settled(target: PlayerPose): boolean {
        const c = this.current;
        return !!c && Math.abs(c.x - target.x) < SETTLE_DISTANCE && Math.abs(c.z - target.z) < SETTLE_DISTANCE
            && Math.abs(angleDelta(c.yaw, target.yaw)) < SETTLE_ANGLE && Math.abs(c.pitch - target.pitch) < SETTLE_ANGLE;
    }
}

/**
 * Pointer-lock mouse look for FirstPersonControls (integration point for the controls owner; not wired yet).
 * Call `request()` from a user gesture; `onLook(dx, dy)` then receives raw movement deltas with no cursor
 * edge limits. Esc or `exit()` releases it. Clicking monitors needs the crosshair centre while locked.
 */
export class PointerLockLook {
    private readonly listeners: Array<() => void> = [];
    constructor(private readonly element: HTMLElement, onLook: (dx: number, dy: number) => void, onChange?: (locked: boolean) => void) {
        const move = (event: MouseEvent): void => { if (this.locked) onLook(event.movementX, event.movementY); };
        const change = (): void => onChange?.(this.locked);
        document.addEventListener('mousemove', move);
        document.addEventListener('pointerlockchange', change);
        this.listeners.push(() => document.removeEventListener('mousemove', move), () => document.removeEventListener('pointerlockchange', change));
    }
    get locked(): boolean { return document.pointerLockElement === this.element; }
    request(): void { if (!this.locked) void Promise.resolve(this.element.requestPointerLock?.()).catch(() => undefined); }
    exit(): void { if (this.locked) document.exitPointerLock(); }
    dispose(): void { this.exit(); this.listeners.forEach(off => off()); }
}
