import type { TaskWorkspace, TaskWorkspaceService } from '../common/task-workspace-protocol';
import type { AgentKind } from '../common/runtime-protocol';
import type { AgentTaskTarget } from './agent-task-draft';

export const TASK_HANDOFF_STORAGE_LIMIT_BYTES = 64 * 1024;
export const TASK_HANDOFF_KEY_PREFIX = 'omo.agent-task-handoff.v1:';
export const TASK_HANDOFF_MAX_RECORDS = 256;
export const TASK_HANDOFF_NAME_LIMIT = 80;
export const TASK_HANDOFF_PROFILE_LIMIT = 128;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TASK_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const KINDS: readonly AgentKind[] = ['hermes', 'claude', 'codex'];
const URI_LIMIT = 4096;
const TASK_TEXT_LIMIT_BYTES = 32 * 1024;

export interface TaskWorkspaceAuthority extends TaskWorkspaceService {
    /** Parent adds this exact read-only authority method. There is no fallback. */
    getTaskWorkspace(worktreeUri: string): Promise<TaskWorkspace | undefined>;
}

export type HandoffStage = 'pending' | 'opened' | 'launched' | 'pasted';

export interface PendingAgentHandoff {
    version: 1;
    id: string;
    sourceProjectUri: string;
    worktreeUri: string;
    workspaceId: string;
    workspaceName: string;
    taskName: string;
    taskText: string;
    agentKind: Exclude<AgentKind, 'shell'>;
    profile: string;
    stationId: string;
    stage: HandoffStage;
    createdAt: string;
}

export interface HandoffStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem?(key: string): void;
    readonly length?: number;
    key?(index: number): string | null;
}

export interface AgentWorkflowState {
    readonly projectUri?: string;
    readonly pending?: Readonly<PendingAgentHandoff>;
    readonly phase: 'idle' | 'checking' | 'ready' | 'error';
    readonly notice: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function wellFormed(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
}

function utf8Bytes(value: string): number {
    let bytes = 0;
    for (const character of value) {
        const code = character.codePointAt(0)!;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}

function boundedString(value: unknown, limit: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= limit && wellFormed(value) && !CONTROL.test(value);
}

function localFileUri(value: unknown): value is string {
    if (!boundedString(value, URI_LIMIT)) return false;
    try {
        const uri = new URL(value);
        return uri.protocol === 'file:' && uri.host === '' && uri.search === '' && uri.hash === '';
    } catch { return false; }
}

function validTaskText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.trim().length > 0 && wellFormed(value)
        && !TASK_CONTROL.test(value) && utf8Bytes(value) <= TASK_TEXT_LIMIT_BYTES;
}

function validStage(value: unknown): value is HandoffStage {
    return value === 'pending' || value === 'opened' || value === 'launched' || value === 'pasted';
}

function clone(value: PendingAgentHandoff): Readonly<PendingAgentHandoff> {
    return Object.freeze({ ...value });
}

export function taskHandoffKey(sourceProjectUri: string, worktreeUri: string): string {
    if (!localFileUri(sourceProjectUri) || !localFileUri(worktreeUri)) return '';
    return `${TASK_HANDOFF_KEY_PREFIX}${JSON.stringify([sourceProjectUri, worktreeUri])}`;
}

export function validatePendingHandoff(value: unknown): Readonly<PendingAgentHandoff> | undefined {
    if (!isObject(value)) return undefined;
    const allowed = ['version', 'id', 'sourceProjectUri', 'worktreeUri', 'workspaceId', 'workspaceName', 'taskName', 'taskText', 'agentKind', 'profile', 'stationId', 'stage', 'createdAt'];
    if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return undefined;
    if (value.version !== 1 || !boundedString(value.id, 128) || !localFileUri(value.sourceProjectUri) || !localFileUri(value.worktreeUri)
        || !boundedString(value.workspaceId, 256) || !boundedString(value.workspaceName, TASK_HANDOFF_NAME_LIMIT)
        || !boundedString(value.taskName, TASK_HANDOFF_NAME_LIMIT) || !validTaskText(value.taskText)
        || !KINDS.includes(value.agentKind as Exclude<AgentKind, 'shell'>)
        || typeof value.profile !== 'string' || value.profile.length > TASK_HANDOFF_PROFILE_LIMIT || !wellFormed(value.profile) || CONTROL.test(value.profile)
        || !boundedString(value.stationId, 256) || !validStage(value.stage)
        || !boundedString(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    return clone({ version: 1, id: value.id, sourceProjectUri: value.sourceProjectUri, worktreeUri: value.worktreeUri,
        workspaceId: value.workspaceId, workspaceName: value.workspaceName, taskName: value.taskName, taskText: value.taskText,
        agentKind: value.agentKind as Exclude<AgentKind, 'shell'>, profile: value.profile, stationId: value.stationId,
        stage: value.stage, createdAt: value.createdAt });
}

export function handoffForWorkspace(record: PendingAgentHandoff, workspace: TaskWorkspace | undefined): boolean {
    return !!workspace && workspace.id === record.workspaceId && workspace.sourceProjectUri === record.sourceProjectUri
        && workspace.worktreeUri === record.worktreeUri && workspace.name === record.workspaceName;
}

export function writePendingHandoff(storage: HandoffStorage | undefined, value: PendingAgentHandoff): boolean {
    const checked = validatePendingHandoff(value);
    const key = checked ? taskHandoffKey(checked.sourceProjectUri, checked.worktreeUri) : '';
    if (!checked || !key || !storage || typeof storage.setItem !== 'function') return false;
    try {
        const raw = JSON.stringify(checked);
        if (utf8Bytes(raw) > TASK_HANDOFF_STORAGE_LIMIT_BYTES) return false;
        storage.setItem(key, raw);
        return true;
    } catch { return false; }
}

export function updatePendingHandoff(storage: HandoffStorage | undefined, value: PendingAgentHandoff, stage: HandoffStage): boolean {
    const checked = validatePendingHandoff({ ...value, stage });
    return !!checked && writePendingHandoff(storage, checked);
}

function readAt(storage: HandoffStorage | undefined, key: string): Readonly<PendingAgentHandoff> | undefined {
    if (!storage || !key || typeof storage.getItem !== 'function') return undefined;
    try {
        const raw = storage.getItem(key);
        if (typeof raw !== 'string' || !raw || !wellFormed(raw) || utf8Bytes(raw) > TASK_HANDOFF_STORAGE_LIMIT_BYTES) return undefined;
        const value = validatePendingHandoff(JSON.parse(raw));
        if (!value || taskHandoffKey(value.sourceProjectUri, value.worktreeUri) !== key) return undefined;
        return value;
    } catch { return undefined; }
}

/**
 * Reads only records whose key names the current project as source or worktree.
 * It never treats sessionStorage as workspace authority; callers must validate
 * the returned worktree with getTaskWorkspace before opening or continuing.
 */
export function readPendingHandoffForProject(storage: HandoffStorage | undefined, projectUri: string): Readonly<PendingAgentHandoff> | undefined {
    if (!localFileUri(projectUri) || !storage || typeof storage.key !== 'function') return undefined;
    try {
        const length = typeof storage.length === 'number' && Number.isSafeInteger(storage.length) && storage.length >= 0
            ? Math.min(storage.length, TASK_HANDOFF_MAX_RECORDS) : 0;
        for (let index = 0; index < length; index++) {
            const key = storage.key(index);
            if (typeof key !== 'string' || !key.startsWith(TASK_HANDOFF_KEY_PREFIX)) continue;
            let tuple: unknown;
            try { tuple = JSON.parse(key.slice(TASK_HANDOFF_KEY_PREFIX.length)); } catch { continue; }
            if (!Array.isArray(tuple) || tuple.length !== 2 || (tuple[0] !== projectUri && tuple[1] !== projectUri)) continue;
            const value = readAt(storage, key);
            if (value && (value.sourceProjectUri === projectUri || value.worktreeUri === projectUri)) return value;
        }
    } catch { return undefined; }
    return undefined;
}

export function removePendingHandoff(storage: HandoffStorage | undefined, value: PendingAgentHandoff): boolean {
    const key = taskHandoffKey(value.sourceProjectUri, value.worktreeUri);
    if (!key || !storage || typeof storage.removeItem !== 'function') return false;
    try { storage.removeItem(key); return true; } catch { return false; }
}

export function sameAgentTaskTarget(a: AgentTaskTarget | undefined, b: AgentTaskTarget | undefined): boolean {
    return !!a && !!b && a.projectUri === b.projectUri && a.stationId === b.stationId
        && a.workspaceId === b.workspaceId && a.tabId === b.tabId && a.viewId === b.viewId;
}

/** Small race-safe controller for pending handoffs. It performs no launch or paste. */
export class AgentWorkflowController {
    private readonly authority: TaskWorkspaceAuthority;
    private readonly storage?: HandoffStorage;
    private readonly listeners = new Set<(state: AgentWorkflowState) => void>();
    private revision = 0;
    private disposed = false;
    private current: AgentWorkflowState = Object.freeze({ phase: 'idle', notice: '' });

    constructor(authority: TaskWorkspaceAuthority, storage?: HandoffStorage) { this.authority = authority; this.storage = storage; }
    get state(): AgentWorkflowState { return this.current; }
    subscribe(listener: (state: AgentWorkflowState) => void): () => void { this.listeners.add(listener); listener(this.current); return () => this.listeners.delete(listener); }
    private set(state: AgentWorkflowState): void {
        if (this.disposed) return;
        this.current = Object.freeze({ ...state, pending: state.pending ? clone(state.pending) : undefined });
        for (const listener of this.listeners) listener(this.current);
    }
    setProject(projectUri: string | undefined): void {
        if (this.disposed) return;
        this.revision++;
        const pending = projectUri ? readPendingHandoffForProject(this.storage, projectUri) : undefined;
        this.set({ projectUri, pending, phase: projectUri ? 'ready' : 'idle', notice: '' });
    }
    async validatePending(expectedProjectUri: string, expected: PendingAgentHandoff): Promise<TaskWorkspace> {
        const revision = this.revision;
        if (this.disposed || this.current.projectUri !== expectedProjectUri || !this.current.pending
            || this.current.pending.id !== expected.id || (expectedProjectUri !== expected.worktreeUri && expectedProjectUri !== expected.sourceProjectUri)) {
            throw new Error('This task handoff is no longer current.');
        }
        const workspace = await this.authority.getTaskWorkspace(expected.worktreeUri);
        if (this.disposed || revision !== this.revision || this.current.projectUri !== expectedProjectUri) throw new Error('This task handoff became stale.');
        if (!handoffForWorkspace(expected, workspace)) throw new Error('The registered task workspace does not match this handoff.');
        return workspace!;
    }
    dispose(): void { this.disposed = true; this.revision++; this.listeners.clear(); }
}
