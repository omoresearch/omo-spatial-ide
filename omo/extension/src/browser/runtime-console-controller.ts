import type { AgentKind, FindResult, HostStatus, OmoRuntimeService, RuntimeFrame, RuntimePoll, SessionTab, SessionWorkspace, ViewModes, WorkspaceSummary } from '../common/runtime-protocol';
import type { AgentTaskTarget } from './agent-task-draft';
import type { StationRecipe } from './station-recipe';
export type { AgentTaskTarget } from './agent-task-draft';

/**
 * Frontend state machine for the in-world terminal monitor. It owns the
 * workspace binding, the attached view, the bounded poll loop and every
 * explicit user action. It never starts, revives or closes a tab on its own.
 * Pure TypeScript (no Theia/DOM imports) so it can be tested against a fake service.
 */
export const MONITOR_COLS = 80;
export const MONITOR_ROWS = 22;
/**
 * Grid limits for a view that follows its box (attached / full-window terminal). Narrow boxes keep
 * a sane minimum (they scroll); the top matches the host's own clamp (op_resize / termcore).
 */
export const GRID_MIN_COLS = 40;
export const GRID_MIN_ROWS = 10;
export const GRID_MAX_COLS = 400;
export const GRID_MAX_ROWS = 200;
export function clampGrid(cols: number, rows: number): { cols: number; rows: number } {
    const fit = (n: number, min: number, max: number, fallback: number): number => Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
    return { cols: fit(cols, GRID_MIN_COLS, GRID_MAX_COLS, MONITOR_COLS), rows: fit(rows, GRID_MIN_ROWS, GRID_MAX_ROWS, MONITOR_ROWS) };
}
export const TAB_NAME_MAX = 24;
export const POLL_MS = 200;
export const RETRY_MS = 1500;
/** Idle interval for the pane clipboard-write check (it is also checked on every new frame). */
const CLIPBOARD_CHECK_MS = 1000;
export const AGENT_KINDS: AgentKind[] = ['shell', 'hermes', 'claude', 'codex', 'dsh']; // w2:agents
export const AGENT_LABELS: Record<AgentKind, string> = { shell: 'Shell', hermes: 'Hermes', claude: 'Claude Code', codex: 'Codex', dsh: 'dsh' }; // w2:agents
export const WORKSPACE_NAME_MAX = 40;
/** w2:agents: what a dsh start confirmation adds. */
export const DSH_START_NOTE = 'dsh has no terminal screen of its own: this tab runs “dsh web” on a private loopback port, and you open it on the web wall. It uses the model account set up in dsh and may use API credits. Needs Node 24.9 or newer.';
/** Same limit the bridge enforces; checked here too so a refused paste never leaves the browser. */
export const PASTE_LIMIT_BYTES = 256 * 1024;
export interface CopyRange { x1: number; y1: number; x2: number; y2: number; unit?: 'char' | 'word' | 'line' }

export interface StationBinding { stationId: string; projectUri: string; name: string }
export type RuntimePhase = 'idle' | 'checking' | 'unavailable' | 'opening' | 'attaching' | 'live' | 'reconnecting' | 'interrupted' | 'error';
export interface PendingAction { type: 'new' | 'close' | 'revive' | 'deleteWorkspace' | 'deleteWorkspaceBusy' | 'resume' | 'clearHistory' | 'recipe'; kind?: AgentKind; tabId?: string; workspaceId?: string; recipe?: StationRecipe; message: string; confirmLabel: string;
    /** w2:runtime — the station's own StationConfig tabs (world setup). Allowed on a locked station; still needs the one confirmation. */
    setup?: boolean }
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
    cells?: RuntimeFrame['cells'];
    foreground?: string[];
    background?: string[];
    truecolor?: RuntimeFrame['truecolor'];
    palette?: Record<string, string>;
    cursor?: RuntimeFrame['cursor'];
    /** Grid size of the latest frame (80 x 22 on the desk monitor; larger when a focus view follows its box). */
    cols?: number;
    rows?: number;
    sequence: number;
    pending?: PendingAction;
    acting: boolean;
    /** From the latest frame, when the runtime reports them. */
    history?: number;
    scrollOffset?: number;
    bell?: number;
    /** Bells actually received by this desk's attached views, not an inferred task state. */
    unreadBells: number;
    bracketedPaste?: boolean;
    pendingClipboard?: { text: string; chars: number };
    /** Workspace board (read-only list from live metadata), loaded on request. */
    board?: WorkspaceSummary[];
    find?: FindResult;
    /** Station Lock: this desk refuses tab close and recipe changes (client flag, see station-recipe.ts). */
    stationLocked?: boolean;
}
export interface LauncherOption { kind: AgentKind; label: string; available: boolean; reason: string; installHint?: string }
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface RuntimeConsoleOptions {
    service: OmoRuntimeService;
    storage?: StorageLike;
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
    onChange: (state: RuntimeConsoleState) => void;
    onMirrorFrame?: (frame: RuntimeFrame | undefined) => void;
    onMirrorError?: (message: string) => void;
    /** w2:runtime — StationConfig.profile from the world. Used when this browser has no profile choice yet; must exist on the host. */
    preferredProfile?: () => string | undefined;
    pollMs?: number;
    retryMs?: number;
    /** w3:perf — live poll interval for this desk (desk-activity budget). Read before every poll; falls back to pollMs. */
    pollInterval?: () => number;
    /** w3:perf — clock for the poll budget (tests). */
    now?: () => number;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const EXTRA_ACTIONS: PendingAction['type'][] = ['deleteWorkspace', 'deleteWorkspaceBusy', 'resume', 'clearHistory'];
const CONTROL = /[\u0000-\u001f\u007f]/;
const TASK_DRAFT_LIMIT_BYTES = 32 * 1024;
const TASK_UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const RESUME_NOTE: Record<AgentKind, string> = {
    shell: '', hermes: 'It resumes this tab’s own Hermes conversation.',
    claude: 'Claude Code resumes this tab’s saved session when there is one.',
    codex: 'Codex starts a fresh session: an earlier Codex conversation is not resumed.',
    dsh: 'dsh has no terminal session to resume. Revive the tab to start dsh web again.' // w2:agents
};
function utf8Bytes(text: string): number {
    let n = 0;
    for (const ch of text) { const c = ch.codePointAt(0)!; n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
    return n;
}
function wellFormed(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (i + 1 >= text.length || next < 0xdc00 || next > 0xdfff) return false;
            i++;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
}
function validTaskText(text: unknown): text is string {
    return typeof text === 'string' && text.length > 0 && text.trim().length > 0 && wellFormed(text)
        && !TASK_UNSAFE_CONTROL.test(text) && utf8Bytes(text) <= TASK_DRAFT_LIMIT_BYTES;
}
function sameTaskTarget(a: AgentTaskTarget | undefined, b: AgentTaskTarget | undefined): boolean {
    return !!a && !!b && a.projectUri === b.projectUri && a.stationId === b.stationId
        && a.workspaceId === b.workspaceId && a.tabId === b.tabId && a.viewId === b.viewId;
}
const ACTIVE_PHASES: RuntimePhase[] = ['checking', 'opening', 'attaching', 'live', 'reconnecting', 'interrupted'];

export function bindingKey(binding: Pick<StationBinding, 'stationId' | 'projectUri'>): string {
    return `omo.runtime.v1:${binding.projectUri}#${binding.stationId}`;
}

/** '+' remembers the last tab kind opened on this device (only the kind; never starts anything). */
export const LAST_TAB_KIND_KEY = 'omo.runtime.last-tab-kind.v1';
export function readLastTabKind(): AgentKind | undefined {
    try { const value = globalThis.localStorage?.getItem(LAST_TAB_KIND_KEY); return AGENT_KINDS.includes(value as AgentKind) ? value as AgentKind : undefined; } catch { return undefined; }
}
export function rememberLastTabKind(kind: AgentKind): void {
    try { globalThis.localStorage?.setItem(LAST_TAB_KIND_KEY, kind); } catch { /* storage unavailable: nothing remembered */ }
}
/** Launchers with the last-used kind first (the rest keep their order). */
export function launchersLastFirst(options: LauncherOption[], last = readLastTabKind()): LauncherOption[] {
    const index = last ? options.findIndex(o => o.kind === last) : -1;
    return index <= 0 ? options : [options[index], ...options.slice(0, index), ...options.slice(index + 1)];
}

export function launcherOptions(host: HostStatus | undefined): LauncherOption[] {
    // w2:agents: dsh is optional: offered only when this computer reports it installed.
    return AGENT_KINDS.filter(kind => kind !== 'dsh' || !!host?.agents.some(a => a.kind === 'dsh')).map(kind => {
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

export interface CellRun { x: number; text: string; fg: string; bg: string; columns?: number; glyphColumns?: number }
/** Split one monitor row into runs of equal colour. fg/bg hold one palette key per cell. */
export function cellRuns(line: string, fg: string | undefined, bg: string | undefined, palette: Record<string, string> | undefined, defaults: { fg: string; bg: string }, grid?: readonly string[], direct?: { fg?: readonly string[]; bg?: readonly string[] }, maxCols = MONITOR_COLS): CellRun[] {
    const cells = grid ? grid.slice(0,maxCols) : Array.from(line);
    const colour = (codes: string | undefined, i: number, fallback: string, exact: readonly string[] | undefined): string => {
        const exactValue = exact?.[i];
        if (typeof exactValue === 'string' && /^#[0-9a-fA-F]{6}$/.test(exactValue)) return exactValue;
        const key = codes?.[i];
        const value = key !== undefined ? palette?.[key] : undefined;
        if (!value || !/^(?:#[0-9a-fA-F]{6}|[0-9a-fA-F]{6})$/.test(value)) return fallback;
        return value.startsWith('#') ? value : `#${value}`;
    };
    const runs: CellRun[] = [];
    cells.forEach((ch, i) => {
        const f = colour(fg, i, defaults.fg, direct?.fg); const b = colour(bg, i, defaults.bg, direct?.bg);
        if (grid) {
            let glyphColumns = 1;
            while (i+glyphColumns < cells.length && cells[i+glyphColumns] === '') glyphColumns++;
            runs.push({x:i,text:ch,fg:f,bg:b,columns:1,glyphColumns}); return;
        }
        const last = runs[runs.length - 1];
        if (last && last.fg === f && last.bg === b) last.text += ch;
        else runs.push({ x: i, text: ch, fg: f, bg: b });
    });
    return runs;
}

function validTruecolor(value: unknown, rows: number, cols: number): RuntimeFrame['truecolor'] | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 1 || cols < 1) return undefined;
    const candidate = value as { foreground?: unknown; background?: unknown };
    if (!Array.isArray(candidate.foreground) || !Array.isArray(candidate.background)
        || candidate.foreground.length !== rows || candidate.background.length !== rows) return undefined;
    const safeRows = (input: unknown): input is string[][] => Array.isArray(input) && input.length === rows
        && input.every(row => Array.isArray(row) && row.length === cols && row.every(color => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)));
    if (!safeRows(candidate.foreground) || !safeRows(candidate.background)) return undefined;
    return {
        foreground: candidate.foreground.map(row => row.slice()),
        background: candidate.background.map(row => row.slice())
    };
}

function validClipboardNotification(value: unknown, viewId: string): { text: string; chars: number } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as { viewId?: unknown; text?: unknown; chars?: unknown; userGestureRequired?: unknown; writeOnly?: unknown };
    if (candidate.viewId !== viewId || candidate.userGestureRequired !== true || candidate.writeOnly !== true
        || typeof candidate.text !== 'string' || !candidate.text || candidate.text.length > 65536
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.text)) return undefined;
    const chars = typeof candidate.chars === 'number' && Number.isSafeInteger(candidate.chars)
        ? candidate.chars : candidate.text.length;
    if (chars < 0 || chars > 65536) return undefined;
    return { text: candidate.text, chars };
}

function describeTab(tab: SessionTab): string {
    if (tab.state === 'interrupted') return `${tab.name} was interrupted${tab.detail ? ` (${tab.detail})` : ''}. Revive it from the console strip when you are ready.`;
    if (tab.state === 'exited') return `${tab.name} has exited${tab.detail ? ` (${tab.detail})` : ''}.`;
    if (tab.state === 'sleeping') return `${tab.name} is asleep. It resumes when shown.`;
    return `Live · ${tab.name}${tab.busy ? ' · Process active' : ''}`;
}

export class RuntimeConsoleController {
    private readonly service: OmoRuntimeService;
    private readonly options: RuntimeConsoleOptions;
    private binding?: StationBinding;
    private viewId?: string;
    private mirrorViewId?: string;
    private mirrorTimer: unknown;
    private mirrorSequence = 0;
    private mirrorStationId?: string;
    private mirrorAttachInFlight?: Promise<boolean>;
    private mirrorAttachEpoch = -1;
    private mirrorAttachGen = -1;
    private mirrorAttachGeneration = -1;
    private mirrorGeneration = 0;
    private epoch = 0;
    private viewGen = 0;
    private pollInFlight = -1;
    private clipboardCheckedAt = 0;
    /** Grid the attached view should have. The desk monitor is 80 x 22; a focus view may ask for its box size. */
    private size = { cols: MONITOR_COLS, rows: MONITOR_ROWS };
    /** Last size the current view really has (attach or a confirmed resize). */
    private sentSize?: { viewId: string; cols: number; rows: number };
    private resizing: Promise<void> = Promise.resolve();
    private timer: unknown;
    /** w3:perf — the pending timer is the next live poll: when it was planned and with which interval. */
    private pollWait?: { epoch: number; gen: number; at: number; ms: number };
    private disposed = false;
    private current: RuntimeConsoleState = RuntimeConsoleController.initial();

    constructor(options: RuntimeConsoleOptions) { this.options = options; this.service = options.service; }

    static initial(): RuntimeConsoleState {
        return { phase: 'idle', statusText: 'Walk up and click this screen.', notice: '', error: '', profile: '', lines: [], sequence: 0, acting: false, unreadBells: 0 };
    }
    get state(): RuntimeConsoleState { return this.current; }
    get launchers(): LauncherOption[] { return launcherOptions(this.current.host); }

    /**
     * Apply a state patch and notify. A non-empty patch that changes nothing is dropped, so an idle
     * poll does not re-render the widget. An empty patch is an explicit "notify anyway".
     */
    private set(patch: Partial<RuntimeConsoleState>): void {
        if (this.disposed) return;
        const keys = Object.keys(patch) as Array<keyof RuntimeConsoleState>;
        if (keys.length && keys.every(key => Object.is(this.current[key], patch[key]))) return;
        this.current = { ...this.current, ...patch };
        this.options.onChange(this.current);
    }
    /** Keep the old workspace object when the polled one has the same content (each poll returns a new copy). */
    private sameWorkspace(next: SessionWorkspace): SessionWorkspace {
        const old = this.current.workspace;
        if (!old) return next;
        try { return JSON.stringify(old) === JSON.stringify(next) ? old : next; } catch { return next; }
    }
    private activeTab(): SessionTab | undefined { return this.current.workspace?.tabs.find(t => t.id === this.current.activeTabId); }

    /** Return the exact live destination snapshot, never a redirect to another tab. */
    taskTarget(): AgentTaskTarget | undefined {
        const binding = this.binding;
        const workspace = this.current.workspace;
        const tab = this.activeTab();
        if (this.disposed || this.current.phase !== 'live' || this.current.acting || this.current.pending
            || !this.viewId || !binding || !workspace || workspace.state !== 'running'
            || workspace.projectUri !== binding.projectUri || !tab || tab.kind === 'shell'
            || tab.state !== 'running') return undefined;
        return {
            projectUri: binding.projectUri,
            stationId: binding.stationId,
            workspaceId: workspace.id,
            tabId: tab.id,
            viewId: this.viewId,
        };
    }

    /** Prepare task text with semantic paste only. It never submits or starts anything. */
    async prepareTask(target: AgentTaskTarget, text: string): Promise<boolean> {
        if (!validTaskText(text)) {
            this.set({ notice: '', error: `Task text must be non-empty, valid Unicode, free of terminal controls, and at most ${TASK_DRAFT_LIMIT_BYTES / 1024} KiB.` });
            return false;
        }
        const requested = target && typeof target === 'object' ? { ...target } : undefined;
        const current = this.taskTarget();
        if (!sameTaskTarget(current, requested)) {
            this.set({ notice: '', error: 'The selected agent tab changed, so this task was not pasted.' });
            return false;
        }
        const viewId = current!.viewId;
        if (!await this.paste(text)) return false;
        if (!sameTaskTarget(this.taskTarget(), requested) || viewId !== this.viewId) return false;
        this.set({ error: '', notice: 'Task text pasted without Enter. It remains a draft.' });
        return true;
    }

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

    private clearTimer(): void { this.pollWait = undefined; if (this.timer !== undefined) { this.options.cancel(this.timer); this.timer = undefined; } }
    private later(fn: () => void, ms: number): void {
        this.clearTimer();
        const epoch = this.epoch; const gen = this.viewGen;
        this.timer = this.options.schedule(() => { this.timer = undefined; this.pollWait = undefined; if (epoch === this.epoch && gen === this.viewGen && !this.disposed) fn(); }, ms);
    }
    // ---- w3:perf — poll budget: far desks poll slowly, the active desk at POLL_MS. Input never waits for a poll. ----
    private pollInterval(): number {
        const ms = this.options.pollInterval?.();
        return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : this.options.pollMs ?? POLL_MS;
    }
    private nowMs(): number { return this.options.now?.() ?? Date.now(); }
    private schedulePoll(epoch: number, gen: number, delay: number, at = this.nowMs(), ms = delay): void {
        this.later(() => void this.pollOnce(epoch, gen), delay);
        this.pollWait = { epoch, gen, at, ms };
    }
    /**
     * The desk's budget changed. A faster budget pulls the pending poll forward (a desk you turn to
     * refreshes at once); a slower one applies from the next poll, so nothing already due is delayed.
     */
    pollIntervalChanged(): void {
        const wait = this.pollWait;
        if (this.disposed || !wait || this.timer === undefined || wait.epoch !== this.epoch || wait.gen !== this.viewGen) return;
        const ms = this.pollInterval();
        if (ms >= wait.ms) return;
        this.schedulePoll(wait.epoch, wait.gen, Math.max(0, wait.at + ms - this.nowMs()), wait.at, ms);
    }
    private clearMirrorTimer(): void { if (this.mirrorTimer !== undefined) { this.options.cancel(this.mirrorTimer); this.mirrorTimer = undefined; } }
    private releaseMirror(notify = true): void {
        this.mirrorGeneration++;
        this.clearMirrorTimer();
        const viewId = this.mirrorViewId; this.mirrorViewId = undefined; this.mirrorStationId = undefined; this.mirrorSequence = 0;
        if (notify) this.options.onMirrorFrame?.(undefined);
        if (viewId) this.service.detach(viewId).catch(() => undefined);
    }
    /** Attach a second physical view to this desk's station. It never opens a workspace or tab. */
    async attachMirror(stationId = this.binding?.stationId, cols = 120, rows = 40): Promise<boolean> {
        const workspace = this.current.workspace;
        const tab = this.activeTab();
        if (this.disposed || !stationId || !workspace || !tab || !this.viewId || this.current.phase !== 'live') {
            this.options.onMirrorError?.('Open a live desk before attaching its mirror.');
            return false;
        }
        if (this.mirrorAttachInFlight && this.mirrorAttachEpoch === this.epoch && this.mirrorAttachGen === this.viewGen
            && this.mirrorAttachGeneration === this.mirrorGeneration) return this.mirrorAttachInFlight;
        const epoch = this.epoch;
        const gen = this.viewGen;
        let attachGeneration = this.mirrorGeneration;
        const operation = (async (): Promise<boolean> => {
            this.clearMirrorTimer();
            if (this.mirrorViewId) this.releaseMirror(false);
            attachGeneration = this.mirrorGeneration;
            try {
                const attach = this.service.attach.bind(this.service) as unknown as (input: { workspaceId: string; tabId: string; cols: number; rows: number; stationId?: string }) => Promise<{ viewId: string }>;
                const result = await attach({ workspaceId: workspace.id, tabId: tab.id, cols: Math.max(20, Math.min(240, Math.floor(cols))), rows: Math.max(5, Math.min(80, Math.floor(rows))), stationId });
                if (this.disposed || epoch !== this.epoch || gen !== this.viewGen || attachGeneration !== this.mirrorGeneration || !this.viewId
                    || this.current.workspace?.id !== workspace.id || this.current.activeTabId !== tab.id) {
                    await this.service.detach(result.viewId).catch(() => undefined); return false;
                }
                this.mirrorViewId = result.viewId; this.mirrorStationId = stationId; this.mirrorSequence = 0;
                void this.pollMirror(epoch, result.viewId);
                return true;
            } catch (error) {
                if (!this.disposed && epoch === this.epoch && gen === this.viewGen && attachGeneration === this.mirrorGeneration) {
                    this.options.onMirrorError?.(`Could not attach the mirror: ${message(error)}`);
                    this.options.onMirrorFrame?.(undefined);
                }
                return false;
            }
        })();
        this.mirrorAttachEpoch = epoch;
        this.mirrorAttachGen = gen;
        this.mirrorAttachGeneration = attachGeneration;
        this.mirrorAttachInFlight = operation;
        try { return await operation; }
        finally { if (this.mirrorAttachInFlight === operation) this.mirrorAttachInFlight = undefined; }
    }
    detachMirror(): void { this.releaseMirror(); }
    private async pollMirror(epoch: number, viewId: string): Promise<void> {
        if (this.disposed || epoch !== this.epoch || this.mirrorViewId !== viewId) return;
        try {
            const result = await this.service.poll({ viewId, afterSequence: this.mirrorSequence });
            if (this.disposed || epoch !== this.epoch || this.mirrorViewId !== viewId) return;
            if (result.state === 'error' || result.state === 'detached') {
                this.options.onMirrorError?.(`Mirror disconnected${result.detail ? ` (${result.detail})` : ''}.`); this.releaseMirror(); return;
            }
            if (result.frame && result.frame.sequence > this.mirrorSequence) {
                this.mirrorSequence = result.frame.sequence; this.options.onMirrorFrame?.(result.frame);
            }
            this.mirrorTimer = this.options.schedule(() => { this.mirrorTimer = undefined; void this.pollMirror(epoch, viewId); }, this.options.pollMs ?? POLL_MS);
        } catch (error) {
            if (this.mirrorViewId === viewId) this.options.onMirrorError?.(`Mirror polling failed: ${message(error)}`);
        }
    }
    /** Detach the current monitor view. Never closes the tab or its processes. */
    private releaseView(): void {
        this.releaseMirror();
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
            this.current = { ...RuntimeConsoleController.initial(), stationLocked: this.current.stationLocked, host: this.current.host };
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
        this.current = { ...RuntimeConsoleController.initial(), stationLocked: this.current.stationLocked, host: this.current.host, profile: this.current.profile };
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
        const preferred = this.options.preferredProfile?.(); // w2:runtime
        const createProfile = !this.current.profile && preferred && host.profiles.includes(preferred) ? preferred : undefined;
        try { workspace = await this.service.openWorkspace({ stationId: binding.stationId, projectUri: binding.projectUri, name: binding.name, ...(createProfile ? { profile: createProfile } : {}) }); } catch (error) {
            if (epoch !== this.epoch) return;
            this.set({ phase: 'error', error: `Could not open the terminal workspace: ${message(error)}`, statusText: 'Not connected. Click the monitor to try again.' });
            return;
        }
        if (epoch !== this.epoch) return;
        const tabs = workspace.tabs;
        const active = tabs.find(t => t.id === preferredTab) ?? tabs.find(t => t.state === 'running') ?? tabs[0];
        const profile = host.profiles.includes(this.current.profile) ? this.current.profile
            : createProfile ? createProfile // w2:runtime
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
        this.set({ lines: [], cells: undefined, cols: undefined, rows: undefined, foreground: undefined, background: undefined, truecolor: undefined, cursor: undefined, sequence: 0, history: undefined, scrollOffset: undefined, bell: undefined, bracketedPaste: undefined, find: undefined });
        if (!workspace || !tab) { this.set({ phase: 'idle', statusText: 'This workspace has no tabs. Start a shell from the console strip.' }); return; }
        if (tab.state === 'interrupted' || tab.state === 'exited') { this.set({ phase: 'interrupted', statusText: describeTab(tab) }); return; }
        this.set({ phase: 'attaching', statusText: `Connecting the monitor to ${tab.name}…` });
        let viewId: string;
        const size = { ...this.size };
        try {            const attach = this.service.attach.bind(this.service) as unknown as (input: { workspaceId: string; tabId: string; cols: number; rows: number; stationId?: string }) => Promise<{ viewId: string }>;
            ({ viewId } = await attach({ workspaceId: workspace.id, tabId: tab.id, cols: size.cols, rows: size.rows, stationId: this.binding?.stationId })); } catch (error) {
            if (epoch !== this.epoch || gen !== this.viewGen) return;
            this.set({ phase: 'reconnecting', error: `Could not attach to ${tab.name}: ${message(error)}`, statusText: 'Reconnecting…' });
            this.later(() => void this.attachActive(epoch), this.options.retryMs ?? RETRY_MS);
            return;
        }
        if (epoch !== this.epoch || gen !== this.viewGen || this.disposed) { this.service.detach(viewId).catch(() => undefined); return; }
        this.viewId = viewId;
        this.sentSize = { viewId, ...size };
        // The focus view asked for another grid while this attach was in flight (or walked away): apply it now.
        if (size.cols !== this.size.cols || size.rows !== this.size.rows) void this.flushSize();
        await this.pollOnce(epoch, gen);
    }

    private async readClipboardNotification(epoch: number, gen: number, viewId: string, workspaceId: string, tabId: string): Promise<{ text: string; chars: number } | undefined> {
        const take = this.service.takeClipboardNotification;
        if (typeof take !== 'function') return undefined;
        try {
            const notification = await take.call(this.service, { viewId });
            if (epoch !== this.epoch || gen !== this.viewGen || this.disposed || this.viewId !== viewId
                || this.current.workspace?.id !== workspaceId || this.current.activeTabId !== tabId) return undefined;
            return validClipboardNotification(notification, viewId);
        } catch {
            return undefined;
        }
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
        // One notify per poll: the workspace, phase and frame go out in a single patch.
        const workspace = result.workspace ? this.sameWorkspace(result.workspace) : this.current.workspace;
        const tab = workspace?.tabs.find(t => t.id === this.current.activeTabId);
        if (result.state === 'detached' || result.state === 'error') {
            this.viewId = undefined;
            const reason = result.detail ? ` (${result.detail})` : '';
            this.set(result.state === 'error'
                ? { workspace, phase: 'error', error: `Terminal view error${reason}.`, statusText: 'Reattaching the monitor…' }
                : { workspace, phase: 'reconnecting', statusText: `Monitor disconnected${reason}. Reattaching…` });
            this.later(() => void this.attachActive(epoch), this.options.retryMs ?? RETRY_MS);
            return;
        }
        const patch: Partial<RuntimeConsoleState> = result.state === 'connecting'
            ? { workspace, phase: 'attaching', statusText: result.detail || 'Connecting…' }
            : { workspace, phase: 'live', error: '', statusText: tab ? describeTab(tab) : 'Live' };
        const frame = result.frame;
        if (frame && frame.sequence > this.current.sequence) {
            if (Number.isSafeInteger(frame.bell) && frame.bell! >= 0) {
                const before = this.current.bell ?? 0;
                const delta = frame.bell! >= before ? frame.bell! - before : frame.bell!;
                patch.unreadBells = Math.min(Number.MAX_SAFE_INTEGER, this.current.unreadBells + delta);
                patch.bell = frame.bell;
            }
            if (Number.isSafeInteger(frame.cols) && Number.isSafeInteger(frame.rows) && frame.cols > 0 && frame.rows > 0) Object.assign(patch, { cols: frame.cols, rows: frame.rows });
            Object.assign(patch, { sequence: frame.sequence, lines: frame.lines, cells: frame.cells, foreground: frame.foreground, background: frame.background, truecolor: validTruecolor(frame.truecolor, frame.rows, frame.cols), cursor: frame.cursor, palette: frame.palette ?? this.current.palette });
            for (const key of ['history', 'scrollOffset', 'bracketedPaste'] as const) if (frame[key] !== undefined) Object.assign(patch, { [key]: frame[key] });
        }
        // Show the frame first; the clipboard check is a second round trip and must not delay it.
        this.set(patch);
        // A pane clipboard write comes with output, so check on a new frame, else at most once a second.
        const workspaceId = this.current.workspace?.id;
        const tabId = this.current.activeTabId;
        const now = Date.now();
        if (workspaceId && tabId && (patch.sequence !== undefined || now - this.clipboardCheckedAt >= CLIPBOARD_CHECK_MS)) {
            this.clipboardCheckedAt = now;
            const copy = await this.readClipboardNotification(epoch, gen, viewId, workspaceId, tabId);
            if (epoch !== this.epoch || gen !== this.viewGen || this.disposed) return;
            if (copy) this.set({ pendingClipboard: copy });
        }
        this.schedulePoll(epoch, gen, this.pollInterval()); // w3:perf
    }

    /** The grid this desk's view is asked to have. */
    get viewSize(): { cols: number; rows: number } { return { ...this.size }; }
    /**
     * Give the attached view a real terminal grid (tmux pane size), e.g. the attached / full-window
     * box. Clamped to GRID_MIN..GRID_MAX. Walking away restores MONITOR_COLS x MONITOR_ROWS so the
     * physical monitor keeps its layout. Resizes run in order; only the latest size is sent.
     * Sends no input and starts nothing.
     */
    resizeView(cols: number, rows: number): Promise<void> {
        if (this.disposed) return this.resizing;
        this.size = clampGrid(cols, rows);
        return this.flushSize();
    }
    private flushSize(): Promise<void> {
        this.resizing = this.resizing.then(async () => {
            const viewId = this.viewId, { cols, rows } = this.size, sent = this.sentSize;
            if (this.disposed || !viewId || (sent && sent.viewId === viewId && sent.cols === cols && sent.rows === rows)) return;
            try {
                await this.service.resize({ viewId, cols, rows });
                if (viewId === this.viewId) this.sentSize = { viewId, cols, rows };
            } catch { /* The view keeps its last size; the next resize (or reattach) tries again. */ }
        });
        return this.resizing;
    }

    /** Acknowledge this desk's signal only. Never sends a key or starts/resumes an agent. */
    acknowledgeBells(): void { this.set({ unreadBells: 0 }); }
    acknowledgePendingClipboard(notice: string): void { this.set({ pendingClipboard: undefined, notice, error: '' }); }

    /** Saving a recipe is browser state only. Applying it has one explicit launch confirmation. */
    requestRecipeApply(recipe: StationRecipe, opts?: { setup?: boolean }): void {
        const workspace = this.current.workspace;
        if (!workspace || this.current.acting || !recipe || !recipe.tabs.length) return;
        const setup = !!opts?.setup; // w2:runtime
        if (this.current.stationLocked && !setup) { this.set({ pending: undefined, notice: '', error: 'This desk is locked, so the recipe was not applied. Unlock it in Station recipes first.' }); return; }
        const kinds = recipe.tabs.map(tab => tab.kind === 'shell' ? 'Shell' : tab.kind === 'hermes' ? 'Hermes' : tab.kind === 'claude' ? 'Claude Code' : 'Codex').join(', ');
        this.set({ error: '', notice: '', pending: { type: 'recipe', recipe, setup, confirmLabel: setup ? 'Start station tabs' : 'Start recipe tabs',
            message: setup ? `Set up ${workspace.name} as this station is configured? It will use profile “${recipe.profile}” and start exactly these tabs: ${kinds}. Nothing launches until you confirm; Cancel keeps just the shell.`
                : `Apply “${recipe.name}” to ${workspace.name}? It will save profile “${recipe.profile}” and start exactly these requested tabs: ${kinds}. Nothing launches until you confirm.` } });
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

    /**
     * Opt-in idle sleep for unseen idle Hermes tabs (host-wide, off by default). Only an explicit
     * user toggle calls this; it never starts, wakes or types into an agent.
     */
    async setIdleSleep(authorized: boolean, afterSeconds = 900): Promise<void> {
        if (this.disposed || !this.current.host) return;
        try {
            const idleSleep = await this.service.setIdleSleep(authorized ? { authorized, afterSeconds: Math.max(60, Math.min(86400, Math.round(afterSeconds))) } : { authorized: false });
            this.set({ host: { ...this.current.host!, idleSleep }, error: '', notice: idleSleep.authorized ? `Idle Hermes tabs you are not watching will sleep after ${Math.round(idleSleep.afterSeconds / 60)} min and wake when you look.` : 'Idle sleep is off. Tabs keep running.' });
        } catch (error) { this.set({ error: `Idle sleep was not changed: ${error instanceof Error ? error.message : String(error)}` }); }
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
        const extra = kind === 'dsh' ? ` ${DSH_START_NOTE}` : ''; // w2:agents
        this.set({ error: '', notice: '', pending: { type: 'new', kind, confirmLabel: `Start ${option.label}`,
            message: `Start ${option.label}${profile} in a new tab? It runs on this computer under your own account and may use your plan or API credits. It keeps running when you walk away.${extra}` } });
    }
    /** Station Lock flag from the widget. Changing it never touches a tab. */
    setStationLocked(locked: boolean): void { if (!!this.current.stationLocked !== locked) this.set({ stationLocked: locked }); }

    requestClose(tabId: string): void {
        const tab = this.current.workspace?.tabs.find(t => t.id === tabId);
        if (!tab || this.current.acting) return;
        if (this.current.stationLocked) { this.set({ pending: undefined, notice: '', error: `This desk is locked, so “${tab.name}” was not closed. Unlock it in Station recipes first.` }); return; }
        this.set({ error: '', notice: '', pending: { type: 'close', tabId, confirmLabel: 'Close tab',
            message: `Close “${tab.name}”? This ends what is running in it${tab.busy ? ', and Process active right now' : ''}.` } });
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
        if (this.current.stationLocked && (pending.type === 'close' || (pending.type === 'recipe' && !pending.setup))) { this.set({ pending: undefined, error: 'This desk is locked. Nothing was changed.' }); return; }
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
                rememberLastTabKind(kind);
            } else if (action.type === 'revive') {
                next = await this.service.reviveTab({ workspaceId: workspace.id, tabId: action.tabId!, confirmedStart: true });
                activate = action.tabId; notice = 'Tab revived.';
            } else if (action.type === 'recipe') {
                const recipe = action.recipe!;
                if (recipe.profile && this.current.host?.profiles.includes(recipe.profile)) {
                    next = await this.service.setWorkspaceProfile({ workspaceId: workspace.id, profile: recipe.profile });
                } else next = workspace;
                for (const tab of recipe.tabs) {
                    next = await this.service.newTab(tab.kind === 'hermes'
                        ? { workspaceId: next.id, kind: tab.kind, name: tab.name, profile: recipe.profile, confirmedStart: true }
                        : { workspaceId: next.id, kind: tab.kind, name: tab.name, confirmedStart: true });
                    activate = next.tabs.at(-1)?.id;
                }
                notice = `Recipe “${recipe.name}” applied. Inspect the physical screen; no task was submitted.`;
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
            this.set({ acting: false, notice: '', error: `${action.type === 'new' ? 'Could not start the tab' : action.type === 'revive' ? 'Could not revive the tab' : action.type === 'recipe' ? 'Could not apply the station recipe' : 'Could not close the tab'}: ${message(error)}` });
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
        if (tab.busy) { this.set({ pending: undefined, notice: '', error: `${tab.name} is Process active right now. Finish or interrupt it first.` }); return; }
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
                    this.current = { ...RuntimeConsoleController.initial(), stationLocked: this.current.stationLocked, host: this.current.host, board: this.current.board };
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
        return this.copySelection({ x1: 0, y1: 0, x2: (this.current.cols ?? MONITOR_COLS) - 1, y2: Math.max(0, (this.current.lines.length || MONITOR_ROWS) - 1) });
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
        this.current = { ...RuntimeConsoleController.initial(), stationLocked: this.current.stationLocked, host: this.current.host };
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
