import type { RoomLayoutId } from './player-state';
export type RoomTheme = 'station' | 'jungle';
export interface RoomState {
    version: 1;
    theme: RoomTheme;
    projectUri: string;
    projectName: string;
    layout?: RoomLayoutId;
    camera: { azimuth: number; elevation: number; distance: number };
}
export function parseRoomState(raw: string | null, projectUri: string): RoomState | undefined {
    if (!raw) return undefined;
    try {
        const value = JSON.parse(raw);
        if (!value || value.version !== 1 || !['station', 'jungle'].includes(value.theme)
            || value.projectUri !== projectUri || typeof value.projectName !== 'string'
            || !value.projectName.trim() || value.projectName.length > 120
            || (value.layout !== undefined && value.layout !== 'classic' && value.layout !== 'wide')) return undefined;
        const c = value.camera;
        if (!c || !Number.isFinite(c.azimuth) || !Number.isFinite(c.elevation) || !Number.isFinite(c.distance)
            || c.elevation < 0.15 || c.elevation > 1.4 || c.distance < 10 || c.distance > 30) return undefined;
        const state: RoomState = { version: 1, theme: value.theme, projectUri, projectName: value.projectName,
            camera: { azimuth: c.azimuth, elevation: c.elevation, distance: c.distance } };
        if (value.layout !== undefined) state.layout = value.layout;
        return state;
    } catch { return undefined; }
}
