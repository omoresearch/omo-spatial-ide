import * as React from 'react';
import { collectTaskOverview } from './task-overview';
import type { TaskOverviewResult, TaskOverviewStorage } from './task-overview';
import type { TaskRun, TaskRunPhase } from './agent-task-run';

const PHASE_LABEL: Record<TaskRunPhase, string> = {
    prepared: 'Pasted — not submitted',
    submitted: 'Submitted — reported by you, execution not verified',
    'review-ready': 'Review opened — inspect current project changes',
    accepted: 'Accepted — your review decision',
    'changes-requested': 'Changes requested — your review decision',
};

const PHASE_MEANING: Record<TaskRunPhase, string> = {
    prepared: 'The task text was prepared. It was not submitted.',
    submitted: 'The user reported a submission. Execution is not verified.',
    'review-ready': 'The project review was opened. This is not a completion signal.',
    accepted: 'The user recorded an accepted review note. It is not proof of completion or ownership.',
    'changes-requested': 'The user recorded a changes-requested review note. It is not proof of completion or ownership.',
};

const EMPTY_RESULT: TaskOverviewResult = { entries: [], storageUnavailable: false, truncated: false };
const TASK_TEXT_PREVIEW_MAX_CHARS = 180;

function taskTextPreview(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact.length <= TASK_TEXT_PREVIEW_MAX_CHARS) return compact;
    return `${compact.slice(0, TASK_TEXT_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

function browserStorage(): TaskOverviewStorage | undefined {
    try {
        if (typeof window === 'undefined') return undefined;
        const storage = window.sessionStorage;
        if (!storage || typeof storage.getItem !== 'function' || typeof storage.key !== 'function') return undefined;
        return storage;
    } catch {
        return undefined;
    }
}

function entryKey(entry: TaskRun): string {
    return JSON.stringify([entry.target.projectUri, entry.target.stationId, entry.target.workspaceId, entry.target.tabId]);
}

function load(projectUri: string, storage: TaskOverviewStorage | undefined): TaskOverviewResult {
    return collectTaskOverview(storage, projectUri);
}

export interface TaskOverviewPanelProps {
    projectUri: string;
    storage?: TaskOverviewStorage;
    onClose: () => void;
}

/** A read-only, browser-tab-local view of the latest task records. */
export function TaskOverviewPanel(props: TaskOverviewPanelProps): React.ReactElement {
    const storage = props.storage !== undefined ? props.storage : browserStorage();
    const [loaded, setLoaded] = React.useState<{ projectUri: string; result: TaskOverviewResult }>(() => ({
        projectUri: props.projectUri,
        result: load(props.projectUri, storage),
    }));
    const [selectedKey, setSelectedKey] = React.useState<string | undefined>(() => {
        const first = load(props.projectUri, storage).entries[0];
        return first ? entryKey(first) : undefined;
    });

    React.useEffect(() => {
        const result = load(props.projectUri, storage);
        setLoaded({ projectUri: props.projectUri, result });
        setSelectedKey(result.entries[0] ? entryKey(result.entries[0]) : undefined);
    }, [props.projectUri, storage]);

    const refresh = React.useCallback(() => {
        const result = load(props.projectUri, storage);
        setLoaded({ projectUri: props.projectUri, result });
        setSelectedKey(previous => result.entries.some(entry => entryKey(entry) === previous)
            ? previous
            : result.entries[0] ? entryKey(result.entries[0]) : undefined);
    }, [props.projectUri, storage]);

    // During the one render between a project prop change and its effect, hide
    // the old records. This prevents stale details from crossing project scope.
    const result = loaded.projectUri === props.projectUri ? loaded.result : EMPTY_RESULT;
    const selected = result.entries.find(entry => entryKey(entry) === selectedKey);

    return <section className="omo-panel" data-testid="task-overview-panel" aria-label="Task overview">
        <header className="omo-panel-header">
            <div>
                <h2>Task overview</h2>
                <p className="omo-panel-meta">Project: {props.projectUri}</p>
            </div>
            <div className="omo-panel-actions">
                <button type="button" data-testid="task-overview-refresh" onClick={refresh}>Refresh</button>
                <button type="button" data-testid="task-overview-close" onClick={props.onClose}>Close</button>
            </div>
        </header>

        <p role="note" className="omo-panel-note">
            Browser-tab-only latest records. This is not live execution, completion, or ownership monitoring.
        </p>
        {result.storageUnavailable && <p role="alert" data-testid="task-overview-storage-warning">
            Browser session storage is unavailable. No task history was confirmed; records may be missing after reload.
        </p>}
        {result.truncated && <p role="status">Some records were outside the safe overview limit and are not shown.</p>}
        {!result.storageUnavailable && result.entries.length === 0 && <p role="status">No task-run records are available for this project in this browser tab.</p>}

        {result.entries.length > 0 && <div aria-label="Task records" className="omo-panel-list">
            {result.entries.map(entry => {
                const key = entryKey(entry);
                const selectedEntry = key === selectedKey;
                return <button
                    type="button"
                    key={key}
                    data-testid="task-overview-entry"
                    aria-pressed={selectedEntry}
                    onClick={() => setSelectedKey(key)}
                >
                    <strong>{PHASE_LABEL[entry.phase]}</strong>
                    <span data-testid="task-overview-entry-preview">{taskTextPreview(entry.text)}</span>
                    <small>Desk {entry.target.stationId} · Workspace {entry.target.workspaceId} · Tab {entry.target.tabId}</small>
                </button>;
            })}
        </div>}

        <article className="omo-panel-detail" data-testid="task-overview-detail" aria-live="polite">
            {selected ? <>
                <h3>{PHASE_LABEL[selected.phase]}</h3>
                <p>{PHASE_MEANING[selected.phase]}</p>
                <dl>
                    <dt>Project</dt><dd>{selected.target.projectUri}</dd>
                    <dt>Desk</dt><dd>{selected.target.stationId}</dd>
                    <dt>Workspace</dt><dd>{selected.target.workspaceId}</dd>
                    <dt>Tab</dt><dd>{selected.target.tabId}</dd>
                </dl>
                <h4>Task text</h4>
                <pre style={{ userSelect: 'text' }}>{selected.text}</pre>
            </> : <p>Select a task record to read its details.</p>}
        </article>
    </section>;
}
