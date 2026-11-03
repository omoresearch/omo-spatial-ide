import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    AgentKind, CopyResult, FindResult, HostStatus, OmoRuntimeService, PASTE_MAX_BYTES, PasteResult, ResumeResult,
    RuntimePoll, SessionWorkspace, ViewModes, WorkspaceSummary
} from '../common/runtime-protocol';
import { RuntimeLocations } from './runtime-discovery';
import { RuntimeHost } from './runtime-host';

const AGENT_KINDS: readonly AgentKind[] = ['shell', 'hermes', 'claude', 'codex'];
const INSTALL_TMUX = 'Install tmux (for example: sudo apt install tmux, or brew install tmux) or set OMO_SPATIAL_TMUX to a tmux binary.';
const INSTALL_PYTHON = 'Install Python 3 (for example: sudo apt install python3) or set OMO_SPATIAL_PYTHON.';

function requireString(value: unknown, name: string, max = 512): string {
    if (typeof value !== 'string' || !value || value.length > max) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function requireSize(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${name} must be a number`);
    }
    return Math.round(value);
}

/** A file:// project URI as a real, existing absolute directory. */
export function projectDirectory(projectUri: string): string {
    let dir: string;
    try {
        if (!projectUri.startsWith('file://')) {
            throw new Error();
        }
        dir = fileURLToPath(projectUri);
    } catch {
        throw new Error('projectUri must be a file:// URI of a local directory');
    }
    let real: string;
    try {
        real = fs.realpathSync(dir);
    } catch {
        throw new Error('the project directory does not exist');
    }
    if (!path.isAbsolute(real) || !fs.statSync(real).isDirectory()) {
        throw new Error('the project directory is not a directory');
    }
    return real;
}

/**
 * Backend implementation of the frozen OmoRuntimeService contract. Single local
 * user; validates every RPC argument and forwards to the supervised host. No
 * bridge token, path to a credential, or environment value is ever returned.
 */
export class OmoRuntimeServiceImpl implements OmoRuntimeService {
    protected readonly locations: RuntimeLocations;
    protected readonly host: RuntimeHost;
    protected readonly views = new Set<string>();

    constructor(host: RuntimeHost) {
        this.host = host;
        this.locations = host.locations;
    }

    async status(): Promise<HostStatus> {
        const { tmux, python } = this.locations;
        if (!tmux || !python) {
            const missing = !tmux ? INSTALL_TMUX : INSTALL_PYTHON;
            return {
                available: false, tmux: !!tmux, python: !!python, profiles: [],
                agents: AGENT_KINDS.map(kind => ({ kind, available: false, detail: 'the terminal runtime is unavailable', installHint: missing })),
                detail: `${!tmux ? 'tmux' : 'python3'} was not found. ${missing}`
            };
        }
        try {
            return await this.host.request<HostStatus>('status');
        } catch (err) {
            return {
                available: false, tmux: true, python: true, profiles: [], agents: [],
                detail: `runtime host unavailable: ${(err as Error).message}`
            };
        }
    }

    async openWorkspace(input: { stationId: string; projectUri: string; name: string; profile?: string }): Promise<SessionWorkspace> {
        const stationId = requireString(input?.stationId, 'stationId', 128);
        const projectUri = requireString(input?.projectUri, 'projectUri', 4096);
        const projectDir = projectDirectory(projectUri);
        const name = typeof input.name === 'string' ? input.name.slice(0, 80) : '';
        const profile = typeof input.profile === 'string' ? input.profile.slice(0, 64) : '';
        return this.host.request('open', { stationId, projectUri, projectDir, name, profile });
    }

    async getWorkspace(workspaceId: string): Promise<SessionWorkspace> {
        return this.host.request('get', { workspaceId: requireString(workspaceId, 'workspaceId', 64) });
    }

    async newTab(input: { workspaceId: string; kind: AgentKind; name?: string; profile?: string; confirmedStart: boolean }): Promise<SessionWorkspace> {
        if (!AGENT_KINDS.includes(input?.kind)) {
            throw new Error('kind must be shell, hermes, claude or codex');
        }
        return this.host.request('tab_new', {
            workspaceId: requireString(input.workspaceId, 'workspaceId', 64), kind: input.kind,
            name: typeof input.name === 'string' ? input.name.slice(0, 80) : '',
            profile: typeof input.profile === 'string' ? input.profile.slice(0, 64) : '',
            confirmedStart: input.confirmedStart === true
        });
    }

    async renameTab(input: { workspaceId: string; tabId: string; name: string }): Promise<SessionWorkspace> {
        return this.host.request('tab_rename', {
            workspaceId: requireString(input?.workspaceId, 'workspaceId', 64), tabId: requireString(input.tabId, 'tabId', 64),
            name: requireString(input.name, 'name', 80)
        });
    }

    async closeTab(input: { workspaceId: string; tabId: string; confirmedClose: boolean }): Promise<SessionWorkspace> {
        return this.host.request('tab_close', {
            workspaceId: requireString(input?.workspaceId, 'workspaceId', 64), tabId: requireString(input.tabId, 'tabId', 64),
            confirmedClose: input.confirmedClose === true
        });
    }

    async reviveTab(input: { workspaceId: string; tabId: string; confirmedStart: boolean }): Promise<SessionWorkspace> {
        return this.host.request('tab_revive', {
            workspaceId: requireString(input?.workspaceId, 'workspaceId', 64), tabId: requireString(input.tabId, 'tabId', 64),
            confirmedStart: input.confirmedStart === true
        });
    }

    async attach(input: { workspaceId: string; tabId: string; cols: number; rows: number }): Promise<{ viewId: string }> {
        const result = await this.host.request<{ viewId: string }>('attach', {
            workspaceId: requireString(input?.workspaceId, 'workspaceId', 64), tabId: requireString(input.tabId, 'tabId', 64),
            cols: requireSize(input.cols, 'cols'), rows: requireSize(input.rows, 'rows')
        });
        this.views.add(result.viewId);
        return result;
    }

    async poll(input: { viewId: string; afterSequence: number }): Promise<RuntimePoll> {
        const after = typeof input?.afterSequence === 'number' && Number.isFinite(input.afterSequence) ? input.afterSequence : 0;
        try {
            const result = await this.host.request<RuntimePoll>('poll', { viewId: requireString(input?.viewId, 'viewId', 64), afterSequence: after, waitMs: 250 });
            if (result.state === 'detached') {
                this.views.delete(input.viewId);
            }
            return result;
        } catch (err) {
            return { state: 'error', detail: (err as Error).message };
        }
    }

    async input(input: { viewId: string; data: string }): Promise<void> {
        if (typeof input?.data !== 'string') {
            throw new Error('data must be a string');
        }
        await this.host.request('input', { viewId: requireString(input.viewId, 'viewId', 64), data: input.data });
    }

    async resize(input: { viewId: string; cols: number; rows: number }): Promise<void> {
        await this.host.request('resize', {
            viewId: requireString(input?.viewId, 'viewId', 64), cols: requireSize(input.cols, 'cols'), rows: requireSize(input.rows, 'rows')
        });
    }

    async detach(viewId: string): Promise<void> {
        this.views.delete(viewId);
        await this.host.request('detach', { viewId: requireString(viewId, 'viewId', 64) });
    }

    // --- advanced parity: thin validated forwards to the host (the bridge enforces limits) ---
    async listWorkspaces(): Promise<WorkspaceSummary[]> {
        return this.host.request('ws_list');
    }

    async renameWorkspace(input: { workspaceId: string; name: string }): Promise<SessionWorkspace> {
        return this.host.request('ws_rename', { workspaceId: requireString(input?.workspaceId, 'workspaceId', 64), name: requireString(input.name, 'name', 80) });
    }

    async deleteWorkspace(input: { workspaceId: string; confirmedDelete: boolean; confirmedBusy?: boolean }): Promise<{ deleted: boolean; detail: string }> {
        return this.host.request('ws_delete', {
            workspaceId: requireString(input?.workspaceId, 'workspaceId', 64),
            confirmedDelete: input.confirmedDelete === true, confirmedBusy: input.confirmedBusy === true
        });
    }

    async bindStation(input: { stationId: string; projectUri: string; workspaceId: string }): Promise<SessionWorkspace> {
        const stationId = requireString(input?.stationId, 'stationId', 128);
        const projectUri = requireString(input.projectUri, 'projectUri', 4096);
        return this.host.request('station_bind', {
            stationId, projectUri, projectDir: projectDirectory(projectUri), workspaceId: requireString(input.workspaceId, 'workspaceId', 64)
        });
    }

    async setWorkspaceProfile(input: { workspaceId: string; profile: string }): Promise<SessionWorkspace> {
        return this.host.request('ws_profile', {
            workspaceId: requireString(input?.workspaceId, 'workspaceId', 64), profile: typeof input.profile === 'string' ? input.profile.slice(0, 64) : ''
        });
    }

    async setKeepAwake(input: { workspaceId: string; on: boolean }): Promise<SessionWorkspace> {
        return this.host.request('ws_keep_awake', { workspaceId: requireString(input?.workspaceId, 'workspaceId', 64), on: input.on === true });
    }

    async resumeAgent(input: { workspaceId: string; tabId: string; confirmedStart: boolean }): Promise<ResumeResult> {
        return this.host.request('agent_resume', {
            workspaceId: requireString(input?.workspaceId, 'workspaceId', 64), tabId: requireString(input.tabId, 'tabId', 64),
            confirmedStart: input.confirmedStart === true
        });
    }

    async scroll(input: { viewId: string; lines: number }): Promise<ViewModes> {
        return this.host.request('scroll', { viewId: requireString(input?.viewId, 'viewId', 64), lines: requireSize(input.lines, 'lines') });
    }

    async wheel(input: { viewId: string; notches: number; x?: number; y?: number }): Promise<ViewModes> {
        return this.host.request('wheel', {
            viewId: requireString(input?.viewId, 'viewId', 64), notches: requireSize(input.notches, 'notches'),
            x: typeof input.x === 'number' && Number.isFinite(input.x) ? Math.round(input.x) : 0,
            y: typeof input.y === 'number' && Number.isFinite(input.y) ? Math.round(input.y) : 0
        });
    }

    async find(input: { viewId: string; query: string; step: number }): Promise<FindResult> {
        if (typeof input?.query !== 'string') {
            throw new Error('query must be a string');
        }
        return this.host.request('find', {
            viewId: requireString(input.viewId, 'viewId', 64), query: input.query.slice(0, 200),
            step: typeof input.step === 'number' && Number.isFinite(input.step) ? Math.sign(input.step) : 0
        });
    }

    async copyText(input: { viewId: string; x1: number; y1: number; x2: number; y2: number; unit?: 'char' | 'word' | 'line' }): Promise<CopyResult> {
        return this.host.request('copy', {
            viewId: requireString(input?.viewId, 'viewId', 64),
            x1: requireSize(input.x1, 'x1'), y1: requireSize(input.y1, 'y1'), x2: requireSize(input.x2, 'x2'), y2: requireSize(input.y2, 'y2'),
            unit: input.unit === 'word' || input.unit === 'line' ? input.unit : 'char'
        });
    }

    async clearHistory(input: { viewId: string; confirmedClear: boolean }): Promise<ViewModes> {
        return this.host.request('clear_history', { viewId: requireString(input?.viewId, 'viewId', 64), confirmedClear: input.confirmedClear === true });
    }

    async paste(input: { viewId: string; text: string }): Promise<PasteResult> {
        if (typeof input?.text !== 'string') {
            throw new Error('text must be a string');
        }
        if (Buffer.byteLength(input.text, 'utf8') > PASTE_MAX_BYTES) {
            throw new Error(`paste too large (the limit is ${PASTE_MAX_BYTES / 1024} KiB)`);
        }
        return this.host.request('paste', { viewId: requireString(input.viewId, 'viewId', 64), text: input.text });
    }

    /** Detach this connection's views only; the tabs keep running. */
    async detachAll(): Promise<void> {
        const ids = [...this.views];
        this.views.clear();
        await Promise.all(ids.map(id => this.host.request('detach', { viewId: id }).catch(() => undefined)));
    }

    dispose(): void {
        void this.detachAll();
    }

    stopHost(): Promise<void> {
        return this.host.stop();
    }
}
