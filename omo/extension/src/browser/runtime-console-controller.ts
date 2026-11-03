import type { AgentKind, FindResult, HostStatus, OmoRuntimeService, RuntimeFrame, RuntimePoll, SessionTab, SessionWorkspace, ViewModes, WorkspaceSummary } from '../common/runtime-protocol';

/**
 * Frontend state machine for the in-world terminal monitor. It owns the
 * workspace binding, the attached view, the bounded poll loop and every
 * explicit user action. It never starts, revives or closes a tab on its own.
 * Pure TypeScript (no Theia/DOM imports) so it can be tested against a fake service.
 */
export const MONITOR_COLS = 80;
export const MONITOR_ROWS = 22;
export const TAB_NAME_MAX = 24;
export const POLL_MS = 200;
export const RETRY_MS = 1500;
export const AGENT_KINDS: AgentKind[] = ['shell', 'hermes', 'claude', 'codex'];
export const AGENT_LABELS: Record<AgentKind, string> = { shell: 'Shell', hermes: 'Hermes', claude: 'Claude Code', codex: 'Codex' };
export const WORKSPACE_NAME_MAX = 40;
/** Same limit the bridge enforces; checked here too so a refused paste never leaves the browser. */
export const PASTE_LIMIT_BYTES = 256 * 1024;
export interface CopyRange { x1: number; y1: number; x2: number; y2: number; unit?: 'char' | 'word' | 'line' }

export interface StationBinding { stationId: string; projectUri: string; name: string }
export type RuntimePhase = 'idle' | 'checking' | 'unavailable' | 'opening' | 'attaching' | 'live' | 'reconnecting' | 'interrupted' | 'error';
export interface PendingAction { type: 'new' | 'close' | 'revive' | 'deleteWorkspace' | 'deleteWorkspaceBusy' | 'resume' | 'clearHistory'; kind?: AgentKind; tabId?: string; workspaceId?: string; message: string; confirmLabel: string }
export interface RuntimeConsoleState {
    phase: RuntimePhase;
    statusText: string;
    notice: string;
    error: string;
    host?: HostStatus;
    workspace?: SessionWorkspace;
    activeTabId?: string;
    profile: string;
    lines: string[];
    foreground?: string[];
    background?: string[];
    palette?: Record<string, string>;
    cursor?: RuntimeFrame['cursor'];
    sequence: number;
    pending?: PendingAction;
    acting: boolean;
    /** From the latest frame, when the runtime reports them. */
    history?: number;
    scrollOffset?: number;
    bell?: number;
    bracketedPaste?: boolean;
    /** Workspace board (read-only list from live metadata), loaded on request. */
    board?: WorkspaceSummary[];
    find?: FindResult;
}
export interface LauncherOption { kind: AgentKind; label: string; available: boolean; reason: string; installHint?: string }
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface RuntimeConsoleOptions {
    service: OmoRuntimeService;
    storage?: StorageLike;
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
    onChange: (state: RuntimeConsoleState) => void;
    pollMs?: number;
    retryMs?: number;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const EXTRA_ACTIONS: PendingAction['type'][] = ['deleteWorkspace', 'deleteWorkspaceBusy', 'resume', 'clearHistory'];
const CONTROL = /[\u0000-\u001f\u007f]/;
const RESUME_NOTE: Record<AgentKind, string> = {
    shell: '', hermes: 'It resumes this tab’s own Hermes conversation.',
    claude: 'Claude Code resumes this tab’s saved session when there is one.',
    codex: 'Codex starts a fresh session: an earlier Codex conversation is not resumed.'
};
function utf8Bytes(text: string): number {
    let n = 0;
    for (const ch of text) { const c = ch.codePointAt(0)!; n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
    return n;
}
const ACTIVE_PHASES: RuntimePhase[] = ['checking', 'opening', 'attaching', 'live', 'reconnecting', 'interrupted'];

export function bindingKey(binding: Pick<StationBinding, 'stationId' | 'projectUri'>): string {
    return `omo.runtime.v1:${binding.projectUri}#${binding.stationId}`;
}

export function launcherOptions(host: HostStatus | undefined): LauncherOption[] {
    return AGENT_KINDS.map(kind => {
        const label = AGENT_LABELS[kind];
        if (!host) return { kind, label, available: false, reason: 'Checking this computer…' };
        if (!host.tmux) return { kind, label, available: false, reason: `tmux is required for tabs that keep running. ${host.detail}`.trim() };
        if (!host.available) return { kind, label, available: false, reason: host.detail || 'The local runtime is not available.' };
        const agent = host.agents.find(a => a.kind === kind);
        if (!agent) return { kind, label, available: false, reason: `${label} was not reported by this computer.` };
        if (!agent.available) return { kind, label, available: false, reason: agent.detail || `${label} is not installed.`, installHint: agent.installHint };
        if (kind === 'hermes' && !host.profiles.length) return { kind, label, available: false, reason: 'No Hermes profiles found. Create one with: hermes profile create <name>' };
        return { kind, label, available: true, reason: agent.detail };
    });
}

/** The colour key used by most cells: the terminal's own background. */
export function dominantKey(rows: string[] | undefined): string | undefined {
    const counts = new Map<string, number>();
    for (const row of rows ?? []) for (const key of row) counts.set(key, (counts.get(key) ?? 0) + 1);
    let best: string | undefined; let most = 0;
    counts.forEach((n, key) => { if (n > most) { most = n; best = key; } });
    return best;
}

export interface CellRun { x: number; text: string; fg: string; bg: string }
/** Split one monitor row into runs of equal colour. fg/bg hold one palette key per cell. */
export function cellRuns(line: string, fg: string | undefined, bg: string | undefined, palette: Record<string, string> | undefined, defaults: { fg: string; bg: string }): CellRun[] {
    const cells = Array.from(line);
    const colour = (codes: string | undefined, i: number, fallback: string): string => {
        const key = codes?.[i];
        const value = key !== undefined ? palette?.[key] : undefined;
        if (!value) return fallback;
        return value.startsWith('#') ? value : `#${value}`;
    };
    const runs: CellRun[] = [];
    cells.forEach((ch, i) => {
        const f = colour(fg, i, defaults.fg); const b = colour(bg, i, defaults.bg);
        const last = runs[runs.length - 1];
        if (last && last.fg === f && last.bg === b) last.text += ch;
        else runs.push({ x: i, text: ch, fg: f, bg: b });
    });
    return runs;
}

function describeTab(tab: SessionTab): string {
    if (tab.state === 'interrupted') return `${tab.name} was interrupted${tab.detail ? ` (${tab.detail})` : ''}. Revive it from the console strip when you are ready.`;
    if (tab.state === 'exited') return `${tab.name} has exited${tab.detail ? ` (${tab.detail})` : ''}.`;
    if (tab.state === 'sleeping') return `${tab.name} is asleep. It resumes when shown.`;
    return `Live · ${tab.name}${tab.busy ? ' · working' : ''}`;
}

export class RuntimeConsoleController {
    private readonly service: OmoRuntimeService;
    private readonly options: RuntimeConsoleOptions;
    private binding?: StationBinding;
    private viewId?: string;
    private epoch = 0;
    private viewGen = 0;
    private pollInFlight = -1;
    private timer: unknown;
    private disposed = false;
    private current: RuntimeConsoleState = RuntimeConsoleController.initial();

    constructor(options: RuntimeConsoleOptions) { this.options = options; this.service = options.service; }

    static initial(): RuntimeConsoleState {
        return { phase: 'idle', statusText: 'Walk up and click this screen.', notice: '', error: '', profile: '', lines: [], sequence: 0, acting: false };
    }
    get state(): RuntimeConsoleState { return this.current; }
    get launchers(): LauncherOption[] { return launcherOptions(this.current.host); }

    private set(patch: Partial<RuntimeConsoleState>): void {
        if (this.disposed) return;
        this.current = { ...this.current, ...patch };
        this.options.onChange(this.current);
    }
    private activeTab(): SessionTab | undefined { return this.current.workspace?.tabs.find(t => t.id === this.current.activeTabId); }

    private readStored(binding: StationBinding): { workspaceId?: string; tabId?: string } | undefined {
        try {
            const raw = this.options.storage?.getItem(bindingKey(binding));
            if (!raw) return undefined;
            const value = JSON.parse(raw);
            return value && typeof value === 'object' ? { workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : undefined, tabId: typeof value.tabId === 'string' ? value.tabId : undefined } : undefined;
        } catch { return undefined; }
    }
    private store(): void {
        if (!this.binding || !this.current.workspace) return;
        try { this.options.storage?.setItem(bindingKey(this.binding), JSON.stringify({ workspaceId: this.current.workspace.id, tabId: this.current.activeTabId })); } catch { /* storage is optional; the backend binding is still stable */ }
    }

    private clearTimer(): void { if (this.timer !== undefined) { this.options.cancel(this.timer); this.timer = undefined; } }
    private later(fn: () => void, ms: number): void {
        this.clearTimer();
        const epoch = this.epoch; const gen = this.viewGen;
        this.timer = this.options.schedule(() => { this.timer = undefined; if (epoch === this.epoch && gen === this.viewGen && !this.disposed) fn(); }, ms);
    }
    /** Detach the current monitor view. Never closes the tab or its processes. */
    private releaseView(): void {
        this.viewGen++; this.clearTimer();
        const viewId = this.viewId; this.viewId = undefined;
        if (viewId) this.service.detach(viewId).catch(() => undefined);
    }
    private sameBinding(binding: StationBinding): boolean {
        return !!this.binding && this.binding.projectUri === binding.projectUri && this.binding.stationId === binding.stationId;
    }

    /** Explicit user connect (click on the monitor). Idempotent while connected. */
    async bind(binding: StationBinding): Promise<void> {
        if (this.disposed) return;
        if (this.sameBinding(binding) && ACTIVE_PHASES.includes(this.current.phase)) return;
        await this.open(binding, this.readStored(binding)?.tabId);
    }
    /** Refresh/project switch: reconnect only a binding the user opened before. */
    async reconnect(binding: StationBinding): Promise<void> {
        if (this.disposed) return;
        const stored = this.readStored(binding);
        if (!stored) {
            this.epoch++; this.releaseView(); this.binding = binding;
            this.current = { ...RuntimeConsoleController.initial(), host: this.current.host };
            this.set({});
            return;
        }
        if (this.sameBinding(binding) && ACTIVE_PHASES.includes(this.current.phase)) return;
        await this.open(binding, stored.tabId);
    }

    private async open(binding: StationBinding, preferredTab: string | undefined): Promise<void> {
        const epoch = ++this.epoch;
        this.releaseView();
        this.binding = binding;
        this.current = { ...RuntimeConsoleController.initial(), host: this.current.host, profile: this.current.profile };
        this.set({ phase: 'checking', statusText: 'Checking this computer for tmux and agents…' });
        let host: HostStatus;
        try { host = await this.service.status(); } catch (error) {
            if (epoch !== this.epoch) return;
            this.set({ phase: 'error', error: `Could not reach the local runtime: ${message(error)}`, statusText: 'Runtime unreachable. Click the monitor to try again.' });
            return;
        }
        if (epoch !== this.epoch) return;
        if (!host.available || !host.tmux) {
            this.set({ host, phase: 'unavailable', statusText: host.detail || 'The local runtime is not available on this computer.' });
            return;
        }
        this.set({ host, phase: 'opening', statusText: 'Opening this room’s terminal workspace…' });
        let workspace: SessionWorkspace;
        try { workspace = await this.service.openWorkspace({ stationId: binding.stationId, projectUri: binding.projectUri, name: binding.name }); } catch (error) {
            if (epoch !== this.epoch) return;
            this.set({ phase: 'error', error: `Could not open the terminal workspace: ${message(error)}`, statusText: 'Not connected. Click the monitor to try again.' });
            return;
        }
        if (epoch !== this.epoch) return;
        const tabs = workspace.tabs;
        const active = tabs.find(t => t.id === preferredTab) ?? tabs.find(t => t.state === 'running') ?? tabs[0];
        const profile = host.profiles.includes(this.current.profile) ? this.current.profile
            : host.profiles.includes(workspace.profile) ? workspace.profile : host.profiles[0] ?? '';
        this.set({ workspace, activeTabId: active?.id, profile });
        this.store();
        await this.attachActive(epoch);
    }

    private async attachActive(epoch: number): Promise<void> {
        if (epoch !== this.epoch || this.disposed) return;
        this.releaseView();
        const gen = this.viewGen;
        const workspace = this.current.workspace; const tab = this.activeTab();
        this.set({ lines: [], foreground: undefined, background: undefined, cursor: undefined, sequence: 0, history: undefined, scrollOffset: undefined, bell: undefined, bracketedPaste: undefined, find: undefined });
        if (!workspace || !tab) { this.set({ phase: 'idle', statusText: 'This workspace has no tabs. Start a shell from the console strip.' }); return; }
        if (tab.state === 'interrupted' || tab.state === 'exited') { this.set({ phase: 'interrupted', statusText: describeTab(tab) }); return; }
        this.set({ phase: 'attaching', statusText: `Connecting the monitor to ${tab.name}…` });
        let viewId: string;
        try { ({ viewId } = await this.service.attach({ workspaceId: workspace.id, tabId: tab.id, cols: MONITOR_COLS, rows: MONITOR_ROWS })); } catch (error) {
            if (epoch !== this.epoch || gen !== this.viewGen) return;
            this.set({ phase: 'reconnecting', error: `Could not attach to ${tab.name}: ${message(error)}`, statusText: 'Reconnecting…' });
            this.later(() => void this.attachActive(epoch), this.options.retryMs ?? RETRY_MS);
            return;
        }
        if (epoch !== this.epoch || gen !== this.viewGen || this.disposed) { this.service.detach(viewId).catch(() => undefined); return; }
        this.viewId = viewId;
        await this.pollOnce(epoch, gen);
    }

    private async pollOnce(epoch: number, gen: number): Promise<void> {
        const viewId = this.viewId;
        if (!viewId || this.pollInFlight === gen) return;
        this.pollInFlight = gen;
        let result: RuntimePoll;
        try { result = await this.service.poll({ viewId, afterSequence: this.current.sequence }); } catch (error) {
            if (this.pollInFlight === gen) this.pollInFlight = -1;
            if (epoch !== this.epoch || gen !== this.viewGen) return;
            this.set({ phase: 'reconnecting', error: `Connection lost: ${message(error)}`, statusText: 'Connection lost. Reconnecting…' });
            this.later(() => void this.pollOnce(epoch, gen), this.options.retryMs ?? RETRY_MS);
            return;
        }
        if (this.pollInFlight === gen) this.pollInFlight = -1;
        if (epoch !== this.epoch || gen !== this.viewGen || this.disposed) return;
        if (result.workspace) this.set({ workspace: result.workspace });
        const tab = this.activeTab();
        if (result.state === 'detached' || result.state === 'error') {
            this.viewId = undefined;
            const reason = result.detail ? ` (${result.detail})` : '';
            this.set(result.state === 'error'
                ? { phase: 'error', error: `Terminal view error${reason}.`, statusText: 'Reattaching the monitor…' }
                : { phase: 'reconnecting', statusText: `Monitor disconnected${reason}. Reattaching…` });
            this.later(() => void this.attachActive(epoch), this.options.retryMs ?? RETRY_MS);
            return;
        }
        const patch: Partial<RuntimeConsoleState> = result.state === 'connecting'
            ? { phase: 'attaching', statusText: result.detail || 'Connecting…' }
            : { phase: 'live', error: '', statusText: tab ? describeTab(tab) : 'Live' };
        const frame = result.frame;
        if (frame && frame.sequence > this.current.sequence) {
            Object.assign(patch, { sequence: frame.sequence, lines: frame.lines, foreground: frame.foreground, background: frame.background, cursor: frame.cursor, palette: frame.palette ?? this.current.palette });
            for (const key of ['history', 'scrollOffset', 'bell', 'bracketedPaste'] as const) if (frame[key] !== undefined) Object.assign(patch, { [key]: frame[key] });
        }
        this.set(patch);
        this.later(() => void this.pollOnce(epoch, gen), this.options.pollMs ?? POLL_MS);
    }

    async sendInput(data: string): Promise<void> {
        if (this.disposed || !data) return;
        const viewId = this.viewId;
        if (!viewId) { this.set({ error: 'The monitor is not connected to a terminal yet, so nothing was typed.' }); return; }
        try { await this.service.input({ viewId, data }); } catch (error) {
            if (viewId === this.viewId) this.set({ error: `Typing was not delivered: ${message(error)}` });
        }
    }

    async selectTab(tabId: string): Promise<void> {
        if (this.disposed || !this.current.workspace?.tabs.some(t => t.id === tabId)) return;
        if (tabId === this.current.activeTabId && this.viewId) return;
        this.set({ activeTabId: tabId, notice: '', error: '' });
        this.store();
        await this.attachActive(this.epoch);
    }

    /** Rename metadata only: keep the existing attached view and process. */
    async renameTab(tabId: string, name: string): Promise<boolean> {
        const workspace = this.current.workspace;
        if (this.disposed || this.current.acting || !workspace?.tabs.some(tab => tab.id === tabId)) return false;
        const cleaned = name.trim();
        if (!cleaned || cleaned.length > TAB_NAME_MAX || /[\u0000-\u001f\u007f]/.test(cleaned)) {
            this.set({ error: 'Use a tab name from 1 to 24 characters, without control characters.', notice: '' });
            return false;
        }
        const epoch = this.epoch;
        this.set({ acting: true, error: '', notice: '' });
        try {
            const next = await this.service.renameTab({ workspaceId: workspace.id, tabId, name: cleaned });
            if (epoch !== this.epoch || this.disposed) return false;
            if (next.id !== workspace.id || next.tabs.find(tab => tab.id === tabId)?.name !== cleaned) throw new Error('The runtime did not confirm the renamed tab.');
            this.set({ workspace: next, acting: false, notice: 'Tab renamed.' });
            return true;
        } catch (error) {
            if (epoch === this.epoch && !this.disposed) this.set({ acting: false, notice: '', error: `Could not rename the tab: ${message(error)}` });
            return false;
        }
    }

    setProfile(profile: string): void {
        if (this.current.host?.profiles.includes(profile)) this.set({ profile });
    }

    async requestNewTab(kind: AgentKind): Promise<void> {
        if (this.disposed || this.current.acting) return;
        if (!this.current.workspace) { this.set({ error: 'Click the terminal monitor first to open this room’s workspace.' }); return; }
        const option = this.launchers.find(o => o.kind === kind)!;
        if (!option.available) {
            this.set({ pending: undefined, notice: '', error: `${option.label} is not available: ${option.reason}${option.installHint ? ` Install: ${option.installHint}` : ''}` });
            return;
        }
        if (kind === 'shell') { await this.run({ type: 'new', kind, message: '', confirmLabel: '' }); return; }
        const profile = kind === 'hermes' ? ` with profile “${this.current.profile}”` : '';
        this.set({ error: '', notice: '', pending: { type: 'new', kind, confirmLabel: `Start ${option.label}`,
            message: `Start ${option.label}${profile} in a new tab? It runs on this computer under your own account and may use your plan or API credits. It keeps running when you walk away.` } });
    }
    requestClose(tabId: string): void {
        const tab = this.current.workspace?.tabs.find(t => t.id === tabId);
        if (!tab || this.current.acting) return;
        this.set({ error: '', notice: '', pending: { type: 'close', tabId, confirmLabel: 'Close tab',
            message: `Close “${tab.name}”? This ends what is running in it${tab.busy ? ', and it is working right now' : ''}.` } });
    }
    requestRevive(tabId: string): void {
        const tab = this.current.workspace?.tabs.find(t => t.id === tabId);
        if (!tab || this.current.acting) return;
        if (tab.kind !== 'shell') {
            const option = this.launchers.find(o => o.kind === tab.kind)!;
            if (!option.available) { this.set({ error: `${option.label} is not available: ${option.reason}${option.installHint ? ` Install: ${option.installHint}` : ''}` }); return; }
        }
        this.set({ error: '', notice: '', pending: { type: 'revive', tabId, confirmLabel: `Revive ${tab.name}`,
            message: `Start “${tab.name}” (${AGENT_LABELS[tab.kind]}) again? Commands that were running are not re-run.` } });
    }
    cancelPending(): void { this.set({ pending: undefined }); }
    async confirmPending(): Promise<void> {
        const pending = this.current.pending;
        if (!pending || this.current.acting) return;
        if (EXTRA_ACTIONS.includes(pending.type)) await this.runExtra(pending);
        else await this.run(pending);
    }

    private async run(action: PendingAction): Promise<void> {
        const workspace = this.current.workspace;
        if (!workspace) return;
        const epoch = this.epoch;
        const before = new Set(workspace.tabs.map(t => t.id));
        this.set({ pending: undefined, acting: true, error: '', notice: '' });
        try {
            let next: SessionWorkspace; let activate: string | undefined; let notice = '';
            if (action.type === 'new') {
                const kind = action.kind!;
                next = await this.service.newTab(kind === 'hermes'
                    ? { workspaceId: workspace.id, kind, profile: this.current.profile, confirmedStart: true }
                    : { workspaceId: workspace.id, kind, confirmedStart: true });
                activate = next.tabs.find(t => !before.has(t.id))?.id;
                notice = activate ? `${AGENT_LABELS[kind]} started in a new tab.` : '';
                if (!activate) throw new Error('The runtime did not report a new tab.');
            } else if (action.type === 'revive') {
                next = await this.service.reviveTab({ workspaceId: workspace.id, tabId: action.tabId!, confirmedStart: true });
                activate = action.tabId; notice = 'Tab revived.';
            } else {
                next = await this.service.closeTab({ workspaceId: workspace.id, tabId: action.tabId!, confirmedClose: true });
                notice = 'Tab closed.';
                if (action.tabId === this.current.activeTabId) activate = (next.tabs.find(t => t.state === 'running') ?? next.tabs[0])?.id ?? '';
            }
            if (epoch !== this.epoch) return;
            this.set({ workspace: next, acting: false, notice });
            if (activate !== undefined) {
                this.set({ activeTabId: activate || undefined });
                this.store();
                await this.attachActive(epoch);
            }
        } catch (error) {
            if (epoch !== this.epoch) return;
            this.set({ acting: false, notice: '', error: `${action.type === 'new' ? 'Could not start the tab' : action.type === 'revive' ? 'Could not revive the tab' : 'Could not close the tab'}: ${message(error)}` });
        }
    }

    // ------------------------------------------------------------ advanced parity
    private modes(m: ViewModes): Partial<RuntimeConsoleState> { return { history: m.history, scrollOffset: m.scrollOffset, bracketedPaste: m.bracketedPaste }; }
    private needView(what: string): string | undefined {
        if (!this.viewId) this.set({ error: `The monitor is not connected to a terminal, so ${what} was not done.`, notice: '' });
        return this.viewId;
    }

    /** Read-only workspace board from live metadata. */
    async refreshBoard(): Promise<void> {
        if (this.disposed) return;
        const epoch = this.epoch;
        try {
            const board = await this.service.listWorkspaces();
            if (epoch === this.epoch) this.set({ board });
        } catch (error) { if (epoch === this.epoch) this.set({ error: `Could not list workspaces: ${message(error)}` }); }
    }

    async renameWorkspace(workspaceId: string, name: string): Promise<boolean> {
        if (this.disposed || this.current.acting) return false;
        const cleaned = name.trim();
        if (!cleaned || cleaned.length > WORKSPACE_NAME_MAX || CONTROL.test(cleaned)) {
            this.set({ error: `Use a workspace name from 1 to ${WORKSPACE_NAME_MAX} characters, without control characters.`, notice: '' });
            return false;
        }
        const epoch = this.epoch;
        this.set({ acting: true, error: '', notice: '' });
        try {
            const next = await this.service.renameWorkspace({ workspaceId, name: cleaned });
            if (epoch !== this.epoch) return false;
            if (next.name !== cleaned) throw new Error('The runtime did not confirm the new name.');
            this.set({ acting: false, notice: 'Workspace renamed.', ...(this.current.workspace?.id === workspaceId ? { workspace: next } : {}) });
            if (this.current.board) await this.refreshBoard();
            return true;
        } catch (error) {
            if (epoch === this.epoch) this.set({ acting: false, error: `Could not rename the workspace: ${message(error)}` });
            return false;
        }
    }

    requestDeleteWorkspace(workspaceId: string): void {
        if (this.current.acting) return;
        const name = this.current.board?.find(w => w.id === workspaceId)?.name ?? (this.current.workspace?.id === workspaceId ? this.current.workspace.name : 'this workspace');
        this.set({ error: '', notice: '', pending: { type: 'deleteWorkspace', workspaceId, confirmLabel: 'Delete workspace',
            message: `Delete “${name}”? This ends every tab in it and cannot be undone. Stations bound to it are unbound.` } });
    }

    /** Point this station at an existing workspace of the same project. Starts nothing. */
    async bindToWorkspace(workspaceId: string): Promise<void> {
        const binding = this.binding;
        if (this.disposed || this.current.acting || !binding) return;
        const epoch = this.epoch;
        this.set({ acting: true, error: '', notice: '' });
        try {
            await this.service.bindStation({ stationId: binding.stationId, projectUri: binding.projectUri, workspaceId });
        } catch (error) {
            if (epoch === this.epoch) this.set({ acting: false, error: `Could not bind this station: ${message(error)}` });
            return;
        }
        if (epoch !== this.epoch) return;
        this.set({ acting: false });
        await this.open(binding, undefined);
        if (this.current.workspace?.id === workspaceId) this.set({ notice: 'This station now shows that workspace.' });
    }

    /** Default Hermes profile for tabs started from now on. Running tabs keep their process. */
    async setWorkspaceProfile(profile: string): Promise<void> {
        const ws = this.current.workspace;
        if (this.disposed || this.current.acting || !ws) return;
        if (!this.current.host?.profiles.includes(profile)) { this.set({ error: `No Hermes profile named “${profile}”.` }); return; }
        const epoch = this.epoch;
        try {
            const next = await this.service.setWorkspaceProfile({ workspaceId: ws.id, profile });
            if (epoch === this.epoch) this.set({ workspace: next, error: '', notice: `Saved. New tabs use the “${next.profile}” profile; running tabs keep theirs.` });
        } catch (error) { if (epoch === this.epoch) this.set({ error: `Could not set the profile: ${message(error)}` }); }
    }

    /** Metadata only: this runtime has no auto-sleep, so nothing is started or stopped. */
    async setKeepAwake(on: boolean): Promise<void> {
        const ws = this.current.workspace;
        if (this.disposed || this.current.acting || !ws) return;
        const epoch = this.epoch;
        try {
            const next = await this.service.setKeepAwake({ workspaceId: ws.id, on });
            if (epoch === this.epoch) this.set({ workspace: next, error: '', notice: `Keep awake ${next.keepAwake ? 'on' : 'off'}. Auto-sleep is off in this runtime, so nothing changes now.` });
        } catch (error) { if (epoch === this.epoch) this.set({ error: `Could not save keep awake: ${message(error)}` }); }
    }

    /** Explicit, confirmed restart of an agent in its own idle shell. */
    requestResume(tabId: string): void {
        const tab = this.current.workspace?.tabs.find(t => t.id === tabId);
        if (!tab || this.current.acting) return;
        if (tab.kind === 'shell') { this.set({ pending: undefined, notice: '', error: 'A shell tab has no agent to resume.' }); return; }
        if (tab.state !== 'running' && tab.state !== 'sleeping') { this.set({ pending: undefined, notice: '', error: `${tab.name} is not running. Revive it first.` }); return; }
        if (tab.busy) { this.set({ pending: undefined, notice: '', error: `${tab.name} is working right now. Finish or interrupt it first.` }); return; }
        const option = this.launchers.find(o => o.kind === tab.kind)!;
        if (!option.available) { this.set({ pending: undefined, error: `${option.label} is not available: ${option.reason}` }); return; }
        this.set({ error: '', notice: '', pending: { type: 'resume', tabId, confirmLabel: `Start ${option.label}`,
            message: `Start ${option.label} again in “${tab.name}”? ${RESUME_NOTE[tab.kind]} It runs under your own account and may use your plan or API credits.` } });
    }

    requestClearHistory(): void {
        if (this.current.acting || !this.needView('clearing scrollback')) return;
        this.set({ error: '', notice: '', pending: { type: 'clearHistory', confirmLabel: 'Clear scrollback',
            message: 'Clear this tab’s scrollback? Earlier output can no longer be scrolled to or found. What is on screen stays.' } });
    }

    private async runExtra(action: PendingAction): Promise<void> {
        const epoch = this.epoch;
        this.set({ pending: undefined, acting: true, error: '', notice: '' });
        try {
            if (action.type === 'resume') {
                const ws = this.current.workspace!;
                const r = await this.service.resumeAgent({ workspaceId: ws.id, tabId: action.tabId!, confirmedStart: true });
                if (epoch === this.epoch) this.set({ acting: false, workspace: r.workspace, notice: r.detail });
            } else if (action.type === 'clearHistory') {
                const viewId = this.viewId;
                if (!viewId) throw new Error('the monitor is not connected');
                const m = await this.service.clearHistory({ viewId, confirmedClear: true });
                if (epoch === this.epoch) this.set({ acting: false, ...this.modes(m), find: undefined, notice: 'Scrollback cleared.' });
            } else {
                const workspaceId = action.workspaceId!;
                let result: { deleted: boolean; detail: string };
                try {
                    result = await this.service.deleteWorkspace({ workspaceId, confirmedDelete: true, confirmedBusy: action.type === 'deleteWorkspaceBusy' });
                } catch (error) {
                    if (epoch === this.epoch && action.type === 'deleteWorkspace' && /still has work running/.test(message(error))) {
                        this.set({ acting: false, pending: { type: 'deleteWorkspaceBusy', workspaceId, confirmLabel: 'Delete anyway', message: message(error) } });
                        return;
                    }
                    throw error;
                }
                if (epoch !== this.epoch) return;
                if (this.current.workspace?.id === workspaceId) {
                    this.epoch++; this.releaseView();
                    if (this.binding) { try { this.options.storage?.setItem(bindingKey(this.binding), ''); } catch { /* optional */ } }
                    this.current = { ...RuntimeConsoleController.initial(), host: this.current.host, board: this.current.board };
                }
                this.set({ acting: false, notice: result.detail || 'Workspace deleted.' });
                await this.refreshBoard();
            }
        } catch (error) {
            if (epoch === this.epoch) this.set({ acting: false, error: `${action.type === 'resume' ? 'Could not resume the agent' : action.type === 'clearHistory' ? 'Could not clear scrollback' : 'Could not delete the workspace'}: ${message(error)}` });
        }
    }

    /** Move through tmux history (positive = older). */
    async scroll(lines: number): Promise<void> {
        const viewId = this.needView('scrolling');
        if (!viewId || !Number.isFinite(lines) || !lines) return;
        try { const m = await this.service.scroll({ viewId, lines: Math.round(lines) }); if (viewId === this.viewId) this.set(this.modes(m)); } catch (error) { if (viewId === this.viewId) this.set({ error: `Could not scroll: ${message(error)}` }); }
    }
    /** Mouse wheel over the monitor (positive = up); x/y are the cell under the pointer. */
    async wheel(notches: number, x = 0, y = 0): Promise<void> {
        const viewId = this.viewId;
        if (!viewId || !Number.isFinite(notches) || !notches) return;
        try { const m = await this.service.wheel({ viewId, notches: Math.round(notches), x, y }); if (viewId === this.viewId) this.set(this.modes(m)); } catch (error) { if (viewId === this.viewId) this.set({ error: `Could not scroll: ${message(error)}` }); }
    }
    /** Find across the whole history. step: 0 = newest/same, 1 = older, -1 = newer. Empty query clears. */
    async find(query: string, step = 0): Promise<void> {
        const viewId = this.needView('find');
        if (!viewId) return;
        try {
            const r = await this.service.find({ viewId, query: query.slice(0, 200), step: Math.sign(step) });
            if (viewId === this.viewId) this.set({ find: r.query ? r : undefined, error: '', notice: r.query && !r.count ? `“${r.query}” was not found.` : '' });
        } catch (error) { if (viewId === this.viewId) this.set({ error: `Find failed: ${message(error)}` }); }
    }
    /** The selected text, returned to the caller. This class never touches a clipboard. */
    async copySelection(range: CopyRange): Promise<string> {
        const viewId = this.needView('copying');
        if (!viewId) return '';
        try {
            const r = await this.service.copyText({ viewId, x1: range.x1, y1: range.y1, x2: range.x2, y2: range.y2, unit: range.unit ?? 'char' });
            if (!r.text) this.set({ notice: 'Nothing selected.' });
            return r.text;
        } catch (error) { if (viewId === this.viewId) this.set({ error: `Could not copy: ${message(error)}` }); return ''; }
    }
    /** Every row on the monitor now. */
    copyScreen(): Promise<string> {
        return this.copySelection({ x1: 0, y1: 0, x2: MONITOR_COLS - 1, y2: Math.max(0, (this.current.lines.length || MONITOR_ROWS) - 1) });
    }
    /**
     * Safe paste of text the browser already holds (never read from a device clipboard here).
     * Multi-line text needs bracketed paste from the app, so nothing runs before Enter.
     */
    async paste(text: string): Promise<boolean> {
        if (this.disposed || typeof text !== 'string' || !text) return false;
        if (utf8Bytes(text) > PASTE_LIMIT_BYTES) { this.set({ error: `That paste is too large: the limit is ${PASTE_LIMIT_BYTES / 1024} KiB.`, notice: '' }); return false; }
        const multiLine = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').includes('\n');
        if (multiLine && this.current.bracketedPaste !== true) {
            this.set({ error: 'This program has not turned on bracketed paste, so multi-line text could run line by line. Paste one line at a time.', notice: '' });
            return false;
        }
        const viewId = this.needView('pasting');
        if (!viewId) return false;
        try {
            await this.service.paste({ viewId, text });
            if (viewId === this.viewId) this.set({ error: '', notice: multiLine ? 'Pasted as one block. Press Enter to run it.' : '' });
            return true;
        } catch (error) { if (viewId === this.viewId) this.set({ error: `Paste was not delivered: ${message(error)}` }); return false; }
    }

    /** Project closed: detach the monitor view and forget the binding. The tabs keep running. */
    release(): void {
        if (this.disposed) return;
        this.epoch++; this.releaseView(); this.binding = undefined;
        this.current = { ...RuntimeConsoleController.initial(), host: this.current.host };
        this.set({});
    }

    /** View disposal: detach only. Tabs and their processes keep running. */
    dispose(): void {
        if (this.disposed) return;
        this.epoch++;
        this.releaseView();
        this.disposed = true;
    }
}
