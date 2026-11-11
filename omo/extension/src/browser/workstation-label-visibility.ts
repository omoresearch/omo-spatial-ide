export type WorkstationLabelMode = 'walk' | 'overview';

export function workstationLabelVisible(
  mode: WorkstationLabelMode,
  projectedZ: number,
  distance: number | undefined,
): boolean {
  if (!Number.isFinite(projectedZ) || projectedZ < -1 || projectedZ > 1) return false;
  if (mode === 'overview') return true;
  return distance !== undefined && Number.isFinite(distance) && distance >= 0 && distance <= 3.2;
}

/**
 * t3:polish2 — screen-space label layout. Labels are centred boxes; each one keeps its projected spot when free,
 * else it moves up (away from the screens below it) or down in label-height steps until it no longer touches a
 * placed label. Front labels (larger y) are placed first so the nearest things keep their exact spot.
 */
export function layoutLabels<T extends { x: number; y: number; w: number; h: number }>(items: readonly T[], gap = 4): T[] {
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const hits = (x: number, y: number, w: number, h: number): boolean => placed.some(p => Math.abs(p.x - x) * 2 < p.w + w + gap * 2 && Math.abs(p.y - y) * 2 < p.h + h + gap);
    const out: T[] = [];
    for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const step = item.h + gap;
        let y = item.y;
        for (const k of [0, -1, -2, 1, -3, 2, -4, 3, -5]) { const c = item.y + k * step; if (!hits(item.x, c, item.w, item.h)) { y = c; break; } }
        placed.push({ x: item.x, y, w: item.w, h: item.h }); out.push({ ...item, y });
    }
    return out;
}

/**
 * w3:look — overview labels of an open world: no stacking. Each label keeps its anchored spot next to its object;
 * one that would touch an already placed label is hidden instead (zooming in shows it again). Lower `priority`
 * is placed first (room names 0, desk chips 1, other screens 2), then front labels (larger y), then left to right.
 * Returns every item, in input order, with `hidden`.
 */
export function declutterLabels<T extends { x: number; y: number; w: number; h: number; priority?: number }>(items: readonly T[], gap = 3): Array<T & { hidden: boolean }> {
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const hidden = new Set<T>();
    const order = [...items].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1) || b.y - a.y || a.x - b.x);
    for (const item of order) {
        const hits = placed.some(p => Math.abs(p.x - item.x) * 2 < p.w + item.w + gap * 2 && Math.abs(p.y - item.y) * 2 < p.h + item.h + gap * 2);
        if (hits) hidden.add(item); else placed.push(item);
    }
    return items.map(item => ({ ...item, hidden: hidden.has(item) }));
}
/** w3:look — the short overview chip of a label: the desk number ("03  Desk three ↗" -> "03"), else the title without the arrow. */
export function chipText(text: string): string {
    const number = /^(\d+)\s/.exec(text);
    return number ? number[1] : text.replace(/\s*↗$/, '');
}
