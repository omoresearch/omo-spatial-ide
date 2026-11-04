import * as React from 'react';
import type { TaskRun, TaskRunPhase } from './agent-task-run';

const PHASE_LABEL: Record<TaskRunPhase, string> = {
    prepared: 'Pasted — not submitted',
    submitted: 'Submitted — reported by you, execution not verified',
    'review-ready': 'Review opened — inspect current project changes',
    accepted: 'Accepted — your review decision',
    'changes-requested': 'Changes requested — your review decision',
};

export function AgentTaskRunPanel(props: {
    run?: TaskRun;
    storageWarning: boolean;
    transitionReady: boolean;
    reviewing: boolean;
    notice: string;
    onSubmitted: () => void;
    onReview: () => void;
    onAccept: () => void;
    onChanges: () => void;
}): React.ReactElement | null {
    const { run } = props;
    if (!run) return null;
    const canSubmit = props.transitionReady && run.phase === 'prepared';
    const canReview = props.transitionReady && !props.reviewing && (run.phase === 'submitted' || run.phase === 'review-ready');
    const canDecide = props.transitionReady && !props.reviewing && run.phase === 'review-ready';
    return <section data-testid="task-run-panel" aria-label="Task review" style={{ borderTop: '1px solid #ffffff14', marginTop: 6, paddingTop: 6 }}>
        <div className="omo-console-row"><strong data-testid="task-run-phase" data-phase={run.phase}>{PHASE_LABEL[run.phase]}</strong></div>
        <pre data-testid="task-run-text" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 100, overflowY: 'auto', margin: '4px 0', font: 'inherit' }}>{run.text}</pre>
        <p className="omo-console-hint">This record is your control note. Decisions send no terminal input and perform no Git writes. They are not proof of execution, tests, completion or ownership.</p>
        <div className="omo-console-row">
            <button type="button" data-testid="task-run-submitted" disabled={!canSubmit} onClick={props.onSubmitted}>I submitted this in the terminal</button>
            <button type="button" data-testid="task-run-review" disabled={!canReview} onClick={props.onReview}>Review current project changes</button>
            <button type="button" data-testid="task-run-accept" disabled={!canDecide} onClick={props.onAccept}>Accept reviewed result</button>
            <button type="button" data-testid="task-run-changes" disabled={!canDecide} onClick={props.onChanges}>Request changes</button>
        </div>
        {props.storageWarning && <div data-testid="task-run-storage-warning" className="omo-console-hint" role="status">Task review state is held in memory only: browser session storage is unavailable. It may be lost on reload.</div>}
        {props.notice && <div data-testid="task-run-notice" className="omo-console-hint" role="status">{props.notice}</div>}
    </section>;
}
