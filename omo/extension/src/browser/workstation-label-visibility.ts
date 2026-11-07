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
