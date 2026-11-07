import type { AgentKind, SessionTab } from '../common/runtime-protocol';
import { agentLabel } from './agent-avatars';
import type { DeskId } from './agent-avatars';
import { currentStations, onStationDirectory, stationAliases } from './world-stations'; // w2:runtime
import type { StationInfo } from './world-stations'; // w2:runtime

/**
 * `@agent` mentions in room chat.
 *
 * Rule (simple on purpose): a line that STARTS with an agent mention is a private draft for that
 * agent. It is pasted into that agent's tab on one of YOUR desks with the existing safe paste,
 * without Enter, and it is NOT posted to the room. Mentions later in a line are plain text.
 * Peers' messages are never parsed into drafts.
 */

// w2:runtime — DESKS / DESK_NAME / aliases are LIVE: refreshed from the world's stations (world-stations.ts),
// so chat-controller, hud-overlay and notifications see every station without changes. Same array/object
// identities as before; legacy ids 'terminal' / 'terminal-2' keep @desk1 / @desk2.
export const DESKS: DeskId[] = ['terminal', 'terminal-2'];
export const DESK_NAME: Record<DeskId, string> = { terminal: 'Desk one', 'terminal-2': 'Desk two' };
const DESK_ALIASES: Record<string, DeskId> = { desk1: 'terminal', 'desk-1': 'terminal', deskone: 'terminal', 'desk-one': 'terminal', one: 'terminal', desk2: 'terminal-2', 'desk-2': 'terminal-2', desktwo: 'terminal-2', 'desk-two': 'terminal-2', two: 'terminal-2' };
const KIND_ALIASES: Record<string, Exclude<AgentKind, 'shell'> | 'any'> = { hermes: 'hermes', claude: 'claude', 'claude-code': 'claude', claudecode: 'claude', codex: 'codex', agent: 'any', ai: 'any' };
/** Station-name handles (e.g. @research). A kind word (@hermes) stays a kind, never a station name. */
const NAME_ALIASES: Record<string, DeskId> = {};
export function syncStations(list: readonly Pick<StationInfo, 'id' | 'slot' | 'name'>[]): void {
    DESKS.splice(0, DESKS.length, ...list.map(s => s.id as DeskId));
    for (const key of Object.keys(DESK_NAME)) delete (DESK_NAME as Record<string, string>)[key];
    for (const key of Object.keys(DESK_ALIASES)) delete DESK_ALIASES[key];
    for (const key of Object.keys(NAME_ALIASES)) delete NAME_ALIASES[key];
    for (const info of list) {
        (DESK_NAME as Record<string, string>)[info.id] = info.name;
        const nameSlug = slug(info.name);
        for (const alias of stationAliases(info)) {
            if (KIND_ALIASES[alias]) continue;
            const isName = alias === nameSlug || alias === nameSlug.replace(/-/g, '');
            if (isName && alias !== info.id) { if (!NAME_ALIASES[alias]) NAME_ALIASES[alias] = info.id as DeskId; }
            else if (!DESK_ALIASES[alias]) DESK_ALIASES[alias] = info.id as DeskId;
        }
    }
}
/** Station id for a handle: id / desk-N / ordinal first, then station name. */
export function stationForHandle(handle: string): DeskId | undefined { const h = handle.toLowerCase(); return DESK_ALIASES[h] ?? NAME_ALIASES[h]; }
syncStations(currentStations());
onStationDirectory(syncStations);

export interface DeskTabs { desk: DeskId; tabs: SessionTab[]; activeTabId?: string; live: boolean }
export interface MentionTarget { desk: DeskId; tabId: string; kind: Exclude<AgentKind, 'shell'>; label: string }
export type MentionParse =
    | { kind: 'none' }
    | { kind: 'draft'; target: MentionTarget; text: string; token: string }
    | { kind: 'error'; token: string; error: string };

export function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

/** Every handle a user may type for an agent tab: @desk1, @hermes, @claude, @<tab-name>. */
export function mentionHandles(desks: DeskTabs[]): string[] {
    const out = new Set<string>(DESKS.map((_, i) => `desk${i + 1}`)); // w2:runtime
    for (const id of DESKS) { const name = slug(DESK_NAME[id] ?? ''); if (name && NAME_ALIASES[name] === id) out.add(name); }
    for (const d of desks) for (const tab of d.tabs) if (tab.kind !== 'shell' && tab.state === 'running') { out.add(tab.kind); const s = slug(tab.name); if (s) out.add(s); }
    return [...out];
}

function agentTabs(d: DeskTabs): Array<SessionTab & { kind: Exclude<AgentKind, 'shell'> }> {
    return d.tabs.filter((tab): tab is SessionTab & { kind: Exclude<AgentKind, 'shell'> } => tab.kind !== 'shell' && tab.state === 'running');
}
function target(desk: DeskId, tab: SessionTab & { kind: Exclude<AgentKind, 'shell'> }): MentionTarget {
    return { desk, tabId: tab.id, kind: tab.kind, label: `${agentLabel(tab.kind, tab.name)} (${DESK_NAME[desk]})` };
}

/** Is `handle` (without @) an agent word at all? Person names are left alone. */
export function isAgentHandle(handle: string, desks: DeskTabs[]): boolean {
    const h = handle.toLowerCase();
    if (stationForHandle(h) || KIND_ALIASES[h]) return true; // w2:runtime
    return desks.some(d => d.tabs.some(tab => tab.kind !== 'shell' && slug(tab.name) === h));
}

/** Resolve one handle to exactly one running agent tab on the user's own desks. */
export function resolveHandle(handle: string, desks: DeskTabs[]): MentionTarget | { error: string } {
    const h = handle.toLowerCase();
    // w2:runtime — @desk-3 / @three / @<station-id> / @<station-name>. A running tab with the same name as a station name wins over the station name.
    const tabNamed = !DESK_ALIASES[h] && desks.some(d => d.live && agentTabs(d).some(tab => slug(tab.name) === h));
    const desk = DESK_ALIASES[h] ?? (tabNamed ? undefined : NAME_ALIASES[h]);
    if (desk) {
        const d = desks.find(x => x.desk === desk);
        if (!d?.live) return { error: `${DESK_NAME[desk]} is not open. Click its monitor first. Nothing was started.` };
        const tabs = agentTabs(d);
        const active = tabs.find(t => t.id === d.activeTabId);
        if (active) return target(desk, active);
        if (tabs.length === 1) return target(desk, tabs[0]);
        return { error: tabs.length ? `${DESK_NAME[desk]} has ${tabs.length} agent tabs. Use the tab name, for example @${slug(tabs[0].name) || tabs[0].kind}.` : `${DESK_NAME[desk]} has no running agent tab. Open a Hermes, Claude Code or Codex tab there first. Nothing was started.` };
    }
    const named: MentionTarget[] = [];
    for (const d of desks) if (d.live) for (const tab of agentTabs(d)) if (slug(tab.name) === h) named.push(target(d.desk, tab));
    const kind = KIND_ALIASES[h];
    const kinded: MentionTarget[] = [];
    if (kind) for (const d of desks) if (d.live) for (const tab of agentTabs(d)) if (kind === 'any' || tab.kind === kind) kinded.push(target(d.desk, tab));
    const found = named.length ? named : kinded;
    if (found.length === 1) return found[0];
    if (found.length > 1) {
        // Prefer the tab that is on screen, when exactly one of them is.
        const onScreen = found.filter(t => desks.find(d => d.desk === t.desk)?.activeTabId === t.tabId);
        if (onScreen.length === 1) return onScreen[0];
        return { error: `@${handle} matches ${found.length} agent tabs. Use a desk (${DESKS.slice(0, 3).map((_, i) => `@desk${i + 1}`).join(', ')}) or a tab name.` };
    }
    const what = kind && kind !== 'any' ? (kind === 'hermes' ? 'Hermes' : kind === 'claude' ? 'Claude Code' : 'Codex') : 'agent';
    return { error: `No running ${what} tab on your open desks matches @${handle}. Nothing was started.` };
}

/** Parse a line the local user typed. Only a LEADING agent mention makes a draft. */
export function parseMention(line: string, desks: DeskTabs[]): MentionParse {
    const match = /^@([A-Za-z0-9][\w.-]{0,31})(?:[\s,:]+|$)/.exec(line.trim());
    if (!match || !isAgentHandle(match[1], desks)) return { kind: 'none' };
    const token = match[1];
    const text = line.trim().slice(match[0].length).trim();
    const resolved = resolveHandle(token, desks);
    if ('error' in resolved) return { kind: 'error', token, error: resolved.error };
    if (!text) return { kind: 'error', token, error: `Type what @${token} should do after the mention.` };
    return { kind: 'draft', target: resolved, text, token };
}

/** Does a peer's line mention this user by name (case-insensitive, whole handle)? */
export function mentionsName(text: string, name: string): boolean {
    const want = slug(name);
    if (!want) return false;
    const re = /(^|\s)@([A-Za-z0-9][\w.-]{0,31})/g;
    for (let m = re.exec(text); m; m = re.exec(text)) if (slug(m[2]) === want) return true;
    return false;
}
