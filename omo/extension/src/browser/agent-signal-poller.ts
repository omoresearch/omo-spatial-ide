import type { AgentSignalsService, AgentTabRef } from '../common/agent-signals-protocol';
import type { AgentStatusReading } from '../common/agent-status-signals';
import type { SessionWorkspace } from '../common/runtime-protocol';
import type { DeskId } from './agent-avatars';

/**
 * w2:agents — polls the backend for real agent signals (Claude hooks, Hermes lease, process tree)
 * for the agent tabs on the desks, and keeps the newest readings per `${desk}:${tabId}` (the same key
 * as AgentPresence). Read-only: it never starts, types into or approves anything.
 */
export const SIGNAL_POLL_MS = 3000;

export interface SignalPollerOptions {
    service: Pick<AgentSignalsService, 'readSignals'>;
    desks(): Array<{ desk: DeskId; workspace?: SessionWorkspace }>;
    schedule(fn: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
    onChange?(): void;
    pollMs?: number;
}

export class AgentSignalPoller {
    private readings = new Map<string, AgentStatusReading[]>();
    private handle: unknown;
    private disposed = false;
    private inFlight = false;
    private polled = false; // t2:agents

    constructor(private readonly options: SignalPollerOptions) {
        this.handle = options.schedule(() => void this.loop(), 0);
    }

    /** Real readings for one agent key (`${desk}:${tabId}`); [] when none. */
    get(key: string): AgentStatusReading[] { return this.readings.get(key) ?? []; }
    /** t2:agents: true after the first answered poll (before it, "no reading" only means "not asked yet"). */
    get ready(): boolean { return this.polled; }

    /** One poll. Exposed for tests and for an explicit refresh. */
    async poll(): Promise<void> {
        if (this.inFlight || this.disposed) return;
        this.inFlight = true;
        try {
            const refs: Array<{ desk: DeskId; ref: AgentTabRef }> = [];
            for (const { desk, workspace } of this.options.desks()) {
                for (const tab of workspace?.tabs ?? []) {
                    if (tab.kind === 'shell') continue;
                    refs.push({ desk, ref: { workspaceId: workspace!.id, tabId: tab.id, kind: tab.kind, ...(tab.kind === 'hermes' ? { profile: tab.profile || 'default' } : {}) } });
                }
            }
            const next = new Map<string, AgentStatusReading[]>();
            if (refs.length) {
                const result = await this.options.service.readSignals({ tabs: refs.map(r => r.ref) });
                for (const row of result) {
                    const owner = refs.find(r => r.ref.workspaceId === row.workspaceId && r.ref.tabId === row.tabId);
                    if (owner) next.set(`${owner.desk}:${row.tabId}`, row.readings.filter(r => r.source !== 'screen') as AgentStatusReading[]);
                }
            }
            const changed = JSON.stringify([...next]) !== JSON.stringify([...this.readings]);
            this.readings = next;
            this.polled = true; // t2:agents
            if (changed) this.options.onChange?.();
        } catch {
            // backend unavailable: keep the last readings; the screen hint still works
        } finally {
            this.inFlight = false;
        }
    }

    private async loop(): Promise<void> {
        await this.poll();
        if (!this.disposed) this.handle = this.options.schedule(() => void this.loop(), this.options.pollMs ?? SIGNAL_POLL_MS);
    }

    dispose(): void {
        this.disposed = true;
        if (this.handle !== undefined) this.options.cancel(this.handle);
    }
}
