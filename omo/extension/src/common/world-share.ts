/**
 * promise:share (L7) — shareable world files (".omo-world.json").
 *
 * "Share this world" writes the world LAYOUT only: rooms, desk names and starting tabs, wall home pages
 * (scheme + host + path), decor and the room shell. It never writes terminal content, tokens, local paths,
 * Hermes profile names, the onboarding plan text, invite links or room codes. Every object is rebuilt from
 * an allow-list of fields, and every free-text field is checked: text that looks like a path, a token or
 * a runtime id is replaced by a neutral name (and counted), so a world with a stray `/home/...` label or a
 * pasted key still exports clean.
 *
 * "Open a world file" reads it back: the envelope and every object must have only known fields, the world
 * must pass the shared world validation, and the same text checks run again (a hand-edited file is cleaned
 * the same way). The result is a NEW world (revision 0) the app proposes as one change; nothing applies
 * until the user presses Apply, and nothing in a world file can start an agent.
 *
 * Pure module (no DOM / Node APIs): the browser, the tests and any future server share it.
 */
import type { StationConfig, Transform, WorldEntity, WorldShell, WorldSpec } from './world-model';
import { validateWorld, WORLD_MAX_BYTES, WORLD_VERSION } from './world-model';
import { isShareableText, shareableUrl } from './world-preset';

export const WORLD_FILE_FORMAT = 'omo-world' as const;
export const WORLD_FILE_VERSION = 1 as const;
export const WORLD_FILE_EXT = '.omo-world.json';
/** The world cap plus room for the envelope and pretty printing. */
export const WORLD_FILE_MAX_BYTES = WORLD_MAX_BYTES + 16 * 1024;
const DEFAULT_NAME = 'Shared world';

export interface WorldFile {
    format: typeof WORLD_FILE_FORMAT;
    version: typeof WORLD_FILE_VERSION;
    world: WorldSpec;
    /** How many text fields were replaced on export because they looked private (count only, never the text). */
    redacted: number;
}

export interface ShareResult { text: string; file: WorldFile; redacted: number; filename: string }
export interface OpenResult { world: WorldSpec; redacted: number; summary: string }

const FILE_KEYS = ['format', 'version', 'world', 'redacted'] as const;
const WORLD_KEYS = ['version', 'name', 'shell', 'entities', 'revision', 'plan'] as const;
const SHELL_KEYS = ['theme', 'width', 'depth', 'open'] as const;
const TRANSFORM_KEYS = ['x', 'z', 'rotation'] as const;
const STATION_KEYS = ['name', 'kind', 'profile', 'tabs', 'locked'] as const;
const TAB_KEYS = ['name', 'kind'] as const;
const ENTITY_KEYS: Record<WorldEntity['kind'], readonly string[]> = {
    'station': ['id', 'kind', 'transform', 'label', 'station'],
    'monitor-wall': ['id', 'kind', 'transform', 'label', 'width', 'height', 'elevation', 'link'],
    'web-wall': ['id', 'kind', 'transform', 'label', 'width', 'height', 'elevation', 'home'],
    'mirror': ['id', 'kind', 'transform', 'label', 'link'],
    'review-screen': ['id', 'kind', 'transform', 'label'],
    'decor': ['id', 'kind', 'transform', 'label', 'decor', 'scale', 'prop'],
    'room': ['id', 'kind', 'transform', 'label', 'width', 'depth', 'theme', 'doors']
};

/** Emails are not secrets, but a shared layout has no reason to carry them. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** Text that may go into a shared world file: no path, token, runtime id or email. */
export function isPublicText(value: string): boolean { return isShareableText(value) && !EMAIL_RE.test(value); }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (v: unknown, keys: readonly string[]): boolean => isRecord(v) && Object.keys(v).every(k => keys.includes(k));

class ShareError extends Error {}
const refuse = (message: string): never => { throw new ShareError(message); };

function utf8Bytes(value: string): number {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) { bytes += 4; i++; continue; }
        bytes += c <= 0x7f ? 1 : c <= 0x7ff ? 2 : 3;
    }
    return bytes;
}

/**
 * Rebuild a world from allow-listed fields with private text replaced. `strict` (import) also refuses
 * unknown fields anywhere. Returns the clean world and how many texts were replaced.
 */
export function cleanShareWorld(source: WorldSpec, strict = false): { world: WorldSpec; redacted: number } {
    let redacted = 0;
    const text = (value: string | undefined, fallback: string | undefined): string | undefined => {
        if (value === undefined) return undefined;
        if (isPublicText(value)) return value;
        redacted++;
        return fallback;
    };
    if (strict && !onlyKeys(source, WORLD_KEYS)) refuse('The world in that file has unknown fields.');
    if (strict && !onlyKeys(source.shell, SHELL_KEYS)) refuse('The room shell in that file has unknown fields.');
    const shell: WorldShell = { theme: source.shell.theme, width: source.shell.width, depth: source.shell.depth, ...(source.shell.open === true ? { open: true } : {}) };
    const transform = (t: Transform): Transform => {
        if (strict && !onlyKeys(t, TRANSFORM_KEYS)) refuse('A position in that file has unknown fields.');
        return { x: t.x, z: t.z, rotation: t.rotation };
    };
    const station = (s: StationConfig, id: string): StationConfig => {
        if (strict && (!onlyKeys(s, STATION_KEYS) || !Array.isArray(s.tabs) || s.tabs.some(t => !onlyKeys(t, TAB_KEYS)))) refuse(`Desk ${id} in that file has unknown fields.`);
        // The Hermes profile is this computer's setting: never shared (the desk uses the workspace default).
        if (s.profile !== undefined) redacted++;
        return {
            name: text(s.name, 'Desk')!,
            kind: s.kind,
            tabs: (s.tabs ?? []).map(t => ({ name: text(t.name, t.kind === 'shell' ? 'Shell' : 'Agent')!, kind: t.kind })),
            locked: s.locked
        };
    };
    const entities = (Array.isArray(source.entities) ? source.entities : []).map((e: WorldEntity): WorldEntity => {
        if (!isRecord(e as unknown) || typeof e.kind !== 'string' || !(e.kind in ENTITY_KEYS)) return refuse('A thing in that world has an unknown kind.');
        if (strict && !onlyKeys(e as unknown, ENTITY_KEYS[e.kind])) refuse(`${String(e.id)} in that file has unknown fields.`);
        const label = text(e.label, undefined);
        const base = { id: e.id, transform: transform(e.transform), ...(label !== undefined ? { label } : {}) };
        switch (e.kind) {
            case 'station': return { ...base, kind: 'station', station: station(e.station, e.id) };
            case 'monitor-wall': return { ...base, kind: 'monitor-wall', width: e.width, height: e.height, elevation: e.elevation, ...(e.link !== undefined ? { link: e.link } : {}) };
            case 'web-wall': {
                const home = e.home === undefined ? undefined : shareableUrl(e.home);
                if (e.home !== undefined && home !== e.home) redacted++;
                return { ...base, kind: 'web-wall', width: e.width, height: e.height, elevation: e.elevation, ...(home !== undefined ? { home } : {}) };
            }
            case 'mirror': return { ...base, kind: 'mirror', link: e.link };
            case 'review-screen': return { ...base, kind: 'review-screen' };
            case 'decor': return { ...base, kind: 'decor', decor: e.decor, ...(e.scale !== undefined ? { scale: e.scale } : {}), ...(e.prop !== undefined ? { prop: e.prop } : {}) };
            case 'room': return { ...base, kind: 'room', width: e.width, depth: e.depth, ...(e.theme !== undefined ? { theme: e.theme } : {}), ...(e.doors !== undefined ? { doors: [...e.doors] } : {}) };
            default: return refuse('A thing in that world has an unknown kind.');
        }
    });
    if (typeof source.plan === 'string') redacted++; // free text the world was planned from: never shared
    const name = text(source.name, DEFAULT_NAME) ?? DEFAULT_NAME;
    return { world: { version: WORLD_VERSION, name, shell, entities, revision: 0 }, redacted };
}

/** A file name from the world name: letters, digits and dashes only. */
export function worldFileName(world: Pick<WorldSpec, 'name'>): string {
    const slug = world.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return `${slug || 'omo-world'}${WORLD_FILE_EXT}`;
}

/** "Share this world": the clean file text, the count of replaced texts and a file name. Throws a readable Error. */
export function shareWorld(world: WorldSpec): ShareResult {
    const checked = validateWorld(world);
    if (!checked.ok) throw new Error(`This world cannot be shared: ${checked.error}`);
    let clean: { world: WorldSpec; redacted: number };
    try { clean = cleanShareWorld(checked.world); }
    catch (error) { throw new Error(error instanceof ShareError ? error.message : 'This world cannot be shared.'); }
    const again = validateWorld(clean.world);
    if (!again.ok) throw new Error(`This world cannot be shared: ${again.error}`);
    const file: WorldFile = { format: WORLD_FILE_FORMAT, version: WORLD_FILE_VERSION, world: again.world, redacted: clean.redacted };
    const text = `${JSON.stringify(file, null, 2)}\n`;
    openWorldFile(text); // the file we write must open cleanly (and fit the size cap)
    return { text, file, redacted: clean.redacted, filename: worldFileName(again.world) };
}

/** "Open a world file": check and clean the text. Throws an Error with a short, readable message. */
export function openWorldFile(raw: string): OpenResult {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('That file is empty.');
    if (utf8Bytes(raw) > WORLD_FILE_MAX_BYTES) throw new Error(`World files must be at most ${Math.round(WORLD_FILE_MAX_BYTES / 1024)} KiB.`);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('That file is not valid JSON.'); }
    if (!isRecord(value) || value.format !== WORLD_FILE_FORMAT) throw new Error('That is not an Omo world file (.omo-world.json).');
    if (value.version !== WORLD_FILE_VERSION) throw new Error('That world file is from a newer version of Omo.');
    if (!onlyKeys(value, FILE_KEYS) || !isRecord(value.world)) throw new Error('That world file has unknown fields.');
    if (value.redacted !== undefined && !(Number.isInteger(value.redacted) && (value.redacted as number) >= 0)) throw new Error('That world file is damaged (redacted count).');
    const first = validateWorld(value.world);
    if (!first.ok) throw new Error(`That world is not valid: ${first.error}`);
    let clean: { world: WorldSpec; redacted: number };
    try { clean = cleanShareWorld(first.world, true); }
    catch (error) { throw new Error(error instanceof ShareError ? error.message : 'That world file is not valid.'); }
    const second = validateWorld(clean.world);
    if (!second.ok) throw new Error(`That world is not valid: ${second.error}`);
    return { world: second.world, redacted: clean.redacted, summary: summarizeWorld(second.world) };
}

/** One line a person reads before opening a world. */
export function summarizeWorld(world: WorldSpec): string {
    const n = (kind: WorldEntity['kind']): number => world.entities.filter(e => e.kind === kind).length;
    const parts: string[] = [];
    const plural = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;
    if (n('room')) parts.push(plural(n('room'), 'room'));
    parts.push(plural(n('station'), 'desk'));
    const walls = n('web-wall') + n('monitor-wall');
    if (walls) parts.push(plural(walls, 'wall'));
    if (n('decor')) parts.push(plural(n('decor'), 'decor item'));
    return `“${world.name}”: ${parts.join(', ')} · ${world.shell.width} × ${world.shell.depth} m${world.shell.open ? ' open world' : ''}`;
}
