import * as React from 'react';
import type { AgentTaskTarget } from './agent-task-draft';
import { readTaskDraft, taskDraftKey, TASK_DRAFT_LIMIT_BYTES, writeTaskDraft } from './agent-task-draft';
import { AGENT_LABELS, RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';

function browserStorage(): Storage | undefined {
    try { return window.sessionStorage; } catch { return undefined; }
}

/** Keyed by the original destination: an async paste must never clear a different agent's draft. */
function TaskDraft(props: { target: AgentTaskTarget; ready: boolean; state: RuntimeConsoleState; controller: RuntimeConsoleController; onReview?: () => void }): React.ReactElement {
    const { target, state, controller } = props;
    const [storage] = React.useState(browserStorage);
    const [text, setText] = React.useState(() => storage ? readTaskDraft(storage, target) : '');
    const [saved, setSaved] = React.useState(!!storage);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const generation = React.useRef(0);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
    React.useEffect(() => { generation.current++; setNotice(''); }, [target.viewId]);
    const tab = state.workspace?.tabs.find(t => t.id === target.tabId);
    const size = new TextEncoder().encode(text).length;
    const multiline = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').includes('\n');
    const invalid = !text.trim() || size > TASK_DRAFT_LIMIT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text);
    const blocked = !props.ready || busy || invalid || (multiline && state.bracketedPaste !== true);
    const paste = async (): Promise<void> => {
        if (blocked) return;
        const ownGeneration = ++generation.current;
        setBusy(true); setNotice('');
        try {
            const ok = await controller.prepareTask(target, text);
            if (mounted.current && ownGeneration === generation.current) setNotice(ok ? 'Draft pasted without Enter. Inspect the physical screen, then press Enter there when ready.' : 'Draft not pasted. Check the terminal status. Your text is still here.');
        } catch {
            if (mounted.current && ownGeneration === generation.current) setNotice('Draft not pasted. Your text is still here.');
        } finally { if (mounted.current) setBusy(false); }
    };
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
            {props.onReview && <button type="button" data-testid="agent-task-review" onClick={props.onReview}>Review project changes</button>}
            <span className="omo-console-hint">{size > TASK_DRAFT_LIMIT_BYTES ? 'Too large: limit 32 KiB.' : multiline && state.bracketedPaste !== true ? 'Multiline paste is blocked: this program has not enabled bracketed paste.' : 'Text stays here after pasting. Nothing is submitted automatically.'}</span>
        </div>
        {!saved && <div className="omo-console-hint" role="status">Draft is held in memory only: it was not saved in browser storage. It may be lost if you switch tabs or reload.</div>}
        {notice && <div data-testid="agent-task-notice" className="omo-console-hint" role="status">{notice}</div>}
    </section>;
}

/** Preserve the current editor through temporary attach/action states; never redirect its target. */
export function AgentTaskDrawer(props: { state: RuntimeConsoleState; controller?: RuntimeConsoleController; onReview?: () => void }): React.ReactElement {
    const { state, controller } = props;
    const target = controller?.taskTarget();
    const previous = React.useRef<AgentTaskTarget>();
    if (target) previous.current = target;
    const selected = previous.current;
    if (!selected || selected.workspaceId !== state.workspace?.id || selected.projectUri !== state.workspace?.projectUri || selected.tabId !== state.activeTabId || !controller) {
        return <div data-testid="agent-task-unavailable" className="omo-console-hint">Select a live Hermes, Claude Code or Codex tab to prepare a task. Agent starts still need your confirmation.</div>;
    }
    return <TaskDraft key={taskDraftKey(selected)} target={target ?? selected} ready={!!target} state={state} controller={controller} onReview={props.onReview} />;
}
