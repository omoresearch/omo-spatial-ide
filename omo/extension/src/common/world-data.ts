/**
 * promise:share (L7) — "Build a world from data".
 *
 *  - CSV: the user picks a column to group by. Each group becomes a room (at most 12; past 11 groups the
 *    smallest ones share an "Other" room). The room's name plate and floating title are its sign
 *    ("North · 4 rows"); inside, up to 4 note boards (whiteboards) carry short row summaries.
 *  - Repo folder: each top-level folder of a local folder becomes a room; its boards are the folder's
 *    README first line, its file count, its main file types and its subfolder count. The folder is read
 *    through a small read-only adapter (list + read), so this module never sees an absolute path and
 *    never writes anything.
 *
 * Every text that lands in the world goes through `isPublicText` (no paths, tokens, ids or emails) and the
 * world-model text rules (one line, at most 60 characters). The result is a normal WorldSpec; the app turns
 * it into ONE proposal (diffWorlds -> WorldStore.propose) so it is checked and applied like any other
 * change (Apply / Discard / Undo). Pure module: no DOM or Node APIs.
 */
import type { DecorEntity, RoomEntity, StationEntity, WorldEntity, WorldSpec } from './world-model';
import { defaultStation, validateWorld, WORLD_VERSION } from './world-model';
import { isPublicText } from './world-share';

export const DATA_MAX_ROOMS = 12;
export const DATA_BOARDS_PER_ROOM = 4;
export const CSV_MAX_BYTES = 1024 * 1024;
export const CSV_MAX_ROWS = 10000;
/**
 * At most this many things in a data world (rooms + boards + one desk). A shared room server takes at most
 * 64 changes per batch; replacing a small world with 52 new things stays under it.
 */
export const DATA_MAX_ENTITIES = 52;
const LABEL_MAX = 60;

// ------------------------------------------------------------------------------------------- text helpers

/** One clean line for a label: control characters removed, spaces folded, cut to `max` with an ellipsis. */
export function oneLine(value: string, max = LABEL_MAX): string {
    const flat = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
/** A label safe to share, or undefined. */
function publicLabel(value: string, max = LABEL_MAX): string | undefined {
    const line = oneLine(value, max);
    return line && isPublicText(line) ? line : undefined;
}
function slug(value: string): string {
    return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}
function uniqueId(base: string, taken: Set<string>): string {
    let id = base.slice(0, 44) || 'item', n = 2;
    while (taken.has(id)) id = `${base.slice(0, 40)}-${n++}`;
    taken.add(id);
    return id;
}

// ------------------------------------------------------------------------------------------------ CSV

export interface CsvTable { headers: string[]; rows: string[][]; delimiter: string; truncated: boolean }

/** Read CSV text (RFC 4180 quotes, CRLF or LF, comma / semicolon / tab detected from the header). */
export function parseCsv(text: string): CsvTable {
    if (typeof text !== 'string') throw new Error('That file could not be read as text.');
    if (text.length > CSV_MAX_BYTES) throw new Error(`CSV files must be at most ${CSV_MAX_BYTES / 1024 / 1024} MB.`);
    const body = text.replace(/^\uFEFF/, '');
    const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
    const delimiter = [',', ';', '\t'].map(d => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
    const records: string[][] = [];
    let field = '', record: string[] = [], quoted = false, truncated = false;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (quoted) {
            if (c === '"') { if (body[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
            else field += c;
            continue;
        }
        if (c === '"' && field === '') { quoted = true; continue; }
        if (c === delimiter) { record.push(field); field = ''; continue; }
        if (c === '\n' || c === '\r') {
            if (c === '\r' && body[i + 1] === '\n') i++;
            record.push(field); field = '';
            if (record.some(v => v.trim() !== '')) records.push(record);
            record = [];
            if (records.length > CSV_MAX_ROWS) { truncated = true; break; }
            continue;
        }
        field += c;
    }
    if (!truncated && (field !== '' || record.length)) { record.push(field); if (record.some(v => v.trim() !== '')) records.push(record); }
    if (quoted && !truncated) throw new Error('That CSV has a quote that is never closed.');
    if (!records.length) throw new Error('That CSV is empty.');
    const headers = records[0].map((h, i) => oneLine(h, 40) || `Column ${i + 1}`);
    const rows = records.slice(1).map(r => headers.map((_, i) => (r[i] ?? '').trim()));
    if (!rows.length) throw new Error('That CSV has a header but no rows.');
    return { headers, rows, delimiter, truncated };
}

/** The column a person most likely wants to group by: the one with the fewest distinct values from 2 to 12. */
export function suggestGroupColumn(table: CsvTable): number {
    let best = -1, bestCount = Infinity;
    table.headers.forEach((_, i) => {
        const distinct = new Set(table.rows.map(r => r[i]).filter(Boolean)).size;
        if (distinct >= 2 && distinct <= DATA_MAX_ROOMS && distinct < bestCount) { best = i; bestCount = distinct; }
    });
    return best >= 0 ? best : 0;
}

/** A short summary of one row: the first few shareable cells that are not the group column. */
export function rowSummary(table: CsvTable, row: string[], groupIndex: number): string | undefined {
    const parts: string[] = [];
    for (let i = 0; i < row.length && parts.length < 3; i++) {
        if (i === groupIndex) continue;
        const cell = oneLine(row[i], 40);
        if (cell && isPublicText(cell)) parts.push(cell);
    }
    return parts.length ? publicLabel(parts.join(' · ')) : undefined;
}

export interface DataRoom { name: string; boards: string[] }
export interface DataPlan { name: string; rooms: DataRoom[]; notes: string[] }

/** Group CSV rows by a column into at most 12 rooms with up to 4 board lines each. */
export function planFromCsv(table: CsvTable, groupBy: number | string, options: { name?: string } = {}): DataPlan {
    const index = typeof groupBy === 'number' ? groupBy : table.headers.findIndex(h => h.toLowerCase() === groupBy.toLowerCase());
    if (index < 0 || index >= table.headers.length) throw new Error(`There is no column “${String(groupBy)}”.`);
    const notes: string[] = [];
    const groups = new Map<string, string[][]>();
    for (const row of table.rows) {
        const key = oneLine(row[index] ?? '', 40) || '(blank)';
        const list = groups.get(key) ?? []; list.push(row); groups.set(key, list);
    }
    let entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (entries.length > DATA_MAX_ROOMS) {
        const keep = entries.slice(0, DATA_MAX_ROOMS - 1), rest = entries.slice(DATA_MAX_ROOMS - 1);
        notes.push(`${entries.length} groups: the ${rest.length} smallest share the “Other” room.`);
        entries = [...keep, ['Other', rest.flatMap(([, rows]) => rows)]];
    }
    if (table.truncated) notes.push(`Only the first ${CSV_MAX_ROWS} rows were read.`);
    const rooms: DataRoom[] = entries.map(([key, rows]) => {
        const title = publicLabel(key, 40) ?? 'Group';
        const lines = rows.map(r => rowSummary(table, r, index)).filter((s): s is string => !!s);
        const boards = lines.length > DATA_BOARDS_PER_ROOM ? [...lines.slice(0, DATA_BOARDS_PER_ROOM - 1), `+${lines.length - (DATA_BOARDS_PER_ROOM - 1)} more rows`] : lines;
        return { name: oneLine(`${title} · ${rows.length} row${rows.length === 1 ? '' : 's'}`), boards };
    });
    const column = table.headers[index];
    return { name: publicLabel(options.name ?? `Data by ${column}`, 120) ?? 'Data world', rooms, notes };
}

// ---------------------------------------------------------------------------------------------- repo folder

/** Read-only view of a folder. Paths are segment lists relative to the chosen folder. */
export interface FolderReader {
    list(path: readonly string[]): Promise<Array<{ name: string; dir: boolean }>>;
    /** Text of a small file, or undefined (missing, too big, not text). */
    read(path: readonly string[]): Promise<string | undefined>;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'lib', 'out', 'target', '__pycache__', '.cache', 'coverage', 'vendor']);
const README_RE = /^readme(\.(md|markdown|txt|rst))?$/i;
/** First meaningful README line: markdown heading marks, badges and HTML removed. */
export function readmeFirstLine(text: string | undefined): string | undefined {
    if (!text) return undefined;
    for (const raw of text.split(/\r?\n/).slice(0, 40)) {
        const line = raw.replace(/<[^>]*>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
        if (line && !/^[-=]{3,}$/.test(line)) return line;
    }
    return undefined;
}

export interface FolderFacts { name: string; readme?: string; files: number; subfolders: number; types: Array<[string, number]>; capped: boolean }

/** Facts about one top-level folder: README first line, file count (capped), main file types, subfolders. */
export async function folderFacts(reader: FolderReader, name: string, limit = 2000): Promise<FolderFacts> {
    const facts: FolderFacts = { name, files: 0, subfolders: 0, types: [], capped: false };
    const types = new Map<string, number>();
    const top = await reader.list([name]);
    const readme = top.find(e => !e.dir && README_RE.test(e.name));
    if (readme) facts.readme = readmeFirstLine(await reader.read([name, readme.name]));
    facts.subfolders = top.filter(e => e.dir && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')).length;
    const queue: string[][] = [[name]];
    while (queue.length && !facts.capped) {
        const dir = queue.shift()!;
        const entries = dir.length === 1 ? top : await reader.list(dir);
        for (const e of entries) {
            if (e.dir) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && dir.length < 8) queue.push([...dir, e.name]); continue; }
            facts.files++;
            const ext = /\.([A-Za-z0-9]{1,8})$/.exec(e.name)?.[1]?.toLowerCase();
            if (ext) types.set(ext, (types.get(ext) ?? 0) + 1);
            if (facts.files >= limit) { facts.capped = true; break; }
        }
    }
    facts.types = [...types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    return facts;
}

/** Each top-level folder becomes a room (at most 12, the ones with most files first). */
export async function planFromRepo(reader: FolderReader, repoName: string): Promise<DataPlan> {
    const notes: string[] = [];
    const top = (await reader.list([])).filter(e => e.dir && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
    if (!top.length) throw new Error('That folder has no subfolders to turn into rooms.');
    const facts: FolderFacts[] = [];
    for (const e of top.slice(0, 60)) facts.push(await folderFacts(reader, e.name));
    facts.sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
    if (facts.length > DATA_MAX_ROOMS) notes.push(`${facts.length} folders: the ${DATA_MAX_ROOMS} with the most files became rooms.`);
    const rooms: DataRoom[] = facts.slice(0, DATA_MAX_ROOMS).map(f => {
        const boards: string[] = [];
        const readme = f.readme && publicLabel(f.readme);
        if (readme) boards.push(readme);
        boards.push(`${f.capped ? `${f.files}+` : f.files} file${f.files === 1 ? '' : 's'}`);
        if (f.types.length) boards.push(oneLine(`Mostly ${f.types.map(([ext, n]) => `.${ext} (${n})`).join(', ')}`));
        if (f.subfolders) boards.push(`${f.subfolders} subfolder${f.subfolders === 1 ? '' : 's'}`);
        return { name: publicLabel(`${f.name}/`, 40) ?? 'Folder', boards: boards.slice(0, DATA_BOARDS_PER_ROOM) };
    });
    return { name: publicLabel(repoName, 120) ?? 'Repo world', rooms, notes };
}

// ------------------------------------------------------------------------------------------- plan -> world

const ROOM_W = 11, ROOM_D = 7, GAP_X = 4, GAP_Z = 5, PLAZA = 34, EDGE = 4;

/**
 * Lay a plan out as an open world: rooms in rows of up to 4 at the north end (doors facing the plaza),
 * boards along each room's back wall, one desk on the plaza so the world still has a place to work,
 * and a wide plaza to the south. Throws when the result is not a valid world (it always should be).
 */
export function worldFromPlan(plan: DataPlan, options: { theme?: WorldSpec['shell']['theme']; maxEntities?: number } = {}): WorldSpec {
    const rooms = plan.rooms.slice(0, DATA_MAX_ROOMS);
    if (!rooms.length) throw new Error('There is nothing to build: no groups were found.');
    const cols = Math.min(4, rooms.length), rowsN = Math.ceil(rooms.length / cols);
    const gridW = cols * ROOM_W + (cols - 1) * GAP_X, gridD = rowsN * ROOM_D + (rowsN - 1) * GAP_Z;
    const width = Math.max(40, Math.ceil(gridW + 2 * EDGE)), depth = Math.ceil(gridD + EDGE + PLAZA);
    const top = -depth / 2 + EDGE;
    const budget = Math.max(rooms.length + 1, options.maxEntities ?? DATA_MAX_ENTITIES) - rooms.length - 1;
    const perRoom = Math.max(0, Math.min(DATA_BOARDS_PER_ROOM, Math.floor(budget / rooms.length)));
    const taken = new Set<string>(['terminal']);
    const entities: WorldEntity[] = [];
    rooms.forEach((room, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const inRow = Math.min(cols, rooms.length - row * cols);
        const rowW = inRow * ROOM_W + (inRow - 1) * GAP_X;
        const x = Math.round((-rowW / 2 + ROOM_W / 2 + col * (ROOM_W + GAP_X)) * 100) / 100;
        const z = Math.round((top + ROOM_D / 2 + row * (ROOM_D + GAP_Z)) * 100) / 100;
        const id = uniqueId(`data-${slug(room.name.split(' · ')[0]) || 'room'}`, taken);
        const r: RoomEntity = { id, kind: 'room', label: oneLine(room.name) || 'Room', transform: { x, z, rotation: 0 }, width: ROOM_W, depth: ROOM_D, doors: ['front'] };
        entities.push(r);
        const boards = room.boards.slice(0, perRoom);
        boards.forEach((text, b) => {
            const span = 2.4, bx = x + (b - (boards.length - 1) / 2) * span;
            const board: DecorEntity = { id: uniqueId(`${id}-board-${b + 1}`, taken), kind: 'decor', decor: 'whiteboard', label: oneLine(text) || 'Note', transform: { x: Math.round(bx * 100) / 100, z: Math.round((z - ROOM_D / 2 + 0.75) * 100) / 100, rotation: 0 } };
            entities.push(board);
        });
    });
    const desk: StationEntity = { id: 'terminal', kind: 'station', label: 'Desk one', transform: { x: 0, z: Math.round((depth / 2 - PLAZA / 2) * 100) / 100, rotation: 0 }, station: defaultStation('Desk one') };
    entities.push(desk);
    const world: WorldSpec = { version: WORLD_VERSION, name: oneLine(plan.name, 120) || 'Data world', shell: { theme: options.theme ?? 'station', width, depth, open: true }, entities, revision: 0 };
    const checked = validateWorld(world);
    if (!checked.ok) throw new Error(`The data world is not valid: ${checked.error}`);
    return checked.world;
}

/** The room names and board lines of a world (for previews and tests). */
export function dataRooms(world: WorldSpec): Array<{ id: string; name: string; boards: string[] }> {
    return world.entities.filter((e): e is RoomEntity => e.kind === 'room').map(r => ({
        id: r.id, name: r.label ?? r.id,
        boards: world.entities.filter((e): e is DecorEntity => e.kind === 'decor' && e.id.startsWith(`${r.id}-board-`)).map(e => e.label ?? '')
    }));
}
