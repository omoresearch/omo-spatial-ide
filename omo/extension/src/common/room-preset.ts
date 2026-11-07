import type { RoomState, RoomTheme } from './room-state';
import type { RoomLayoutId } from './player-state';
import type { StationConfig, Transform, WorldEntity, WorldShell, WorldSpec } from './world-model'; // w2:templates
import { validateWorld, WORLD_MAX_BYTES, WORLD_VERSION } from './world-model'; // w2:templates

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

/* ------------------------------------------------------------------------------------------------
 * w2:templates — World preset v2: a portable WorldSpec (appearance + entities + station setup).
 *
 * What is exported: the room shell (theme, size), every entity with its position, size and links,
 * and each station's setup (name, kind, Hermes profile NAME, starting tabs, lock), plus the camera.
 * What is NEVER exported: workspace or session ids, tokens, host paths, project folders, the
 * onboarding plan text, URL query strings / fragments / credentials. Every object is rebuilt from
 * an allow-list of fields, so unknown fields (a stray workspaceId, say) cannot leak out; imports with
 * unknown fields or secret-looking text are refused. Importing only previews; Save applies it, and
 * nothing in a preset can start an agent.
 * ---------------------------------------------------------------------------------------------- */

export const WORLD_PRESET_FORMAT = 'omo-world-preset' as const;
export const WORLD_PRESET_VERSION = 2 as const;
/** File cap for a v2 preset: the world cap plus room for the envelope and pretty-printing. */
export const WORLD_PRESET_MAX_BYTES = WORLD_MAX_BYTES + 16 * 1024;
export const WORLD_PRESET_FILENAME = 'omo-world-preset.json';
export const WORLD_PRESET_DEFAULT_NAME = 'Shared Omo world';

export interface WorldPreset {
    format: typeof WORLD_PRESET_FORMAT;
    version: typeof WORLD_PRESET_VERSION;
    world: WorldSpec;
    camera?: RoomPreset['camera'];
}

/** Either kind of preset file, as read from disk. */
export type AnyRoomPreset = { version: 1; preset: RoomPreset } | { version: 2; preset: WorldPreset };

const ENTITY_KEYS: Record<WorldEntity['kind'], readonly string[]> = {
    'station': ['id', 'kind', 'transform', 'label', 'station'],
    'monitor-wall': ['id', 'kind', 'transform', 'label', 'width', 'height', 'elevation', 'link'],
    'web-wall': ['id', 'kind', 'transform', 'label', 'width', 'height', 'elevation', 'home'],
    'mirror': ['id', 'kind', 'transform', 'label', 'link'],
    'review-screen': ['id', 'kind', 'transform', 'label'],
    'decor': ['id', 'kind', 'transform', 'label', 'decor', 'scale']
};
const WORLD_KEYS = ['version', 'name', 'shell', 'entities', 'revision', 'plan'] as const;
const SHELL_KEYS = ['theme', 'width', 'depth'] as const;
const TRANSFORM_KEYS = ['x', 'z', 'rotation'] as const;
const STATION_KEYS = ['name', 'kind', 'profile', 'tabs', 'locked'] as const;
const TAB_KEYS = ['name', 'kind'] as const;
const V2_KEYS = ['format', 'version', 'world', 'camera'] as const;

/** Host paths: unix home/system roots, ~/, Windows drives, UNC shares, file: URLs. */
const HOST_PATH_RE = /(^|[^A-Za-z0-9])(\/(home|Users|root|var|etc|tmp|opt|mnt|srv|private|Volumes|usr)\/|~\/|[A-Za-z]:[\\/]|\\\\[A-Za-z0-9]|file:)/i;
/** Token-ish text: provider key prefixes, JWTs, bearer, and long hex / base64 runs (ids, secrets). */
const TOKEN_RE = /(sk-[A-Za-z0-9_-]{8,}|sk_(live|test)_|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|bearer\s+\S{8,}|[0-9a-f]{24,}|[A-Za-z0-9+/_-]{40,})/i;
/** Workspace / session / tab ids as the runtime mints them. */
const RUNTIME_ID_RE = /\b(tw_[0-9a-f]{8,}|ws[_-][0-9a-z]{6,}|tab-[0-9a-f]{6,}|web-[0-9a-f]{6,}|recipe-[0-9a-z]{6,})\b/i;

/** True when a string is safe to put in a shared file (no host path, token or runtime id). */
export function isShareableText(value: string): boolean {
    return !HOST_PATH_RE.test(value) && !TOKEN_RE.test(value) && !RUNTIME_ID_RE.test(value);
}

/** Keep only scheme, host and path of an http(s) URL; drop credentials, query and fragment. */
export function shareableUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
        const clean = `${url.protocol}//${url.host}${url.pathname}`;
        return clean.length <= 2048 && isShareableText(url.pathname) && isShareableText(url.host) ? clean : undefined;
    } catch { return undefined; }
}

function utf8Bytes(value: string): number {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) { bytes += 4; i++; continue; }
        bytes += c <= 0x7f ? 1 : c <= 0x7ff ? 2 : 3;
    }
    return bytes;
}

function onlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
    return isRecord(value) && Object.keys(value).every(key => allowed.includes(key));
}

class PresetError extends Error {}
const refuse = (message: string): never => { throw new PresetError(message); };

/** Rebuild a world from allow-listed fields. mode 'export' redacts unsafe text; 'import' refuses it. */
function cleanWorld(source: WorldSpec, mode: 'export' | 'import', name?: string): WorldSpec {
    const safe = (value: string | undefined, fallback: string | undefined, what: string): string | undefined => {
        if (value === undefined || isShareableText(value)) return value;
        if (mode === 'import') refuse(`${what} looks like a path, token or private id.`);
        return fallback;
    };
    if (mode === 'import' && !onlyKeys(source, WORLD_KEYS)) refuse('The world has unknown fields.');
    if (mode === 'import' && !onlyKeys(source.shell, SHELL_KEYS)) refuse('The room shell has unknown fields.');
    const shell: WorldShell = { theme: source.shell.theme, width: source.shell.width, depth: source.shell.depth };
    const transform = (t: Transform): Transform => {
        if (mode === 'import' && !onlyKeys(t, TRANSFORM_KEYS)) refuse('A position has unknown fields.');
        return { x: t.x, z: t.z, rotation: t.rotation };
    };
    const station = (s: StationConfig, id: string): StationConfig => {
        if (mode === 'import' && (!onlyKeys(s, STATION_KEYS) || !Array.isArray(s.tabs) || s.tabs.some(t => !onlyKeys(t, TAB_KEYS)))) refuse(`Station ${id} has unknown fields.`);
        const out: StationConfig = {
            name: safe(s.name, 'Desk', `The name of station ${id}`)!,
            kind: s.kind,
            tabs: (s.tabs ?? []).map(t => ({ name: safe(t.name, t.kind === 'shell' ? 'Shell' : 'Agent', `A tab name on station ${id}`)!, kind: t.kind })),
            locked: s.locked
        };
        const profile = safe(s.profile, undefined, `The Hermes profile on station ${id}`);
        if (profile !== undefined) out.profile = profile;
        return out;
    };
    const entities = (Array.isArray(source.entities) ? source.entities : []).map((e: WorldEntity): WorldEntity => {
        if (!isRecord(e as unknown) || typeof e.kind !== 'string' || !(e.kind in ENTITY_KEYS)) return refuse('A world item has an unknown kind.');
        if (mode === 'import' && !onlyKeys(e as unknown, ENTITY_KEYS[e.kind])) refuse(`${String(e.id)} has unknown fields.`);
        const label = e.label !== undefined ? safe(e.label, undefined, `The label of ${e.id}`) : undefined;
        const base = { id: e.id, transform: transform(e.transform), ...(label !== undefined ? { label } : {}) };
        switch (e.kind) {
            case 'station': return { ...base, kind: 'station', station: station(e.station, e.id) };
            case 'monitor-wall': return { ...base, kind: 'monitor-wall', width: e.width, height: e.height, elevation: e.elevation, ...(e.link !== undefined ? { link: e.link } : {}) };
            case 'web-wall': {
                const home = e.home === undefined ? undefined : shareableUrl(e.home);
                if (mode === 'import' && e.home !== undefined && home !== e.home) refuse(`The web wall ${e.id} home page is not a plain http(s) address.`);
                return { ...base, kind: 'web-wall', width: e.width, height: e.height, elevation: e.elevation, ...(home !== undefined ? { home } : {}) };
            }
            case 'mirror': return { ...base, kind: 'mirror', link: e.link };
            case 'review-screen': return { ...base, kind: 'review-screen' };
            case 'decor': return { ...base, kind: 'decor', decor: e.decor, ...(e.scale !== undefined ? { scale: e.scale } : {}) };
            default: return refuse('A world item has an unknown kind.');
        }
    });
    const worldName = safe(name ?? source.name, WORLD_PRESET_DEFAULT_NAME, 'The world name') ?? WORLD_PRESET_DEFAULT_NAME;
    // The onboarding plan is free text and may hold anything: never exported, ignored on import.
    return { version: WORLD_VERSION, name: worldName, shell, entities, revision: 0 };
}

/**
 * Export a world as a v2 preset file. `name` defaults to a neutral name so project names do not
 * leak; pass the world name explicitly to keep it. Throws if the result is invalid or too large.
 */
export function exportWorldPreset(world: WorldSpec, options: { name?: string; camera?: RoomPreset['camera']; includeProfiles?: boolean } = {}): string {
    const checked = validateWorld(world);
    if (!checked.ok) throw new Error(`This world cannot be exported: ${checked.error}`);
    let clean: WorldSpec;
    try { clean = cleanWorld(checked.world, 'export', options.name ?? WORLD_PRESET_DEFAULT_NAME); }
    catch (error) { throw new Error(error instanceof PresetError ? error.message : 'This world cannot be exported.'); }
    if (options.includeProfiles === false) for (const e of clean.entities) if (e.kind === 'station') delete e.station.profile;
    const preset: WorldPreset = { format: WORLD_PRESET_FORMAT, version: WORLD_PRESET_VERSION, world: clean };
    if (options.camera && isRecord(options.camera) && validCamera(options.camera as unknown as Record<string, unknown>)) {
        preset.camera = { azimuth: options.camera.azimuth, elevation: options.camera.elevation, distance: options.camera.distance };
    }
    const raw = `${JSON.stringify(preset, null, 2)}\n`;
    parseWorldPreset(raw); // the exported file must import cleanly (also enforces the size cap)
    return raw;
}

/** Parse and check a v2 preset file. Throws an Error with a short, user-facing message. */
export function parseWorldPreset(raw: string): WorldPreset {
    if (typeof raw !== 'string') throw new Error('Invalid world preset');
    if (utf8Bytes(raw) > WORLD_PRESET_MAX_BYTES) throw new Error(`World preset files must be at most ${Math.round(WORLD_PRESET_MAX_BYTES / 1024)} KiB.`);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('That file is not valid JSON.'); }
    if (!onlyKeys(value, V2_KEYS) || value.format !== WORLD_PRESET_FORMAT || value.version !== WORLD_PRESET_VERSION || !isRecord(value.world)) {
        throw new Error('That file is not an Omo world preset (version 2).');
    }
    if (value.camera !== undefined && (!isRecord(value.camera) || !hasExactKeys(value.camera, CAMERA_KEYS) || !validCamera(value.camera))) throw new Error('The camera in that preset is invalid.');
    const first = validateWorld(value.world);
    if (!first.ok) throw new Error(first.error);
    let world: WorldSpec;
    try { world = cleanWorld(first.world, 'import'); }
    catch (error) { throw new Error(error instanceof PresetError ? error.message : 'That world preset is invalid.'); }
    const second = validateWorld(world);
    if (!second.ok) throw new Error(second.error);
    const preset: WorldPreset = { format: WORLD_PRESET_FORMAT, version: WORLD_PRESET_VERSION, world: second.world };
    if (isRecord(value.camera)) preset.camera = { azimuth: value.camera.azimuth as number, elevation: value.camera.elevation as number, distance: value.camera.distance as number };
    return preset;
}

/** Read either preset version. v1 keeps its strict 8 KiB rules; v2 allows up to WORLD_PRESET_MAX_BYTES. */
export function parseAnyRoomPreset(raw: string): AnyRoomPreset {
    if (typeof raw !== 'string') throw new Error('Invalid room preset');
    if (utf8Bytes(raw) > WORLD_PRESET_MAX_BYTES) throw new Error(`Preset files must be at most ${Math.round(WORLD_PRESET_MAX_BYTES / 1024)} KiB.`);
    let probe: unknown;
    try { probe = JSON.parse(raw); } catch { throw new Error('That file is not valid JSON.'); }
    if (isRecord(probe) && probe.format === WORLD_PRESET_FORMAT) return { version: 2, preset: parseWorldPreset(raw) };
    try { return { version: 1, preset: parseRoomPreset(raw) }; }
    catch (error) { throw new Error(error instanceof Error && /exceeds/.test(error.message) ? 'Appearance presets (version 1) must be at most 8 KiB.' : 'That file is not a valid Omo room or world preset.'); }
}

/** Human-readable preview lines for an imported world (shown before Save). */
export function previewWorldPreset(preset: WorldPreset): string[] {
    const w = preset.world;
    const lines = [`${w.shell.theme === 'jungle' ? 'Jungle' : 'Station'} room, ${w.shell.width} × ${w.shell.depth} m, ${w.entities.length} items.`];
    for (const e of w.entities) {
        const name = e.label ?? e.id;
        switch (e.kind) {
            case 'station': lines.push(`Desk “${e.station.name}”${e.station.profile ? ` (profile ${e.station.profile})` : ''}: ${e.station.tabs.map(t => t.name).join(', ')}${e.station.locked ? ' · locked' : ''}`); break;
            case 'monitor-wall': lines.push(`Monitor wall “${name}”${e.link ? ` linked to ${e.link}` : ''}`); break;
            case 'web-wall': lines.push(`Web wall “${name}”${e.home ? ` · ${e.home}` : ''}`); break;
            case 'mirror': lines.push(`Mirror of ${e.link}`); break;
            case 'review-screen': lines.push(`Code review screen “${name}”`); break;
            default: break;
        }
    }
    const decor = w.entities.filter(e => e.kind === 'decor').length;
    if (decor) lines.push(`${decor} decor item${decor === 1 ? '' : 's'}.`);
    lines.push('Starting tabs are listed only. No agent starts until you confirm it at the desk.');
    return lines;
}
