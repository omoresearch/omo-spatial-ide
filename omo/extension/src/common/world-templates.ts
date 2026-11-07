/**
 * World v2 templates (lane: templates). Curated, ready-made WorldSpecs a user can start from.
 *
 * Every template is plain data, validated by `validateWorld` when this module loads. In a dev build an
 * invalid template throws at once; in a production build it is dropped with a console warning, so a bad
 * template can never reach a user. Templates never start an agent: a station only lists the tabs it
 * WOULD open; starting any agent still asks the user first.
 *
 * Ids: the first two stations keep the v1 ids `terminal` / `terminal-2` (and `web`, `mirror`, `code`
 * where present) so existing runtime bindings and saved workspaces keep working after a switch.
 */
import type { RoomTheme } from './room-state';
import type { StationConfig, TabKind, WorldEntity, WorldSpec } from './world-model';
import { validateWorld, worldFromRoomV1, WORLD_VERSION } from './world-model';

export type WorldTemplateId =
    | 'solo-builder' | 'classic-pair' | 'agent-lab' | 'research-library' | 'startup-war-room'
    | 'review-studio' | 'jungle-expedition' | 'space-station' | 'minimal-terminal-nook';

export interface WorldTemplate {
    id: WorldTemplateId;
    label: string;
    description: string;
    /** Short tag line for pickers, e.g. "1 desk · 1 wall". Derived from the world. */
    summary: string;
    world: WorldSpec;
}

const HALF_PI = Math.PI / 2;

const TAB_LABEL: Record<TabKind, string> = { hermes: 'Hermes', claude: 'Claude', codex: 'Codex', shell: 'Shell' };

/** A station config whose first tab is `main`, plus a shell tab. Shell-only stations get one shell tab. */
function setup(name: string, main: TabKind, extra: TabKind[] = main === 'shell' ? [] : ['shell']): StationConfig {
    return {
        name,
        kind: main === 'hermes' ? 'hermes' : 'shell',
        tabs: [main, ...extra].map(kind => ({ name: TAB_LABEL[kind], kind })),
        locked: false
    };
}
function station(id: string, label: string, x: number, z: number, rotation: number, config: StationConfig): WorldEntity {
    return { id, kind: 'station', label, transform: { x, z, rotation }, station: config };
}
function decor(id: string, kind: Extract<WorldEntity, { kind: 'decor' }>['decor'], x: number, z: number, rotation = 0, scale?: number): WorldEntity {
    return { id, kind: 'decor', decor: kind, transform: { x, z, rotation }, ...(scale !== undefined ? { scale } : {}) };
}
function world(name: string, theme: RoomTheme, width: number, depth: number, entities: WorldEntity[]): WorldSpec {
    return { version: WORLD_VERSION, name, shell: { theme, width, depth }, entities, revision: 0 };
}

/** One-line description of a world's contents, for pickers and import previews. */
export function describeWorld(w: WorldSpec): string {
    const count = (kind: WorldEntity['kind']): number => w.entities.filter(e => e.kind === kind).length;
    const part = (n: number, one: string, many = `${one}s`): string | undefined => n ? `${n} ${n === 1 ? one : many}` : undefined;
    return [
        part(count('station'), 'desk'),
        part(count('monitor-wall'), 'monitor wall'),
        part(count('web-wall'), 'web wall'),
        part(count('review-screen'), 'review screen'),
        part(count('mirror'), 'mirror'),
        part(count('decor'), 'decor item')
    ].filter(Boolean).join(' · ') || 'An empty room';
}

const RAW_TEMPLATES: Array<Omit<WorldTemplate, 'summary'>> = [
    {
        id: 'solo-builder',
        label: 'Solo builder',
        description: 'One Hermes desk facing a big monitor wall that mirrors it.',
        world: world('Solo builder', 'station', 12, 10, [
            station('terminal', 'Hermes desk', 0, 0.4, 0, setup('Hermes desk', 'hermes')),
            { id: 'wall', kind: 'monitor-wall', label: 'Monitor wall', transform: { x: 0, z: -4.2, rotation: 0 }, width: 4.6, height: 2.3, elevation: 0.6, link: 'terminal' },
            decor('lamp', 'lamp', 1.5, 0.6),
            decor('plant', 'plant', -5.2, -4.2),
            decor('rug', 'rug', 0, 1.6, 0, 1.4)
        ])
    },
    {
        id: 'classic-pair',
        label: 'Classic pair',
        description: 'The original Omo room: two desks, a web wall, a mirror and the code review screen.',
        world: { ...worldFromRoomV1({ theme: 'station', projectName: 'Classic pair', layout: 'classic', kit: 'hermes-desk' }) }
    },
    {
        id: 'agent-lab',
        label: 'Agent lab',
        description: 'Four stations in a U (Hermes, Claude, Codex, Shell) around one big wall linked to Hermes.',
        world: world('Agent lab', 'station', 14, 12, [
            station('terminal', 'Hermes', -1.6, -2.4, 0, setup('Hermes', 'hermes')),
            station('terminal-2', 'Claude', 1.6, -2.4, 0, setup('Claude', 'claude')),
            station('codex', 'Codex', -4.2, 0.4, HALF_PI, setup('Codex', 'codex')),
            station('shell', 'Shell', 4.2, 0.4, -HALF_PI, setup('Shell', 'shell')),
            { id: 'big-wall', kind: 'monitor-wall', label: 'Big wall · Hermes', transform: { x: 0, z: -5.4, rotation: 0 }, width: 6.4, height: 2.8, elevation: 0.5, link: 'terminal' },
            decor('rug', 'rug', 0, 0.4, 0, 2),
            decor('plant-left', 'plant', -6.2, -5.2),
            decor('plant-right', 'plant', 6.2, -5.2),
            decor('lamp', 'lamp', 0, 3.6)
        ])
    },
    {
        id: 'research-library',
        label: 'Research library',
        description: 'Three Hermes desks, a wide web wall for sources and shelves of books.',
        world: world('Research library', 'station', 14, 12, [
            station('terminal', 'Reader one', -3.6, 0.2, 0, setup('Reader one', 'hermes')),
            station('terminal-2', 'Reader two', 0, 0.2, 0, setup('Reader two', 'hermes')),
            station('reader-3', 'Reader three', 3.6, 0.2, 0, setup('Reader three', 'hermes')),
            { id: 'web', kind: 'web-wall', label: 'Sources wall', transform: { x: 0, z: -5.4, rotation: 0 }, width: 5.4, height: 2.6, elevation: 0.6 },
            decor('shelf-l1', 'bookshelf', -6.5, -3, HALF_PI),
            decor('shelf-l2', 'bookshelf', -6.5, 0, HALF_PI),
            decor('shelf-l3', 'bookshelf', -6.5, 3, HALF_PI),
            decor('shelf-r1', 'bookshelf', 6.5, -3, -HALF_PI),
            decor('shelf-r2', 'bookshelf', 6.5, 0, -HALF_PI),
            decor('shelf-r3', 'bookshelf', 6.5, 3, -HALF_PI),
            decor('lamp-1', 'lamp', -2.2, 0.4),
            decor('lamp-2', 'lamp', 2.2, 0.4),
            decor('sofa', 'sofa', 0, 4.4, Math.PI),
            decor('rug', 'rug', 0, 3.4, 0, 1.6)
        ])
    },
    {
        id: 'startup-war-room',
        label: 'Startup war room',
        description: 'Six desks in two rows, a monitor wall and a web wall, plus a whiteboard.',
        world: world('Startup war room', 'station', 16, 14, [
            station('terminal', 'Lead · Hermes', -4, -1.6, 0, setup('Lead · Hermes', 'hermes')),
            station('terminal-2', 'Builder · Claude', 0, -1.6, 0, setup('Builder · Claude', 'claude')),
            station('desk-3', 'Builder · Codex', 4, -1.6, 0, setup('Builder · Codex', 'codex')),
            station('desk-4', 'Ops · Shell', -4, 2, 0, setup('Ops · Shell', 'shell')),
            station('desk-5', 'Research · Hermes', 0, 2, 0, setup('Research · Hermes', 'hermes')),
            station('desk-6', 'QA · Shell', 4, 2, 0, setup('QA · Shell', 'shell')),
            { id: 'ops-wall', kind: 'monitor-wall', label: 'Ops wall · Lead', transform: { x: -3.4, z: -6.5, rotation: 0 }, width: 5.6, height: 2.6, elevation: 0.6, link: 'terminal' },
            { id: 'web', kind: 'web-wall', label: 'Web wall', transform: { x: 3.4, z: -6.5, rotation: 0 }, width: 5.6, height: 2.6, elevation: 0.6 },
            decor('whiteboard', 'whiteboard', 7.6, 0, -HALF_PI, 1.4),
            decor('plant-1', 'plant', -7.4, -6.4),
            decor('plant-2', 'plant', 7.4, -6.4),
            decor('sofa', 'sofa', -6.8, 5.2, HALF_PI)
        ])
    },
    {
        id: 'review-studio',
        label: 'Review studio',
        description: 'A central code review screen between two desks, with a mirror of desk one.',
        world: world('Review studio', 'station', 12, 10, [
            { id: 'code', kind: 'review-screen', label: 'Code review', transform: { x: 0, z: -4.3, rotation: 0 } },
            station('terminal', 'Author', -2.6, 0.4, 0, setup('Author', 'hermes')),
            station('terminal-2', 'Reviewer', 2.6, 0.4, 0, setup('Reviewer', 'claude')),
            { id: 'mirror', kind: 'mirror', label: 'Mirror · Author', link: 'terminal', transform: { x: -5.6, z: 0, rotation: HALF_PI } },
            decor('sofa', 'sofa', 0, 3.6, Math.PI),
            decor('plant', 'plant', 5.4, -4.2),
            decor('lamp', 'lamp', 5.4, 3.8)
        ])
    },
    {
        id: 'jungle-expedition',
        label: 'Jungle expedition',
        description: 'Two desks and a web wall deep in the jungle, with plants and a glowing crystal.',
        world: world('Jungle expedition', 'jungle', 14, 12, [
            station('terminal', 'Base camp', -2.6, 0, 0, setup('Base camp', 'hermes')),
            station('terminal-2', 'Scout', 2.6, 0, 0, setup('Scout', 'shell')),
            { id: 'web', kind: 'web-wall', label: 'Map wall', transform: { x: 0, z: -5.4, rotation: 0 }, width: 4.6, height: 2.4, elevation: 0.7 },
            { id: 'mirror', kind: 'mirror', label: 'Mirror · Base camp', link: 'terminal', transform: { x: -6.6, z: 1.4, rotation: HALF_PI } },
            decor('crystal', 'crystal', 0, 3.2, 0, 1.3),
            decor('plant-1', 'plant', -6.2, -5.2, 0, 1.6),
            decor('plant-2', 'plant', 6.2, -5.2, 0, 1.6),
            decor('plant-3', 'plant', -6.2, 5.2, 0, 1.3),
            decor('plant-4', 'plant', 6.2, 5.2, 0, 1.3),
            decor('plant-5', 'plant', 6.4, 0, 0, 2),
            decor('window', 'window', 6.9, -2.6, -HALF_PI, 1.4),
            decor('rug', 'rug', 0, 1.6, 0, 1.6)
        ])
    },
    {
        id: 'space-station',
        label: 'Space station',
        description: 'Three consoles in an arc under a big linked wall, with windows to space.',
        world: world('Space station', 'station', 14, 12, [
            station('terminal', 'Command', 0, -1.4, 0, setup('Command', 'hermes')),
            station('terminal-2', 'Engineering', -3.6, -0.4, 0.45, setup('Engineering', 'codex')),
            station('science', 'Science', 3.6, -0.4, -0.45, setup('Science', 'claude')),
            { id: 'viewscreen', kind: 'monitor-wall', label: 'Viewscreen · Command', transform: { x: 0, z: -5.4, rotation: 0 }, width: 7, height: 3, elevation: 0.5, link: 'terminal' },
            decor('window-l', 'window', -6.9, -1, HALF_PI, 1.6),
            decor('window-r', 'window', 6.9, -1, -HALF_PI, 1.6),
            decor('crystal-1', 'crystal', -5.6, 4.6),
            decor('crystal-2', 'crystal', 5.6, 4.6),
            decor('rug', 'rug', 0, 2, 0, 1.8)
        ])
    },
    {
        id: 'minimal-terminal-nook',
        label: 'Minimal terminal nook',
        description: 'A small, quiet room: one shell desk with a linked screen and a lamp.',
        world: world('Minimal terminal nook', 'station', 8, 8, [
            station('terminal', 'Terminal', 0, 0, 0, setup('Terminal', 'shell')),
            { id: 'nook-wall', kind: 'monitor-wall', label: 'Screen · Terminal', transform: { x: 0, z: -3.6, rotation: 0 }, width: 2.6, height: 1.5, elevation: 0.8, link: 'terminal' },
            decor('lamp', 'lamp', 1.2, 0.2),
            decor('rug', 'rug', 0, 1.2)
        ])
    }
];

function isDevBuild(): boolean {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.NODE_ENV !== 'production';
}

/** Validate every template (dev: throw; production: drop and warn). Exported for checks. */
export function checkTemplates(raw: ReadonlyArray<Omit<WorldTemplate, 'summary'>>, strict: boolean): WorldTemplate[] {
    const out: WorldTemplate[] = [];
    const ids = new Set<string>();
    for (const t of raw) {
        const result = validateWorld(t.world);
        const problem = !result.ok ? result.error : ids.has(t.id) ? 'duplicate template id' : undefined;
        if (problem) {
            const message = `[omo world-templates] template "${t.id}" is invalid: ${problem}`;
            if (strict) throw new Error(message);
            console.warn(message);
            continue;
        }
        ids.add(t.id);
        out.push(Object.freeze({ ...t, summary: describeWorld(t.world) }) as WorldTemplate);
    }
    return out;
}

/** Dev assert at module load: every template must pass validateWorld. */
export const WORLD_TEMPLATES: readonly WorldTemplate[] = checkTemplates(RAW_TEMPLATES, isDevBuild());

export function worldTemplate(id: string): WorldTemplate | undefined {
    return WORLD_TEMPLATES.find(t => t.id === id);
}

/**
 * A fresh, independent copy of a template for a project. Name defaults to the template label;
 * `theme` overrides the shell theme (so any template works in either world). Revision starts at 0.
 */
export function instantiateTemplate(id: string, options: { name?: string; theme?: RoomTheme } = {}): WorldSpec | undefined {
    const t = worldTemplate(id);
    if (!t) return undefined;
    const copy: WorldSpec = JSON.parse(JSON.stringify(t.world));
    const name = options.name?.trim().slice(0, 120);
    if (name) copy.name = name;
    if (options.theme) copy.shell.theme = options.theme;
    copy.revision = 0;
    delete copy.plan;
    const checked = validateWorld(copy);
    return checked.ok ? checked.world : undefined;
}
