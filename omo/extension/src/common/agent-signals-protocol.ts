/**
 * w2:agents — real agent status signals over RPC (local, single user).
 *
 * Everything here is read-only except two explicit, confirmed writes inside the Omo data dir:
 *   - the opt-in Claude status settings file (enableClaudeStatus / disableClaudeStatus)
 *   - the Real agent check report (recordAgentCheck)
 * Nothing here starts, types into, approves or stops an agent, and nothing reads ~/.claude.
 */
export const OMO_AGENT_SIGNALS_PATH = '/services/omo-agent-signals';

/** What the 'Enable Claude status' button shows before anything is written. */
export interface ClaudeStatusPlan {
    /** True when the settings file exists and holds exactly `json`. */
    enabled: boolean;
    /** True when a file exists at settingsFile but is not the Omo hook config (it is left alone). */
    foreign: boolean;
    /** Absolute target file, always inside the Omo data dir. */
    settingsFile: string;
    /** The recorder script the hook runs, and the JSON-lines file it appends to. */
    hookScript: string;
    eventsFile: string;
    /** The exact file content that will be written (pretty JSON). */
    json: string;
    detail: string;
}

export interface AgentTabRef {
    workspaceId: string;
    tabId: string;
    kind: 'hermes' | 'claude' | 'codex' | 'dsh';
    /** Hermes tabs: the captured profile ('default' for the base profile). */
    profile?: string;
}

export type AgentSignalStatus = 'working' | 'waiting-approval' | 'idle' | 'exited' | 'unknown';
export interface AgentSignalReading { status: AgentSignalStatus; source: 'hook' | 'lease' | 'process' | 'screen'; at: number; detail?: string }
export interface AgentTabSignals {
    workspaceId: string;
    tabId: string;
    /** Every real reading found (hook, lease, process); the browser adds the screen fallback and merges. */
    readings: AgentSignalReading[];
}

/** One observed agent in a Real agent check. */
export interface AgentCheckObservation {
    kind: string;
    tabId?: string;
    started: boolean;
    error?: string;
    /** Observed states over time, oldest first. */
    states: Array<{ at: number; tabState: string; status: AgentSignalStatus; source: string; detail?: string }>;
}
export interface AgentCheckReport {
    startedAt: number;
    finishedAt: number;
    workspaceId: string;
    projectUri: string;
    /** Always true: the check never sends input to a tab. */
    sentNothing: true;
    observations: AgentCheckObservation[];
}

export interface AgentSignalsService {
    claudeStatus(): Promise<ClaudeStatusPlan>;
    /** Writes `json` to plan.settingsFile only when confirmed and `json` equals the plan the user was shown. */
    enableClaudeStatus(input: { confirmedWrite: boolean; json: string }): Promise<ClaudeStatusPlan>;
    /** Removes the Omo settings file (only when it is the Omo hook config). */
    disableClaudeStatus(input: { confirmedRemove: boolean }): Promise<ClaudeStatusPlan>;
    /** Real signals for these tabs: Claude hook events, Hermes turn leases (read-only), process tree. */
    readSignals(input: { tabs: AgentTabRef[] }): Promise<AgentTabSignals[]>;
    /** Saves a Real agent check report as JSON in the Omo data dir; returns the file path. */
    recordAgentCheck(input: { report: AgentCheckReport }): Promise<{ file: string }>;
}
export const AgentSignalsService = Symbol('AgentSignalsService');
