import * as React from 'react';
import type { AgentTaskTarget } from './agent-task-draft';
import { readTaskDraft, taskDraftKey, TASK_DRAFT_LIMIT_BYTES, writeTaskDraft } from './agent-task-draft';
import type { GitReviewSnapshot } from '../common/git-review-protocol';
import { attachTaskReview, createTaskRun, decideTaskRun, markTaskSubmitted, readTaskRun, sameTaskRunTarget, type TaskRun, writeTaskRun } from './agent-task-run';
import { AgentTaskRunPanel } from './agent-task-run-panel';
import { AGENT_LABELS, RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';

function browserStorage(): Storage | undefined {
    try { return window.sessionStorage; } catch { return undefined; }
}

function samePersistentTarget(a: AgentTaskTarget | undefined, b: AgentTaskTarget | undefined): boolean {
    return !!a && !!b && a.projectUri === b.projectUri && a.stationId === b.stationId && a.workspaceId === b.workspaceId && a.tabId === b.tabId;
}

/** Keyed by the original destination: an async paste must never clear a different agent's draft. */
function TaskDraft(props: { target: AgentTaskTarget; ready: boolean; state: RuntimeConsoleState; controller: RuntimeConsoleController; onReview?: () => Promise<GitReviewSnapshot | undefined> }): React.ReactElement {
    const { target, state, controller } = props;
    const [storage] = React.useState(browserStorage);
    const [text, setText] = React.useState(() => storage ? readTaskDraft(storage, target) : '');
    const [saved, setSaved] = React.useState(!!storage);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const [run, setRun] = React.useState<TaskRun | undefined>(() => storage ? readTaskRun(storage, target) : undefined);
    const [runStorageWarning, setRunStorageWarning] = React.useState(!storage);
    const [runNotice, setRunNotice] = React.useState('');
    const [reviewing, setReviewing] = React.useState(false);
    const generation = React.useRef(0);
    const reviewOperation = React.useRef(0);
    const mounted = React.useRef(true);
    const runRef = React.useRef(run);
    runRef.current = run;
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; reviewOperation.current++; }; }, []);
    React.useEffect(() => { generation.current++; reviewOperation.current++; setNotice(''); setRunNotice(''); setReviewing(false); }, [target.viewId, state.activeTabId, state.workspace?.id, state.workspace?.projectUri, state.phase]);
    React.useEffect(() => { reviewOperation.current++; setReviewing(false); }, [run?.id]);
    const tab = state.workspace?.tabs.find(t => t.id === target.tabId);
    const size = new TextEncoder().encode(text).length;
    const multiline = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').includes('\n');
    const invalid = !text.trim() || size > TASK_DRAFT_LIMIT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text);
    const liveTarget = props.ready ? controller.taskTarget() : undefined;
    const transitionReady = !!liveTarget && !!run && samePersistentTarget(run.target, liveTarget);

    const persistRun = (next: TaskRun, storageTarget: AgentTaskTarget): void => {
        runRef.current = next;
        setRun(next);
        const persisted = !!storage && writeTaskRun(storage, storageTarget, next);
        setRunStorageWarning(!persisted);
    };

    const reportSubmitted = (): void => {
        const current = controller.taskTarget();
        const currentRun = runRef.current;
        if (!currentRun || !current) return;
        try {
            const next = markTaskSubmitted(currentRun, current);
            persistRun(next, current);
            setRunNotice('Submitted is your report only. No terminal input was sent and execution was not verified.');
        } catch { setRunNotice('This task record is no longer current. No submission was recorded.'); }
    };

    const review = async (): Promise<void> => {
        const currentRun = runRef.current;
        const requestedTarget = controller.taskTarget();
        if (!currentRun || !requestedTarget || !props.onReview || (currentRun.phase !== 'submitted' && currentRun.phase !== 'review-ready')) return;
        const operation = ++reviewOperation.current;
        setReviewing(true); setRunNotice('Opening the real current project review…');
        try {
            const snapshot = await props.onReview();
            const current = controller.taskTarget();
            const stillCurrent = mounted.current && operation === reviewOperation.current && !!current
                && sameTaskRunTarget(requestedTarget, current) && runRef.current === currentRun
                && samePersistentTarget(currentRun.target, current);
            if (!stillCurrent || !snapshot) {
                if (mounted.current && operation === reviewOperation.current) setRunNotice('Review was not confirmed for this current tab. Decisions remain locked.');
                return;
            }
            try {
                const next = attachTaskReview(currentRun, current, snapshot);
                persistRun(next, current);
                setRunNotice('Review opened. Inspect the current project changes before choosing a decision.');
            } catch { setRunNotice('The review did not match this task project. Decisions remain locked.'); }
        } catch {
            if (mounted.current && operation === reviewOperation.current) setRunNotice('Review failed or closed. Decisions remain locked.');
        } finally {
            if (mounted.current && operation === reviewOperation.current) setReviewing(false);
        }
    };

    const decide = (decision: 'accepted' | 'changes-requested'): void => {
        const current = controller.taskTarget();
        const currentRun = runRef.current;
        if (!currentRun || !current || reviewing || currentRun.phase !== 'review-ready') return;
        try {
            const next = decideTaskRun(currentRun, current, decision);
            persistRun(next, current);
            setRunNotice(decision === 'accepted' ? 'Accepted is your review decision only. No terminal input or Git write was made.' : 'Changes requested is your review decision only. No terminal input or Git write was made.');
        } catch { setRunNotice('This task record is no longer current. No decision was recorded.'); }
    };

    const paste = async (): Promise<void> => {
        if (!props.ready || busy || invalid || (multiline && state.bracketedPaste !== true)) return;
        const requestedTarget = { ...target };
        const pastedText = text;
        const ownGeneration = ++generation.current;
        setBusy(true); setNotice('');
        try {
            const ok = await controller.prepareTask(requestedTarget, pastedText);
            const current = controller.taskTarget();
            if (ok && mounted.current && sameTaskRunTarget(requestedTarget, current as AgentTaskTarget)) {
                try {
                    const next = createTaskRun(requestedTarget, pastedText, crypto.randomUUID());
                    persistRun(next, requestedTarget);
                    setRunNotice('Pasted text is frozen in this record. It is still not submitted.');
                } catch { setRunNotice('The task was pasted, but its review record could not be created.'); }
            }
            if (mounted.current && ownGeneration === generation.current) setNotice(ok ? 'Draft pasted without Enter. Inspect the physical screen, then press Enter there when ready.' : 'Draft not pasted. Check the terminal status. Your text is still here.');
        } catch {
            if (mounted.current && ownGeneration === generation.current) setNotice('Draft not pasted. Your text is still here.');
        } finally { if (mounted.current) setBusy(false); }
    };
    const blocked = !props.ready || busy || invalid || (multiline && state.bracketedPaste !== true);
    return <section data-testid="agent-task-drawer" aria-label="Prepare an agent task" style={{ borderTop: '1px solid #ffffff14', paddingTop: 6, maxHeight: 230, overflowY: 'auto' }}>
        <div className="omo-console-row"><strong>Task for {tab ? AGENT_LABELS[tab.kind] : 'agent'} · {tab?.name}</strong><span className="omo-console-hint">This browser tab only · kept across reload</span></div>
        <p className="omo-console-hint">Check the physical screen first: this tab can be at an agent, shell, login or permission prompt. Paste does not press Enter, start an agent, or prove work is complete.</p>
        <textarea data-testid="agent-task-input" aria-label="Agent task draft" rows={3} maxLength={TASK_DRAFT_LIMIT_BYTES} value={text}
            style={{ boxSizing: 'border-box', width: '100%', resize: 'vertical', background: '#17232c', color: '#cfdeda', border: '1px solid #ffffff26', borderRadius: 4, padding: 6, fontSize: 12 }}
            placeholder="Describe the task for this agent tab…" onChange={event => {
                generation.current++; setNotice(''); setText(event.target.value);
                setSaved(!!storage && writeTaskDraft(storage, target, event.target.value));
            }} />
        <div className="omo-console-row">
            <button type="button" data-testid="agent-task-paste" disabled={blocked} onClick={() => void paste()}>Paste draft (no Enter)</button>
            {props.onReview && <button type="button" data-testid="agent-task-review" onClick={() => void props.onReview?.()}>Review project changes</button>}
            <span className="omo-console-hint">{size > TASK_DRAFT_LIMIT_BYTES ? 'Too large: limit 32 KiB.' : multiline && state.bracketedPaste !== true ? 'Multiline paste is blocked: this program has not enabled bracketed paste.' : 'Text stays here after pasting. Nothing is submitted automatically.'}</span>
        </div>
        {!saved && <div className="omo-console-hint" role="status">Draft is held in memory only: it was not saved in browser storage. It may be lost if you switch tabs or reload.</div>}
        {notice && <div data-testid="agent-task-notice" className="omo-console-hint" role="status">{notice}</div>}
        <AgentTaskRunPanel run={run} storageWarning={runStorageWarning} transitionReady={transitionReady} reviewing={reviewing} notice={runNotice}
            onSubmitted={reportSubmitted} onReview={() => void review()} onAccept={() => decide('accepted')} onChanges={() => decide('changes-requested')} />
    </section>;
}

/** Preserve the current editor through temporary attach/action states; never redirect its target. */
export function AgentTaskDrawer(props: { state: RuntimeConsoleState; controller?: RuntimeConsoleController; onReview?: () => Promise<GitReviewSnapshot | undefined> }): React.ReactElement {
    const { state, controller } = props;
    const target = controller?.taskTarget();
    const previous = React.useRef<AgentTaskTarget>();
    if (target) previous.current = target;
    const selected = previous.current;
    const contextMismatch = !!selected && !!state.workspace && (selected.workspaceId !== state.workspace.id || selected.projectUri !== state.workspace.projectUri || (!!state.activeTabId && selected.tabId !== state.activeTabId));
    if (!selected || contextMismatch || !controller) {
        return <div data-testid="agent-task-unavailable" className="omo-console-hint">Select a live Hermes, Claude Code or Codex tab to prepare a task. Agent starts still need your confirmation.</div>;
    }
    return <TaskDraft key={taskDraftKey(selected)} target={target ?? selected} ready={!!target} state={state} controller={controller} onReview={props.onReview} />;
}
