export const OMO_RUNTIME_PATH = '/services/omo-runtime';
export type AgentKind = 'shell' | 'hermes' | 'claude' | 'codex';
export interface AgentAvailability {
    kind: AgentKind;
    available: boolean;
    detail: string;
    installHint?: string;
}
export interface HostStatus {
    available: boolean;
    tmux: boolean;
    python: boolean;
    agents: AgentAvailability[];
    profiles: string[];
    detail: string;
}
export interface SessionTab {
    id: string;
    name: string;
    kind: AgentKind;
    state: 'running' | 'exited' | 'interrupted' | 'sleeping' | 'unknown';
    busy: boolean;
    detail?: string;
}
export interface SessionWorkspace {
    id: string;
    name: string;
    projectUri: string;
    profile: string;
    tabs: SessionTab[];
    state: 'running' | 'ended' | 'interrupted' | 'unknown';
}
export interface RuntimeFrame {
    sequence: number;
    cols: number;
    rows: number;
    lines: string[];
    foreground?: string[];
    background?: string[];
    palette?: Record<string, string>;
    cursor?: { x: number; y: number; visible: boolean };
}
export interface RuntimePoll {
    state: 'connecting' | 'live' | 'detached' | 'error';
    frame?: RuntimeFrame;
    workspace?: SessionWorkspace;
    detail?: string;
}
/** Local, single-user backend. No bridge credentials are returned to the browser. */
export interface OmoRuntimeService {
    status(): Promise<HostStatus>;
    openWorkspace(input: { stationId: string; projectUri: string; name: string; profile?: string }): Promise<SessionWorkspace>;
    getWorkspace(workspaceId: string): Promise<SessionWorkspace>;
    newTab(input: { workspaceId: string; kind: AgentKind; name?: string; profile?: string; confirmedStart: boolean }): Promise<SessionWorkspace>;
    renameTab(input: { workspaceId: string; tabId: string; name: string }): Promise<SessionWorkspace>;
    closeTab(input: { workspaceId: string; tabId: string; confirmedClose: boolean }): Promise<SessionWorkspace>;
    reviveTab(input: { workspaceId: string; tabId: string; confirmedStart: boolean }): Promise<SessionWorkspace>;
    attach(input: { workspaceId: string; tabId: string; cols: number; rows: number }): Promise<{ viewId: string }>;
    poll(input: { viewId: string; afterSequence: number }): Promise<RuntimePoll>;
    input(input: { viewId: string; data: string }): Promise<void>;
    resize(input: { viewId: string; cols: number; rows: number }): Promise<void>;
    detach(viewId: string): Promise<void>;
}
export const OmoRuntimeService = Symbol('OmoRuntimeService');
