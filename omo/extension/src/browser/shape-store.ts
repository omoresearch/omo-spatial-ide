/**
 * shape — the tiny shared state of Shape mode, so the top-bar button (world-topbar.tsx) and the
 * in-world experience (shape-mode.tsx) agree without passing props through the widget.
 * Nothing here touches the world: it only says whether Shape is open, and asks to toggle it.
 */
export const SHAPE_TOGGLE_EVENT = 'omo:shape-toggle';

type Listener = (open: boolean) => void;
let open = false;
const listeners = new Set<Listener>();

export const shapeStore = {
    get open(): boolean { return open; },
    set(next: boolean): void {
        if (next === open) return;
        open = next;
        if (typeof document !== 'undefined') document.body.classList.toggle('omo-shaping', open);
        for (const l of [...listeners]) { try { l(open); } catch { /* UI listener */ } }
    },
    subscribe(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    /** Ask the mounted Shape experience to open or close (the top-bar button uses this). */
    requestToggle(): void { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SHAPE_TOGGLE_EVENT)); }
};
