import * as React from 'react';
import type { TaskWorkspaceService } from '../common/task-workspace-protocol';
import { TaskWorkspaceController } from './task-workspace-controller';
import type { TaskWorkspaceState } from './task-workspace-controller';

export interface TaskWorkspacePanelProps {
    projectUri: string;
    service: TaskWorkspaceService;
    onClose: () => void;
    onOpen?: (worktreeUri: string) => void | Promise<void>;
}

/** Explicit creation and project navigation only. Never starts an agent or promotes code. */
export function TaskWorkspacePanel(props: TaskWorkspacePanelProps): React.ReactElement {
    const [state, setState] = React.useState<TaskWorkspaceState>({ phase: 'idle', entries: [], notice: '' });
    const [form, setForm] = React.useState({ projectUri: props.projectUri, name: '', confirmed: false });
    const [openError, setOpenError] = React.useState<{ projectUri: string; message: string }>();
    const binding = React.useRef<{ projectUri: string; controller: TaskWorkspaceController }>();
    const latestProject = React.useRef(props.projectUri);
    latestProject.current = props.projectUri;

    // Allocate inside the effect so StrictMode cleanup cannot permanently dispose
    // a controller reused by its second effect mount.
    React.useEffect(() => {
        const controller = new TaskWorkspaceController(props.service);
        binding.current = { projectUri: props.projectUri, controller };
        const unsubscribe = controller.subscribe(setState);
        controller.setProject(props.projectUri);
        void controller.load();
        return () => {
            if (binding.current?.controller === controller) binding.current = undefined;
            unsubscribe();
            controller.dispose();
        };
    }, [props.projectUri, props.service]);

    const visible = state.projectUri === props.projectUri ? state : { phase: 'idle', entries: [], notice: '' } as TaskWorkspaceState;
    const value = form.projectUri === props.projectUri ? form : { projectUri: props.projectUri, name: '', confirmed: false };
    const busy = visible.phase === 'creating' || visible.phase === 'loading';
    const canCreate = visible.phase === 'ready' && value.confirmed && value.name.length > 0 && value.name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value.name);
    const currentController = (): TaskWorkspaceController | undefined => binding.current?.projectUri === props.projectUri ? binding.current.controller : undefined;

    const open = (id: string): void => {
        const controller = currentController();
        const uri = controller?.openTarget(id, props.projectUri);
        if (!uri || !props.onOpen) return;
        setOpenError(undefined);
        void Promise.resolve().then(() => {
            if (latestProject.current === props.projectUri && binding.current?.controller === controller) return props.onOpen?.(uri);
        }).catch(() => {
            if (latestProject.current === props.projectUri && binding.current?.controller === controller) setOpenError({ projectUri: props.projectUri, message: 'Could not open the task project. Its worktree was not removed.' });
        });
    };

    return <section className="omo-panel" data-testid="task-workspace-panel" data-phase={visible.phase} aria-label="Isolated task workspaces">
        <header className="omo-panel-header">
            <h2>Isolated task workspaces</h2>
            <div className="omo-panel-actions">
                <button type="button" data-testid="task-workspace-refresh" disabled={busy} onClick={() => { void currentController()?.load(); }}>Refresh</button>
                <button type="button" data-testid="task-workspace-close" onClick={props.onClose}>Close</button>
            </div>
        </header>
        <p className="omo-panel-meta">Source: {props.projectUri}</p>
        <p role="note" className="omo-panel-note" data-testid="task-workspace-warning">
            Each workspace creates a new Git branch and working folder from a captured commit.
            Uncommitted and untracked source changes are not copied. This does not start an agent, merge code or deploy anything.
        </p>
        <form className="omo-panel-form" onSubmit={event => { event.preventDefault(); void currentController()?.create(value.name, value.confirmed, props.projectUri); }}>
            <label>Task name
                <input data-testid="task-workspace-name" value={value.name} maxLength={80} required disabled={busy}
                    onChange={event => setForm({ ...value, projectUri: props.projectUri, name: event.currentTarget.value })} />
            </label>
            <label>
                <input type="checkbox" data-testid="task-workspace-confirm" checked={value.confirmed} disabled={busy}
                    onChange={event => setForm({ ...value, projectUri: props.projectUri, confirmed: event.currentTarget.checked })} />
                {' '}Create a new branch and worktree from the saved commit; do not copy uncommitted changes.
            </label>
            <button type="submit" data-testid="task-workspace-create" disabled={!canCreate}>
                {visible.phase === 'creating' ? 'Creating worktree…' : 'Create isolated workspace'}
            </button>
        </form>
        {visible.phase === 'loading' && <p role="status">Loading registered workspaces…</p>}
        {visible.phase === 'creating' && <p role="status">If you leave now, creation may still finish for the original source project. Return there and refresh to find it.</p>}
        {visible.notice && <p role={visible.phase === 'error' ? 'alert' : 'status'} data-testid="task-workspace-notice">{visible.notice}</p>}
        {openError?.projectUri === props.projectUri && <p role="alert">{openError.message}</p>}
        {visible.phase === 'ready' && visible.entries.length === 0 && <p>No isolated task workspaces are registered for this source project.</p>}
        <ul className="omo-panel-list">
            {visible.entries.map(entry => <li key={entry.id} data-testid="task-workspace-entry" data-worktree-id={entry.id}>
                <strong>{entry.name}</strong>
                <div><code>{entry.branch}</code></div>
                <div><code>{entry.worktreeUri}</code></div>
                <small>Base commit: <code>{entry.baseHead}</code></small>
                {entry.sourceHasChanges && <p>Source had uncommitted changes. They were not copied.</p>}
                <button type="button" data-testid="task-workspace-open" disabled={!props.onOpen || visible.phase !== 'ready'} onClick={() => open(entry.id)}>Open task project</button>
            </li>)}
        </ul>
    </section>;
}
