import * as React from 'react';
import type { AgentKind, SessionTab } from '../common/runtime-protocol';
import type { TaskWorkspace } from '../common/task-workspace-protocol';
import { TaskWorkspaceController } from './task-workspace-controller';
import type { TaskWorkspaceState } from './task-workspace-controller';
import { AGENT_LABELS, RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';
import {
    AgentWorkflowController, HandoffStorage, PendingAgentHandoff, TaskWorkspaceAuthority,
    handoffForWorkspace, readPendingHandoffForProject, updatePendingHandoff, writePendingHandoff,
} from './task-handoff';

function browserStorage(): HandoffStorage | undefined {
    try { return window.sessionStorage; } catch { return undefined; }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TASK_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const KINDS: readonly Exclude<AgentKind, 'shell'>[] = ['hermes', 'claude', 'codex'];

function validField(value: string, max: number, required = true): boolean {
    return (required ? value.trim().length > 0 : true) && value.length <= max && !CONTROL.test(value);
}

function sameWorkspace(a: TaskWorkspace | undefined, b: PendingAgentHandoff): boolean {
    return handoffForWorkspace(b, a);
}

function tabFor(state: RuntimeConsoleState, kind: PendingAgentHandoff | undefined): SessionTab | undefined {
    if (!kind || state.workspace?.projectUri !== kind.worktreeUri) return undefined;
    return state.workspace.tabs.find(tab => tab.id === state.activeTabId);
}

export interface AgentWorkflowPanelProps {
    projectUri: string;
    stationId: string;
    stationLabel: string;
    authority: TaskWorkspaceAuthority;
    runtimeState: RuntimeConsoleState;
    runtimeController?: RuntimeConsoleController;
    onOpenWorkspace: (worktreeUri: string, sourceProjectUri: string) => void | Promise<void>;
    onContinueDesk: (stationId: string) => void | Promise<void>;
    onClose: () => void;
}

/**
 * The complete, explicit handoff. This panel stays on the real room page.
 * It never starts a CLI, sends Enter, reads a device clipboard, or claims
 * that a foreground process completed the task.
 */
export function AgentWorkflowPanel(props: AgentWorkflowPanelProps): React.ReactElement {
    const [storage] = React.useState(browserStorage);
    const [handoffController] = React.useState(() => new AgentWorkflowController(props.authority, storage));
    const [handoffState, setHandoffState] = React.useState(handoffController.state);
    const [workspaceState, setWorkspaceState] = React.useState<TaskWorkspaceState>({ phase: 'idle', entries: [], notice: '' });
    const [form, setForm] = React.useState({ taskText: '', taskName: '', agentKind: 'hermes' as Exclude<AgentKind, 'shell'>, profile: props.runtimeState.profile || '', confirmed: false });
    const [created, setCreated] = React.useState<Readonly<TaskWorkspace>>();
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const [error, setError] = React.useState('');
    const [inspected, setInspected] = React.useState(false);
    const [pasted, setPasted] = React.useState(false);
    const generation = React.useRef(0);

    React.useEffect(() => {
        const unsubscribe = handoffController.subscribe(setHandoffState);
        handoffController.setProject(props.projectUri);
        const workspaceController = new TaskWorkspaceController(props.authority);
        const stopWorkspace = workspaceController.subscribe(setWorkspaceState);
        workspaceController.setProject(props.projectUri);
        void workspaceController.load();
        return () => { generation.current++; unsubscribe(); stopWorkspace(); workspaceController.dispose(); handoffController.dispose(); };
    }, [handoffController, props.projectUri, props.authority]);

    React.useEffect(() => {
        setInspected(false); setPasted(false); setNotice(''); setError('');
    }, [props.runtimeState.workspace?.id, props.runtimeState.activeTabId, props.runtimeState.phase]);

    React.useEffect(() => {
        if (handoffState.pending?.stage === 'pasted') setPasted(true);
    }, [handoffState.pending?.id, handoffState.pending?.stage]);

    const pending = handoffState.pending;
    const onSource = !!pending && pending.sourceProjectUri === props.projectUri;
    const onTarget = !!pending && pending.worktreeUri === props.projectUri;
    const activeTab = tabFor(props.runtimeState, pending);
    const deskReady = !!pending && props.runtimeState.workspace?.projectUri === pending.worktreeUri
        && props.runtimeState.phase === 'live' && activeTab?.state === 'running';
    const matchingAgent = deskReady && activeTab?.kind === pending?.agentKind;
    const canCreate = workspaceState.phase === 'ready' && form.confirmed
        && validField(form.taskName, 80) && validField(form.profile, 128)
        && form.taskText.trim().length > 0 && form.taskText.length <= 32768 && !TASK_CONTROL.test(form.taskText);

    const validate = async (record: PendingAgentHandoff): Promise<TaskWorkspace | undefined> => {
        try {
            setBusy(true); setError(''); setNotice('Checking the registered task worktree…');
            return await handoffController.validatePending(props.projectUri, record);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The task handoff could not be validated.');
            setNotice('');
            return undefined;
        } finally { setBusy(false); }
    };

    const create = async (): Promise<void> => {
        if (!canCreate || busy) return;
        const ownGeneration = ++generation.current;
        setBusy(true); setError(''); setNotice('');
        const controller = new TaskWorkspaceController(props.authority);
        try {
            controller.setProject(props.projectUri);
            await controller.load();
            const entry = await controller.create(form.taskName, true, props.projectUri);
            if (!entry || ownGeneration !== generation.current) return;
            const record: PendingAgentHandoff = {
                version: 1,
                id: crypto.randomUUID(),
                sourceProjectUri: props.projectUri,
                worktreeUri: entry.worktreeUri,
                workspaceId: entry.id,
                workspaceName: entry.name,
                taskName: form.taskName,
                taskText: form.taskText,
                agentKind: form.agentKind,
                profile: form.profile,
                stationId: props.stationId,
                stage: 'pending',
                createdAt: new Date().toISOString(),
            };
            if (!writePendingHandoff(storage, record)) throw new Error('The pending handoff could not be saved in this browser tab.');
            setCreated(entry);
            handoffController.setProject(props.projectUri);
            setNotice('Isolated workspace created. Validate it, then explicitly open the task project.');
        } catch (cause) {
            if (ownGeneration === generation.current) setError(cause instanceof Error ? cause.message : 'The isolated task could not be created.');
        } finally { controller.dispose(); if (ownGeneration === generation.current) setBusy(false); }
    };

    const open = async (): Promise<void> => {
        if (!pending || !onSource || busy) return;
        const workspace = await validate(pending);
        if (!workspace || !sameWorkspace(workspace, pending)) return;
        try {
            setBusy(true); setNotice('Opening the validated isolated project…');
            await props.onOpenWorkspace(workspace.worktreeUri, pending.sourceProjectUri);
            updatePendingHandoff(storage, pending, 'opened');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The isolated project was not opened.');
            setNotice('');
        } finally { setBusy(false); }
    };

    const continueDesk = async (): Promise<void> => {
        if (!pending || !onTarget || busy) return;
        const workspace = await validate(pending);
        if (!workspace || !sameWorkspace(workspace, pending)) return;
        try {
            setBusy(true); setNotice('Validated. Opening the existing terminal desk for this project…');
            await props.onContinueDesk(pending.stationId);
            updatePendingHandoff(storage, pending, 'opened');
            handoffController.setProject(props.projectUri);
            setNotice('Desk opened. Nothing has started. Inspect the physical CLI screen before launch.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The correct project desk could not be opened.');
            setNotice('');
        } finally { setBusy(false); }
    };

    const launch = async (): Promise<void> => {
        if (!pending || !props.runtimeController || !deskReady || busy) return;
        const profiles = props.runtimeState.host?.profiles ?? [];
        if (pending.agentKind === 'hermes' && !profiles.includes(pending.profile)) {
            setError(`Profile “${pending.profile || '(empty)'}” is not available on this computer.`); return;
        }
        setBusy(true); setError(''); setNotice('Choose the explicit Start confirmation in the terminal controls.');
        props.runtimeController.setProfile(pending.profile);
        await props.runtimeController.requestNewTab(pending.agentKind);
        setBusy(false);
    };

    const inspect = (): void => {
        if (!pending || !matchingAgent) return;
        setInspected(true); setNotice(`Inspect ${activeTab?.name || AGENT_LABELS[pending.agentKind]} on the physical CLI screen. Login and tool approvals remain CLI-owned.`);
    };

    const paste = async (): Promise<void> => {
        if (!pending || !inspected || pasted || !props.runtimeController || busy) return;
        const target = props.runtimeController.taskTarget();
        if (!target || target.projectUri !== pending.worktreeUri || target.stationId !== pending.stationId || target.tabId !== activeTab?.id) {
            setError('The selected CLI tab changed. No task text was pasted.'); return;
        }
        const ownGeneration = ++generation.current;
        setBusy(true); setError(''); setNotice('');
        try {
            const ok = await props.runtimeController.prepareTask(target, pending.taskText);
            if (ownGeneration !== generation.current) return;
            if (!ok) { setError('Safe paste was refused. The task text remains in this handoff.'); return; }
            updatePendingHandoff(storage, pending, 'pasted');
            setPasted(true);
            setNotice('Task text pasted without Enter. Press Enter manually on the physical CLI screen when you are ready.');
        } finally { if (ownGeneration === generation.current) setBusy(false); }
    };

    const tabName = activeTab?.name || '(CLI tab not active)';
    return <section className="omo-agent-workflow" data-testid="agent-workflow-panel" data-phase={onTarget ? 'continue' : onSource ? 'pending' : 'draft'} aria-label="New agent task workflow">
        <header className="omo-agent-workflow-header">
            <div><span className="omo-console-label">NEW AGENT TASK</span><h3>Prepare work in an isolated project</h3></div>
            <button type="button" data-testid="agent-workflow-close" onClick={props.onClose}>Close</button>
        </header>
        <p className="omo-agent-workflow-note">Every step is explicit. This flow never launches on reload, changes project, submits a shell, presses Enter, or bypasses CLI login and tool approvals.</p>
        {!pending && <form data-testid="agent-workflow-form" onSubmit={event => { event.preventDefault(); void create(); }}>
            <label>Task name<input data-testid="agent-workflow-name" maxLength={80} value={form.taskName} disabled={busy} onChange={event => setForm({ ...form, taskName: event.currentTarget.value })} placeholder="Short task name" /></label>
            <label>Task text<textarea data-testid="agent-workflow-text" maxLength={32768} rows={4} value={form.taskText} disabled={busy} onChange={event => setForm({ ...form, taskText: event.currentTarget.value })} placeholder="Describe the exact task. It will be pasted without Enter." /></label>
            <div className="omo-agent-workflow-row">
                <label>Agent kind<select data-testid="agent-workflow-kind" value={form.agentKind} disabled={busy} onChange={event => setForm({ ...form, agentKind: event.currentTarget.value as Exclude<AgentKind, 'shell'> })}>{KINDS.map(kind => <option key={kind} value={kind}>{AGENT_LABELS[kind]}</option>)}</select></label>
                <label>Profile<input data-testid="agent-workflow-profile" maxLength={128} value={form.profile} disabled={busy} onChange={event => setForm({ ...form, profile: event.currentTarget.value })} placeholder="CLI profile" /></label>
            </div>
            <label className="omo-agent-workflow-confirm"><input type="checkbox" data-testid="agent-workflow-isolated-confirm" checked={form.confirmed} disabled={busy} onChange={event => setForm({ ...form, confirmed: event.currentTarget.checked })} /> Create a new isolated Git worktree from the registered project commit.</label>
            <button type="submit" data-testid="agent-workflow-create" disabled={!canCreate || busy}>{busy ? 'Creating isolated workspace…' : 'Create isolated workspace'}</button>
        </form>}
        {workspaceState.notice && !pending && <p className="omo-console-hint">{workspaceState.notice}</p>}
        {created && !pending && <p className="omo-console-hint">Created {created.name}. The handoff is saved only for this browser tab.</p>}
        {pending && <div data-testid="agent-workflow-handoff" className="omo-agent-workflow-handoff">
            <p><strong>{onTarget ? 'Pending task for this isolated project' : 'Pending isolated task handoff'}</strong></p>
            <dl><dt>Task</dt><dd data-testid="agent-workflow-task-name">{pending.taskName}</dd><dt>Agent</dt><dd>{AGENT_LABELS[pending.agentKind]} · {pending.profile || 'No profile named'}</dd><dt>Desk</dt><dd>{props.stationLabel}</dd><dt>Worktree</dt><dd><code data-testid="agent-workflow-worktree">{pending.worktreeUri}</code></dd></dl>
            <pre data-testid="agent-workflow-task-text">{pending.taskText}</pre>
            {onSource && <><p>Authority check is required before opening. A session record alone cannot open a project.</p><button type="button" data-testid="agent-workflow-open" disabled={busy} onClick={() => void open()}>Validate and open isolated project</button></>}
            {onTarget && <>
                <p>Continue only in this exact worktree. The registered workspace is checked before the desk opens.</p>
                <button type="button" data-testid="agent-workflow-continue-desk" disabled={busy} onClick={() => void continueDesk()}>Continue on the correct desk</button>
                {props.runtimeState.workspace?.projectUri === pending.worktreeUri && <div className="omo-agent-workflow-steps">
                    <p><strong>1. Current desk:</strong> {props.runtimeState.workspace.name} · {tabName}</p>
                    <p><strong>2. Start:</strong> choose the normal explicit launch confirmation. No launch happens from reload or project change.</p>
                    <button type="button" data-testid="agent-workflow-launch" disabled={busy || !deskReady || !!props.runtimeState.pending} onClick={() => void launch()}>Ask to start {AGENT_LABELS[pending.agentKind]}</button>
                    {matchingAgent && <><p><strong>3. Inspect:</strong> read the actual physical CLI screen. It may show login, trust or tool approval.</p><pre data-testid="agent-workflow-cli-screen" aria-label="Actual CLI screen">{props.runtimeState.lines.join('\n')}</pre><button type="button" data-testid="agent-workflow-inspect" disabled={!matchingAgent || busy} onClick={inspect}>I inspected the CLI screen</button></>}
                    {inspected && <><p><strong>4. Safe paste:</strong> paste exact text without Enter.</p><button type="button" data-testid="agent-workflow-paste" disabled={busy || pasted || !inspected} onClick={() => void paste()}>Paste task safely (no Enter)</button></>}
                    {pasted && <p data-testid="agent-workflow-manual-enter" role="status">Paste finished without Enter. Press Enter manually on the physical CLI screen. This workflow does not submit it.</p>}
                </div>}
            </>}
        </div>}
        {error && <p data-testid="agent-workflow-error" role="alert">{error}</p>}
        {notice && <p data-testid="agent-workflow-notice" role="status">{notice}</p>}
    </section>;
}
