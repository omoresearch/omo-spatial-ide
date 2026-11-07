import type { SessionTab } from '../common/runtime-protocol';
import type { RuntimeConsoleState } from './runtime-console-controller';
import type { AgentPresence, DeskId } from './agent-avatars';
import { agentLabel } from './agent-avatars';
import { DESKS, DESK_NAME } from './chat-mentions';
import type { AgentStatus, AgentStatusReading } from '../common/agent-status-signals';
import { mergeStatus } from '../common/agent-status-signals';

/**
 * Agent notifications: the HUD version of the mod pack's Status Lamp and bell.
 * Read-only. It watches desk metadata and the visible screen; it never types, starts,
 * wakes or approves anything. w2:agents: when a real signal exists (Claude hook event, Hermes turn
 * lease, process tree) it decides; otherwise "needs approval" is a screen-text hint, said as a hint.
 */
export type NoticeKind = 'finished' | 'approval' | 'bell' | 'interrupted' | 'ended';
export interface AgentNotice { id: string; kind: NoticeKind; desk: DeskId; tabId?: string; label: string; text: string; at: number; read: boolean }
export interface NoticeInputs {
    desk(desk: DeskId): RuntimeConsoleState;
    agents(): AgentPresence[];
    /** The desk the user is typing into / attached to right now (no notice for what you are watching). */
    watching(): DeskId | undefined;
    now(): number;
    /** w2:agents: real readings (hook, lease, process) for one agent key; the screen text stays the fallback. */
    signals?(key: string): AgentStatusReading[];
}

const SOURCE_TEXT: Record<AgentStatusReading['source'], string> = { hook: 'reported by the agent', lease: 'Hermes turn state', process: 'process ended', screen: 'check the screen' };

/**
 * w2:agents: the real status of one agent, or undefined when only the screen hint is known.
 * The process tree saying 'exited' always wins; otherwise the strongest fresh signal.
 */
export function realAgentStatus(readings: AgentStatusReading[], screenApproval: boolean, now: number): AgentStatusReading | undefined {
    if (!readings.length) return undefined;
    const merged = mergeStatus([...readings, ...(screenApproval ? [{ status: 'waiting-approval' as AgentStatus, source: 'screen' as const, at: now }] : [])], now);
    return merged.source === 'screen' || merged.status === 'unknown' ? undefined : merged;
}

export const NOTICE_MAX = 30;
/** A run must last this long before its end counts as "finished" (typing echoes are shorter). */
export const FINISH_MIN_MS = 4000;
const BELL_GAP_MS = 5000;
const APPROVAL = /(do you want to (proceed|make this edit|run|create|allow)|allow (this|command|once|always)|approve (this|the|command)|\(y\/n\)|\[y\/n\]|\[Y\/n\]|yes, (and )?don'?t ask|press enter to (confirm|approve)|requires? (your )?approval|waiting for (your )?approval|dangerous command)/i;
export const NOTICE_TEXT: Record<NoticeKind, string> = { finished: 'finished', approval: 'may need your approval', bell: 'rang the bell', interrupted: 'was interrupted', ended: 'ended' };

/** True when the last visible lines of an agent screen look like an approval prompt. */
export function looksLikeApproval(lines: string[]): boolean {
    return APPROVAL.test(lines.slice(-12).join('\n'));
}

interface Track { activity?: AgentPresence['activity']; since: number; approval: boolean; state?: SessionTab['state']; real?: AgentStatus; realSince?: number }

let seq = 0;

export class NotificationsHub {
    items: AgentNotice[] = [];
    private tracks = new Map<string, Track>();
    private bells: Record<DeskId, { count: number; at: number }> = { terminal: { count: 0, at: 0 }, 'terminal-2': { count: 0, at: 0 } };
    private primed = false;
    constructor(private inputs: NoticeInputs, private onNotice: (notice: AgentNotice) => void) {}

    get unread(): number { return this.items.filter(item => !item.read).length; }
    markRead(id?: string): void { this.items = this.items.map(item => (!id || item.id === id) ? { ...item, read: true } : item); }
    clear(): void { this.items = []; }

    private add(kind: NoticeKind, desk: DeskId, label: string, tabId?: string, detail?: string): void {
        const notice: AgentNotice = { id: `n${++seq}`, kind, desk, tabId, label, text: `${label} ${NOTICE_TEXT[kind]}${detail ? ` · ${detail}` : ''}`, at: this.inputs.now(), read: false };
        // One live notice per (desk, tab, kind): a newer one replaces the older.
        this.items = [notice, ...this.items.filter(item => !(item.desk === desk && item.tabId === tabId && item.kind === kind))].slice(0, NOTICE_MAX);
        this.onNotice(notice);
    }

    /** Call often (4 Hz). Compares with the previous call only. */
    tick(): void {
        const now = this.inputs.now();
        const watching = this.inputs.watching();
        const agents = this.inputs.agents();
        const seen = new Set<string>();
        for (const agent of agents) {
            seen.add(agent.key);
            const state = this.inputs.desk(agent.desk);
            const tab = state.workspace?.tabs.find(t => t.id === agent.key.slice(agent.desk.length + 1));
            const onScreen = state.activeTabId === tab?.id;
            const approval = onScreen && state.phase === 'live' && looksLikeApproval(state.lines);
            const old = this.tracks.get(agent.key);
            // w2:agents: a real signal (hook > lease > process) decides when there is one; the screen text is the fallback.
            const real = realAgentStatus(this.inputs.signals?.(agent.key) ?? [], approval, now);
            const track: Track = { activity: agent.activity, since: old && old.activity === agent.activity ? old.since : now, approval, state: tab?.state,
                real: real?.status, realSince: old && old.real === real?.status ? old.realSince : now };
            this.tracks.set(agent.key, track);
            if (!old || !this.primed) continue; // first sight is history, not news
            const label = `${agentLabel(agent.kind, agent.tabName)} (${DESK_NAME[agent.desk]})`;
            const quiet = watching === agent.desk;
            if (real) {
                if (old.real === 'working' && real.status === 'idle' && now - (old.realSince ?? now) >= FINISH_MIN_MS && !quiet) this.add('finished', agent.desk, label, tab?.id);
                if (real.status === 'waiting-approval' && old.real !== 'waiting-approval') this.add('approval', agent.desk, label, tab?.id, SOURCE_TEXT[real.source]);
                if (real.status === 'exited' && old.real !== 'exited' && old.state === 'running' && tab?.state === 'running') this.add('ended', agent.desk, label, tab?.id, SOURCE_TEXT[real.source]);
            } else {
                if (old.activity === 'working' && agent.activity === 'idle' && now - old.since >= FINISH_MIN_MS && !quiet) this.add('finished', agent.desk, label, tab?.id);
                if (approval && !old.approval) this.add('approval', agent.desk, label, tab?.id, 'check the screen');
            }
            if (old.state === 'running' && tab?.state === 'interrupted') this.add('interrupted', agent.desk, label, tab.id);
            if (old.state === 'running' && tab?.state === 'exited') this.add('ended', agent.desk, label, tab.id);
        }
        for (const key of [...this.tracks.keys()]) if (!seen.has(key)) this.tracks.delete(key);
        for (const desk of DESKS) {
            const count = this.inputs.desk(desk).unreadBells;
            const bell = this.bells[desk];
            if (this.primed && count > bell.count && now - bell.at >= BELL_GAP_MS && watching !== desk) { this.add('bell', desk, DESK_NAME[desk]); bell.at = now; }
            bell.count = count;
        }
        this.primed = true;
    }
}
