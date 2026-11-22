/**
 * promise:onboarding — the first minute's world, planned on this device (no model call):
 *
 *   1. "If your mind had a home, what would it look like?" -> mindStyle(sentence) reads style words
 *      (library, garden, observatory, studio, cabin, sea, penthouse) and homeWorld() builds the world through the
 *      onboarding planner path: an existing template (the skyline penthouse kit by default) + the style's decor set,
 *      arranged by applyOnboardingEdit (so the penthouse kit keeps its exact baked floor).
 *   2. "Bring your mind with you" -> mindWorld(home, rooms) turns the importer's topics into small rooms on open
 *      ground beside a Home room: each topic room has a sign and up to 4 note boards (whiteboards whose label is
 *      the note title; the 3D scene paints it on the board). Laid out by the planner's zoned arrangement.
 */
import type { DecorKind, WorldEntity, WorldOp, WorldSpec } from '../common/world-model';
import { applyWorldOps, WORLD_MAX_ENTITIES } from '../common/world-model';
import type { RoomTheme } from '../common/room-state';
import { instantiateTemplate } from '../common/world-templates';
import type { WorldTemplateId } from '../common/world-templates';
import type { MindRoom } from '../common/mind-import-protocol';
import { MIND_MAX_ROOMS, MIND_MAX_SCREENS } from '../common/mind-import-protocol';
import { applyOnboardingEdit, arrangeOps, nextId, sanitizePlanText } from './onboarding-planner';
import type { PlanResult } from './onboarding-planner';

export type MindStyleId = 'library' | 'garden' | 'observatory' | 'studio' | 'cabin' | 'sea' | 'penthouse';

interface StyleDef { id: MindStyleId; label: string; words: RegExp; template: WorldTemplateId; decor: DecorKind[] }

/** Table order breaks ties. Only existing templates, themes and decor kinds are used. */
export const MIND_STYLES: readonly StyleDef[] = [
    { id: 'library', label: 'Library', template: 'nyc-skyscraper', decor: ['bookshelf', 'bookshelf'],
        words: /\b(librar(?:y|ies)|books?|bookshel(?:f|ves)|study|studies|reading|reader|archives?|scholars?|manuscripts?|scrolls?|poetry|novels?)\b/g },
    { id: 'garden', label: 'Garden', template: 'jungle-expedition', decor: ['plant', 'rug'],
        words: /\b(gardens?|greenhouses?|forests?|jungles?|botanic\w*|meadows?|orchards?|trees?|woods?|woodland|leafy|ferns?|moss|flowers?|nature)\b/g },
    { id: 'observatory', label: 'Observatory', template: 'space-station', decor: ['crystal', 'window'],
        words: /\b(observator(?:y|ies)|telescopes?|stars?|starry|starlight|space|cosmos|cosmic|galax(?:y|ies)|orbit\w*|moons?|planets?|astronom\w*|nebula\w*|constellations?)\b/g },
    { id: 'studio', label: 'Studio', template: 'nyc-skyscraper', decor: ['whiteboard', 'lamp'],
        words: /\b(studios?|workshops?|ateliers?|labs?|laborator(?:y|ies)|makers?|whiteboards?|drawing|sketch\w*|canvas|workbench)\b/g },
    { id: 'cabin', label: 'Cabin', template: 'nyc-skyscraper', decor: ['sofa', 'rug'],
        words: /\b(cabins?|cosy|cozy|fireplaces?|hearth|cottages?|lodges?|sofas?|couch(?:es)?|warm|snug|blankets?|candles?)\b/g },
    { id: 'sea', label: 'Seaside', template: 'nyc-skyscraper', decor: ['window', 'crystal'],
        words: /\b(seas?|oceans?|lighthouses?|beach(?:es)?|shores?|coast\w*|harbou?rs?|waves?|islands?|tides?|seaside|cliffs?)\b/g },
    { id: 'penthouse', label: 'Penthouse', template: 'nyc-skyscraper', decor: [],
        words: /\b(penthouses?|skyscrapers?|city|cities|skyline|towers?|lofts?|manhattan|new york|apartments?|high-?rise|rooftops?)\b/g }
];

export interface MindStyle {
    /** Matching styles, best first ([] = nothing matched: the penthouse default). */
    styles: MindStyleId[];
    template: WorldTemplateId;
    theme: RoomTheme;
    /** Decor the sentence adds on top of the template (<= 2). */
    decor: DecorKind[];
    /** Words that matched, in sentence order (for the "what Omo read" line). */
    words: string[];
}

const THEME_OF: Record<WorldTemplateId, RoomTheme> = {
    'nyc-skyscraper': 'skyline', 'jungle-expedition': 'jungle', 'space-station': 'station',
    'solo-builder': 'station', 'classic-pair': 'station', 'agent-lab': 'station', 'research-library': 'station', 'startup-war-room': 'station',
    'review-studio': 'station', 'minimal-terminal-nook': 'station', 'open-campus': 'station', 'mission-control-xl': 'station'
};

/** Read the style words of the sentence. Pure and deterministic. */
export function mindStyle(sentence: string): MindStyle {
    const text = ` ${sanitizePlanText(sentence).toLowerCase()} `;
    const scored = MIND_STYLES.map((s, order) => {
        const hits = [...text.matchAll(new RegExp(s.words.source, 'g'))];
        return { s, order, n: hits.length, first: hits[0]?.index ?? Infinity, words: hits.map(h => ({ w: h[0], at: h.index ?? 0 })) };
    }).filter(x => x.n > 0).sort((a, b) => b.n - a.n || a.order - b.order);
    const top = scored[0]?.s, second = scored[1]?.s;
    const template = top?.template ?? 'nyc-skyscraper';
    const decor: DecorKind[] = top && second && second.decor.length && top.decor.length ? [top.decor[0], second.decor[0]]
        : (top?.decor.length ? top.decor : second?.decor ?? []).slice(0, 2);
    const words = scored.flatMap(x => x.words).sort((a, b) => a.at - b.at).map(x => x.w);
    return { styles: scored.map(x => x.s.id), template, theme: THEME_OF[template], decor, words };
}

/** "A lighthouse library at the edge of the sea" -> "Lighthouse library". */
export function worldNameFrom(sentence: string): string {
    const clean = sanitizePlanText(sentence).replace(/\[(removed|path)\]/g, ' ').replace(/[.…!?]+$/, '').trim();
    const words = clean.replace(/^(?:it(?:'s| is| would be)|i(?:'d| would) (?:say|want|like)|my mind (?:is|would be)|maybe)\s+/i, '').replace(/^(?:a|an|the|my|some|like a|like an)\s+/i, '').split(/\s+/);
    const out: string[] = [];
    for (const w of words) {
        if (!w || /^(at|on|by|in|with|of|near|under|above|over|where|that|which|who|and|full|filled|beside|inside|behind|for|from|to)$/i.test(w) || /[,;:]$/.test(out[out.length - 1] ?? '')) break;
        out.push(w);
        if (out.length >= 4) break;
    }
    const name = out.join(' ').replace(/[,;:]+$/, '').slice(0, 60);
    return name ? name[0].toUpperCase() + name.slice(1) : 'My world';
}

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** Stage 1: the home world for the sentence, planned on this device through the onboarding planner. */
export function homeWorld(sentence: string, options: { name?: string } = {}): PlanResult & { style: MindStyle } {
    const style = mindStyle(sentence);
    const name = (options.name?.trim() || worldNameFrom(sentence)).slice(0, 120);
    const base = instantiateTemplate(style.template, { name }) ?? instantiateTemplate('nyc-skyscraper', { name })!;
    const taken = new Set(base.entities.map(e => e.id));
    const ops: WorldOp[] = style.decor.map(kind => {
        const id = nextId(taken, kind); taken.add(id);
        return { op: 'add', entity: { id, kind: 'decor', decor: kind, label: cap(kind === 'bookshelf' ? 'bookshelf' : kind), transform: { x: 0, z: 0, rotation: 0 } } };
    });
    const built = applyOnboardingEdit(base, ops);
    const world = built.ok ? built.world : base;
    const label = MIND_STYLES.find(s => s.id === style.styles[0])?.label;
    const notes = [label ? `${label}${style.styles[1] ? ` + ${MIND_STYLES.find(s => s.id === style.styles[1])!.label.toLowerCase()}` : ''}: ${style.words.slice(0, 4).join(', ')}` : 'Skyline penthouse (no style words, so the default)'];
    if (style.decor.length) notes.push(`Adds ${style.decor.join(' and ')}`);
    return { world: { ...world, name, plan: sanitizePlanText(sentence).slice(0, 4000), revision: 0 }, notes, warnings: built.ok ? [] : [built.error], style };
}

function slug(text: string): string {
    const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
    return /^[a-z0-9]/.test(s) ? s : 'topic';
}
const label60 = (s: string): string => (s.replace(/[\u0000-\u001f]/g, ' ').trim() || 'Note').slice(0, 60);

/**
 * Stage 2: the home world plus one small room per imported topic (<= 6): a topic board (`sign-*`, the topic title; it
 * stands by the doorway and also lists the notes) and up to 4 notes (`note-*`, one per chat screen, drawn as reading stands). The home things stay together in a Home room. Pure.
 */
export function mindWorld(home: WorldSpec, rooms: readonly MindRoom[]): WorldSpec {
    const topics = rooms.slice(0, MIND_MAX_ROOMS).filter(r => r.screens.length);
    if (!topics.length) return home;
    const taken = new Set(home.entities.map(e => e.id));
    const assign = new Map<string, string>();
    const add: WorldEntity[] = [];
    const origin = { x: 0, z: 0, rotation: 0 };
    const homeId = nextId(taken, 'home'); taken.add(homeId);
    add.push({ id: homeId, kind: 'room', label: label60(home.name), transform: origin, width: 8, depth: 7, doors: ['front'] });
    for (const e of home.entities) if (e.kind !== 'room') assign.set(e.id, homeId);
    for (const topic of topics) {
        if (home.entities.length + add.length + 2 + topic.screens.length > WORLD_MAX_ENTITIES) break;
        const roomId = nextId(taken, `mind-${slug(topic.title)}`); taken.add(roomId);
        add.push({ id: roomId, kind: 'room', label: label60(topic.title), transform: origin, width: 8, depth: 7, doors: ['front'] });
        const signId = nextId(taken, `sign-${slug(topic.title)}`); taken.add(signId);
        add.push({ id: signId, kind: 'decor', decor: 'whiteboard', label: label60(topic.title), transform: origin, scale: 1.25 }); // promise:onboarding (4): the topic board, 2.2 x 1.25 m, by the door
        assign.set(signId, roomId);
        topic.screens.slice(0, MIND_MAX_SCREENS).forEach(screen => {
            const id = nextId(taken, `note-${slug(topic.title)}`); taken.add(id);
            add.push({ id, kind: 'decor', decor: 'whiteboard', label: label60(screen.title), transform: origin });
            assign.set(id, roomId);
        });
    }
    const built = applyWorldOps(home, add.map(entity => ({ op: 'add', entity }) as WorldOp));
    if (!built.ok) return home;
    const tidy = arrangeOps(built.world, assign);
    const arranged = tidy.length ? applyWorldOps(built.world, tidy) : built;
    const world = arranged.ok ? arranged.world : built.world;
    return { ...world, revision: 0 };
}

/** Counts for the "Your mind has rooms now" line. */
export function mindCounts(world: WorldSpec): { rooms: number; notes: number; signs: number } {
    const rooms = world.entities.filter(e => e.kind === 'room' && e.id.startsWith('mind-')).length;
    const notes = world.entities.filter(e => e.id.startsWith('note-')).length, signs = world.entities.filter(e => e.id.startsWith('sign-')).length;
    return { rooms, notes, signs };
}
