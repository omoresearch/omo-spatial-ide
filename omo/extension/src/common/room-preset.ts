import type { RoomState, RoomTheme } from './room-state';
import type { RoomLayoutId } from './player-state';

export const ROOM_PRESET_MAX_BYTES = 8192;
export const ROOM_PRESET_FILENAME = 'omo-room-preset.json';

export interface RoomPreset {
    format: 'omo-room-preset';
    version: 1;
    theme: RoomTheme;
    layout: RoomLayoutId;
    camera: { azimuth: number; elevation: number; distance: number };
}

const PRESET_KEYS = ['format', 'version', 'theme', 'layout', 'camera'] as const;
const CAMERA_KEYS = ['azimuth', 'elevation', 'distance'] as const;

function invalidPreset(): never {
    throw new Error('Invalid room preset');
}

function oversizedPreset(): never {
    throw new Error('Room preset exceeds 8192 bytes');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isUtf8WithinLimit(value: string): boolean {
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const first = value.charCodeAt(index);
        let codePoint = first;
        if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
            const second = value.charCodeAt(index + 1);
            if (second >= 0xdc00 && second <= 0xdfff) {
                codePoint = 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00;
                index++;
            }
        }
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        if (bytes > ROOM_PRESET_MAX_BYTES) return false;
    }
    return true;
}

function validTheme(value: unknown): value is RoomTheme {
    return value === 'station' || value === 'jungle';
}

function validLayout(value: unknown): value is RoomLayoutId {
    return value === 'classic' || value === 'wide';
}

function validCamera(camera: Record<string, unknown>): boolean {
    return Number.isFinite(camera.azimuth)
        && Number.isFinite(camera.elevation)
        && Number.isFinite(camera.distance)
        && (camera.elevation as number) >= 0.15
        && (camera.elevation as number) <= 1.4
        && (camera.distance as number) >= 10
        && (camera.distance as number) <= 30;
}

export function parseRoomPreset(raw: string): RoomPreset {
    if (typeof raw !== 'string') invalidPreset();
    if (!isUtf8WithinLimit(raw)) oversizedPreset();

    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        invalidPreset();
    }

    if (!isRecord(value) || !hasExactKeys(value, PRESET_KEYS)
        || value.format !== 'omo-room-preset'
        || value.version !== 1
        || !validTheme(value.theme)
        || !validLayout(value.layout)
        || !isRecord(value.camera)
        || !hasExactKeys(value.camera, CAMERA_KEYS)
        || !validCamera(value.camera)) {
        invalidPreset();
    }

    return {
        format: 'omo-room-preset',
        version: 1,
        theme: value.theme,
        layout: value.layout,
        camera: {
            azimuth: value.camera.azimuth as number,
            elevation: value.camera.elevation as number,
            distance: value.camera.distance as number
        }
    };
}

export function exportRoomPreset(room: Pick<RoomState, 'theme' | 'layout' | 'camera'>): string {
    try {
        if (!room || typeof room !== 'object') invalidPreset();

        const theme = room.theme;
        const sourceLayout = room.layout;
        const layout: RoomLayoutId = sourceLayout === undefined ? 'classic' : sourceLayout;
        const sourceCamera = room.camera;
        if (!validTheme(theme) || !validLayout(layout) || !isRecord(sourceCamera)) invalidPreset();

        const camera = {
            azimuth: sourceCamera.azimuth,
            elevation: sourceCamera.elevation,
            distance: sourceCamera.distance
        };
        if (!validCamera(camera)) invalidPreset();

        const preset: RoomPreset = { format: 'omo-room-preset', version: 1, theme, layout, camera };
        const raw = `${JSON.stringify(preset, null, 2)}\n`;
        parseRoomPreset(raw);
        return raw;
    } catch {
        invalidPreset();
    }
}
