/**
 * w3:perf — texture budget for many live desk monitors.
 *
 * RoomScene asks this budget to repaint a desk's terminal canvas only when that desk's frame changed
 * (RoomScene already skips an unchanged frame). The budget then:
 *   - paints the active desk (and any desk nobody ranked) at once, so typing never waits;
 *   - holds a hidden desk's paint until the desk is visible again (only its newest frame is kept);
 *   - paints near / far desks on the next animation frame, at most `max` per frame, round-robin:
 *     desks already waiting go before a desk that just painted.
 * The desk lamp and inspection data are not part of this budget: RoomScene updates them at once.
 * Pure TypeScript: no DOM types beyond an optional requestAnimationFrame.
 */
import type { DeskPriority } from './desk-activity';
import { deskActivity } from './desk-activity';

export const MONITOR_PAINTS_PER_FRAME = 6;

export interface MonitorPaintBudgetOptions {
    /** Most monitor repaints per animation frame (default 6). */
    max?: number;
    /** Desk priority (default: the shared deskActivity). */
    priority?: (id: string) => DeskPriority | undefined;
    /** Request one callback on the next animation frame (default requestAnimationFrame). */
    schedule?: (fn: () => void) => unknown;
    /** Deferred paints changed pixels: the owner should render a frame. */
    onPainted?: () => void;
    /** The owner is gone: drop everything (checked before each frame). */
    alive?: () => boolean;
}

function nextFrame(fn: () => void): unknown {
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    return raf ? raf(fn) : setTimeout(fn, 16);
}

export class MonitorPaintBudget {
    private readonly queue = new Map<string, () => boolean>();
    private readonly max: number;
    private readonly priority: (id: string) => DeskPriority | undefined;
    private readonly schedule: (fn: () => void) => unknown;
    private readonly options: MonitorPaintBudgetOptions;
    private scheduled = false;
    private disposed = false;
    private offActivity?: () => void;
    /** Counters for probes: paints run at once, paints run from the queue, frames used. */
    readonly stats = { immediate: 0, deferred: 0, frames: 0 };

    constructor(options: MonitorPaintBudgetOptions = {}) {
        this.options = options;
        this.max = Math.max(1, Math.floor(options.max ?? MONITOR_PAINTS_PER_FRAME));
        this.priority = options.priority ?? (id => deskActivity.priority(id));
        this.schedule = options.schedule ?? nextFrame;
    }

    /** Number of desks waiting for a repaint (hidden ones included). */
    get pending(): number { return this.queue.size; }

    /**
     * Repaint `id` with `paint` (returns whether pixels changed). Returns `paint()`'s result when it ran
     * at once, else false (the owner is told through onPainted when the queued paint runs).
     */
    request(id: string, paint: () => boolean): boolean {
        if (this.disposed) return false;
        const p = this.priority(id);
        if (p === undefined || p === 'active') { this.queue.delete(id); this.stats.immediate++; return paint(); }
        this.queue.set(id, paint); // a queued desk keeps its place; only its newest frame is painted
        this.listen();
        if (p !== 'hidden') this.wake();
        return false;
    }
    /** A desk's priority changed: a desk that became visible gets its held paint scheduled. */
    priorityChanged(id: string): void {
        if (this.disposed) return;
        if (this.options.alive && !this.options.alive()) { this.dispose(); return; }
        if (!this.queue.has(id)) return;
        const p = this.priority(id);
        if (p === undefined || p === 'active') { const paint = this.queue.get(id)!; this.queue.delete(id); this.stats.immediate++; this.unlisten(); if (paint()) this.options.onPainted?.(); return; }
        if (p !== 'hidden') this.wake();
    }
    /** Hear priority changes of the shared deskActivity only while paints are held (no listener leak after the scene is gone). */
    private listen(): void { if (!this.options.priority && !this.offActivity && !this.disposed) this.offActivity = deskActivity.subscribe(id => this.priorityChanged(id)); }
    private unlisten(): void { if (!this.queue.size && this.offActivity) { this.offActivity(); this.offActivity = undefined; } }
    /** Forget a desk (its monitor left the room). */
    drop(id: string): void { this.queue.delete(id); this.unlisten(); }
    dispose(): void { this.disposed = true; this.queue.clear(); this.offActivity?.(); this.offActivity = undefined; }

    private wake(): void {
        if (this.scheduled || this.disposed) return;
        this.scheduled = true;
        this.schedule(() => { this.scheduled = false; this.flush(); });
    }
    private flush(): void {
        if (this.disposed) return;
        if (this.options.alive && !this.options.alive()) { this.dispose(); return; }
        this.stats.frames++;
        let budget = this.max, changed = false, more = false;
        for (const [id, paint] of [...this.queue]) {
            if (this.priority(id) === 'hidden') continue;
            if (budget <= 0) { more = true; break; }
            this.queue.delete(id); budget--; this.stats.deferred++;
            try { if (paint()) changed = true; } catch { /* one bad monitor never stops the others */ }
        }
        this.unlisten();
        if (changed) this.options.onPainted?.();
        if (more) this.wake();
    }
}
