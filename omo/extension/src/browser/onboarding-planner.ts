/**
 * w2:onboard — deterministic, offline "prompt to world" planner.
 *
 * Maps a short plan ("research lab: 3 Hermes desks for literature, data and writing, a shared monitor
 * wall, a web wall for papers") to a valid WorldSpec built ONLY through `applyWorldOps`, so every result
 * passes the shared contract's validation. No model, no network, no randomness: the same text always
 * gives the same world. Nothing here starts an agent; a station's tabs are only what the desk OFFERS
 * to open after the user confirms.
 *
 * Pure module (no DOM, no Theia) so it can run in Node for checks.
 */
import {
    WORLD_VERSION, WORLD_MAX_ENTITIES, WORLD_MAX_STATIONS, applyWorldOps, defaultStation, stations, worldFromRoomV1,
    WorldSpec, WorldEntity, WorldOp, WorldShell, Transform, StationConfig, StationEntity, DecorKind, WorldResult
} from '../common/world-model';
import type { RoomTheme } from '../common/room-state';
import type { RoomLayoutId, RoomKitId } from '../common/player-state';
import { ROOM_LAYOUTS } from '../common/player-state';

export type DeskAgent = 'hermes' | 'claude' | 'codex' | 'shell';

export interface PlanOptions {
    /** World (workspace) name. Falls back to a title before ':' in the text, then 'My workspace'. */
    name?: string;
    /** An explicit theme choice wins over theme words in the text. */
    theme?: RoomTheme;
}

export interface PlanResult {
    world: WorldSpec;
    /** Short human lines: what the planner understood. */
    notes: string[];
    /** Things it had to cap or could not use. */
    warnings: string[];
    /** Theme found in the text (undefined = default). */
    detectedTheme?: RoomTheme;
}

export interface OnboardingTemplate { id: string; title: string; caption: string; symbol: string; prompt: string; }

/** Prompt cards for step 1. They only fill the text box; the planner does the rest. */
export const ONBOARDING_TEMPLATES: readonly OnboardingTemplate[] = [
    { id: 'research', title: 'Research lab', caption: '3 desks · monitor wall · papers', symbol: '⌬',
        prompt: 'research lab: 3 Hermes desks for literature, data and writing, a shared monitor wall, a web wall for papers' },
    { id: 'team', title: 'Agent team', caption: 'Hermes · Claude · Codex', symbol: '⁂',
        prompt: 'agent team: a Hermes desk for planning, a Claude desk for code, a Codex desk for review, a monitor wall for planning, a web wall for docs' },
    { id: 'solo', title: 'Solo builder', caption: '1 desk · docs wall · cosy', symbol: '◐',
        prompt: 'a cosy space station: 1 Hermes desk for building, a web wall for docs, a plant and a lamp' },
    { id: 'jungle', title: 'Jungle studio', caption: '2 writing desks · plants', symbol: '✳',
        prompt: 'prehistoric jungle studio: 2 Hermes desks for writing and editing, a web wall for references, plants and a sofa' },
    { id: 'ops', title: 'Mission control', caption: '4 shells · 2 monitor walls', symbol: '◉',
        prompt: 'mission control in orbit: 4 shell desks for build, deploy, logs and alerts, 2 monitor walls, a web wall for dashboards' },
    { id: 'classic', title: 'Classic room', caption: 'The original Omo room', symbol: '▢',
        prompt: 'classic room: 2 desks, a web wall and a mirror' }
];

const NUMBER_WORDS: Record<string, number> = {
    a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, 'pair of': 2, 'couple of': 2, few: 3, 'a few': 3, several: 3
};
const ORDINAL = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
const QTY = '(\\d{1,2}|a few|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|single|pair of|couple of|few|several)';
const LOOKBEHIND_QTY = new RegExp(`(?:^|[^a-z0-9])${QTY}\\s+((?:[a-z][a-z-]*\\s+){0,2})$`);
const ADJ_ONLY = /(?:^|[\s,:;(])((?:[a-z][a-z-]*\s+){1,2})$/;
const ENTITY_WORD = /\b(walls?|mirrors?|desks?|stations?|workstations?|screens?|plants?|lamps?|sofas?|couch|rugs?|windows?|bookshel(f|ves)|whiteboards?|crystals?|theme|jungle|space)\b/;
const STOP_START = new RegExp(`^(?:the|${QTY})\\b`);

const JUNGLE_WORDS = /\b(jungle|forest|prehistoric|dino\w*|rain ?forest|garden|greenhouse|tropical|nature|leafy|green|botanic\w*|expedition)\b/g;
const SPACE_WORDS = /\b(space|orbit\w*|galax\w*|cosmic|observatory|moon|mars|sci-?fi|rocket|starship|mission control|astro\w*)\b/g;

const DECOR_WORDS: Array<[RegExp, DecorKind]> = [
    [/\b(plants?|greenery|ferns?|palms?)\b/, 'plant'], [/\blamps?\b/, 'lamp'], [/\bcrystals?\b/, 'crystal'],
    [/\b(sofas?|couch(es)?|lounge)\b/, 'sofa'], [/\b(bookshel(f|ves)|library|books)\b/, 'bookshelf'],
    [/\b(white ?boards?)\b/, 'whiteboard'], [/\b(rugs?|carpet)\b/, 'rug'], [/\bwindows?\b/, 'window']
];

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const half = (n: number): number => Math.round(n * 2) / 2;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const cleanLabel = (s: string): string => capitalize(s.replace(/[^\p{L}\p{N} '&+./-]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 60);

/** Remove things that must never live in a shared WorldSpec: tokens, keys and host paths. */
export function sanitizePlanText(text: string): string {
    return text
        .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat|AKIA|AIza)[-_A-Za-z0-9]{8,}/g, '[removed]')
        .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[removed]')
        .replace(/(?:^|\s)(?:~\/|\/home\/|\/Users\/|\/root\/|\/var\/|\/etc\/|[A-Za-z]:\\)[^\s,;]*/g, ' [path]')
        .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
        .slice(0, 4000);
}

/** An http(s) URL reduced to origin + path: no query, fragment or credentials in a shared world. */
export function safeHomeUrl(raw: string): string | undefined {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
        return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2048);
    } catch { return undefined; }
}

interface Mention { index: number; end: number; count?: number; adjectives: string[]; plural: boolean; purpose?: string; roles: string[]; }

function quantityBefore(text: string, index: number): { count?: number; adjectives: string[]; article?: string } {
    const before = text.slice(Math.max(0, index - 48), index);
    const m = LOOKBEHIND_QTY.exec(before);
    if (m) {
        const word = m[1];
        const count = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
        return { count, adjectives: m[2].trim().split(/\s+/).filter(Boolean) };
    }
    const adj = ADJ_ONLY.exec(before);
    const adjectives = adj ? adj[1].trim().split(/\s+/).filter(Boolean) : [];
    return { adjectives, article: adjectives[0] === 'the' ? 'the' : undefined };
}

function purposeAfter(text: string, end: number): string | undefined {
    const m = /^\s+(?:for|showing|with|of)\s+(?:the\s+)?([a-z0-9][a-z0-9 -]{0,40}?)(?=\s*(?:[,.;:!?\n)]|\band\b|\bwith\b|$))/.exec(text.slice(end));
    if (!m) return undefined;
    const p = m[1].trim();
    return p && !ENTITY_WORD.test(p) && !STOP_START.test(p) ? p : undefined;
}

function rolesAfter(text: string, end: number, max: number): string[] {
    const m = /^\s*(?:for|doing|on|to|:|—|-)\s+/.exec(text.slice(end));
    if (!m) return [];
    const rest = text.slice(end + m[0].length).split(/[.;!?\n(]/)[0];
    const roles: string[] = [];
    for (const raw of rest.split(/,|\band\b|\bplus\b|&|\//)) {
        let item = raw.trim().replace(/^the\s+/, '').replace(/\s+(?:in|at|on|inside|aboard|with)\s+.*$/, '');
        if (!item || STOP_START.test(raw.trim()) || ENTITY_WORD.test(item)) break;
        item = item.split(/\s+/).slice(0, 3).join(' ');
        roles.push(item);
        if (roles.length >= max) break;
    }
    return roles;
}

function findMentions(text: string, noun: RegExp, opts: { skipBefore?: RegExp; roles?: boolean } = {}): Mention[] {
    const out: Mention[] = [];
    const re = new RegExp(noun.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const index = m.index, end = index + m[0].length;
        if (opts.skipBefore && opts.skipBefore.test(text.slice(Math.max(0, index - 24), index))) continue;
        const q = quantityBefore(text, index);
        if (q.article === 'the' && q.count === undefined) continue; // "the data desk" refers back; it is not a new thing
        const plural = /s$/.test(m[0]) || /\bwalls of\b/.test(m[0]);
        const roles = opts.roles ? rolesAfter(text, end, q.count ?? WORLD_MAX_STATIONS) : [];
        out.push({ index, end, count: q.count, adjectives: q.adjectives, plural, roles, purpose: opts.roles ? undefined : purposeAfter(text, end) });
    }
    return out;
}

/** Tabs a desk offers. Opening any agent tab still asks the user first. */
export function stationForAgent(name: string, agent: DeskAgent, profile?: string): StationConfig {
    const base: StationConfig = agent === 'hermes' ? defaultStation(name, 'hermes')
        : agent === 'shell' ? defaultStation(name, 'shell')
            : { name, kind: 'shell', tabs: [{ name: agent === 'claude' ? 'Claude' : 'Codex', kind: agent }, { name: 'Shell', kind: 'shell' }], locked: false };
    if (profile && agent === 'hermes') base.profile = profile;
    return base;
}
export function agentOf(station: StationConfig): DeskAgent {
    const first = station.tabs[0]?.kind;
    return first === 'hermes' || first === 'claude' || first === 'codex' ? first : 'shell';
}
export const AGENT_LABEL: Record<DeskAgent, string> = { hermes: 'Hermes', claude: 'Claude', codex: 'Codex', shell: 'Shell' };

function agentFromWords(words: string[], fallback: DeskAgent): DeskAgent {
    const w = words.join(' ');
    if (/\bhermes\b/.test(w)) return 'hermes';
    if (/\bclaude\b/.test(w)) return 'claude';
    if (/\bcodex\b/.test(w)) return 'codex';
    if (/\b(shell|terminal|bash|zsh|console)\b/.test(w)) return 'shell';
    return fallback;
}

/** Stable ids: the first two desks keep the v1 ids so runtime bindings and saved workspaces still match. */
export function nextStationId(taken: ReadonlySet<string>): string {
    if (!taken.has('terminal')) return 'terminal';
    if (!taken.has('terminal-2')) return 'terminal-2';
    for (let i = 3; ; i++) if (!taken.has(`desk-${i}`)) return `desk-${i}`;
}
export function nextId(taken: ReadonlySet<string>, base: string): string {
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
export function deskName(index: number): string { return `Desk ${ORDINAL[index] ?? String(index + 1)}`; }

const ORIGIN: Transform = { x: 0, z: 0, rotation: 0 };

/** Deterministic placement of every entity for a given world. Pure; used by the planner and by edits. */
export function arrangement(world: WorldSpec): { shell: WorldShell; transforms: Map<string, Transform>; sizes: Map<string, { width: number; height: number; elevation: number }> } {
    const desks = stations(world);
    const n = desks.length;
    const cols = n <= 3 ? Math.max(1, n) : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    const rows = Math.max(1, Math.ceil(n / cols));
    const walls = world.entities.filter(e => e.kind === 'web-wall' || e.kind === 'monitor-wall');
    const width = n <= 2 && walls.length <= 2 ? 12 : clamp(half(Math.max(cols * 4.4 + 2.4, walls.length * 2.8 + 1)), 12, 40);
    const depth = n <= 2 ? 10 : clamp(half(rows * 3.2 + 7), 10, 40);
    const shell: WorldShell = { theme: world.shell.theme, width, depth };
    const transforms = new Map<string, Transform>();
    const sizes = new Map<string, { width: number; height: number; elevation: number }>();
    // Desks: the familiar classic positions for one or two desks, else a centred grid facing the back wall.
    desks.forEach((desk, i) => {
        if (n <= 2) {
            const d = n === 1 ? { x: 0, z: 0 } : (i === 0 ? ROOM_LAYOUTS.classic.desks.terminal : ROOM_LAYOUTS.classic.desks['terminal-2']);
            transforms.set(desk.id, { x: d.x, z: d.z, rotation: 0 });
            return;
        }
        const row = Math.floor(i / cols), inRow = row === rows - 1 ? n - row * cols : cols, col = i - row * cols;
        transforms.set(desk.id, { x: r3((col - (inRow - 1) / 2) * 4.4), z: r3(-depth / 2 + 3.6 + row * 3.2), rotation: 0 });
    });
    // Walls: along the back wall while they fit, then down the side walls.
    const backCapacity = Math.max(1, Math.floor((width - 1) / 2.6));
    const back = walls.slice(0, backCapacity), side = walls.slice(backCapacity);
    const slot = (width - 1) / Math.max(1, back.length);
    back.forEach((wall, i) => {
        const isWeb = wall.kind === 'web-wall';
        const w = r3(clamp(Math.min(isWeb ? 3.9 : 3.2, slot - 0.4), isWeb ? 0.8 : 0.6, 8));
        transforms.set(wall.id, { x: r3(-width / 2 + 0.5 + slot * (i + 0.5)), z: r3(-depth / 2 + 0.88), rotation: 0 });
        sizes.set(wall.id, { width: w, height: isWeb ? 2.44 : 1.8, elevation: isWeb ? 0.68 : 0.9 });
    });
    side.forEach((wall, i) => {
        const left = i % 2 === 0, step = Math.floor(i / 2);
        const isWeb = wall.kind === 'web-wall';
        transforms.set(wall.id, { x: r3(left ? -width / 2 + 0.3 : width / 2 - 0.3), z: r3(clamp(-depth / 2 + 2.2 + step * 3.4, -depth / 2 + 1, depth / 2 - 1)), rotation: left ? Math.PI / 2 : -Math.PI / 2 });
        sizes.set(wall.id, { width: isWeb ? 3 : 2.8, height: isWeb ? 2 : 1.6, elevation: isWeb ? 0.8 : 1 });
    });
    let mirrors = 0, reviews = 0, decor = 0;
    const decorSlots: Array<[number, number]> = [
        [-width / 2 + 0.8, -depth / 2 + 0.8], [width / 2 - 0.8, -depth / 2 + 0.8], [-width / 2 + 0.8, depth / 2 - 0.8], [width / 2 - 0.8, depth / 2 - 0.8],
        [-width / 2 + 0.8, 0], [width / 2 - 0.8, 0], [0, depth / 2 - 1.6], [-width / 4, depth / 2 - 0.8], [width / 4, depth / 2 - 0.8]
    ];
    for (const e of world.entities) {
        if (e.kind === 'mirror') { transforms.set(e.id, { x: r3(-width / 2 + 1.4), z: r3(clamp(depth / 2 - 3.8 - mirrors * 2.4, -depth / 2 + 1, depth / 2 - 1)), rotation: Math.PI / 2 }); mirrors++; }
        else if (e.kind === 'review-screen') { transforms.set(e.id, { x: r3(width / 2 - 1.4), z: r3(clamp(depth / 2 - 3.8 - reviews * 2.4, -depth / 2 + 1, depth / 2 - 1)), rotation: -Math.PI / 2 }); reviews++; }
        else if (e.kind === 'decor') {
            const [x, z] = decorSlots[decor % decorSlots.length];
            const nudge = Math.floor(decor / decorSlots.length) * 0.6;
            transforms.set(e.id, { x: r3(clamp(x + (x < 0 ? nudge : -nudge), -width / 2, width / 2)), z: r3(z), rotation: 0 });
            decor++;
        }
    }
    return { shell, transforms, sizes };
}

const sameT = (a: Transform, b: Transform): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6 && Math.abs(a.rotation - b.rotation) < 1e-6;

/** Ops that move everything to its arranged place (and resize the shell). Locked desks are never moved. */
export function arrangeOps(world: WorldSpec): WorldOp[] {
    const plan = arrangement(world);
    const ops: WorldOp[] = [];
    if (plan.shell.width !== world.shell.width || plan.shell.depth !== world.shell.depth) ops.push({ op: 'shell', shell: { width: plan.shell.width, depth: plan.shell.depth } });
    for (const e of world.entities) {
        if (e.kind === 'station' && e.station.locked) continue;
        const t = plan.transforms.get(e.id);
        if (t && !sameT(t, e.transform)) ops.push({ op: 'move', id: e.id, transform: t });
        const s = plan.sizes.get(e.id);
        if (s && (e.kind === 'web-wall' || e.kind === 'monitor-wall') && (s.width !== e.width || s.height !== e.height || s.elevation !== e.elevation)) ops.push({ op: 'resize', id: e.id, width: s.width, height: s.height, elevation: s.elevation });
    }
    return ops;
}

/** Apply user ops, then re-arrange. Atomic: an error leaves the world unchanged. */
export function applyOnboardingEdit(world: WorldSpec, ops: readonly WorldOp[]): WorldResult {
    const first = applyWorldOps(world, ops);
    if (!first.ok) return first;
    const tidy = arrangeOps(first.world);
    return tidy.length ? applyWorldOps(first.world, tidy) : first;
}

export function emptyWorld(name: string, theme: RoomTheme): WorldSpec {
    return { version: WORLD_VERSION, name: name.trim().slice(0, 120) || 'My workspace', shell: { theme, width: 12, depth: 10 }, entities: [], revision: 0 };
}

function detectTheme(text: string): RoomTheme | undefined {
    const jungle = (text.match(JUNGLE_WORDS) ?? []).length, space = (text.match(SPACE_WORDS) ?? []).length;
    if (jungle > space) return 'jungle';
    if (space > 0) return 'station';
    return undefined;
}

/** "research lab: ..." names the world. Not a URL colon, not a long sentence. */
export function planTitle(prompt: string): string | undefined {
    const title = /^\s*([^:,\n]{2,48}):(?!\/\/)/.exec(sanitizePlanText(prompt))?.[1]?.replace(/^(?:a|an|the|my|our)\s+/i, '');
    return title && title.split(/\s+/).length <= 6 ? cleanLabel(title) || undefined : undefined;
}

/** The deterministic planner. */
export function planWorld(prompt: string, options: PlanOptions = {}): PlanResult {
    const clean = sanitizePlanText(prompt).trim();
    const text = ` ${clean.toLowerCase().replace(/[’']/g, '\'')} `;
    const notes: string[] = [], warnings: string[] = [];
    if (clean !== prompt.trim() && /\[(removed|path)\]/.test(clean)) warnings.push('Removed what looked like a key, token or file path. Worlds are shared, so they never hold secrets.');
    const name = (options.name?.trim() || planTitle(clean) || 'My workspace').slice(0, 120);
    const detected = detectTheme(text);
    const theme: RoomTheme = options.theme ?? detected ?? 'station';

    // Empty plan: the classic v1 room, unchanged.
    if (!clean) {
        const world = worldFromRoomV1({ theme, projectName: name });
        return { world, notes: ['Classic room: two desks, a web wall, a mirror and code review'], warnings, detectedTheme: detected };
    }

    const globalAgent: DeskAgent = /\bhermes\b/.test(text) ? 'hermes' : /\bclaude\b/.test(text) && !/\bcodex\b/.test(text) ? 'claude'
        : /\bcodex\b/.test(text) && !/\bclaude\b/.test(text) ? 'codex' : /\b(shell|terminal)s?\b/.test(text) && !/\bagents?\b/.test(text) ? 'shell' : 'hermes';
    const profile = /\bprofile\s+["']?([A-Za-z0-9][A-Za-z0-9._-]{0,63})/.exec(clean)?.[1];

    // ----- desks -----
    const deskMentions = findMentions(text, /\b(desks?|workstations?|agents?|seats?|computers?|stations?)\b/, { skipBefore: /\b(space|docking|mission|charging|weather)\s+$/, roles: true })
        .filter(m => !/^\s*(?:theme|wall|walls|team|tab|tabs|kinds?)\b/.test(text.slice(m.end)) && !m.adjectives.includes('monitor')
            // "agent", "seat" and "computer" only count with a number ("3 agents"), never in "agent team".
            && (m.count !== undefined || /^(desks?|workstations?|stations?)$/.test(text.slice(m.index, m.end))));
    interface DeskPlan { name?: string; agent: DeskAgent }
    const desks: DeskPlan[] = [];
    for (const m of deskMentions) {
        const count = m.count ?? (m.plural ? Math.max(2, m.roles.length) : 1);
        const agent = agentFromWords(m.adjectives, globalAgent);
        const adjective = m.adjectives.filter(a => !/^(hermes|claude|codex|shell|terminal|agent|ai|big|small|shared|new|more|extra|separate|code)$/.test(a)).join(' ');
        for (let i = 0; i < count; i++) {
            const role = m.roles[i];
            desks.push({ agent, name: role ? cleanLabel(role) : adjective ? `${cleanLabel(adjective)}${count > 1 ? ` ${i + 1}` : ''}` : undefined });
        }
    }
    if (!desks.length) {
        if (/\b(solo|just me|alone|single desk|focus room)\b/.test(text)) desks.push({ agent: globalAgent });
        else { desks.push({ agent: globalAgent }, { agent: globalAgent === 'hermes' ? 'shell' : globalAgent }); notes.push('No desk count found, so two desks were added'); }
    }
    if (desks.length > WORLD_MAX_STATIONS) { warnings.push(`A world holds at most ${WORLD_MAX_STATIONS} desks. The first ${WORLD_MAX_STATIONS} were kept.`); desks.length = WORLD_MAX_STATIONS; }

    const entities: WorldEntity[] = [];
    const taken = new Set<string>();
    const usedNames = new Set<string>();
    desks.forEach((d, i) => {
        const id = nextStationId(taken); taken.add(id);
        let label = d.name || deskName(i);
        if (usedNames.has(label.toLowerCase())) label = `${label} ${i + 1}`.slice(0, 60);
        usedNames.add(label.toLowerCase());
        entities.push({ id, kind: 'station', label, transform: ORIGIN, station: stationForAgent(label, d.agent, profile) });
    });
    const deskEntities = entities as StationEntity[];
    const byAgent = new Map<DeskAgent, string[]>();
    for (const d of deskEntities) { const a = agentOf(d.station); byAgent.set(a, [...(byAgent.get(a) ?? []), d.label ?? d.station.name]); }
    for (const [agent, names] of byAgent) notes.push(`${names.length} ${AGENT_LABEL[agent]} desk${names.length === 1 ? '' : 's'}: ${names.join(', ')}`);
    if (profile) notes.push(`Hermes profile: ${profile}`);
    const stationNamed = (purpose?: string): StationEntity | undefined => purpose ? deskEntities.find(d => (d.label ?? d.station.name).toLowerCase() === purpose.toLowerCase()) : undefined;

    // ----- monitor walls -----
    const monitorMentions = findMentions(text, /\b(?:monitor walls?|screen walls?|walls? of (?:monitors|screens)|monitor banks?|video walls?)\b/);
    let monitors = 0;
    for (const m of monitorMentions) {
        const count = m.count ?? (m.plural ? 2 : 1);
        for (let i = 0; i < count; i++) {
            const id = nextId(taken, 'monitor-wall'); taken.add(id);
            const linked = stationNamed(m.purpose);
            const label = m.purpose ? `${cleanLabel(m.purpose)} wall` : m.adjectives.includes('shared') ? 'Shared monitor wall' : 'Monitor wall';
            const wall: WorldEntity = { id, kind: 'monitor-wall', label: label.slice(0, 60), transform: ORIGIN, width: 3.2, height: 1.8, elevation: 0.9 };
            if (linked) wall.link = linked.id;
            entities.push(wall); monitors++;
            notes.push(linked ? `Monitor wall linked to ${linked.label}` : `${label}${m.adjectives.includes('shared') ? ' (its own view)' : ''}`);
        }
    }

    // ----- web walls -----
    const webMentions = findMentions(text, /\b(?:web walls?|browser walls?|web screens?|browser screens?|web pages? wall)\b/);
    const url = /https?:\/\/[^\s,;)<>"']+/.exec(clean)?.[0];
    const home = url ? safeHomeUrl(url) : undefined;
    let webs = 0;
    for (const m of webMentions) {
        const count = m.count ?? (m.plural ? 2 : 1);
        for (let i = 0; i < count; i++) {
            const id = nextId(taken, 'web'); taken.add(id);
            const label = m.purpose ? `${cleanLabel(m.purpose)} wall` : 'Web wall';
            const wall: WorldEntity = { id, kind: 'web-wall', label: label.slice(0, 60), transform: ORIGIN, width: 3.9, height: 2.44, elevation: 0.68 };
            if (home && webs === 0) wall.home = home;
            entities.push(wall); webs++;
            notes.push(`${label}${home && webs === 1 ? ` · opens ${new URL(home).host} when you choose` : ''}`);
        }
    }
    if (url && !webs) {
        const id = nextId(taken, 'web'); taken.add(id);
        entities.push({ id, kind: 'web-wall', label: 'Web wall', transform: ORIGIN, width: 3.9, height: 2.44, elevation: 0.68, ...(home ? { home } : {}) });
        notes.push(`Web wall for ${home ? new URL(home).host : 'your link'}`);
    }

    // ----- mirrors and code review -----
    for (const m of findMentions(text, /\bmirrors?\b/)) {
        const target = stationNamed(m.purpose) ?? deskEntities[0];
        const count = m.count ?? 1;
        for (let i = 0; i < count && target; i++) {
            const id = nextId(taken, 'mirror'); taken.add(id);
            entities.push({ id, kind: 'mirror', label: `Mirror · ${target.label ?? target.station.name}`.slice(0, 60), link: target.id, transform: ORIGIN });
            notes.push(`Mirror of ${target.label}`);
        }
    }
    if (!/\bno (code )?review\b/.test(text)) {
        const id = nextId(taken, 'code'); taken.add(id);
        entities.push({ id, kind: 'review-screen', label: 'Code review', transform: ORIGIN });
    }

    // ----- decor -----
    const decorKinds: DecorKind[] = [];
    for (const [re, kind] of DECOR_WORDS) {
        const g = new RegExp(re.source, 'g');
        let m: RegExpExecArray | null;
        while ((m = g.exec(text))) {
            const q = quantityBefore(text, m.index);
            const count = clamp(q.count ?? (/s\b/.test(m[0]) && !/glass|less/.test(m[0]) ? 2 : 1), 1, 6);
            for (let i = 0; i < count; i++) decorKinds.push(kind);
        }
    }
    if (!decorKinds.length) decorKinds.push(...(theme === 'jungle' ? ['plant', 'plant'] as DecorKind[] : ['window'] as DecorKind[]));
    for (const kind of decorKinds) {
        if (entities.length >= WORLD_MAX_ENTITIES) { warnings.push('Some decor was left out: a world holds at most 64 things.'); break; }
        const id = nextId(taken, kind); taken.add(id);
        entities.push({ id, kind: 'decor', decor: kind, label: capitalize(kind), transform: ORIGIN });
    }
    if (decorKinds.length) notes.push(`Decor: ${summarizeKinds(decorKinds)}`);
    if (entities.length > WORLD_MAX_ENTITIES) { warnings.push('The plan was trimmed to 64 things.'); entities.length = WORLD_MAX_ENTITIES; }

    notes.push(`Theme: ${theme === 'jungle' ? 'Prehistoric jungle' : 'Space station'}${options.theme ? ' (your choice)' : detected ? '' : ' (default)'}`);
    if (monitors + webs === 0) notes.push('No walls asked for. Add a web or monitor wall in the next step.');

    const base = emptyWorld(name, theme);
    const built = applyWorldOps(base, entities.map(entity => ({ op: 'add', entity }) as WorldOp));
    if (!built.ok) {
        warnings.push(`The plan could not be built (${built.error}). The classic room is shown instead.`);
        return { world: worldFromRoomV1({ theme, projectName: name }), notes, warnings, detectedTheme: detected };
    }
    const arranged = applyOnboardingEdit(built.world, []);
    const world = arranged.ok ? arranged.world : built.world;
    return { world: { ...world, plan: clean.slice(0, 4000), revision: 0 }, notes, warnings, detectedTheme: detected };
}

function summarizeKinds(kinds: string[]): string {
    const counts = new Map<string, number>();
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [...counts].map(([k, c]) => c > 1 ? `${c} ${k === 'bookshelf' ? 'bookshelves' : `${k}s`}` : k).join(', ');
}

export interface WorldCounts { desks: number; monitorWalls: number; webWalls: number; mirrors: number; reviews: number; decor: number }
export function countWorld(world: WorldSpec): WorldCounts {
    const c: WorldCounts = { desks: 0, monitorWalls: 0, webWalls: 0, mirrors: 0, reviews: 0, decor: 0 };
    for (const e of world.entities) {
        if (e.kind === 'station') c.desks++; else if (e.kind === 'monitor-wall') c.monitorWalls++; else if (e.kind === 'web-wall') c.webWalls++;
        else if (e.kind === 'mirror') c.mirrors++; else if (e.kind === 'review-screen') c.reviews++; else c.decor++;
    }
    return c;
}
export function describeWorld(world: WorldSpec): string {
    const c = countWorld(world);
    const part = (n: number, one: string, many = `${one}s`): string | undefined => n ? `${n} ${n === 1 ? one : many}` : undefined;
    return [part(c.desks, 'desk'), part(c.monitorWalls, 'monitor wall'), part(c.webWalls, 'web wall'), part(c.mirrors, 'mirror'), part(c.reviews, 'review screen'), part(c.decor, 'decor piece')]
        .filter(Boolean).join(' · ');
}

/**
 * The v1 room the current renderer can draw for this world (theme, layout, kit). Until the render lane's
 * `setWorld` lands, the 3D preview and the saved v1 room use this; the full WorldSpec is saved beside it.
 */
export function v1RoomFor(world: WorldSpec): { theme: RoomTheme; layout: RoomLayoutId; kit: RoomKitId } {
    const c = countWorld(world);
    return { theme: world.shell.theme, layout: world.shell.width > 12 ? 'wide' : 'classic', kit: c.webWalls >= 2 ? 'web-gallery' : c.webWalls === 1 ? 'hermes-desk' : 'terminal-nook' };
}
