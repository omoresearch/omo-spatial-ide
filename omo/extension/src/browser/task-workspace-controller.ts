import type { TaskWorkspace, TaskWorkspaceService } from '../common/task-workspace-protocol';

export function scopeTaskWorkspaceService(service: TaskWorkspaceService, current: (projectUri: string) => boolean): TaskWorkspaceService {
    const check = (projectUri: string): void => { if (!current(projectUri)) throw new Error('Task workspace context changed'); };
    return {
        async list(projectUri) {
            check(projectUri);
            const result = await service.list(projectUri);
            check(projectUri);
            return result;
        },
        async create(input) {
            const projectUri = input.projectUri;
            check(projectUri);
            const result = await service.create(input);
            check(projectUri);
            return result;
        },
        async getTaskWorkspace(worktreeUri) {
            const result = await service.getTaskWorkspace(worktreeUri);
            if (result && !current(result.sourceProjectUri)) throw new Error('Task workspace context changed');
            return result;
        }
    };
}

export interface TaskWorkspaceState {
    readonly projectUri?: string;
    readonly phase: 'idle' | 'loading' | 'ready' | 'creating' | 'error';
    readonly entries: readonly Readonly<TaskWorkspace>[];
    readonly notice: string;
}

function localUri(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return false;
    try {
        const uri = new URL(value);
        return uri.protocol === 'file:' && !uri.host && !uri.search && !uri.hash
            && !/[\u0000-\u001f\u007f]/.test(decodeURIComponent(uri.pathname));
    } catch { return false; }
}

function validName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
}

function checkedRecord(value: unknown, projectUri: string): Readonly<TaskWorkspace> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace');
    const row = value as TaskWorkspace;
    if (typeof row.id !== 'string' || !/^tw_[a-f0-9]{32}$/.test(row.id)
        || row.sourceProjectUri !== projectUri || !localUri(row.worktreeUri)
        || !new URL(row.worktreeUri).pathname.endsWith('/' + row.id)
        || row.branch !== 'omo/task/' + row.id || typeof row.baseHead !== 'string'
        || !/^[a-f0-9]{40,64}$/.test(row.baseHead) || !validName(row.name)
        || typeof row.createdAt !== 'string' || row.createdAt.length > 64 || !Number.isFinite(Date.parse(row.createdAt))
        || typeof row.sourceHasChanges !== 'boolean') throw new Error('Invalid workspace');
    return Object.freeze({ id: row.id, sourceProjectUri: row.sourceProjectUri, worktreeUri: row.worktreeUri,
        branch: row.branch, baseHead: row.baseHead, name: row.name, createdAt: row.createdAt, sourceHasChanges: row.sourceHasChanges });
}

/** Local UI state only. Opening a project never starts an agent here. */
export class TaskWorkspaceController {
    private readonly service: TaskWorkspaceService;
    private readonly listeners = new Set<(state: TaskWorkspaceState) => void>();
    private revision = 0;
    private disposed = false;
    private current: TaskWorkspaceState = Object.freeze({ phase: 'idle', entries: Object.freeze([]), notice: '' });

    constructor(service: TaskWorkspaceService) { this.service = service; }
    get state(): TaskWorkspaceState { return this.current; }

    subscribe(listener: (state: TaskWorkspaceState) => void): () => void {
        if (this.disposed) return () => undefined;
        this.listeners.add(listener);
        listener(this.current);
        return () => { this.listeners.delete(listener); };
    }

    private update(state: TaskWorkspaceState): void {
        if (this.disposed) return;
        this.current = Object.freeze({ ...state, entries: Object.freeze([...state.entries]) });
        for (const listener of this.listeners) listener(this.current);
    }

    setProject(projectUri: string | undefined): void {
        if (this.disposed || projectUri === this.current.projectUri) return;
        this.revision++;
        const valid = projectUri === undefined || localUri(projectUri);
        this.update({ projectUri: valid ? projectUri : undefined, phase: valid ? 'idle' : 'error', entries: [],
            notice: valid ? '' : 'Select a local Git repository root.' });
    }

    private stillCurrent(revision: number, projectUri: string): boolean {
        return !this.disposed && this.revision === revision && this.current.projectUri === projectUri;
    }

    async load(): Promise<void> {
        const projectUri = this.current.projectUri;
        if (this.disposed || !projectUri || this.current.phase === 'creating') return;
        const revision = ++this.revision;
        this.update({ projectUri, phase: 'loading', entries: [], notice: '' });
        try {
            const rows: unknown = await this.service.list(projectUri);
            if (!this.stillCurrent(revision, projectUri)) return;
            if (!Array.isArray(rows) || rows.length > 256) throw new Error('Invalid list');
            const entries = rows.map(row => checkedRecord(row, projectUri));
            if (new Set(entries.map(row => row.id)).size !== entries.length) throw new Error('Duplicate workspace');
            this.update({ projectUri, phase: 'ready', entries, notice: '' });
        } catch {
            if (this.stillCurrent(revision, projectUri)) this.update({ projectUri, phase: 'error', entries: [],
                notice: 'Could not load task workspaces. Open the canonical Git repository root and refresh. No agent was started.' });
        }
    }

    async create(name: string, confirmedCreate: boolean, expectedProjectUri: string): Promise<Readonly<TaskWorkspace> | undefined> {
        if (this.disposed || this.current.projectUri !== expectedProjectUri || this.current.phase !== 'ready') return undefined;
        if (confirmedCreate !== true || !validName(name)) {
            this.update({ ...this.current, notice: confirmedCreate !== true ? 'Confirm the new branch and worktree before creating it.' : 'Use a name of 1 to 80 characters without control characters.' });
            return undefined;
        }
        const projectUri = expectedProjectUri;
        const revision = ++this.revision;
        const previous = this.current.entries;
        this.update({ projectUri, phase: 'creating', entries: previous, notice: '' });
        try {
            const reply = await this.service.create({ projectUri, name, confirmedCreate: true });
            if (!this.stillCurrent(revision, projectUri)) return undefined;
            const entry = checkedRecord(reply, projectUri);
            if (entry.name !== name || previous.some(row => row.id === entry.id)) throw new Error('Invalid create receipt');
            this.update({ projectUri, phase: 'ready', entries: [...previous, entry],
                notice: entry.sourceHasChanges ? 'Created from the captured commit. Uncommitted source changes were not copied. No agent was started.' : 'Task worktree created. No agent was started.' });
            return entry;
        } catch {
            if (this.stillCurrent(revision, projectUri)) this.update({ projectUri, phase: 'error', entries: [],
                notice: 'Create failed or incomplete. Refresh or inspect task-workspace state before trying again. No agent was started.' });
            return undefined;
        }
    }

    openTarget(id: string, expectedProjectUri: string): string | undefined {
        if (this.disposed || this.current.phase !== 'ready' || this.current.projectUri !== expectedProjectUri) return undefined;
        return this.current.entries.find(row => row.id === id && row.sourceProjectUri === expectedProjectUri)?.worktreeUri;
    }

    dispose(): void {
        this.disposed = true;
        this.revision++;
        this.listeners.clear();
    }
}
