/**
 * promise-agent — the room-aware Omo (pure: no DOM, no THREE, no I/O; unit-tested on its own).
 *   - worldSnapshot: a compact text map of the world (rooms, desks with names/tabs/what runs, web walls with
 *     their page, every thing's place as "north wall of Lounge") from the saved world + the live runtime state.
 *   - answerQuestion: rules over that snapshot answer "where is the Claude desk?", "what is on the web wall?",
 *     "what is running on desk two?", "what is in this room?". A place answer names the entity, so the UI can
 *     beam to it. Extensible: add a row to ANSWERS. No LLM is needed for these.
 *   - routeOmo: what the Shape prompt should do with a line (answer / make a page / walk somewhere / change).
 *   - pageRequest: "make a dashboard of my desks" -> a local page template + title.
 *   - sinceYouLeft: the quiet one-line return card from two runtime readings.
 *   - placePose: where to stand to look at a thing (for "take me to …" / "where was I").
 * Nothing here starts an agent, types into a terminal or changes the world.
 */
import type { WorldSpec, WorldEntity, EntityKind } from './world-model';
import { activeKit, kitProp } from './world-style-kits';

// ---- runtime state (what the widget knows live) --------------------------------------------------------

export type DeskStatus = 'working' | 'waiting' | 'idle' | 'shell' | 'off';
export interface RuntimeTab { name: string; kind: string; /** merged agent status (working, waiting-approval, idle, exited, unknown) */ status?: string }
export interface RuntimeDesk { id: string; name?: string; /** runtime console phase: live, connecting, idle, error … */ phase?: string; tabs: RuntimeTab[]; activeTab?: string }
export interface RuntimeSnapshot { at?: number; desks: RuntimeDesk[]; web?: { url: string; title: string } }

/** One status per desk: an agent waiting for you wins, then working, then idle; a desk with only shells is 'shell'. */
export function deskStatus(desk: RuntimeDesk | undefined): DeskStatus {
    if (!desk) return 'off';
    const agents = desk.tabs.filter(t => t.kind !== 'shell');
    if (agents.some(t => t.status === 'waiting-approval')) return 'waiting';
    if (agents.some(t => t.status === 'working')) return 'working';
    if (agents.some(t => t.status === 'idle' || t.status === 'exited')) return 'idle';
    return desk.phase === 'live' ? 'shell' : 'off';
}
const STATUS_WORDS: Record<DeskStatus, string> = { working: 'working', waiting: 'waiting for you', idle: 'finished / idle', shell: 'shell open', off: 'not connected' };
export function statusWords(s: DeskStatus): string { return STATUS_WORDS[s]; }

// ---- places --------------------------------------------------------------------------------------------

export interface Place { id: string; kind: EntityKind; name: string; room: string; where: string; x: number; z: number; rotation: number }
interface RoomArea { name: string; minX: number; maxX: number; minZ: number; maxZ: number; named: boolean }

export function entityName(e: WorldEntity): string {
    if (e.label) return e.label;
    if (e.kind === 'station') return e.station.name;
    if (e.kind === 'decor') return e.decor;
    return ({ 'web-wall': 'Web wall', 'monitor-wall': 'Monitor wall', mirror: 'Mirror', 'review-screen': 'Code review', room: 'Room' } as Record<string, string>)[e.kind] ?? e.kind;
}
function areas(world: WorldSpec): RoomArea[] {
    const out: RoomArea[] = [];
    for (const e of world.entities) {
        if (e.kind !== 'room') continue;
        const side = Math.abs(Math.round(e.transform.rotation / (Math.PI / 2))) % 2 === 1;
        const hw = (side ? e.depth : e.width) / 2, hd = (side ? e.width : e.depth) / 2;
        out.push({ name: entityName(e), minX: e.transform.x - hw, maxX: e.transform.x + hw, minZ: e.transform.z - hd, maxZ: e.transform.z + hd, named: true });
    }
    if (!out.length || !world.shell.open) {
        const w = world.shell.width / 2, d = world.shell.depth / 2;
        out.push({ name: world.name?.trim() || 'the room', minX: -w, maxX: w, minZ: -d, maxZ: d, named: !!world.name?.trim() });
    }
    return out;
}
const WALL_KINDS = new Set<string>(['web-wall', 'monitor-wall', 'mirror', 'review-screen']);
/** The way a thing faces in compass words (rotation 0 = facing north, towards -z; +90° turns it to face west). */
function facing(rotation: number): string {
    const i = ((Math.round(rotation / (Math.PI / 2)) % 4) + 4) % 4;
    return ['north', 'west', 'south', 'east'][i];
}
function describe(e: WorldEntity, a: RoomArea): string {
    const { x, z } = e.transform;
    const of = a.named ? a.name : 'the room';
    const inside = x >= a.minX - 0.3 && x <= a.maxX + 0.3 && z >= a.minZ - 0.3 && z <= a.maxZ + 0.3;
    if (!inside) return 'outside, in the open';
    const d = { north: z - a.minZ, south: a.maxZ - z, west: x - a.minX, east: a.maxX - x };
    const nearest = (Object.entries(d) as Array<[string, number]>).sort((p, q) => p[1] - q[1]);
    const wallish = WALL_KINDS.has(e.kind) || (e.kind === 'decor' && (e.decor === 'window' || e.decor === 'whiteboard' || e.decor === 'bookshelf'));
    if (wallish && nearest[0][1] <= 1.6) return `on the ${nearest[0][0]} wall of ${of}`;
    const ns = d.north < 1.8 ? 'north' : d.south < 1.8 ? 'south' : '', ew = d.west < 1.8 ? 'west' : d.east < 1.8 ? 'east' : '';
    if (ns && ew) return `in the ${ns}-${ew} corner of ${of}`;
    const fx = (x - a.minX) / Math.max(0.1, a.maxX - a.minX), fz = (z - a.minZ) / Math.max(0.1, a.maxZ - a.minZ);
    const row = fz < 1 / 3 ? 'north' : fz > 2 / 3 ? 'south' : '', col = fx < 1 / 3 ? 'west' : fx > 2 / 3 ? 'east' : '';
    if (!row && !col) return `in the middle of ${of}`;
    return `in the ${[row, col].filter(Boolean).join('-')} of ${of}`;
}
export function placesOf(world: WorldSpec): Place[] {
    const rooms = areas(world);
    const out: Place[] = [];
    for (const e of world.entities) {
        if (e.kind === 'room') continue;
        const { x, z } = e.transform;
        const a = rooms.find(r => x >= r.minX - 0.3 && x <= r.maxX + 0.3 && z >= r.minZ - 0.3 && z <= r.maxZ + 0.3) ?? rooms[rooms.length - 1];
        out.push({ id: e.id, kind: e.kind, name: entityName(e), room: a.name, where: describe(e, a), x, z, rotation: e.transform.rotation });
    }
    return out;
}

// ---- the snapshot --------------------------------------------------------------------------------------

export interface WorldSnapshot { text: string; places: Place[]; world: WorldSpec; runtime: RuntimeSnapshot }

/** A compact text map of the world: what an assistant needs to know about the room, in plain lines. */
export function worldSnapshot(world: WorldSpec, runtime: RuntimeSnapshot = { desks: [] }): WorldSnapshot {
    const places = placesOf(world);
    const byId = new Map(world.entities.map(e => [e.id, e]));
    const lines: string[] = [];
    const rooms = areas(world);
    lines.push(`World "${world.name || 'Omo'}" · ${world.shell.width} × ${world.shell.depth} m · ${rooms.length === 1 ? `one room (${rooms[0].name})` : `rooms: ${rooms.map(r => r.name).join(', ')}`}`);
    const desks = places.filter(p => p.kind === 'station');
    lines.push(`Desks (${desks.length}):`);
    for (const p of desks) {
        const e = byId.get(p.id) as Extract<WorldEntity, { kind: 'station' }>;
        const live = runtime.desks.find(d => d.id === p.id);
        const tabs = (live?.tabs.length ? live.tabs.map(t => t.name) : e.station.tabs.map(t => t.name)).join(', ');
        const running = live ? (live.tabs.filter(t => t.kind !== 'shell').map(t => `${t.name} ${t.status ?? 'unknown'}`).join(', ') || (live.phase === 'live' ? 'a shell' : 'nothing (not connected)')) : 'nothing (not opened)';
        lines.push(`- ${p.name} [${p.id}]: tabs ${tabs}; running ${running}; status ${statusWords(deskStatus(live))}; ${p.where}, facing ${facing(p.rotation)}`);
    }
    const walls = places.filter(p => p.kind === 'web-wall');
    lines.push(`Web walls (${walls.length}):`);
    for (const p of walls) {
        const e = byId.get(p.id) as Extract<WorldEntity, { kind: 'web-wall' }>;
        const shows = webShows(e, runtime);
        lines.push(`- ${p.name} [${p.id}]: ${shows}; ${p.where}`);
    }
    const other = places.filter(p => p.kind !== 'station' && p.kind !== 'web-wall');
    if (other.length) {
        lines.push(`Other things (${other.length}):`);
        for (const p of other) lines.push(`- ${p.name} [${p.id}] (${p.kind === 'decor' ? (byId.get(p.id) as Extract<WorldEntity, { kind: 'decor' }>).decor : p.kind}): ${p.where}`);
    }
    return { text: lines.join('\n'), places, world, runtime };
}
function webShows(e: Extract<WorldEntity, { kind: 'web-wall' }>, runtime: RuntimeSnapshot): string {
    // One live web surface draws on the walls today: a wall shows the live page when it is its home (or it has no home).
    const live = runtime.web;
    if (live && (!e.home || sameUrl(e.home, live.url))) return `showing “${live.title || shortUrl(live.url)}” (${shortUrl(live.url)})`;
    if (e.home) return `home page ${shortUrl(e.home)} (not open)`;
    return live ? `showing “${live.title || shortUrl(live.url)}” (${shortUrl(live.url)})` : 'no page open';
}
function sameUrl(a: string, b: string): boolean { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } }
export function shortUrl(url: string): string { return url.replace(/^https?:\/\//, '').replace(/\/$/, ''); }

// ---- finding things by name ----------------------------------------------------------------------------

const KIND_WORDS: Array<[RegExp, EntityKind]> = [[/\bweb ?wall|web page|browser|web screen\b/, 'web-wall'], [/\bmonitor wall\b/, 'monitor-wall'], [/\bmirror\b/, 'mirror'], [/\bcode review|review screen\b/, 'review-screen']];
function norm(s: string): string { return s.toLowerCase().replace(/[“”"'’?!.,]/g, ' ').replace(/\b(the|my|a|an|our|please)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
/** The entity a phrase names ("the Claude desk", "desk two", "the web wall", "lamp"), best match first. */
export function findEntity(snap: Pick<WorldSnapshot, 'places' | 'world' | 'runtime'>, phrase: string): Place | undefined {
    const q = norm(phrase);
    if (!q) return undefined;
    const scored: Array<[number, Place]> = [];
    for (const p of snap.places) {
        const n = norm(p.name);
        let s = 0;
        if (n === q) s = 100;
        else if (n && (n.includes(q) || q.includes(n))) s = 70 + Math.min(20, n.length);
        else {
            const words = q.split(' ').filter(w => w.length > 1 && w !== 'desk' && w !== 'wall');
            const hit = words.filter(w => n.split(' ').includes(w)).length;
            if (hit) s = 30 + hit * 10;
        }
        const e = snap.world.entities.find(x => x.id === p.id);
        // "the Claude desk" with no desk named Claude: a desk running a Claude tab.
        if (!s && e?.kind === 'station' && /\bdesk\b/.test(q)) {
            const agent = /\b(claude|codex|hermes|dsh)\b/.exec(q)?.[1];
            if (agent && (e.station.tabs.some(t => t.kind === agent) || snap.runtime.desks.find(d => d.id === p.id)?.tabs.some(t => t.kind === agent))) s = 50;
        }
        for (const [re, kind] of KIND_WORDS) if (!s && re.test(q) && p.kind === kind) s = 40;
        if (!s && e?.kind === 'decor' && q.split(' ').includes(e.decor)) s = 35;
        if (!s && /^desk$/.test(q) && p.kind === 'station') s = 20;
        if (s) scored.push([s, p]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored[0]?.[1];
}

// ---- answers -------------------------------------------------------------------------------------------

export interface OmoAnswer { text: string; /** the entity the answer is about: the UI beams to it */ target?: string }
interface AnswerRule { re: RegExp; answer(m: RegExpExecArray, snap: WorldSnapshot): OmoAnswer }
const near = (snap: WorldSnapshot, p: Place): string => {
    const other = snap.places.filter(o => o.id !== p.id && o.kind !== 'decor').map(o => [Math.hypot(o.x - p.x, o.z - p.z), o] as const).sort((a, b) => a[0] - b[0])[0];
    return other && other[0] < 2.6 ? `, next to ${other[1].name}` : '';
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const ANSWERS: AnswerRule[] = [
    { re: /^(?:omo[, ]+)?(?:where(?:'s| is| are)|where\s+did\s+i\s+put|find|locate|show me)\s+(.+?)\s*\??$/i, answer: (m, snap) => {
        const p = findEntity(snap, m[1]);
        if (!p) return { text: `I can't find ${m[1].replace(/\?$/, '')} in this room.${/\bdesk\b/i.test(m[1]) ? ' Say “add a desk for Claude” to make one.' : ''}` };
        return { text: `${cap(p.name)} is ${p.where}${near(snap, p)}.`, target: p.id };
    } },
    { re: /^(?:omo[, ]+)?what(?:'s| is)\s+(?:on|showing on|open on|playing on)\s+(.+?)\s*\??$/i, answer: (m, snap) => {
        const p = findEntity(snap, m[1]) ?? (/\bwall|screen|web\b/i.test(m[1]) ? snap.places.find(x => x.kind === 'web-wall') : undefined);
        if (!p) return { text: `I can't find ${m[1]} in this room.` };
        const e = snap.world.entities.find(x => x.id === p.id)!;
        if (e.kind === 'web-wall') { const shows = webShows(e, snap.runtime); return { text: shows === 'no page open' ? `${cap(p.name)} has no page open.` : `${cap(p.name)} is ${shows}.`, target: p.id }; }
        if (e.kind === 'station') return { text: deskLine(snap, e), target: p.id };
        return { text: `${cap(p.name)} is ${p.where}.`, target: p.id };
    } },
    { re: /^(?:omo[, ]+)?what(?:'s| is)\s+(?:running|happening|going on)\s+(?:on|at|in)\s+(.+?)\s*\??$/i, answer: (m, snap) => {
        const p = findEntity(snap, m[1]);
        const e = p && snap.world.entities.find(x => x.id === p.id);
        if (!p || !e || e.kind !== 'station') return { text: `I can't find a desk called ${m[1]}.` };
        return { text: deskLine(snap, e), target: p.id };
    } },
    { re: /^(?:omo[, ]+)?(?:what(?:'s| is) in (?:this|the|my) (?:room|world)|what do i have|list (?:my )?(?:desks|things|everything)|how many desks(?: do i have| are there)?)\s*\??$/i, answer: (_m, snap) => {
        const desks = snap.places.filter(p => p.kind === 'station'), walls = snap.places.filter(p => p.kind === 'web-wall');
        const working = snap.runtime.desks.filter(d => deskStatus(d) === 'working').length, waiting = snap.runtime.desks.filter(d => deskStatus(d) === 'waiting').length;
        return { text: `${desks.length} desk${desks.length === 1 ? '' : 's'} (${desks.map(d => d.name).join(', ') || 'none'}), ${walls.length} web wall${walls.length === 1 ? '' : 's'}${working || waiting ? `; ${working} working, ${waiting} waiting for you` : ''}.` };
    } }
];
function deskLine(snap: WorldSnapshot, e: Extract<WorldEntity, { kind: 'station' }>): string {
    const live = snap.runtime.desks.find(d => d.id === e.id);
    const name = cap(entityName(e));
    if (!live) return `${name} has ${e.station.tabs.map(t => t.name).join(' and ')}; it is not opened yet.`;
    const agents = live.tabs.filter(t => t.kind !== 'shell');
    const what = agents.length ? agents.map(t => `${t.name} (${t.status && t.status !== 'unknown' ? t.status.replace('waiting-approval', 'waiting for you') : 'no signal'})`).join(', ') : live.phase === 'live' ? 'a plain shell' : 'nothing yet';
    return `${name} is running ${what}; ${statusWords(deskStatus(live))}.`;
}
/** True when the line is a question about the room (no change wanted). */
export function isRoomQuestion(text: string): boolean { return ANSWERS.some(r => r.re.test(text.trim())); }
/** A one-line answer from the snapshot, or undefined when the line is not a room question. */
export function answerQuestion(snap: WorldSnapshot, text: string): OmoAnswer | undefined {
    const t = text.trim().replace(/\s+/g, ' ');
    for (const rule of ANSWERS) { rule.re.lastIndex = 0; const m = rule.re.exec(t); if (m) return rule.answer(m, snap); }
    return undefined;
}

// ---- routing a Shape line -------------------------------------------------------------------------------

export type OmoRoute =
    | { kind: 'ask' }
    | { kind: 'page'; page: PageRequest }
    | { kind: 'goto'; target: string }
    | { kind: 'back' }
    | { kind: 'change' };
export function routeOmo(text: string): OmoRoute {
    const t = text.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
    if (/^(?:omo[, ]+)?(?:where was i|where did i leave off|take me back|back to where i was|go back to where i was)\b\??$/i.test(t)) return { kind: 'back' };
    const go = /^(?:omo[, ]+)?(?:take me to|go to|walk (?:me )?to|bring me to|fly (?:me )?to)\s+(.+)$/i.exec(t);
    if (go) return { kind: 'goto', target: go[1] };
    const page = pageRequest(t);
    if (page) return { kind: 'page', page };
    if (isRoomQuestion(t)) return { kind: 'ask' };
    return { kind: 'change' };
}

// ---- pages on demand ------------------------------------------------------------------------------------

export type PageTemplate = 'dashboard' | 'notes' | 'landing';
export interface PageRequest { template: PageTemplate; title: string; words: string; slug: string }
export function slugify(s: string): string { return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'page'; }
const titleCase = (s: string): string => { const t = s.trim().replace(/\s+/g, ' ').slice(0, 60); return t.charAt(0).toUpperCase() + t.slice(1); };
/** "make a dashboard of my desks" / "make a page that shows X" / "make a landing page for X" -> a page, else undefined. */
export function pageRequest(text: string): PageRequest | undefined {
    const t = text.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
    const m = /^(?:omo[, ]+)?(?:make|build|create|generate|give me|put up)\s+(?:me\s+)?(?:a|an|one)\s+(?:(?:live|little|simple|new|quick|small)\s+)*(dashboard|landing page|report|notes page|notes|status page|page|web page)\b\s*(.*)$/i.exec(t);
    if (!m) return undefined;
    const what = m[1].toLowerCase(), rest = m[2].replace(/^(?:of|for|about|that shows|which shows|showing|that lists|with|on)\s+/i, '').trim();
    const deskish = /\b(desks?|agents?|status|terminals?|workstations?)\b/i.test(rest);
    if (what === 'dashboard' || what === 'status page' || ((what === 'page' || what === 'web page') && deskish)) {
        const title = !rest || deskish ? 'Desk dashboard' : `${titleCase(rest)} dashboard`;
        return { template: 'dashboard', title, words: rest, slug: slugify(title) };
    }
    if (what === 'landing page') {
        const title = rest ? titleCase(rest) : 'Landing page';
        return { template: 'landing', title, words: rest, slug: slugify(`${title} landing`) };
    }
    const title = rest ? titleCase(rest) : what === 'report' ? 'Room report' : 'Notes';
    return { template: 'notes', title, words: rest, slug: slugify(title) };
}

// ---- walking back in ------------------------------------------------------------------------------------

export interface ReturnRecord { at: number; desks: Array<{ id: string; name: string; status: DeskStatus }> }
export function returnRecord(snap: RuntimeSnapshot, names: (id: string) => string, at = Date.now()): ReturnRecord {
    return { at, desks: snap.desks.map(d => ({ id: d.id, name: names(d.id) || d.name || d.id, status: deskStatus(d) })) };
}
function away(ms: number): string {
    const m = Math.round(ms / 60000);
    if (m < 1) return '';
    if (m < 60) return ` (away ${m} min)`;
    const h = Math.round(m / 60);
    return h < 48 ? ` (away ${h} h)` : ` (away ${Math.round(h / 24)} days)`;
}
/** "Since you left: 2 desks finished, 1 waiting for you." from what the desks were doing then and now. */
export function sinceYouLeft(before: ReturnRecord | undefined, now: ReturnRecord): string | undefined {
    if (!before || !before.desks.length) return undefined;
    const prev = new Map(before.desks.map(d => [d.id, d.status]));
    let finished = 0, waiting = 0, started = 0, stopped = 0;
    for (const d of now.desks) {
        const was = prev.get(d.id), busy = was === 'working' || was === 'waiting';
        if (d.status === 'waiting') waiting++;
        // An agent that was busy and is now idle, or gone back to its plain shell, has finished.
        else if ((d.status === 'idle' || d.status === 'shell') && busy) finished++;
        else if (d.status === 'working' && was !== 'working') started++;
        // A busy desk that is not connected now: its agent stopped while you were away.
        else if (d.status === 'off' && busy) stopped++;
    }
    const parts: string[] = [];
    const n = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;
    if (finished) parts.push(`${n(finished, 'desk')} finished`);
    if (waiting) parts.push(`${waiting} waiting for you`);
    if (started) parts.push(`${n(started, 'desk')} started working`);
    if (stopped) parts.push(`${n(stopped, 'desk')} stopped (not connected now)`);
    const gap = away(now.at - before.at);
    if (!parts.length) {
        const ready = now.desks.filter(d => d.status !== 'off').length;
        return `Since you left: nothing changed${ready ? ` · ${n(ready, 'desk')} still open` : ''}${gap}.`;
    }
    return `Since you left: ${parts.join(', ')}${gap}.`;
}

// ---- memory you can walk: the places you used, newest last -----------------------------------------------

export interface VisitedPlace { id: string; name: string; at: number }
export const MAX_VISITS = 20;
/** Add a visit (a screen you used, a place Omo took you); a repeat of the newest just refreshes its time. */
export function rememberPlace(list: readonly VisitedPlace[], visit: VisitedPlace): VisitedPlace[] {
    const prev = list[list.length - 1];
    if (prev && prev.id === visit.id) return [...list.slice(0, -1), visit];
    return [...list.filter(v => v.id !== visit.id), visit].slice(-MAX_VISITS);
}
/**
 * "Where was I": the last place you used. When you are standing at that place already (Omo just took you
 * there), the one before it. Places that are no longer in the world are skipped.
 */
export function whereWasI(list: readonly VisitedPlace[], hereId: string | undefined, exists: (id: string) => boolean): VisitedPlace | undefined {
    const live = list.filter(v => exists(v.id));
    for (let i = live.length - 1; i >= 0; i--) if (live[i].id !== hereId) return live[i];
    return undefined;
}
export function agoWords(ms: number): string {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// ---- where a made page hangs: a solid wall, clear of furniture, in sight -----------------------------------

export type Side = 'north' | 'south' | 'east' | 'west';
/** A wall spot for a new page: centre on the floor plan, rotation (the screen faces into the room), height. */
export interface WallSpot { x: number; z: number; rotation: number; elevation: number; width: number; height: number; side: Side }
interface Box2 { x: number; z: number; hx: number; hz: number; tall: boolean }
/** Eye height (m) the page's centre hangs at. */
export const PAGE_EYE = 1.55;
function footprint(e: WorldEntity): Box2 | undefined {
    const { x, z, rotation } = e.transform;
    const turn = Math.abs(Math.sin(rotation)) > 0.7;
    let hx = 0.4, hz = 0.4, tall = true;
    if (e.kind === 'room') return undefined;
    if (e.kind === 'station') { hx = 1.8; hz = 1.05; tall = true; }
    else if (e.kind === 'web-wall' || e.kind === 'monitor-wall') { hx = e.width / 2; hz = 0.2; }
    else if (e.kind === 'mirror') { hx = 0.7; hz = 0.2; }
    else if (e.kind === 'review-screen') { hx = 0.9; hz = 0.3; }
    else if (e.kind === 'decor') {
        const prop = kitProp(e.prop), k = e.scale ?? 1;
        if (prop) { hx = prop.half.x * k; hz = prop.half.z * k; tall = prop.category === 'plant' || prop.category === 'shelf' || prop.category === 'storage'; }
        else { tall = e.decor !== 'rug'; if (e.decor === 'rug') return undefined; }
    }
    return { x, z, hx: turn ? hz : hx, hz: turn ? hx : hz, tall };
}
const hit = (a: Box2, b: Box2, gap: number): boolean => Math.abs(a.x - b.x) < a.hx + b.hx + gap && Math.abs(a.z - b.z) < a.hz + b.hz + gap;
/** True when the floor segment p -> q crosses the box (slab test). */
function crosses(p: { x: number; z: number }, q: { x: number; z: number }, b: Box2): boolean {
    let t0 = 0, t1 = 1;
    for (const [o, d, lo, hi] of [[p.x, q.x - p.x, b.x - b.hx, b.x + b.hx], [p.z, q.z - p.z, b.z - b.hz, b.z + b.hz]] as const) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return false; continue; }
        let a = (lo - o) / d, c = (hi - o) / d; if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) return false;
    }
    return true;
}
/**
 * promise-agent fix 2 — the wall a made page hangs on. Only solid walls (a kit's glazing, e.g. the penthouse's
 * north and east glass, never), clear of the kit's baked furniture and every thing in the world, the centre at
 * eye height, and a clear line of sight from where you stand (`from`). Best: in sight, about 5 m away.
 * Undefined in an open world (no walls) — the planner then finds its own spot.
 */
export function pageWallSpot(world: WorldSpec, from?: { x: number; z: number }, size: { width: number; height: number } = { width: 3.2, height: 1.8 }): WallSpot | undefined {
    if (world.shell.open) return undefined;
    const kit = activeKit(world);
    const glass = new Set<Side>(kit?.glass ?? []);
    const W = world.shell.width / 2, D = world.shell.depth / 2, hw = size.width / 2, inset = 0.35;
    const things: Box2[] = [
        ...(kit?.blocks ?? []).map(b => ({ x: b.x, z: b.z, hx: b.hx, hz: b.hz, tall: true })),
        ...world.entities.map(footprint).filter((b): b is Box2 => !!b)
    ];
    const eye = from ?? (kit ? { x: kit.spawn.x, z: kit.spawn.z } : { x: 0, z: Math.min(4.1, D - 0.9) });
    const sides: Array<{ side: Side; rotation: number; at(u: number): { x: number; z: number }; span: number }> = [
        { side: 'south', rotation: Math.PI, at: u => ({ x: u, z: D - inset }), span: W },
        { side: 'west', rotation: Math.PI / 2, at: u => ({ x: -W + inset, z: u }), span: D },
        { side: 'north', rotation: 0, at: u => ({ x: u, z: -D + inset }), span: W },
        { side: 'east', rotation: -Math.PI / 2, at: u => ({ x: W - inset, z: u }), span: D }
    ];
    let best: { score: number; spot: WallSpot } | undefined;
    for (const s of sides) {
        if (glass.has(s.side)) continue;
        for (let u = -s.span + hw + 0.3; u <= s.span - hw - 0.3 + 1e-9; u += 0.2) {
            const c = s.at(u), along = s.side === 'south' || s.side === 'north';
            const me: Box2 = { x: c.x, z: c.z, hx: along ? hw : 0.2, hz: along ? 0.2 : hw, tall: true };
            if (things.some(b => hit(me, b, 0.25))) continue;
            // In front of the screen, 1.2 m of floor stays free (you can stand there and look at it).
            const front: Box2 = { x: c.x + Math.sin(s.rotation) * 0.9, z: c.z + Math.cos(s.rotation) * 0.9, hx: along ? hw : 0.6, hz: along ? 0.6 : hw, tall: false };
            if (things.some(b => b.tall && hit(front, b, 0))) continue;
            const dist = Math.hypot(c.x - eye.x, c.z - eye.z);
            // Things you stand inside or right against (your own desk) do not block the view.
            const blocked = things.filter(b => b.tall && crosses(eye, c, b) && !(Math.abs(eye.x - b.x) <= b.hx + 0.1 && Math.abs(eye.z - b.z) <= b.hz + 0.1)).length;
            const score = blocked * 10 + Math.abs(dist - 5) + Math.abs(u) * 0.02;
            if (!best || score < best.score) best = { score, spot: { x: Math.round(c.x * 100) / 100, z: Math.round(c.z * 100) / 100, rotation: s.rotation, elevation: Math.round(Math.max(0.3, PAGE_EYE - size.height / 2) * 100) / 100, width: size.width, height: size.height, side: s.side } };
        }
    }
    return best?.spot;
}
/** The side of the shell a wall thing hangs on (nearest edge), for checks and words. */
export function wallSide(world: WorldSpec, at: { x: number; z: number }): Side {
    const W = world.shell.width / 2, D = world.shell.depth / 2;
    const d: Array<[Side, number]> = [['north', at.z + D], ['south', D - at.z], ['west', at.x + W], ['east', W - at.x]];
    return d.sort((a, b) => a[1] - b[1])[0][0];
}
/** True when that side of the shell is glazing (a kit's glass), so no screen should hang there. */
export function isGlassSide(world: WorldSpec, side: Side): boolean { return !!activeKit(world)?.glass?.includes(side); }

export interface StandPose { x: number; z: number; yaw: number; pitch: number }
/** Where to stand to look at a thing: in front of its screen, facing it, inside the floor. */
export function placePose(e: WorldEntity, world: WorldSpec): StandPose {
    const r = e.transform.rotation;
    const d = e.kind === 'station' ? 1.75 : e.kind === 'web-wall' || e.kind === 'monitor-wall' ? Math.max(2.4, Math.min(4.5, e.width * 0.8)) : WALL_KINDS.has(e.kind) ? 2.0 : 1.6;
    const w = world.shell.width / 2 - 0.45, dd = world.shell.depth / 2 - 0.45;
    const x = Math.max(-w, Math.min(w, e.transform.x + Math.sin(r) * d)), z = Math.max(-dd, Math.min(dd, e.transform.z + Math.cos(r) * d));
    return { x: Math.round(x * 1000) / 1000, z: Math.round(z * 1000) / 1000, yaw: r, pitch: e.kind === 'station' ? -0.12 : 0.04 };
}
