import type { AgentCheckObservation, AgentCheckReport, AgentSignalsService, AgentTabRef } from '../common/agent-signals-protocol';
import { mergeStatus } from '../common/agent-status-signals';
import type { AgentStatusReading } from '../common/agent-status-signals';
import type { AgentKind, HostStatus, OmoRuntimeService, SessionWorkspace } from '../common/runtime-protocol';

/**
 * w2:agents — Real agent check.
 *
 * Runs only when the user presses Run and then confirms the exact list of tabs it will start. It opens
 * one tab per installed agent kind in the desk's workspace, then only OBSERVES: it reads tab metadata
 * and real status signals. It never calls input, paste, resume or close, so nothing is typed or sent
 * to any agent. The observed states are saved as JSON in the Omo data dir.
 */
export type CheckKind = Exclude<AgentKind, 'shell'>;
export const CHECK_KINDS: CheckKind[] = ['hermes', 'claude', 'codex', 'dsh'];
export const CHECK_OBSERVE_MS = 60_000;
export const CHECK_POLL_MS = 3_000;

export type CheckPhase = 'idle' | 'confirm' | 'starting' | 'observing' | 'saving' | 'done' | 'error';
export interface AgentCheckState {
    phase: CheckPhase;
    kinds: CheckKind[];
    observations: AgentCheckObservation[];
    message: string;
    file?: string;
}

export interface AgentCheckOptions {
    runtime: Pick<OmoRuntimeService, 'status' | 'newTab' | 'getWorkspace'>;
    signals: Pick<AgentSignalsService, 'readSignals' | 'recordAgentCheck'>;
    workspace(): SessionWorkspace | undefined;
    profile(): string;
    now(): number;
    sleep(ms: number): Promise<void>;
    onChange(state: AgentCheckState): void;
    observeMs?: number;
    pollMs?: number;
}

/** Installed agent kinds this computer can start now (from the runtime host status). */
export function installedCheckKinds(host: HostStatus | undefined): CheckKind[] {
    return CHECK_KINDS.filter(kind => !!host?.agents.some(a => a.kind === kind && a.available)
        && (kind !== 'hermes' || !!host?.profiles.length));
}

export class AgentCheckController {
    state: AgentCheckState = { phase: 'idle', kinds: [], observations: [], message: '' };
    private stopRequested = false;

    constructor(private readonly o: AgentCheckOptions) { }

    private set(patch: Partial<AgentCheckState>): void {
        this.state = { ...this.state, ...patch };
        this.o.onChange(this.state);
    }

    /** Step 1 (explicit Run click): find installed agents and ask for confirmation. Starts nothing. */
    async requestRun(): Promise<void> {
        if (this.state.phase === 'starting' || this.state.phase === 'observing' || this.state.phase === 'saving') return;
        const ws = this.o.workspace();
        if (!ws) { this.set({ phase: 'error', message: 'Click a desk monitor first, so the check has a workspace to open tabs in. Nothing was started.' }); return; }
        let host: HostStatus | undefined;
        try { host = await this.o.runtime.status(); } catch (e) { this.set({ phase: 'error', message: `The runtime is not available: ${e instanceof Error ? e.message : String(e)}` }); return; }
        const kinds = installedCheckKinds(host);
        if (!kinds.length) { this.set({ phase: 'error', kinds, message: 'No agent is installed on this computer. Nothing was started.' }); return; }
        this.set({ phase: 'confirm', kinds, observations: [], file: undefined, message: '' });
    }

    cancel(): void {
        if (this.state.phase === 'confirm') this.set({ phase: 'idle', message: 'Cancelled. Nothing was started.' });
    }

    /** Stop observing early. Tabs keep running; the report is still saved. */
    stop(): void { this.stopRequested = true; }

    /** Step 2 (explicit confirm click): start one tab per kind, observe, save. Never sends input. */
    async confirmRun(): Promise<void> {
        if (this.state.phase !== 'confirm') return;
        const ws = this.o.workspace();
        if (!ws) { this.set({ phase: 'error', message: 'The desk workspace went away. Nothing was started.' }); return; }
        this.stopRequested = false;
        const startedAt = this.o.now();
        const observations: AgentCheckObservation[] = [];
        this.set({ phase: 'starting', message: 'Starting one tab per agent…' });
        let current = ws;
        for (const kind of this.state.kinds) {
            const before = new Set(current.tabs.map(t => t.id));
            try {
                current = await this.o.runtime.newTab({ workspaceId: ws.id, kind, name: `check ${kind}`, confirmedStart: true,
                    ...(kind === 'hermes' ? { profile: this.o.profile() } : {}) });
                const tab = current.tabs.find(t => !before.has(t.id));
                observations.push({ kind, tabId: tab?.id, started: !!tab, ...(tab ? {} : { error: 'the runtime did not report a new tab' }), states: [] });
            } catch (e) {
                observations.push({ kind, started: false, error: e instanceof Error ? e.message : String(e), states: [] });
            }
            this.set({ observations: observations.map(x => ({ ...x })) });
        }
        const observeMs = this.o.observeMs ?? CHECK_OBSERVE_MS;
        const end = this.o.now() + observeMs;
        this.set({ phase: 'observing', message: `Watching for ${Math.round(observeMs / 1000)} s. Nothing is typed into the tabs. Use them yourself if you want to see more states.` });
        while (!this.stopRequested) {
            await this.observeOnce(ws.id, observations);
            this.set({ observations: observations.map(x => ({ ...x, states: [...x.states] })) });
            if (this.o.now() >= end) break;
            await this.o.sleep(this.o.pollMs ?? CHECK_POLL_MS);
        }
        this.set({ phase: 'saving', message: 'Saving the report…' });
        const report: AgentCheckReport = { startedAt, finishedAt: this.o.now(), workspaceId: ws.id, projectUri: ws.projectUri, sentNothing: true, observations };
        try {
            const { file } = await this.o.signals.recordAgentCheck({ report });
            this.set({ phase: 'done', file, message: `Saved to ${file}. The check tabs keep running; close them from the desk when you are done.` });
        } catch (e) {
            this.set({ phase: 'error', message: `The report was not saved: ${e instanceof Error ? e.message : String(e)}` });
        }
    }

    private async observeOnce(workspaceId: string, observations: AgentCheckObservation[]): Promise<void> {
        const at = this.o.now();
        let ws: SessionWorkspace | undefined;
        try { ws = await this.o.runtime.getWorkspace(workspaceId); } catch { /* recorded as unknown below */ }
        const refs: AgentTabRef[] = [];
        for (const obs of observations) {
            const tab = obs.tabId ? ws?.tabs.find(t => t.id === obs.tabId) : undefined;
            if (tab && tab.kind !== 'shell') refs.push({ workspaceId, tabId: tab.id, kind: tab.kind, ...(tab.kind === 'hermes' ? { profile: tab.profile || 'default' } : {}) });
        }
        let readings = new Map<string, AgentStatusReading[]>();
        try {
            const rows = refs.length ? await this.o.signals.readSignals({ tabs: refs }) : [];
            readings = new Map(rows.map(r => [r.tabId, r.readings as AgentStatusReading[]]));
        } catch { /* no real signal this round */ }
        for (const obs of observations) {
            if (!obs.started || !obs.tabId) continue;
            const tab = ws?.tabs.find(t => t.id === obs.tabId);
            const merged = mergeStatus(readings.get(obs.tabId) ?? [], at);
            const entry = { at, tabState: tab?.state ?? 'missing', status: merged.status, source: merged.status === 'unknown' ? 'none' : merged.source, ...(merged.detail ? { detail: merged.detail } : {}) };
            const last = obs.states[obs.states.length - 1];
            // Keep the report small: only changes (plus the first and the final sample).
            if (!last || last.tabState !== entry.tabState || last.status !== entry.status || last.source !== entry.source) obs.states.push(entry);
        }
    }
}
