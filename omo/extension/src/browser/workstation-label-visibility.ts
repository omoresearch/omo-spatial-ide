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
