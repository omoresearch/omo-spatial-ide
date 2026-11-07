/**
 * w2:admin — deterministic, rule-based world planner. No model, no I/O, no randomness except
 * the proposal id (injectable). It reads plain requests like
 *   "add a third desk for Codex and a big monitor wall linked to it"
 *   "add 2 shell desks named Ops", "add a web wall showing github.com", "add some plants"
 *   "move desk two left 2 m", "rename desk one to Build", "lock desk two"
 *   "arrange the desks in a U-shape", "remove the mirror", "link the mirror to the codex desk"
 * and returns WorldOps. Every op is checked against the world with applyWorldOps as it is
 * planned (so later parts of the request can refer to earlier ones: "linked to it"), and the
 * whole list is checked again at the end. Nothing is applied: the caller wraps the ops in a
 * WorldProposal that the user must Apply.
 */
import {
    applyWorldOps, defaultStation, stations, validateWorld,
    WORLD_ID_RE, WORLD_MAX_ENTITIES, WORLD_MAX_STATIONS
} from './world-model';
import type {
    DecorKind, EntityKind, StationConfig, StationEntity, TabKind, Transform, WorldEntity, WorldOp, WorldProposal, WorldSpec
} from './world-model';

export interface RulePlanResult {
    ops: WorldOp[];
    steps: string[];
    notes: string[];
    summary: string;
    explanation: string;
    proposal: WorldProposal | null;
}

export interface RulePlanOptions {
    /** Proposal id factory (tests pass a fixed one). */
    makeId?: () => string;
    source?: WorldProposal['source'];
}

export const ADMIN_EXAMPLES: readonly string[] = [
    'add a third desk for Codex and a big monitor wall linked to it',
    'add 2 shell desks named Ops',
    'add a web wall showing https://example.com',
    'add a plant and a lamp',
    'move desk two left 2 m',
    'rename desk one to Build',
    'lock desk two',
    'arrange the desks in a U-shape',
    'remove the mirror'
];

// ---------------------------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
    a: 1, an: 1, one: 1, another: 1, single: 1, two: 2, pair: 2, couple: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, some: 2, few: 3, several: 3
};
const ORDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
const ORDINAL_ADJ = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

const DECOR_WORDS: Array<[DecorKind, RegExp]> = [
    ['plant', /\b(plants?|ferns?|trees?)\b/],
    ['lamp', /\b(lamps?|lights?)\b/],
    ['crystal', /\b(crystals?|gems?)\b/],
    ['sofa', /\b(sofas?|couch(?:es)?)\b/],
    ['bookshelf', /\b(bookshel(?:f|ves)|bookcases?|shel(?:f|ves))\b/],
    ['whiteboard', /\b(whiteboards?|white boards?)\b/],
    ['rug', /\b(rugs?|carpets?)\b/],
    ['window', /\b(windows?)\b/]
];
const KIND_WORDS: Array<[EntityKind, RegExp]> = [
    ['monitor-wall', /\b(monitor ?walls?|walls? of (?:monitors|screens)|screens? ?walls?|video ?walls?|monitor arrays?|(?:big |large |huge )?monitors)\b/],
    ['web-wall', /\b(web ?walls?|browser ?walls?|web ?screens?|browser screens?|websites?|web pages?)\b/],
    ['mirror', /\b(mirrors?)\b/],
    ['review-screen', /\b(code ?review(?: screens?)?|review ?screens?|diff screens?)\b/],
    ['station', /\b(desks?|stations?|workstations?|terminals?|workspaces?)\b/]
];
const KIND_NAME: Record<EntityKind, string> = {
    station: 'desk', 'monitor-wall': 'monitor wall', 'web-wall': 'web wall', mirror: 'mirror', 'review-screen': 'code review screen', decor: 'decor'
};
const AGENT_WORDS: Array<[TabKind, RegExp]> = [
    ['codex', /\bcodex\b/], ['claude', /\bclaude(?: code)?\b/], ['hermes', /\bhermes\b/], ['shell', /\b(shell|bash|terminal only|plain terminal)\b/]
];
const TAB_TITLE: Record<TabKind, string> = { codex: 'Codex', claude: 'Claude', hermes: 'Hermes', shell: 'Shell', dsh: 'DeepSeek Harness' };

const PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const round = (n: number): number => Math.round(n * 100) / 100;
const titleCase = (s: string): string => s.replace(/\b\w/g, c => c.toUpperCase());

function slug(text: string): string {
    const s = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    return s && /^[a-z0-9]/.test(s) ? s : 'item';
}

function cleanName(raw: string): string {
    // eslint-disable-next-line no-control-regex
    return raw.replace(/[\u0000-\u001f]/g, ' ').replace(/^["'`\s]+|["'`\s.,!?]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function entityName(e: WorldEntity | undefined): string {
    if (!e) return 'it';
    if (e.label) return e.label;
    if (e.kind === 'station') return e.station.name;
    if (e.kind === 'decor') return e.decor;
    return KIND_NAME[e.kind] + ' ' + e.id;
}

// ---------------------------------------------------------------------------------------------
// Op description (also used for Hermes-planned ops)
// ---------------------------------------------------------------------------------------------

/** One readable line per op. `world` is the world BEFORE this op (names are looked up there). */
export function describeOp(world: WorldSpec, op: WorldOp): string {
    const find = (id: string): WorldEntity | undefined => world.entities.find(e => e.id === id);
    const name = (id: string): string => { const e = find(id); return e ? `“${entityName(e)}”` : `“${id}”`; };
    const at = (t: Transform): string => `at x ${round(t.x)} m, z ${round(t.z)} m${Math.abs(t.rotation) > 0.01 ? `, turned ${Math.round(t.rotation * 180 / Math.PI)}°` : ''}`;
    switch (op.op) {
        case 'add': {
            const e = op.entity;
            const label = `“${entityName(e)}”`;
            switch (e.kind) {
                case 'station': return `Add desk ${label} (${e.station.tabs.map(t => t.name).join(' + ')}${e.station.profile ? `, profile ${e.station.profile}` : ''}${e.station.locked ? ', locked' : ''}) ${at(e.transform)}`;
                case 'monitor-wall': return `Add monitor wall ${label} ${round(e.width)} × ${round(e.height)} m${e.link ? `, linked to ${name(e.link)}` : ''} ${at(e.transform)}`;
                case 'web-wall': return `Add web wall ${label} ${round(e.width)} × ${round(e.height)} m${e.home ? `, home ${e.home}` : ''} ${at(e.transform)}`;
                case 'mirror': return `Add mirror ${label} of ${name(e.link)} ${at(e.transform)}`;
                case 'review-screen': return `Add code review screen ${label} ${at(e.transform)}`;
                case 'decor': return `Add ${e.decor}${e.scale && e.scale !== 1 ? ` (size ×${round(e.scale)})` : ''} ${at(e.transform)}`;
            }
            return 'Add something';
        }
        case 'remove': {
            const e = find(op.id);
            const mirrors = world.entities.filter(x => x.kind === 'mirror' && x.link === op.id);
            return `Remove ${name(op.id)}${mirrors.length ? ` (its mirror ${mirrors.map(m => `“${entityName(m)}”`).join(', ')} goes too)` : ''}${e?.kind === 'station' ? '' : ''}`;
        }
        case 'move': {
            const e = find(op.id);
            if (e && Math.abs(e.transform.x - op.transform.x) < 0.005 && Math.abs(e.transform.z - op.transform.z) < 0.005) return `Turn ${name(op.id)} to face ${Math.round(op.transform.rotation * 180 / Math.PI)}°`;
            return `Move ${name(op.id)} ${at(op.transform)}`;
        }
        case 'update-station': {
            const parts: string[] = [];
            if (op.station.locked === true) parts.push('lock it');
            if (op.station.locked === false) parts.push('unlock it');
            if (op.station.name !== undefined) parts.push(`set its name to “${op.station.name}”`);
            if (op.station.kind !== undefined) parts.push(`make it a ${op.station.kind} desk`);
            if (op.station.profile !== undefined) parts.push(`use profile ${op.station.profile}`);
            if (op.station.tabs !== undefined) parts.push(`set its starting tabs to ${op.station.tabs.map(t => t.name).join(' + ')}`);
            return `Desk ${name(op.id)}: ${parts.join(', ') || 'no change'}`;
        }
        case 'resize': return `Resize ${name(op.id)} to ${round(op.width)} × ${round(op.height)} m${op.elevation !== undefined ? `, ${round(op.elevation)} m off the floor` : ''}`;
        case 'link': return op.to ? `Link ${name(op.id)} to ${name(op.to)}` : `Unlink ${name(op.id)}`;
        case 'rename': return `Rename ${name(op.id)} to “${op.label}”`;
        case 'shell': {
            const parts: string[] = [];
            if (op.shell.theme) parts.push(`theme ${op.shell.theme === 'jungle' ? 'Prehistoric jungle' : 'Space station'}`);
            if (op.shell.width !== undefined || op.shell.depth !== undefined) parts.push(`size ${round(op.shell.width ?? world.shell.width)} × ${round(op.shell.depth ?? world.shell.depth)} m`);
            return `Room: ${parts.join(', ') || 'no change'}`;
        }
        case 'name': return `Rename the world to “${op.name}”`;
    }
    return 'Unknown change';
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

interface Rect { x: number; z: number; hx: number; hz: number }

function halfSize(e: WorldEntity): [number, number] {
    switch (e.kind) {
        case 'station': return [1.8, 1.05];
        case 'monitor-wall': return [e.width / 2, 0.25];
        case 'web-wall': return [e.width / 2, 0.2];
        case 'mirror': return [0.7, 0.2];
        case 'review-screen': return [0.9, 0.3];
        case 'decor': {
            const s = e.scale ?? 1;
            const base: Record<DecorKind, [number, number]> = {
                plant: [0.45, 0.45], lamp: [0.35, 0.35], crystal: [0.4, 0.4], sofa: [1.1, 0.5], bookshelf: [0.9, 0.25],
                whiteboard: [1.0, 0.15], rug: [1.2, 0.9], window: [0.9, 0.1]
            };
            const [hx, hz] = base[e.decor];
            return [hx * s, hz * s];
        }
    }
    return [0.5, 0.5];
}

function rectOf(e: WorldEntity, t: Transform = e.transform): Rect {
    const [hx, hz] = halfSize(e);
    const sideways = Math.abs(Math.sin(t.rotation)) > 0.7;
    return { x: t.x, z: t.z, hx: sideways ? hz : hx, hz: sideways ? hx : hz };
}

const overlaps = (a: Rect, b: Rect, gap: number): boolean => Math.abs(a.x - b.x) < a.hx + b.hx + gap && Math.abs(a.z - b.z) < a.hz + b.hz + gap;
const isRug = (e: WorldEntity): boolean => e.kind === 'decor' && e.decor === 'rug';
/** Wall-mounted things hang above the floor: they only clash with other wall things and tall furniture. */
const isWallThing = (e: WorldEntity): boolean => e.kind === 'web-wall' || e.kind === 'monitor-wall' || e.kind === 'mirror' || (e.kind === 'decor' && (e.decor === 'window' || e.decor === 'whiteboard'));

type Placement = 'floor' | 'wall' | 'near';

function fits(world: WorldSpec, cand: WorldEntity, t: Transform, ignore: ReadonlySet<string>): boolean {
    const r = rectOf(cand, t);
    const W = world.shell.width / 2, D = world.shell.depth / 2;
    if (Math.abs(r.x) + r.hx > W - 0.1 || Math.abs(r.z) + r.hz > D - 0.1) return false;
    // Keep the spawn walkway (front centre) free of floor furniture.
    if (!isWallThing(cand) && !isRug(cand) && overlaps(r, { x: 0, z: D - 0.9, hx: 0.7, hz: 0.7 }, 0)) return false;
    for (const other of world.entities) {
        if (other.id === cand.id || ignore.has(other.id)) continue;
        if (isRug(cand) || isRug(other)) continue;
        if (isWallThing(cand) && !isWallThing(other) && other.kind !== 'decor' && other.kind !== 'review-screen') {
            // A wall item may hang behind a desk only if it does not cut through the desk itself.
            if (overlaps(r, rectOf(other), 0)) return false;
            continue;
        }
        if (overlaps(r, rectOf(other), cand.kind === 'station' || other.kind === 'station' ? 0.45 : 0.25)) return false;
    }
    return true;
}

function candidates(world: WorldSpec, cand: WorldEntity, mode: Placement, near?: { x: number; z: number }): Transform[] {
    const W = world.shell.width / 2, D = world.shell.depth / 2;
    const out: Array<Transform & { score: number }> = [];
    const [hx, hz] = halfSize(cand);
    const prefer = near ?? (mode === 'wall' ? { x: 0, z: -D } : { x: 0, z: -D / 3 });
    const add = (x: number, z: number, rotation: number): void => {
        out.push({ x: round(x), z: round(z), rotation, score: Math.hypot(x - prefer.x, z - prefer.z) });
    };
    if (mode === 'wall') {
        const inset = hz + 0.15;
        for (let x = -W + hx + 0.3; x <= W - hx - 0.3 + 1e-9; x += 0.25) add(x, -D + inset, 0);
        for (let z = -D + hx + 0.3; z <= D - hx - 1.2 + 1e-9; z += 0.25) { add(-W + inset, z, Math.PI / 2); add(W - inset, z, -Math.PI / 2); }
    } else {
        for (let x = -W + 0.5; x <= W - 0.5 + 1e-9; x += 0.25) for (let z = -D + 0.5; z <= D - 0.5 + 1e-9; z += 0.25) add(x, z, 0);
    }
    out.sort((a, b) => a.score - b.score || a.x - b.x || a.z - b.z);
    return out.map(({ x, z, rotation }) => ({ x, z, rotation }));
}

// ---------------------------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------------------------

type Intent = 'add' | 'remove' | 'move' | 'rename' | 'name' | 'lock' | 'unlock' | 'arrange' | 'link' | 'unlink' | 'resize' | 'rotate' | 'theme' | 'room-size';

class Planner {
    readonly ops: WorldOp[] = [];
    readonly steps: string[] = [];
    readonly notes: string[] = [];
    draft: WorldSpec;
    lastRefs: string[] = [];
    lastScore = 0;
    private quotes: string[] = [];

    constructor(readonly world: WorldSpec) { this.draft = world; }

    /** Plan one op against the draft; on failure record a readable note. */
    push(op: WorldOp, extra = ''): boolean {
        const res = applyWorldOps(this.draft, [op]);
        if (!res.ok) { this.notes.push(`Skipped: ${describeOp(this.draft, op)} — ${res.error}`); return false; }
        this.steps.push(describeOp(this.draft, op) + extra);
        this.ops.push(op);
        this.draft = res.world;
        return true;
    }

    // ----- text --------------------------------------------------------------------------
    protect(text: string): string {
        return text.replace(/[“”]/g, '"').replace(/[‘’]/g, '\'').replace(/"([^"]{1,80})"|'([^']{1,80})'(?=\s|$|[,.;!?])/g, (_m, a, b) => {
            this.quotes.push(String(a ?? b)); return `\u0001${this.quotes.length - 1}\u0001`;
        });
    }
    restore(text: string): string { return text.replace(/\u0001(\d+)\u0001/g, (_m, i) => this.quotes[Number(i)] ?? ''); }

    clauses(prompt: string): string[] {
        const text = this.protect(prompt.trim());
        const sentences = text.split(/[\n;]+|\.(?=\s|$)|\bthen\b|\bafter that\b/i).map(s => s.trim()).filter(Boolean);
        const out: string[] = [];
        for (const sentence of sentences) {
            const parts = sentence.split(/(,\s*(?:and\s+|then\s+)?|\s+and\s+|\s+plus\s+|\s+as well as\s+|\s+also\s+)/i);
            let current = parts[0];
            for (let i = 1; i < parts.length; i += 2) {
                const next = parts[i + 1] ?? '';
                if (startsClause(next)) { out.push(current); current = next; } else current += parts[i] + next;
            }
            out.push(current);
        }
        return out.map(s => s.trim()).filter(Boolean);
    }

    // ----- entity lookup ------------------------------------------------------------------
    aliases(e: WorldEntity): Array<[string, number]> {
        const out: Array<[string, number]> = [[e.id, 3], [e.id.replace(/-/g, ' '), 3]];
        if (e.label) out.push([e.label.toLowerCase(), 4]);
        if (e.kind === 'station') {
            out.push([e.station.name.toLowerCase(), 4]);
            const index = stations(this.draft).findIndex(s => s.id === e.id);
            if (index >= 0 && index < ORDINALS.length) {
                for (const noun of ['desk', 'station', 'workstation', 'terminal']) {
                    out.push([`${noun} ${ORDINALS[index]}`, 3], [`${noun} ${index + 1}`, 3]);
                    if (index < ORDINAL_ADJ.length) out.push([`${ORDINAL_ADJ[index]} ${noun}`, 3]);
                }
            }
            for (const t of e.station.tabs) if (t.kind !== 'shell') for (const noun of ['desk', 'station']) out.push([`${t.kind} ${noun}`, 2], [`${noun} for ${t.kind}`, 2]);
            if (e.station.kind === 'shell') out.push(['shell desk', 2]);
            out.push(['desk', 1], ['station', 1], ['workstation', 1]);
        } else if (e.kind === 'decor') {
            out.push([e.decor, 1]);
        } else {
            out.push([KIND_NAME[e.kind], 1]);
            if (e.kind === 'monitor-wall') out.push(['monitors', 1], ['screen wall', 1]);
            if (e.kind === 'web-wall') out.push(['browser', 1], ['web screen', 1]);
            if (e.kind === 'review-screen') out.push(['code review', 1], ['review screen', 1], ['code screen', 1]);
        }
        return out;
    }

    /** Best matches for a reference text. Returns [] if nothing matches; several when ambiguous. */
    lookup(refText: string, filter?: (e: WorldEntity) => boolean): WorldEntity[] {
        const text = ` ${this.restore(refText).toLowerCase().replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ')} `;
        if (/\b(it|that|this one|them|those|these|that one)\b/.test(text) && this.lastRefs.length) {
            const refs = this.lastRefs.map(id => this.draft.entities.find(e => e.id === id)).filter((e): e is WorldEntity => !!e && (!filter || filter(e)));
            if (refs.length) return refs;
        }
        let best = 0; let found: WorldEntity[] = []; this.lastScore = 0;
        for (const e of this.draft.entities) {
            if (filter && !filter(e)) continue;
            let score = 0;
            for (const [alias, weight] of this.aliases(e)) {
                if (!alias) continue;
                if (text.includes(` ${alias} `) || text.includes(` ${alias}s `)) score = Math.max(score, weight * 100 + alias.length);
            }
            if (score > best) { best = score; found = [e]; } else if (score === best && score > 0) found.push(e);
        }
        this.lastScore = best;
        return found;
    }

    one(refText: string, what: string, filter?: (e: WorldEntity) => boolean): WorldEntity | undefined {
        const found = this.lookup(refText, filter);
        const shown = this.restore(refText).trim();
        if (/^(?:it|that|this one|that one|them)\b/.test(shown) && !this.lastRefs.length) {
            this.notes.push(`Which ${what === 'thing' ? 'one' : what} do you mean? Say it by name (for example “desk two”).`);
            return undefined;
        }
        // Only the generic noun matched ("desk five" when there is no desk five): do not guess.
        const generic = this.lastScore > 0 && this.lastScore < 200 && /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+|first|second|third|fourth|fifth)\b|\S+\s+\S+/.test(shown.replace(/^(?:the|my|our)\s+/, ''));
        if (found.length === 1 && !generic) return found[0];
        if (found.length > 1 && generic || found.length === 1 && generic) {
            this.notes.push(`I could not find “${shown}”. Here: ${found.slice(0, 8).map(e => `“${entityName(e)}”`).join(', ')}.`);
            return undefined;
        }
        if (found.length > 1) {
            this.notes.push(`“${this.restore(refText).trim()}” could mean ${found.slice(0, 5).map(e => `“${entityName(e)}”`).join(', ')}. Say which ${what} by name.`);
            return undefined;
        }
        this.notes.push(`I could not find ${what === 'thing' ? 'anything' : `a ${what}`} called “${this.restore(refText).trim() || '…'}” in this world.`);
        return undefined;
    }

    locked(e: WorldEntity): boolean {
        if (e.kind === 'station' && e.station.locked) { this.notes.push(`“${entityName(e)}” is locked, so it was not changed. Say “unlock ${entityName(e).toLowerCase()}” first.`); return true; }
        return false;
    }

    uniqueId(base: string): string {
        let id = slug(base);
        if (!WORLD_ID_RE.test(id)) id = 'item';
        const taken = new Set(this.draft.entities.map(e => e.id));
        if (!taken.has(id)) return id;
        for (let i = 2; i < 999; i++) { const c = `${id.slice(0, 44)}-${i}`; if (!taken.has(c)) return c; }
        return `${id.slice(0, 30)}-${Date.now().toString(36)}`;
    }

    /** Find a free spot, growing the room once by 4 m (width) if nothing fits. */
    place(e: WorldEntity, mode: Placement, near?: { x: number; z: number }): Transform | undefined {
        for (let attempt = 0; attempt < 3; attempt++) {
            for (const t of candidates(this.draft, e, mode, near)) if (fits(this.draft, e, t, new Set())) return t;
            if (this.draft.shell.width + 4 > 40) break;
            const width = this.draft.shell.width + 4;
            if (!this.push({ op: 'shell', shell: { width } }, ` — so the new ${KIND_NAME[e.kind]} fits`)) break;
        }
        this.notes.push(`There is no free spot for the ${KIND_NAME[e.kind]}. Make the room bigger or remove something first.`);
        return undefined;
    }

    // ----- intents ------------------------------------------------------------------------
    run(prompt: string): void {
        let inherited: Intent | undefined;
        for (const raw of this.clauses(prompt)) {
            const clause = raw.replace(/^(?:please|pls|can you|could you|would you|will you|let'?s|ok(?:ay)?|now|and|also|then|hermes,?|admin,?)\s+/i, '').replace(/^(?:please)\s+/i, '');
            const lower = ` ${clause.toLowerCase()} `;
            const intent = detectIntent(lower) ?? inherited ?? (hasAddable(lower) ? 'add' : undefined);
            if (!intent) { this.notes.push(`I did not understand “${this.restore(clause)}”.`); continue; }
            inherited = intent === 'arrange' || intent === 'theme' || intent === 'name' || intent === 'room-size' ? undefined : intent;
            try { this.handle(intent, clause, lower); }
            catch (error) { this.notes.push(`Could not plan “${this.restore(clause)}”: ${error instanceof Error ? error.message : String(error)}`); }
        }
    }

    handle(intent: Intent, clause: string, lower: string): void {
        switch (intent) {
            case 'add': return this.add(clause, lower);
            case 'remove': return this.remove(lower);
            case 'move': return this.move(lower);
            case 'rotate': return this.rotate(lower);
            case 'rename': return this.rename(clause, lower);
            case 'name': return this.nameWorld(clause, lower);
            case 'lock': case 'unlock': return this.lock(lower, intent === 'lock');
            case 'arrange': return this.arrange(lower);
            case 'link': case 'unlink': return this.link(lower, intent === 'link');
            case 'resize': return this.resize(lower);
            case 'theme': return this.theme(lower);
            case 'room-size': return this.roomSize(lower);
        }
    }

    add(clause: string, lower: string): void {
        const kind = addKind(lower);
        if (!kind) { this.notes.push(`I could not tell what to add in “${this.restore(clause)}”.`); return; }
        const kindIndex = kindPosition(lower, kind);
        const count = Math.max(1, Math.min(8, countBefore(lower, kindIndex)));
        const name = extractName(lower, clause, this);
        const size = sizeWord(lower);
        const added: string[] = [];
        for (let i = 0; i < count; i++) {
            if (this.draft.entities.length >= WORLD_MAX_ENTITIES) { this.notes.push(`A world holds at most ${WORLD_MAX_ENTITIES} things, so ${count - i} were not added.`); break; }
            const label = name ? (count > 1 ? `${name} ${i + 1}` : name) : undefined;
            const id = this.addOne(kind, lower, label, size);
            if (!id) break;
            added.push(id);
        }
        if (added.length) this.lastRefs = added;
    }

    addOne(kind: EntityKind | DecorKind, lower: string, given: string | undefined, size: number): string | undefined {
        if (kind === 'station') {
            if (stations(this.draft).length >= WORLD_MAX_STATIONS) { this.notes.push(`A world holds at most ${WORLD_MAX_STATIONS} desks.`); return undefined; }
            const agents = AGENT_WORDS.filter(([, re]) => re.test(lower)).map(([k]) => k);
            const primary = agents.find(a => a !== 'shell');
            const index = stations(this.draft).length;
            const defaultName = primary && primary !== 'hermes' ? `${TAB_TITLE[primary]} desk` : `Desk ${ORDINALS[index] ?? index + 1}`;
            const name = given ?? defaultName;
            const station: StationConfig = primary === 'hermes' || (!primary && !agents.includes('shell'))
                ? defaultStation(name, 'hermes')
                : primary
                    ? { name, kind: 'shell', tabs: [{ name: TAB_TITLE[primary], kind: primary }, { name: 'Shell', kind: 'shell' }], locked: false }
                    : defaultStation(name, 'shell');
            for (const extra of agents) if (extra !== primary && extra !== 'shell' && !station.tabs.some(t => t.kind === extra) && station.tabs.length < 8) station.tabs.splice(station.tabs.length - 1, 0, { name: TAB_TITLE[extra], kind: extra });
            const profile = extractProfile(lower, this);
            if (profile) station.profile = profile;
            if (/\blocked\b/.test(lower)) station.locked = true;
            const entity: StationEntity = { id: this.uniqueId(name), kind: 'station', label: name, transform: { x: 0, z: 0, rotation: 0 }, station };
            const near = this.nearRef(lower);
            const t = this.place(entity, near ? 'near' : 'floor', near); if (!t) return undefined;
            entity.transform = t;
            return this.push({ op: 'add', entity }) ? entity.id : undefined;
        }
        if (kind === 'monitor-wall') {
            const target = this.linkTarget(lower);
            const dims = dimensions(lower);
            const [width, height] = dims ?? (size > 1.6 ? [6, 3] : size > 1.1 ? [4, 2.25] : size < 0.9 ? [1.6, 0.9] : [2.4, 1.35]);
            const label = this.labelOr(label0(given, target ? `Monitor wall · ${entityName(target)}` : 'Monitor wall'));
            const entity: WorldEntity = { id: this.uniqueId(label), kind: 'monitor-wall', label, width: clamp(width, 0.6, 8), height: clamp(height, 0.4, 4), elevation: round(clamp(3 - clamp(height, 0.4, 4) - 0.15, 0.3, 1.0)), transform: { x: 0, z: 0, rotation: 0 } };
            if (target) entity.link = target.id;
            const near = target ? { x: target.transform.x, z: target.transform.z - 1.5 } : this.nearRef(lower);
            const t = (target && this.behind(entity, target)) || this.place(entity, 'wall', near); if (!t) return undefined;
            entity.transform = t;
            return this.push({ op: 'add', entity }) ? entity.id : undefined;
        }
        if (kind === 'web-wall') {
            const home = extractUrl(this.restore(lower), this);
            const dims = dimensions(lower);
            const [width, height] = dims ?? (size > 1.1 ? [4.8, 2.7] : size < 0.9 ? [1.6, 0.9] : [3.2, 1.8]);
            const label = this.labelOr(label0(given, home ? `Web · ${new URL(home).hostname}` : 'Web wall'));
            const entity: WorldEntity = { id: this.uniqueId(label), kind: 'web-wall', label, width: clamp(width, 0.8, 8), height: clamp(height, 0.6, 4), elevation: round(clamp(3 - clamp(height, 0.6, 4) - 0.15, 0.3, 1.0)), transform: { x: 0, z: 0, rotation: 0 } };
            if (home) entity.home = home;
            const t = this.place(entity, 'wall', this.nearRef(lower)); if (!t) return undefined;
            entity.transform = t;
            return this.push({ op: 'add', entity }) ? entity.id : undefined;
        }
        if (kind === 'mirror') {
            const target = this.linkTarget(lower) ?? (stations(this.draft).length === 1 ? stations(this.draft)[0] : undefined);
            if (!target) { this.notes.push('A mirror shows a desk. Say which desk, for example “add a mirror of desk two”.'); return undefined; }
            const label = this.labelOr(label0(given, `Mirror · ${entityName(target)}`));
            const entity: WorldEntity = { id: this.uniqueId(label), kind: 'mirror', label, link: target.id, transform: { x: 0, z: 0, rotation: 0 } };
            const t = this.place(entity, 'wall', { x: target.transform.x, z: target.transform.z }); if (!t) return undefined;
            entity.transform = t;
            return this.push({ op: 'add', entity }) ? entity.id : undefined;
        }
        if (kind === 'review-screen') {
            const label = this.labelOr(label0(given, 'Code review'));
            const entity: WorldEntity = { id: this.uniqueId(label), kind: 'review-screen', label, transform: { x: 0, z: 0, rotation: 0 } };
            const t = this.place(entity, 'wall', this.nearRef(lower)); if (!t) return undefined;
            entity.transform = t;
            return this.push({ op: 'add', entity }) ? entity.id : undefined;
        }
        // decor
        const decor = kind as DecorKind;
        const entity: WorldEntity = { id: this.uniqueId(given ?? decor), kind: 'decor', decor, transform: { x: 0, z: 0, rotation: 0 } };
        if (given) entity.label = given;
        if (size !== 1) entity.scale = clamp(size, 0.25, 4);
        const wall = decor === 'window' || decor === 'whiteboard' || decor === 'bookshelf';
        const corner = /\bcorners?\b/.test(lower);
        const W = this.draft.shell.width / 2, D = this.draft.shell.depth / 2;
        const near = this.nearRef(lower) ?? (corner || decor === 'plant' || decor === 'lamp' || decor === 'crystal'
            ? CORNERS(W, D)[this.draft.entities.filter(e => e.kind === 'decor').length % 4]
            : decor === 'rug' ? { x: 0, z: 0.5 } : decor === 'sofa' ? { x: 0, z: D - 2.2 } : undefined);
        const t = this.place(entity, wall ? 'wall' : 'floor', near); if (!t) return undefined;
        entity.transform = t;
        return this.push({ op: 'add', entity }) ? entity.id : undefined;
    }

    /** A spot just behind a desk, facing the same way (the desk's own big screen). */
    behind(e: WorldEntity, desk: WorldEntity): Transform | undefined {
        const r = desk.transform.rotation;
        for (const d of [1.4, 1.7, 2.1]) {
            const t: Transform = { x: round(desk.transform.x - Math.sin(r) * d), z: round(desk.transform.z - Math.cos(r) * d), rotation: r };
            if (fits(this.draft, e, t, new Set())) return t;
        }
        return undefined;
    }

    labelOr(label: string): string { return cleanName(label) || 'Item'; }

    /** "linked to it / for desk two / of the codex desk / mirroring desk one" → a station. */
    linkTarget(lower: string): StationEntity | undefined {
        const m = /\b(?:linked|connected|attached|hooked up|wired|tied|mirroring|showing|following|that shows|which shows|for|of|to)\s+(?:to\s+)?(.+)$/.exec(lower);
        if (!m) return undefined;
        const ref = m[1].replace(/\b(?:with|using|named|called)\b.*$/, '');
        if (/\b(it|that|this one|that one|them)\b/.test(ref)) {
            const station = this.lastRefs.map(id => this.draft.entities.find(e => e.id === id)).find((e): e is StationEntity => e?.kind === 'station');
            if (station) return station;
        }
        const found = this.lookup(ref, e => e.kind === 'station');
        if (found.length === 1) return found[0] as StationEntity;
        if (found.length > 1 && /\b(desk|station|workstation|terminal|it)\b/.test(ref)) this.notes.push(`Which desk should it link to? ${found.map(e => `“${entityName(e)}”`).join(', ')}.`);
        return undefined;
    }

    nearRef(lower: string): { x: number; z: number } | undefined {
        const m = /\b(?:next to|beside|near|by|close to|behind|in front of|opposite)\s+(.+)$/.exec(lower);
        if (!m) return undefined;
        const found = this.lookup(m[1]);
        return found.length === 1 ? { x: found[0].transform.x, z: found[0].transform.z } : undefined;
    }

    remove(lower: string): void {
        const all = /\b(all|every|each)\b/.test(lower);
        const decor = DECOR_WORDS.find(([, re]) => re.test(lower));
        let targets: WorldEntity[];
        if (all && decor) targets = this.draft.entities.filter(e => e.kind === 'decor' && e.decor === decor[0]);
        else if (all && /\b(decor|decorations?|furniture)\b/.test(lower)) targets = this.draft.entities.filter(e => e.kind === 'decor');
        else if (all) targets = this.lookup(lower);
        else { const one = this.one(stripVerb(lower), 'thing'); targets = one ? [one] : []; }
        if (!targets.length) { if (all) this.notes.push('Nothing matched to remove.'); return; }
        for (const e of targets) {
            if (!this.draft.entities.some(x => x.id === e.id) || this.locked(e)) continue;
            this.push({ op: 'remove', id: e.id });
        }
        this.lastRefs = [];
    }

    move(lower: string): void {
        // Split target from destination at the first destination keyword.
        const m = /^(.*?)\s(to|towards|toward|into|in|next to|beside|near|closer to|by|left|right|forward|forwards|back|backwards|backward|up|down|\d+(?:\.\d+)?\s*(?:m|metres?|meters?))\b(.*)$/.exec(stripVerb(lower).trim() + ' ');
        const refText = m ? m[1] : stripVerb(lower);
        const dest = m ? `${m[2]}${m[3]}` : '';
        const targets = /\b(them|those|these|all desks|the desks)\b/.test(refText) ? this.lookup(refText) : [this.one(refText, 'thing')].filter((e): e is WorldEntity => !!e);
        for (const e of targets) {
            if (this.locked(e)) continue;
            const t = this.destination(e, ` ${dest} `);
            if (!t) { this.notes.push(`Where should “${entityName(e)}” go? Try “left 2 m”, “to the back wall”, “to the back left corner” or “next to desk one”.`); continue; }
            this.push({ op: 'move', id: e.id, transform: t });
        }
        this.lastRefs = targets.map(e => e.id);
    }

    destination(e: WorldEntity, dest: string): Transform | undefined {
        const W = this.draft.shell.width / 2, D = this.draft.shell.depth / 2;
        const r = rectOf(e);
        const t: Transform = { ...e.transform };
        const dist = /(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\b/.exec(dest);
        const d = dist ? Number(dist[1]) : 1;
        const near = /\b(?:next to|beside|near|closer to|by)\s+(.+)$/.exec(dest);
        if (near) {
            const found = this.lookup(near[1], x => x.id !== e.id);
            if (found.length !== 1) return undefined;
            for (const c of candidates(this.draft, e, isWallThing(e) ? 'wall' : 'floor', { x: found[0].transform.x, z: found[0].transform.z })) {
                if (fits(this.draft, e, { ...c, rotation: isWallThing(e) ? c.rotation : e.transform.rotation }, new Set([e.id]))) return { ...c, rotation: isWallThing(e) ? c.rotation : e.transform.rotation };
            }
            return undefined;
        }
        let changed = false;
        const corner = /\bcorner\b/.test(dest);
        if (/\b(cent(?:er|re)|middle)\b/.test(dest)) { t.x = 0; t.z = 0; changed = true; }
        if (/\b(back|far|rear)\b/.test(dest) && (/\bwall\b/.test(dest) || corner)) { t.z = -D + r.hz + 0.2; changed = true; }
        else if (/\bfront\b/.test(dest) && (/\bwall\b/.test(dest) || corner || /\bto the front\b/.test(dest))) { t.z = D - r.hz - 1.6; changed = true; }
        if (/\bleft\b/.test(dest) && (/\b(wall|side|corner)\b/.test(dest) || /\bto the left\b/.test(dest) && !dist)) { t.x = -W + r.hx + 0.2; changed = true; }
        else if (/\bright\b/.test(dest) && (/\b(wall|side|corner)\b/.test(dest) || /\bto the right\b/.test(dest) && !dist)) { t.x = W - r.hx - 0.2; changed = true; }
        if (!changed) {
            if (/\bleft\b/.test(dest)) { t.x -= d; changed = true; }
            if (/\bright\b/.test(dest)) { t.x += d; changed = true; }
            if (/\b(forwards?|closer|towards? the (?:front|door)|down)\b/.test(dest)) { t.z += d; changed = true; }
            if (/\b(back|backwards?|away|towards? the back|up)\b/.test(dest)) { t.z -= d; changed = true; }
        }
        if (!changed) return undefined;
        t.x = round(clamp(t.x, -W + r.hx + 0.1, W - r.hx - 0.1));
        t.z = round(clamp(t.z, -D + r.hz + 0.1, D - r.hz - 0.1));
        return t;
    }

    rotate(lower: string): void {
        const target = this.one(stripVerb(lower).replace(/\b(around|round|by|\d+\s*(?:degrees?|°)|left|right|clockwise|counter-?clockwise|anti-?clockwise|to face.*)\b/g, ' '), 'thing');
        if (!target || this.locked(target)) return;
        const deg = /(\d+)\s*(?:degrees?|°)/.exec(lower);
        let delta = /\b(around|round)\b/.test(lower) ? Math.PI : (deg ? Number(deg[1]) : 90) * Math.PI / 180;
        if (/\b(right|clockwise)\b/.test(lower) && !/\b(counter-?clockwise|anti-?clockwise)\b/.test(lower)) delta = -delta;
        let rotation = target.transform.rotation + delta;
        while (rotation > Math.PI) rotation -= 2 * Math.PI;
        while (rotation < -Math.PI) rotation += 2 * Math.PI;
        this.push({ op: 'move', id: target.id, transform: { ...target.transform, rotation: round(rotation * 1000) / 1000 } });
        this.lastRefs = [target.id];
    }

    rename(clause: string, lower: string): void {
        const body = stripVerb(lower);
        const m = /^(.*?)\s+(?:to|as|into)\s+(.+)$/.exec(body) ?? /^(.*?)\s+(\u0001\d+\u0001)\s*$/.exec(body);
        if (!m) { this.notes.push('Say “rename <thing> to <new name>”.'); return; }
        if (/^\s*(?:the |this )?(room|world|space)\s*$/.test(m[1])) { this.nameFrom(this.restoreCase(clause, m[2])); return; }
        const target = this.one(m[1], 'thing'); if (!target || this.locked(target)) return;
        const label = cleanName(this.restoreCase(clause, m[2]));
        if (!label) { this.notes.push('The new name is empty.'); return; }
        this.push({ op: 'rename', id: target.id, label });
        if (target.kind === 'station') this.push({ op: 'update-station', id: target.id, station: { name: label } });
        this.lastRefs = [target.id];
    }

    nameWorld(clause: string, lower: string): void {
        const m = /\b(?:to|as)\s+(.+)$/.exec(lower) ?? /\b(?:room|world|space)\s+(.+)$/.exec(lower);
        if (!m) { this.notes.push('Say “rename the world to <name>”.'); return; }
        this.nameFrom(this.restoreCase(clause, m[1]));
    }

    nameFrom(raw: string): void {
        const name = cleanName(raw).slice(0, 120);
        if (!name) { this.notes.push('The new world name is empty.'); return; }
        this.push({ op: 'name', name });
    }

    /** Return the original-case text for a lower-cased tail of the clause (names keep their case). */
    restoreCase(clause: string, lowerTail: string): string {
        const original = clause.trim();
        const idx = original.toLowerCase().lastIndexOf(lowerTail.trim());
        return this.restore(idx >= 0 ? original.slice(idx, idx + lowerTail.trim().length) : lowerTail);
    }

    lock(lower: string, lock: boolean): void {
        const body = stripVerb(lower);
        const targets = /\b(all|every|the desks|all desks|everything)\b/.test(body) ? stations(this.draft) : [this.one(body, 'desk', e => e.kind === 'station')].filter((e): e is StationEntity => !!e);
        for (const e of targets) {
            if (e.kind !== 'station') { this.notes.push('Only desks can be locked.'); continue; }
            if (e.station.locked === lock) { this.notes.push(`“${entityName(e)}” is already ${lock ? 'locked' : 'unlocked'}.`); continue; }
            this.push({ op: 'update-station', id: e.id, station: { locked: lock } });
        }
        this.lastRefs = targets.map(e => e.id);
    }

    link(lower: string, link: boolean): void {
        const body = stripVerb(lower);
        if (!link) {
            const target = this.one(body, 'monitor wall', e => e.kind === 'monitor-wall');
            if (target && !this.locked(target)) this.push({ op: 'link', id: target.id });
            return;
        }
        const m = /^(.*?)\s+(?:to|with)\s+(.+)$/.exec(body);
        if (!m) { this.notes.push('Say “link <monitor wall or mirror> to <desk>”.'); return; }
        const source = this.one(m[1], 'monitor wall or mirror', e => e.kind === 'monitor-wall' || e.kind === 'mirror');
        const target = this.one(m[2], 'desk', e => e.kind === 'station');
        if (source && target) this.push({ op: 'link', id: source.id, to: target.id });
    }

    resize(lower: string): void {
        if (/\b(room|world|space|floor)\b/.test(lower) && !/\b(wall|monitor|web)\b/.test(lower)) return this.roomSize(lower);
        const target = this.one(stripVerb(lower).replace(/\b(bigger|larger|smaller|wider|taller|huge|giant|tiny|\d+(?:\.\d+)?\s*(?:x|×|by)\s*\d+(?:\.\d+)?\s*(?:m|metres?|meters?)?)\b.*$/, ''), 'monitor wall or web wall', e => e.kind === 'monitor-wall' || e.kind === 'web-wall');
        if (!target || (target.kind !== 'monitor-wall' && target.kind !== 'web-wall')) return;
        const dims = dimensions(lower);
        const factor = /\b(smaller|tiny|shrink)\b/.test(lower) ? 0.7 : /\b(huge|giant|massive)\b/.test(lower) ? 1.8 : 1.4;
        const [w, h] = dims ?? [target.width * factor, target.height * factor];
        const minW = target.kind === 'monitor-wall' ? 0.6 : 0.8, minH = target.kind === 'monitor-wall' ? 0.4 : 0.6;
        const width = round(clamp(w, minW, 8)), height = round(clamp(h, minH, 4));
        this.push({ op: 'resize', id: target.id, width, height, elevation: round(clamp(Math.min(target.elevation, 3 - height - 0.1), 0, 3)) });
        this.lastRefs = [target.id];
    }

    theme(lower: string): void {
        const theme = /\bjungle\b/.test(lower) ? 'jungle' : /\b(space|station|orbital)\b/.test(lower) ? 'station' : undefined;
        if (!theme) { this.notes.push('The themes are “space station” and “jungle”.'); return; }
        if (this.draft.shell.theme === theme) { this.notes.push(`The world already uses the ${theme === 'jungle' ? 'jungle' : 'space station'} theme.`); return; }
        this.push({ op: 'shell', shell: { theme } });
    }

    roomSize(lower: string): void {
        const dims = dimensions(lower);
        let width = this.draft.shell.width, depth = this.draft.shell.depth;
        if (dims) { [width, depth] = dims; }
        else {
            const step = (/(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\b/.exec(lower)?.[1]) ? Number(/(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\b/.exec(lower)![1]) : 4;
            const sign = /\b(smaller|narrower|shorter|shrink)\b/.test(lower) ? -1 : 1;
            if (/\b(wider|narrower)\b/.test(lower)) width += sign * step;
            else if (/\b(deeper|longer|shorter)\b/.test(lower)) depth += sign * step;
            else { width += sign * step; depth += sign * step; }
        }
        width = round(clamp(width, 8, 40)); depth = round(clamp(depth, 8, 40));
        if (width === this.draft.shell.width && depth === this.draft.shell.depth) { this.notes.push('The room is already that size (rooms are 8–40 m each way).'); return; }
        this.push({ op: 'shell', shell: { width, depth } });
    }

    arrange(lower: string): void {
        const shape: 'row' | 'grid' | 'u' | undefined = /\bu[- ]?shape(?:d)?\b|\bhorseshoe\b|\bu\b/.test(lower) ? 'u' : /\bgrid\b/.test(lower) ? 'grid' : /\b(row|line)\b/.test(lower) ? 'row' : undefined;
        if (!shape) { this.notes.push('I can arrange desks in a row, a grid or a U-shape.'); return; }
        const named = this.lookup(lower.replace(/\b(arrange|rearrange|line up|lay out|layout|organi[sz]e|put|place|move|in|into|as|a|the|row|line|grid|u-shape|u shape|ushape|horseshoe)\b/g, ' '), e => e.kind === 'station');
        const all = stations(this.draft);
        const pick = /\b(all|desks|stations|everything|workstations)\b/.test(lower) || named.length < 2 ? all : named;
        const free = pick.filter(e => !this.locked(e));
        if (free.length < 1) return;
        const n = free.length, SX = 4.2, SZ = 2.9;
        const D = this.draft.shell.depth / 2;
        const slots: Transform[] = [];
        let needWidth = 0, needDepth = 0;
        if (shape === 'row') {
            needWidth = n * SX + 1;
            for (let i = 0; i < n; i++) slots.push({ x: (i - (n - 1) / 2) * SX, z: -D / 3, rotation: 0 });
        } else if (shape === 'grid') {
            const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
            needWidth = cols * SX + 1; needDepth = rows * SZ + 3;
            for (let i = 0; i < n; i++) { const c = i % cols, r = Math.floor(i / cols); slots.push({ x: (c - (cols - 1) / 2) * SX, z: (r - (rows - 1) / 2) * SZ - 0.6, rotation: 0 }); }
        } else {
            const arm = Math.floor(n / 3), back = n - 2 * arm;
            needWidth = Math.max(back * SX + 1, back > 0 && arm > 0 ? back * SX + 4.6 : 0, arm > 0 ? 10 : 0);
            needDepth = 2.4 + arm * SX + 2.4;
            const width = Math.max(this.draft.shell.width, Math.min(40, needWidth));
            const depth = Math.max(this.draft.shell.depth, Math.min(40, needDepth));
            const bz = -depth / 2 + 1.5;
            for (let i = 0; i < back; i++) slots.push({ x: (i - (back - 1) / 2) * SX, z: bz, rotation: 0 });
            for (let i = 0; i < arm; i++) {
                const z = bz + 2.8 + i * SX;
                // Same convention as the v1 mirror (left wall, +π/2) and code screen (right wall, −π/2).
                slots.push({ x: -width / 2 + 1.35, z, rotation: Math.PI / 2 });
                slots.push({ x: width / 2 - 1.35, z, rotation: -Math.PI / 2 });
            }
        }
        const width = Math.min(40, Math.max(this.draft.shell.width, Math.ceil(needWidth)));
        const depth = Math.min(40, Math.max(this.draft.shell.depth, Math.ceil(needDepth)));
        if (width !== this.draft.shell.width || depth !== this.draft.shell.depth) this.push({ op: 'shell', shell: { width, depth } }, ' — so the desks fit');
        const W = this.draft.shell.width / 2, DD = this.draft.shell.depth / 2;
        free.forEach((e, i) => {
            const s = slots[i];
            this.push({ op: 'move', id: e.id, transform: { x: round(clamp(s.x, -W + 0.5, W - 0.5)), z: round(clamp(s.z, -DD + 0.5, DD - 0.5)), rotation: round(s.rotation * 1000) / 1000 } });
        });
        this.lastRefs = free.map(e => e.id);
    }
}

const CORNERS = (W: number, D: number): Array<{ x: number; z: number }> => [
    { x: -W + 0.6, z: -D + 0.6 }, { x: W - 0.6, z: -D + 0.6 }, { x: -W + 0.6, z: D - 1.6 }, { x: W - 0.6, z: D - 1.6 }
];

function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }
function label0(label: string | undefined, fallback: string): string { return label ?? fallback; }

const VERB_START = /^\s*(?:please\s+|can you\s+|could you\s+|also\s+|then\s+)?(add|create|build|make|put|place|give|install|set up|setup|spawn|i want|i need|we need|i'd like|id like|remove|delete|drop|get rid of|destroy|take away|take out|move|shift|slide|push|bring|rename|call|name|lock|unlock|arrange|rearrange|line up|organi[sz]e|lay out|layout|link|connect|attach|hook up|unlink|disconnect|detach|resize|turn|rotate|spin|switch|change|use|enlarge|shrink|grow)\b/i;
const NOUN_START = /^\s*(?:a|an|another|one more|some|a few|a couple of|several|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
function startsClause(text: string): boolean { return VERB_START.test(text) || NOUN_START.test(text); }

function detectIntent(lower: string): Intent | undefined {
    const s = lower.trim();
    if (/^unlock\b/.test(s)) return 'unlock';
    if (/^lock\b/.test(s)) return 'lock';
    if (/^(re-?name)\b/.test(s)) return /^re-?name\s+(?:the |this )?(room|world|space)\b/.test(s) ? 'name' : 'rename';
    if (/^(name|call)\s+(?:the |this |my )?(room|world|space)\b/.test(s)) return 'name';
    if (/^(arrange|rearrange|re-arrange|line up|lay out|layout|organi[sz]e|reorgani[sz]e)\b/.test(s)) return 'arrange';
    if (/^(move|put|place|set)\b.*\b(in|into|as)\s+(?:a\s+)?(row|line|grid|u[- ]?shape|horseshoe)\b/.test(s)) return 'arrange';
    if (/^(unlink|disconnect|detach)\b/.test(s)) return 'unlink';
    if (/^(link|connect|attach|hook up|point)\b/.test(s)) return 'link';
    if (/^(remove|delete|drop|get rid of|destroy|take away|take out|clear)\b/.test(s)) return 'remove';
    if (/^(switch|change|use|make|set|turn)\b.*\b(jungle|space station|space theme|station theme|orbital)\b/.test(s)) return 'theme';
    if (/^(make|resize|enlarge|shrink|grow|set)\b.*\b(room|world|floor)\b.*\b(bigger|larger|smaller|wider|narrower|deeper|longer|shorter|\d+(?:\.\d+)?\s*(?:x|×|by)\s*\d+)/.test(s) || /^(enlarge|grow|shrink|expand)\s+(?:the |this )?(room|world)\b/.test(s)) return 'room-size';
    if (/^(resize|enlarge|shrink)\b/.test(s)) return 'resize';
    if (/^(make|set)\s+(?:the|my|that|this|it|its|both)\b/.test(s) && /\b(bigger|larger|smaller|wider|taller|huge|giant|tiny|\d+(?:\.\d+)?\s*(?:x|×|by)\s*\d+)/.test(s)) return 'resize';
    if (/^(turn|rotate|spin)\b/.test(s)) return 'rotate';
    if (/^(put|place|set)\s+(?:a|an|another|one more|some|a few|\d+|two|three|four|five)\b/.test(s)) return 'add';
    if (/^(move|shift|slide|push|bring|put|place)\b/.test(s)) return 'move';
    if (/^(add|create|build|make|give(?: me| us)?|install|set ?up|spawn|i want|i need|we need|i'?d like|id like|insert|include)\b/.test(s)) return 'add';
    return undefined;
}

function hasAddable(lower: string): boolean { return !!addKind(lower) && NOUN_START.test(lower); }

function addKind(lower: string): EntityKind | DecorKind | undefined {
    let best: { kind: EntityKind | DecorKind; index: number } | undefined;
    const consider = (kind: EntityKind | DecorKind, re: RegExp): void => {
        const m = re.exec(lower.replace(/\u0001\d+\u0001/g, ' '));
        if (m && (!best || m.index < best.index)) best = { kind, index: m.index };
    };
    for (const [kind, re] of KIND_WORDS) consider(kind, re);
    for (const [kind, re] of DECOR_WORDS) consider(kind, re);
    // "a desk with a lamp" adds a desk; "a lamp next to desk two" adds a lamp: the earliest noun wins,
    // except that "next to / near / linked to <desk>" never names the thing being added.
    if (best && best.kind === 'station') {
        const tail = lower.slice(0, best.index);
        if (/\b(next to|beside|near|by|linked to|for|of|close to)\s+(?:the\s+)?$/.test(tail)) {
            const others = [...KIND_WORDS, ...DECOR_WORDS].filter(([k]) => k !== 'station').map(([k, re]) => ({ k, m: re.exec(lower) })).filter(x => x.m);
            if (others.length) return others.sort((a, b) => a.m!.index - b.m!.index)[0].k;
        }
    }
    return best?.kind;
}

function kindPosition(lower: string, kind: EntityKind | DecorKind): number {
    const re = [...KIND_WORDS, ...DECOR_WORDS].find(([k]) => k === kind)?.[1];
    return re ? (re.exec(lower)?.index ?? lower.length) : lower.length;
}

function countBefore(lower: string, index: number): number {
    const head = lower.slice(0, index).trim().split(/\s+/).slice(-4);
    for (let i = head.length - 1; i >= 0; i--) {
        const w = head[i].replace(/[^a-z0-9]/g, '');
        if (/^\d+$/.test(w)) return Number(w);
        if (w in NUMBER_WORDS) return NUMBER_WORDS[w];
    }
    return 1;
}

function sizeWord(lower: string): number {
    if (/\b(huge|giant|massive|enormous|gigantic)\b/.test(lower)) return 1.8;
    if (/\b(big|large|tall|wide)\b/.test(lower)) return 1.4;
    if (/\b(small|little|tiny|mini)\b/.test(lower)) return 0.7;
    return 1;
}

/** "3x2", "3 by 2", "4.5 x 2 m". Plain whole numbers ≤ 6 without a unit are screens of 1.2 × 0.7 m. */
function dimensions(lower: string): [number, number] | undefined {
    const m = /(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(m\b|metres?|meters?)?/.exec(lower);
    if (!m) return undefined;
    const a = Number(m[1]), b = Number(m[2]);
    if (!m[3] && Number.isInteger(a) && Number.isInteger(b) && a <= 6 && b <= 6 && !/\b(room|world|floor)\b/.test(lower)) return [round(a * 1.2), round(b * 0.7)];
    return [a, b];
}

function stripVerb(lower: string): string {
    return lower.trim().replace(/^(?:re-?name|rename|remove|delete|drop|get rid of|destroy|take away|take out|clear|move|shift|slide|push|bring|put|place|lock|unlock|link|connect|attach|hook up|point|unlink|disconnect|detach|resize|enlarge|shrink|make|turn|rotate|spin)\s+/, '').replace(/^(?:the|my|our|that|this)\s+/, '');
}

function extractName(lower: string, clause: string, p: Planner): string | undefined {
    const m = /\b(?:named|called|labell?ed|name it|call it|titled)\s+(\u0001\d+\u0001|[a-z0-9][a-z0-9 ._-]{0,58}?)(?=\s+(?:with|using|on|at|in|near|next|beside|linked|connected|for|that|which|showing|and|to)\b|\s*$|[,.!?])/.exec(lower);
    if (!m) return undefined;
    const name = cleanName(p.restoreCase(clause, m[1]));
    return name ? (m[1].startsWith('\u0001') ? name : titleCase(name)) : undefined;
}

function extractProfile(lower: string, p: Planner): string | undefined {
    const m = /\bprofile\s+(\u0001\d+\u0001|[a-z0-9][a-z0-9._-]*)/.exec(lower) ?? /\b(?:using|with|on|use)\s+(?:the\s+)?(\u0001\d+\u0001|[a-z0-9][a-z0-9._-]*)\s+profile\b/.exec(lower);
    if (!m) return undefined;
    const value = p.restore(m[1]).trim().toLowerCase();
    if (!PROFILE_RE.test(value)) { p.notes.push(`“${value}” is not a valid Hermes profile name.`); return undefined; }
    return value === 'default' ? undefined : value;
}

const SECRET_QUERY = /(token|key|secret|password|passwd|auth|sig|signature|session|code|credential)/i;
function extractUrl(text: string, p: Planner): string | undefined {
    const m = /\b(https?:\/\/[^\s"'<>]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>]*)?)/i.exec(text.replace(/\u0001\d+\u0001/g, ' '));
    if (!m) return undefined;
    let raw = m[1].replace(/[),.;!?]+$/, '');
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
        if (url.username || url.password) { p.notes.push('The web address had a user name or password in it, so it was left out.'); return undefined; }
        let dropped = false;
        for (const key of [...url.searchParams.keys()]) if (SECRET_QUERY.test(key)) { url.searchParams.delete(key); dropped = true; }
        if (dropped) p.notes.push('Parts of the web address that looked like keys or tokens were removed.');
        url.hash = /token|key|secret/i.test(url.hash) ? '' : url.hash;
        const out = url.toString();
        return out.length <= 2048 ? out : undefined;
    } catch { return undefined; }
}

let proposalSeq = 0;
export function newProposalId(prefix = 'admin'): string {
    proposalSeq = (proposalSeq + 1) % 1e6;
    return `${prefix}-${Date.now().toString(36)}-${proposalSeq.toString(36)}`;
}

/** Plan a request against a world. Never throws; never applies anything. */
export function planWithRules(world: WorldSpec, prompt: string, options: RulePlanOptions = {}): RulePlanResult {
    const valid = validateWorld(world);
    if (!valid.ok) return { ops: [], steps: [], notes: [valid.error], summary: '', explanation: `This world could not be read: ${valid.error}`, proposal: null };
    const p = new Planner(world);
    p.run(String(prompt ?? '').slice(0, 2000));
    const final = p.ops.length ? applyWorldOps(world, p.ops) : undefined;
    if (final && !final.ok) {
        return { ops: [], steps: [], notes: [...p.notes, final.error], summary: '', explanation: `That plan does not fit this world: ${final.error} Nothing was changed.`, proposal: null };
    }
    if (!p.ops.length) {
        const explanation = p.notes.length
            ? `I could not plan a change. ${p.notes.join(' ')}`
            : `I did not understand that. Try, for example: ${ADMIN_EXAMPLES.slice(0, 5).map(e => `“${e}”`).join(', ')}.`;
        return { ops: [], steps: [], notes: p.notes, summary: '', explanation, proposal: null };
    }
    const summary = summarize(p.steps);
    const proposal: WorldProposal = { id: (options.makeId ?? (() => newProposalId()))(), source: options.source ?? 'admin', summary, ops: p.ops, baseRevision: world.revision };
    const explanation = `Here is my plan: ${p.ops.length} change${p.ops.length === 1 ? '' : 's'}. Nothing changes until you press Apply.${p.notes.length ? ` Note: ${p.notes.join(' ')}` : ''}`;
    return { ops: p.ops, steps: p.steps, notes: p.notes, summary, explanation, proposal };
}

export function summarize(steps: string[]): string {
    const short = steps.map(s => s.replace(/\s+at x [-\d.]+ m, z [-\d.]+ m(?:, turned -?\d+°)?/, '').replace(/\s+\(.*?\)/, ''));
    const text = short.slice(0, 4).join('; ') + (short.length > 4 ? `; and ${short.length - 4} more` : '');
    return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}
