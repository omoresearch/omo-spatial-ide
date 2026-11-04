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
    /** Metadata only; the spatial runtime has no auto-sleep. */
    keepAwake?: boolean;
}
/** One row of the workspace board: live metadata plus the stations bound to it. */
export interface WorkspaceSummary extends SessionWorkspace {
    stations: string[];
}
/** Scroll state of a view (tmux history), as the bridge reports it. */
export interface ViewModes {
    history: number;
    scrollOffset: number;
    bracketedPaste: boolean;
}
export interface FindResult { query: string; index: number; count: number }
export interface CopyResult { text: string; chars: number; lines: number }
export interface PasteResult { bracketed: boolean; bytes: number }
export interface ResumeResult { workspace: SessionWorkspace; detail: string; fresh: boolean }
/** Bridge-enforced paste limit (bytes of UTF-8). */
export const PASTE_MAX_BYTES = 256 * 1024;
export interface RuntimeFrame {
    sequence: number;
    cols: number;
    rows: number;
    lines: string[];
    /** Authoritative parser cells: full glyph/combining sequence; '' is a wide continuation. */
    cells?: string[][];
    foreground?: string[];
    background?: string[];
    palette?: Record<string, string>;
    cursor?: { x: number; y: number; visible: boolean };
    /** Lines of tmux history above the screen. */
    history?: number;
    /** Lines scrolled back from the live screen (0 = live). */
    scrollOffset?: number;
    /** Bells rung in this view since it attached (a count; nothing is played). */
    bell?: number;
    /** Whether the app in the pane enabled bracketed paste. */
    bracketedPaste?: boolean;
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
    // --- advanced parity (additive) ---
    listWorkspaces(): Promise<WorkspaceSummary[]>;
    renameWorkspace(input: { workspaceId: string; name: string }): Promise<SessionWorkspace>;
    deleteWorkspace(input: { workspaceId: string; confirmedDelete: boolean; confirmedBusy?: boolean }): Promise<{ deleted: boolean; detail: string }>;
    bindStation(input: { stationId: string; projectUri: string; workspaceId: string }): Promise<SessionWorkspace>;
    setWorkspaceProfile(input: { workspaceId: string; profile: string }): Promise<SessionWorkspace>;
    setKeepAwake(input: { workspaceId: string; on: boolean }): Promise<SessionWorkspace>;
    resumeAgent(input: { workspaceId: string; tabId: string; confirmedStart: boolean }): Promise<ResumeResult>;
    scroll(input: { viewId: string; lines: number }): Promise<ViewModes>;
    wheel(input: { viewId: string; notches: number; x?: number; y?: number }): Promise<ViewModes>;
    find(input: { viewId: string; query: string; step: number }): Promise<FindResult>;
    copyText(input: { viewId: string; x1: number; y1: number; x2: number; y2: number; unit?: 'char' | 'word' | 'line' }): Promise<CopyResult>;
    clearHistory(input: { viewId: string; confirmedClear: boolean }): Promise<ViewModes>;
    paste(input: { viewId: string; text: string }): Promise<PasteResult>;
}
export const OmoRuntimeService = Symbol('OmoRuntimeService');
