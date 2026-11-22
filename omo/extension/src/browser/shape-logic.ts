/**
 * shape — pure helpers of Shape mode (no DOM, no THREE), so they are unit-tested on their own.
 *   - expandIdea: a few room ideas the rules planner does not know as words ("a reading nook") become
 *     the plain things it does know ("an armchair, a lamp and a bookshelf").
 *   - composePrompt: the typed text plus the pointed pills ("move [Sofa] closer") as one planner prompt.
 *   - refinePrompt: a follow-up turn ("bigger", "move it left") on top of the pending prompt.
 *   - captionFor: one plain sentence for the caption card, from the proposal summary.
 *   - suggestionsFor: three quiet chips that fit the room.
 * Nothing here plans or changes the world: the existing planner service does that.
 */
import type { WorldSpec, WorldEntity } from '../common/world-model';

export interface ShapePill { id: string; name: string }

interface Idea { re: RegExp; words: string; caption: string; /** the first thing: the rest goes next to it */ near?: string }
const IDEAS: Idea[] = [
    { re: /\b(?:a |an |the )?(?:cosy |cozy |little |small )?reading (?:nook|corner)\b/i, words: 'an armchair, a lamp and a bookshelf', caption: 'A reading nook', near: 'armchair' },
    { re: /\b(?:a |an |the )?(?:cosy |cozy )?(?:lounge|chill|relax(?:ing)?) (?:corner|nook|area|spot)\b/i, words: 'a sofa, a rug and a lamp', caption: 'A lounge corner' },
    { re: /\b(?:a |an |the )?(?:bit of |some )?greenery\b/i, words: '2 plants', caption: 'Some greenery' },
    { re: /\b(?:a |an |the )?(?:planning|ideas?) (?:corner|wall|spot)\b/i, words: 'a whiteboard and a lamp', caption: 'A planning corner' }
];

/** "add a reading nook by the window" -> "add an armchair, a lamp and a bookshelf by the window" (+ the idea's name). */
export function expandIdea(text: string): { prompt: string; idea?: string } {
    for (const idea of IDEAS) if (idea.re.test(text)) {
        // "add a reading nook by the window" -> "add an armchair by the window, then add a lamp next to the armchair, …" (one cluster).
        const m = idea.near ? /^(add|put|place|make|build|create|give me)\s+(.*)$/i.exec(text.trim()) : null;
        if (m && idea.near) {
            const where = text.trim().slice(m[1].length).replace(idea.re, '').trim();
            const [first, ...rest] = idea.words.replace(/ and /, ', ').split(/,\s*/);
            return { prompt: [`${m[1]} ${first}${where ? ` ${where}` : ''}`, ...rest.map(r => `add ${r} next to the ${idea.near}`)].join(', then '), idea: idea.caption };
        }
        return { prompt: text.replace(idea.re, idea.words), idea: idea.caption };
    }
    // "make it warmer at night" has no rule: warm light is lamps.
    if (/\b(warmer|cosier|cozier|softer light|warm light)\b/i.test(text) && !/\b(add|place|put)\b/i.test(text)) return { prompt: 'add 2 lamps', idea: 'Warmer light' };
    return { prompt: text };
}

const PRONOUN = /\b(this one|that one|this|that|it|them|these|those)\b/i;

/** The prompt text plus the pills: a pronoun takes the pills' names; otherwise the names follow the first word. */
export function composePrompt(text: string, pills: readonly ShapePill[]): string {
    const t = text.trim().replace(/\s+/g, ' ');
    if (!pills.length) return t;
    const names = joinNames(pills.map(p => p.name));
    if (!t) return names;
    if (PRONOUN.test(t)) return t.replace(PRONOUN, names);
    const [verb, ...rest] = t.split(' ');
    return [verb, names, ...rest].join(' ');
}

/** "the screen" / "the tv" mean the nearest screen thing in this world (the rules planner needs its name). */
export function resolveScreens(text: string, world: WorldSpec | undefined, near?: { x: number; z: number }): string {
    if (!world || !/\bthe (screen|tv|monitor|display)\b/i.test(text)) return text;
    const screens = world.entities.filter(e => e.kind === 'web-wall' || e.kind === 'monitor-wall' || e.kind === 'review-screen');
    if (!screens.length) return text;
    const d = (e: WorldEntity): number => near ? Math.hypot(e.transform.x - near.x, e.transform.z - near.z) : 0;
    const best = [...screens].sort((a, b) => d(a) - d(b))[0];
    return text.replace(/\bthe (screen|tv|monitor|display)\b/i, nameOf(best));
}

/**
 * A follow-up turn while a proposal is pending. "bigger" makes every added thing big; anything else is
 * appended as the planner's own next sentence ("… then move it left").
 */
export function refinePrompt(previous: string, next: string): string {
    const n = next.trim().replace(/[.!]+$/, '');
    if (!previous.trim()) return n;
    if (/^(?:(?:make|have) (?:it|them|that|those) )?(?:a (?:bit|little) )?(?:bigger|larger|big|huge)(?: please)?$/i.test(n)) {
        // "add an armchair, a lamp …" -> "add a big armchair, a big lamp …"
        const grown = previous.replace(/\b(a|an|one)\s+(?!big\b)([a-z])/gi, (_m, _a: string, c: string) => `a big ${c}`);
        if (grown !== previous) return grown;
    }
    return `${previous.trim()} then ${n}`;
}

const ARTICLE = (noun: string): string => /^(\d|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(noun) ? noun : /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
function joinNames(names: string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
function nameOf(e: WorldEntity): string {
    if (e.label) return e.label;
    if (e.kind === 'station') return e.station.name;
    if (e.kind === 'decor') return e.decor;
    return e.kind.replace('-', ' ');
}

/**
 * One plain sentence from a proposal summary ("Add armchair (size ×1.4); Add lamp; Add bookshelf").
 * The summary's first sentence only; verbs are grouped: "Adds a big armchair, a lamp and a bookshelf."
 */
export function captionFor(summary: string, idea?: string, where?: string): string {
    const first = summary.split(/(?<=[.!?])\s+/)[0].replace(/[.]+$/, '');
    const parts = first.split(/\s*;\s*/).map(s => s.trim()).filter(Boolean);
    const groups = new Map<string, string[]>(); let more = 0;
    for (const raw of parts) {
        const extra = /^and (\d+) more$/i.exec(raw); if (extra) { more += Number(extra[1]); continue; }
        const m = /^(Add|Place|Remove|Move|Rename|Turn|Link|Resize|Name|Lock|Unlock|Build|Arrange|Reshape)\s+(.*)$/i.exec(raw);
        const verb = m ? m[1].toLowerCase() : 'change';
        let thing = (m ? m[2] : raw).replace(/[“”"]/g, '').replace(/\s+at\s+\(?-?\d.*$/i, '').trim();
        const big = /\(size ×\s*1\.[3-9]\d*\)|\(size ×\s*[2-9]/.test(thing); thing = thing.replace(/\s*\(size ×[^)]*\)/, '');
        if (verb === 'add' || verb === 'place' || verb === 'build') thing = ARTICLE(`${big ? 'big ' : ''}${thing.replace(/^(desk|room)\s+(.+)$/i, '$2')}`.toLowerCase().replace(/\b(claude|codex|hermes)\b/g, w => w[0].toUpperCase() + w.slice(1)));
        const key = verb === 'place' || verb === 'build' ? 'add' : verb;
        groups.set(key, [...(groups.get(key) ?? []), thing]);
    }
    const VERB: Record<string, string> = { add: 'adds', remove: 'removes', move: 'moves', rename: 'renames', turn: 'turns', link: 'links', resize: 'resizes', name: 'names', lock: 'locks', unlock: 'unlocks', arrange: 'arranges', reshape: 'reshapes', change: 'changes' };
    const clauses = [...groups].map(([verb, things]) => `${VERB[verb] ?? verb} ${joinNames(more && verb === 'add' ? [...things, `${more} more`] : things)}`);
    if (!clauses.length) return idea ? `${idea}.` : 'A change to the room.';
    let sentence = joinNames(clauses);
    if (idea) {
        const things = groups.get('add');
        sentence = things && groups.size === 1 ? `${idea}: ${joinNames(things.map(t => t.replace(/^(a|an) /, '')))}` : `${idea}: ${sentence}`;
    } else sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    if (where) sentence += ` ${where}`;
    return `${sentence}.`;
}

/** "… by the window" -> "by the window": where the change goes, for the caption. */
export function whereOf(text: string): string | undefined {
    const m = /\b((?:by|near|next to|beside|in front of|against|under|behind|in the|on the) (?:the |a |my )?[a-z][a-z ]{1,30})$/i.exec(text.trim().replace(/[.!?]+$/, ''));
    return m ? m[1].toLowerCase() : undefined;
}

/** Three short chips that fit the room. */
export function suggestionsFor(world: WorldSpec | undefined): string[] {
    const ents = world?.entities ?? [];
    const has = (re: RegExp): boolean => ents.some(e => re.test(`${e.label ?? ''} ${e.kind === 'decor' ? e.decor : ''} ${e.kind === 'decor' ? e.prop ?? '' : ''}`));
    const out: string[] = [];
    out.push(has(/armchair|bookshelf/i) ? 'Add a lounge corner with a rug' : 'Add a reading nook by the window');
    out.push(ents.filter(e => e.kind === 'decor' && e.decor === 'lamp').length >= 2 ? 'Add some greenery' : 'Make it warmer at night');
    out.push(ents.some(e => e.kind === 'station' && /claude/i.test(`${e.label ?? ''} ${e.station.name}`)) ? 'Add a web wall' : 'Add a desk for Claude');
    return out;
}
