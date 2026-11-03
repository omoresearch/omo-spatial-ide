import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    AgentKind, HostStatus, OmoRuntimeService, RuntimePoll, SessionWorkspace
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
