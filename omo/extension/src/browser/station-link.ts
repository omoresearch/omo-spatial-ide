import type { RecipeStationId } from './station-recipe';
// w2:runtime — any world station id (type-only import keeps this file loadable under --experimental-strip-types).
const validRecipeStationId = (value: unknown): value is RecipeStationId => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value);

export const STATION_LINK_VERSION = 1 as const;
export const MIRROR_STATION_ID = 'monitor-mirror';
export interface StationLink {
    version: typeof STATION_LINK_VERSION;
    mirrorId: typeof MIRROR_STATION_ID;
    targetStationId: RecipeStationId;
}

const PREFIX = 'omo.station-links.v1:';
export function stationLinkKey(projectUri: string): string { return `${PREFIX}${JSON.stringify(projectUri)}`; }
export function defaultStationLink(): StationLink { return { version: 1, mirrorId: MIRROR_STATION_ID, targetStationId: 'terminal' }; }
export function validStationLink(value: unknown): value is StationLink {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && (value as StationLink).version === 1
        && (value as StationLink).mirrorId === MIRROR_STATION_ID
        && validRecipeStationId((value as StationLink).targetStationId); // w2:runtime — any station id
}
export function readStationLink(storage: { getItem(key: string): string | null } | undefined, projectUri: string): StationLink | undefined {
    try {
        const raw = storage?.getItem(stationLinkKey(projectUri));
        if (!raw || raw.length > 256) return undefined;
        const value = JSON.parse(raw);
        return validStationLink(value) ? { ...value } : undefined;
    } catch { return undefined; }
}
export function writeStationLink(storage: { setItem(key: string, value: string): void } | undefined, projectUri: string, link: StationLink): boolean {
    if (!validStationLink(link)) return false;
    try { storage?.setItem(stationLinkKey(projectUri), JSON.stringify(link)); return !!storage; } catch { return false; }
}

/** Full gain through 6 room units, then linear falloff to silence at 40. */
export function distanceGain(distance: number): number {
    if (!Number.isFinite(distance)) return 0;
    if (distance <= 6) return 1;
    if (distance >= 40) return 0;
    return Math.max(0, Math.min(1, 1 - (distance - 6) / 34));
}

export function webWallDistance(pose: { x: number; z: number }): number {
    return Math.hypot(pose.x, pose.z + 4.12);
}
