export type RoomTheme = 'station' | 'jungle';
export interface RoomState {
    version: 1;
    theme: RoomTheme;
    projectUri: string;
    projectName: string;
    camera: { azimuth: number; elevation: number; distance: number };
}
export function parseRoomState(raw: string | null, projectUri: string): RoomState | undefined {
    if (!raw) return undefined;
    try {
        const value = JSON.parse(raw);
        if (!value || value.version !== 1 || !['station', 'jungle'].includes(value.theme)
            || value.projectUri !== projectUri || typeof value.projectName !== 'string'
            || !value.projectName.trim() || value.projectName.length > 120) return undefined;
        const c = value.camera;
        if (!c || !Number.isFinite(c.azimuth) || !Number.isFinite(c.elevation) || !Number.isFinite(c.distance)
            || c.elevation < 0.15 || c.elevation > 1.4 || c.distance < 10 || c.distance > 30) return undefined;
        return { version: 1, theme: value.theme, projectUri, projectName: value.projectName,
            camera: { azimuth: c.azimuth, elevation: c.elevation, distance: c.distance } };
    } catch { return undefined; }
}
