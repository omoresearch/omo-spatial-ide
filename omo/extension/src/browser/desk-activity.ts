/**
 * w3:perf — poll budget for many live desks.
 *
 * Each desk has a priority set by the world widget from the active station and the player pose:
 *   active  the attached / selected desk          polls every 200 ms (the old rate)
 *   near    within reach, or visible and close    polls every 500 ms
 *   far     visible but distant                   polls every 3 s
 *   hidden  off-screen (behind you, widget hidden) polls every 3 s
 * A desk with no live view does not poll at all (the controller only polls an attached view).
 * Far and hidden desks still poll, so a bell or new output still reaches the desk lamp, only slower.
 * Input never waits for a poll: typing is sent at once whatever the priority.
 * Pure TypeScript: no DOM, no Theia.
 */

export type DeskPriority = 'active' | 'near' | 'far' | 'hidden';
export const DESK_PRIORITIES: readonly DeskPriority[] = ['active', 'near', 'far', 'hidden'];
export const POLL_BUDGET_MS: Readonly<Record<DeskPriority, number>> = { active: 200, near: 500, far: 3000, hidden: 3000 };
/** A desk nobody has ranked yet keeps the old rate, so nothing gets slower by accident. */
export const UNRANKED_POLL_MS = 200;
/** Within this distance a desk counts as near even when it is beside or behind you. */
export const REACH_M = 2.5;
/** A visible desk closer than this is near; further away it is far. */
export const NEAR_M = 12;
/** cos of the half view angle used for "visible" (wider than the camera so desks at the edge stay near). */
export const VIEW_COS = Math.cos(70 * Math.PI / 180);

export type DeskPriorityListener = (id: string, priority: DeskPriority | undefined) => void;

export class DeskActivity {
    private readonly priorities = new Map<string, DeskPriority>();
    private readonly listeners = new Set<DeskPriorityListener>();

    priority(id: string): DeskPriority | undefined { return this.priorities.get(id); }
    pollMs(id: string): number { const p = this.priorities.get(id); return p ? POLL_BUDGET_MS[p] : UNRANKED_POLL_MS; }
    /** Set one desk's priority. Unknown values are ignored; listeners hear only real changes. */
    setDeskPriority(id: string, priority: DeskPriority): void {
        if (typeof id !== 'string' || !id || !DESK_PRIORITIES.includes(priority)) return;
        if (this.priorities.get(id) === priority) return;
        this.priorities.set(id, priority);
        this.emit(id, priority);
    }
    /** Apply a full ranking (from classifyDesks). */
    setAll(ranking: Readonly<Record<string, DeskPriority>>): void { for (const [id, p] of Object.entries(ranking)) this.setDeskPriority(id, p); }
    /** Drop desks that left the world: they go back to unranked. */
    forget(ids: readonly string[]): void { for (const id of ids) if (this.priorities.delete(id)) this.emit(id, undefined); }
    subscribe(listener: DeskPriorityListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    snapshot(): Record<string, DeskPriority> { return Object.fromEntries(this.priorities); }
    private emit(id: string, priority: DeskPriority | undefined): void {
        this.listeners.forEach(l => { try { l(id, priority); } catch { /* a listener never breaks the world */ } });
    }
}

/** The one shared instance: the widget writes it, WorldStations (polls) and RoomScene (paints) read it. */
export const deskActivity = new DeskActivity();
export function setDeskPriority(id: string, priority: DeskPriority): void { deskActivity.setDeskPriority(id, priority); }

export interface DeskPlace {
    id: string;
    /** Where this desk can be seen: the desk itself plus any linked monitor wall / mirror. */
    points: ReadonlyArray<{ x: number; z: number }>;
}
export interface ClassifyInput {
    active?: string;
    pose: { x: number; z: number; yaw: number };
    desks: readonly DeskPlace[];
    /** Overview camera sees the whole room: every desk is visible. */
    overview?: boolean;
    /** The world view is not on screen at all. */
    hidden?: boolean;
}

const RANK: Record<DeskPriority, number> = { active: 0, near: 1, far: 2, hidden: 3 };

function pointPriority(pose: ClassifyInput['pose'], p: { x: number; z: number }): DeskPriority {
    const dx = p.x - pose.x, dz = p.z - pose.z, d = Math.hypot(dx, dz);
    if (d <= REACH_M) return 'near';
    // First-person forward is -z rotated by yaw (common/player-state.ts advancePlayer).
    const fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw);
    const visible = (dx * fx + dz * fz) / d >= VIEW_COS;
    if (!visible) return 'hidden';
    return d <= NEAR_M ? 'near' : 'far';
}

/** Rank every desk. The best of a desk's points wins (a wall in view keeps its desk near). */
export function classifyDesks(input: ClassifyInput): Record<string, DeskPriority> {
    const out: Record<string, DeskPriority> = {};
    for (const desk of input.desks) {
        if (desk.id === input.active) { out[desk.id] = input.hidden ? 'near' : 'active'; continue; }
        if (input.hidden) { out[desk.id] = 'hidden'; continue; }
        // Overview sees everything; a desk we cannot place is never slowed down past near.
        if (input.overview || !desk.points.length) { out[desk.id] = 'near'; continue; }
        let best: DeskPriority = 'hidden';
        for (const p of desk.points) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
            const next = pointPriority(input.pose, p);
            if (RANK[next] < RANK[best]) best = next;
        }
        out[desk.id] = best;
    }
    return out;
}
