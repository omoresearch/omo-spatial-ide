import * as React from 'react';
import type { SessionTab } from '../common/runtime-protocol';
import { AGENT_LABELS, RuntimeConsoleController, RuntimeConsoleState, TAB_NAME_MAX, launcherOptions } from './runtime-console-controller';

const STATE_LABEL: Record<SessionTab['state'], string> = { running: 'running', exited: 'exited', interrupted: 'interrupted', sleeping: 'asleep', unknown: 'unknown' };

/** Compact world overlay for the terminal station. It manages tabs; the monitor itself stays the terminal. */
export function RuntimeConsoleStrip(props: { state: RuntimeConsoleState; controller?: RuntimeConsoleController }): React.ReactElement {
    const { state, controller } = props;
    const ws = state.workspace;
    const [editing, setEditing] = React.useState<{ tabId: string; name: string }>();
    React.useEffect(() => setEditing(undefined), [ws?.id]);
    const launchers = launcherOptions(state.host);
    const locked = !ws || state.acting || !!state.pending;
    const hint = launchers.filter(o => !o.available && o.installHint).map(o => `${o.label}: ${o.installHint}`).join(' · ');
    return <div className="omo-console-strip" data-testid="runtime-console" data-phase={state.phase} aria-label="Terminal station tabs">
        <div className="omo-console-row">
            <span className={`omo-console-dot is-${state.phase}`} aria-hidden="true" />
            <span className="omo-console-status" role="status" data-testid="runtime-status">{state.statusText}</span>
            {ws && <span className="omo-console-ws" title={ws.projectUri}>{ws.name}</span>}
        </div>
        {ws && <div className="omo-console-tabs" role="tablist" aria-label="Workspace tabs">
            {ws.tabs.map(tab => <span key={tab.id} className={`omo-console-tab kind-${tab.kind} state-${tab.state} ${tab.id === state.activeTabId ? 'active' : ''}`}>
                <button role="tab" aria-selected={tab.id === state.activeTabId} data-testid={`runtime-tab-${tab.id}`} disabled={state.acting}
                    title={`${AGENT_LABELS[tab.kind]} · ${STATE_LABEL[tab.state]}${tab.detail ? ` · ${tab.detail}` : ''}`}
                    onClick={() => void controller?.selectTab(tab.id)}>
                    {tab.name}{tab.busy && <i className="omo-console-busy" aria-label="working"> ●</i>}
                    {tab.state !== 'running' && <small> {STATE_LABEL[tab.state]}</small>}
                </button>
                {(tab.state === 'interrupted' || tab.state === 'exited') && <button className="omo-console-mini" disabled={locked} data-testid={`runtime-revive-${tab.id}`} onClick={() => controller?.requestRevive(tab.id)} title="Start this tab again">↻</button>}
                <button className="omo-console-mini" aria-label={`Rename ${tab.name}`} disabled={locked} data-testid={`runtime-rename-${tab.id}`} onClick={() => setEditing({ tabId: tab.id, name: tab.name })} title="Rename tab">✎</button>
                <button className="omo-console-mini" aria-label={`Close ${tab.name}`} disabled={locked} data-testid={`runtime-close-${tab.id}`} onClick={() => controller?.requestClose(tab.id)} title="Close tab">×</button>
            </span>)}
        </div>}
        {ws && editing && <form className="omo-console-row" data-testid="runtime-rename-form" onSubmit={event => { event.preventDefault(); void controller?.renameTab(editing.tabId, editing.name).then(saved => { if (saved) setEditing(undefined); }); }}>
            <label>Tab name <input autoFocus aria-label="Tab name" data-testid="runtime-rename-name" maxLength={TAB_NAME_MAX} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
            <button data-testid="runtime-rename-save" disabled={locked || !editing.name.trim()}>Save name</button>
            <button type="button" onClick={() => setEditing(undefined)}>Cancel</button>
        </form>}
        {ws && <div className="omo-console-row omo-console-new">
            <span className="omo-console-label">New</span>
            {launchers.map(o => <button key={o.kind} data-testid={`runtime-new-${o.kind}`} disabled={locked || !o.available}
                title={o.available ? `Open a new ${o.label} tab` : `${o.reason}${o.installHint ? ` — install: ${o.installHint}` : ''}`}
                onClick={() => void controller?.requestNewTab(o.kind)}>+ {o.label}</button>)}
            {!!state.host?.profiles.length && <label className="omo-console-profile">Profile
                <select data-testid="runtime-profile" value={state.profile} disabled={locked} onChange={event => controller?.setProfile(event.target.value)}>
                    {state.host.profiles.map(p => <option key={p} value={p}>{p}</option>)}
                </select></label>}
        </div>}
        {ws && hint && <div className="omo-console-hint" data-testid="runtime-install-hint">Not installed — {hint}</div>}
        {state.pending && <div className="omo-console-confirm" role="alertdialog" aria-label="Confirm" data-testid="runtime-confirm">
            <p>{state.pending.message}</p>
            <button className="omo-console-go" data-testid="runtime-confirm-yes" onClick={() => void controller?.confirmPending()}>{state.pending.confirmLabel}</button>
            <button data-testid="runtime-confirm-no" onClick={() => controller?.cancelPending()}>Cancel</button>
        </div>}
        {state.acting && <div className="omo-console-hint">Working…</div>}
        {state.error && <div className="omo-console-error" role="alert" data-testid="runtime-error">{state.error}</div>}
        {!state.error && state.notice && <div className="omo-console-hint" data-testid="runtime-notice">{state.notice}</div>}
    </div>;
}
