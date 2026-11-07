import * as React from 'react';
import type { AgentSignalsService } from '../common/agent-signals-protocol';
import type { OmoRuntimeService, SessionWorkspace } from '../common/runtime-protocol';
import { AgentCheckController, AgentCheckState } from './agent-check';
import { AGENT_LABELS } from './runtime-console-controller';

/**
 * w2:agents — Real agent check panel.
 * Explicit Run, then a confirmation that names every tab it will start (one per installed agent).
 * It sends nothing to the agents; it only records the states it observes, to a JSON file in the Omo data dir.
 */
export function AgentCheckPanel(props: { runtime: OmoRuntimeService; signals: AgentSignalsService; workspace?: SessionWorkspace; profile: string }): React.ReactElement {
    const [state, setState] = React.useState<AgentCheckState>({ phase: 'idle', kinds: [], observations: [], message: '' });
    const live = React.useRef({ workspace: props.workspace, profile: props.profile });
    live.current = { workspace: props.workspace, profile: props.profile };
    const controller = React.useMemo(() => new AgentCheckController({
        runtime: props.runtime, signals: props.signals, workspace: () => live.current.workspace, profile: () => live.current.profile,
        now: () => Date.now(), sleep: ms => new Promise(resolve => window.setTimeout(resolve, ms)), onChange: setState
    }), [props.runtime, props.signals]);
    React.useEffect(() => () => controller.stop(), [controller]);
    const running = state.phase === 'starting' || state.phase === 'observing' || state.phase === 'saving';
    return <section className="omo-agent-check" data-testid="agent-check" data-phase={state.phase} aria-label="Real agent check">
        <div className="omo-console-row">
            <span className="omo-console-label">Real agent check</span>
            {!running && state.phase !== 'confirm' && <button type="button" data-testid="agent-check-run" onClick={() => void controller.requestRun()}>Run…</button>}
            {state.phase === 'observing' && <button type="button" data-testid="agent-check-stop" onClick={() => controller.stop()}>Stop watching and save</button>}
        </div>
        <p className="omo-console-hint">Starts one tab per installed agent on this desk, after you confirm. It types nothing into them and approves nothing. It records the states it sees to a JSON file in the Omo data folder.</p>
        {state.phase === 'confirm' && <div className="omo-console-confirm" role="alertdialog" aria-label="Confirm real agent check" data-testid="agent-check-confirm">
            <p>Start these {state.kinds.length} tab{state.kinds.length === 1 ? '' : 's'} in “{props.workspace?.name ?? 'this desk'}”?</p>
            <ul data-testid="agent-check-kinds">{state.kinds.map(kind => <li key={kind}>{AGENT_LABELS[kind]}{kind === 'hermes' ? ` (profile “${props.profile}”)` : ''}</li>)}</ul>
            <p>Each runs on this computer under your own account and may use your plan or API credits. They keep running after the check; close them yourself.</p>
            <button className="omo-console-go" data-testid="agent-check-confirm-yes" onClick={() => void controller.confirmRun()}>Start {state.kinds.length} tab{state.kinds.length === 1 ? '' : 's'}</button>
            <button data-testid="agent-check-confirm-no" onClick={() => controller.cancel()}>Cancel</button>
        </div>}
        {!!state.observations.length && <table data-testid="agent-check-results" style={{ fontSize: 10, width: '100%' }}>
            <thead><tr><th align="left">Agent</th><th align="left">Started</th><th align="left">Last seen</th></tr></thead>
            <tbody>{state.observations.map(o => { const last = o.states[o.states.length - 1]; return <tr key={o.kind} data-testid={`agent-check-row-${o.kind}`}>
                <td>{AGENT_LABELS[o.kind as keyof typeof AGENT_LABELS] ?? o.kind}</td>
                <td>{o.started ? 'yes' : `no${o.error ? `: ${o.error}` : ''}`}</td>
                <td>{last ? `${last.tabState} · ${last.status}${last.source !== 'none' ? ` (${last.source})` : ''} · ${o.states.length} change${o.states.length === 1 ? '' : 's'}` : '—'}</td>
            </tr>; })}</tbody>
        </table>}
        {state.message && <div className={state.phase === 'error' ? 'omo-console-error' : 'omo-console-hint'} role={state.phase === 'error' ? 'alert' : 'status'} data-testid="agent-check-message">{state.message}</div>}
    </section>;
}
