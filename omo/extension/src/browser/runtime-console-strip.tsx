import * as React from 'react';
import type { SessionTab } from '../common/runtime-protocol';
import { AGENT_LABELS, PASTE_LIMIT_BYTES, RuntimeConsoleController, RuntimeConsoleState, TAB_NAME_MAX, WORKSPACE_NAME_MAX, launcherOptions } from './runtime-console-controller';

const STATE_LABEL: Record<SessionTab['state'], string> = { running: 'running', exited: 'exited', interrupted: 'interrupted', sleeping: 'asleep', unknown: 'unknown' };

const DRAWER_STYLE: React.CSSProperties = { maxHeight: 220, overflowY: 'auto', borderTop: '1px solid #ffffff14', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 6 };
const FIELD_STYLE: React.CSSProperties = { background: '#17232c', color: '#cfdeda', border: '1px solid #ffffff1a', borderRadius: 4, fontSize: 10, padding: '2px 4px' };

/**
 * Bounded "Manage" drawer: workspace board, find/scrollback, copy/paste, profile and keep-awake.
 * Copy hands text to the browser only on an explicit click (navigator clipboard WRITE). Paste takes
 * text the user typed or dropped into the box; this file never reads a device clipboard.
 */
function ManageDrawer(props: { state: RuntimeConsoleState; controller?: RuntimeConsoleController; locked: boolean }): React.ReactElement {
    const { state, controller, locked } = props;
    const ws = state.workspace!;
    const [query, setQuery] = React.useState(state.find?.query ?? '');
    const [paste, setPaste] = React.useState('');
    const [wsName, setWsName] = React.useState<string>();
    const [copied, setCopied] = React.useState('');
    const pasteBytes = new TextEncoder().encode(paste).length;
    const multiLine = paste.replace(/\r\n?/g, '\n').replace(/\n+$/, '').includes('\n');
    const pasteBlocked = !paste || pasteBytes > PASTE_LIMIT_BYTES || (multiLine && state.bracketedPaste !== true);
    const copyScreen = async (): Promise<void> => {
        const text = await controller?.copyScreen() ?? '';
        if (!text) return;
        try { await navigator.clipboard.writeText(text); setCopied(`Copied ${text.length} characters.`); } catch { setCopied('The browser refused clipboard access. Select the text below and copy it yourself.'); }
    };
    const agentTabs = ws.tabs.filter(t => t.kind !== 'shell');
    return <div data-testid="runtime-manage" role="region" aria-label="Manage terminal" style={DRAWER_STYLE}>
        <form className="omo-console-row" onSubmit={e => { e.preventDefault(); void controller?.find(query, 0); }}>
            <span className="omo-console-label">Find</span>
            <input data-testid="runtime-find-input" aria-label="Find in history" style={FIELD_STYLE} maxLength={200} value={query} onChange={e => setQuery(e.target.value)} />
            <button type="button" data-testid="runtime-find-older" disabled={!query} onClick={() => void controller?.find(query, 1)} title="Older match">▲</button>
            <button type="button" data-testid="runtime-find-newer" disabled={!query} onClick={() => void controller?.find(query, -1)} title="Newer match">▼</button>
            {state.find && <span className="omo-console-hint">{state.find.count ? `${state.find.index} of ${state.find.count}` : 'no match'}</span>}
            {state.find && <button type="button" onClick={() => { setQuery(''); void controller?.find('', 0); }}>Clear find</button>}
        </form>
        <div className="omo-console-row">
            <span className="omo-console-label">Scroll</span>
            <button data-testid="runtime-scroll-up" onClick={() => void controller?.scroll(10)} title="Ten lines older">▲ 10</button>
            <button data-testid="runtime-scroll-down" onClick={() => void controller?.scroll(-10)} title="Ten lines newer">▼ 10</button>
            <button data-testid="runtime-scroll-live" disabled={!state.scrollOffset} onClick={() => void controller?.scroll(-100000)}>Back to live</button>
            <span className="omo-console-hint">{state.scrollOffset ? `${state.scrollOffset} lines back` : 'live'}{state.history !== undefined ? ` · ${state.history} lines of history` : ''}</span>
            <button data-testid="runtime-clear-history" disabled={locked} onClick={() => controller?.requestClearHistory()}>Clear scrollback…</button>
        </div>
        <div className="omo-console-row">
            <span className="omo-console-label">Copy</span>
            <button data-testid="runtime-copy-screen" onClick={() => void copyScreen()} title="Copy the visible screen to this browser's clipboard">Copy screen</button>
            {copied && <span className="omo-console-hint">{copied}</span>}
        </div>
        <form className="omo-console-row" onSubmit={e => { e.preventDefault(); void controller?.paste(paste).then(ok => { if (ok) setPaste(''); }); }}>
            <span className="omo-console-label">Paste</span>
            <textarea data-testid="runtime-paste-input" aria-label="Text to paste" rows={2} style={{ ...FIELD_STYLE, flex: '1 1 160px', resize: 'vertical' }} value={paste} onChange={e => setPaste(e.target.value)} placeholder="Type or drop text here, then Send" />
            <button data-testid="runtime-paste-send" disabled={pasteBlocked}>Send</button>
            <span className="omo-console-hint">{pasteBytes > PASTE_LIMIT_BYTES ? `Too large (limit ${PASTE_LIMIT_BYTES / 1024} KiB).`
                : state.bracketedPaste === true ? 'Multi-line text arrives as one block and waits for Enter.'
                    : 'This program has not turned on bracketed paste: paste one line at a time.'}</span>
        </form>
        <div className="omo-console-row">
            {!!state.host?.profiles.length && <label className="omo-console-profile">Workspace profile (new tabs)
                <select data-testid="runtime-ws-profile" value={ws.profile} disabled={locked} onChange={e => void controller?.setWorkspaceProfile(e.target.value)}>
                    {state.host.profiles.map(p => <option key={p} value={p}>{p}</option>)}
                </select></label>}
            <label className="omo-console-profile"><input type="checkbox" data-testid="runtime-keep-awake" checked={!!ws.keepAwake} disabled={locked} onChange={e => void controller?.setKeepAwake(e.target.checked)} /> Keep awake (auto-sleep is off)</label>
        </div>
        {!!agentTabs.length && <div className="omo-console-row">
            <span className="omo-console-label">Resume</span>
            {agentTabs.map(t => <button key={t.id} data-testid={`runtime-resume-${t.id}`} disabled={locked || t.busy || t.state !== 'running'}
                title={t.busy ? 'Working right now' : t.state !== 'running' ? 'Not running: revive it first' : `Start ${AGENT_LABELS[t.kind]} again in its idle shell`}
                onClick={() => controller?.requestResume(t.id)}>{t.name}</button>)}
        </div>}
        <div className="omo-console-row">
            <span className="omo-console-label">Workspace</span>
            {wsName === undefined
                ? <button data-testid="runtime-ws-rename" disabled={locked} onClick={() => setWsName(ws.name)}>Rename “{ws.name}”</button>
                : <form className="omo-console-row" onSubmit={e => { e.preventDefault(); void controller?.renameWorkspace(ws.id, wsName).then(ok => { if (ok) setWsName(undefined); }); }}>
                    <input data-testid="runtime-ws-name" aria-label="Workspace name" style={FIELD_STYLE} maxLength={WORKSPACE_NAME_MAX} value={wsName} onChange={e => setWsName(e.target.value)} />
                    <button disabled={locked || !wsName.trim()}>Save</button><button type="button" onClick={() => setWsName(undefined)}>Cancel</button>
                </form>}
            <button data-testid="runtime-board-refresh" onClick={() => void controller?.refreshBoard()}>{state.board ? 'Refresh list' : 'All workspaces'}</button>
        </div>
        {state.board && <ul data-testid="runtime-board" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {state.board.map(b => <li key={b.id} className="omo-console-row" data-testid={`runtime-board-${b.id}`}>
                <span title={b.projectUri}>{b.name}{b.id === ws.id ? ' (here)' : ''}</span>
                <span className="omo-console-hint">{b.state} · {b.tabs.length} tab{b.tabs.length === 1 ? '' : 's'}{b.tabs.some(t => t.busy) ? ' · working' : ''}{b.stations.length ? ` · stations: ${b.stations.join(', ')}` : ''}</span>
                {b.id !== ws.id && b.projectUri === ws.projectUri && <button data-testid={`runtime-board-bind-${b.id}`} disabled={locked} onClick={() => void controller?.bindToWorkspace(b.id)}>Show here</button>}
                {b.id !== ws.id && <button data-testid={`runtime-board-delete-${b.id}`} disabled={locked} onClick={() => controller?.requestDeleteWorkspace(b.id)}>Delete…</button>}
            </li>)}
            <li className="omo-console-row"><button data-testid="runtime-board-delete-current" disabled={locked} onClick={() => controller?.requestDeleteWorkspace(ws.id)}>Delete this workspace…</button></li>
        </ul>}
    </div>;
}

/** Compact world overlay for the terminal station. It manages tabs; the monitor itself stays the terminal. */
export function RuntimeConsoleStrip(props: { state: RuntimeConsoleState; controller?: RuntimeConsoleController; initialDrawer?: boolean }): React.ReactElement {
    const { state, controller } = props;
    const ws = state.workspace;
    const [drawer, setDrawer] = React.useState(!!props.initialDrawer);
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
            {state.unreadBells > 0 && <button data-testid="runtime-bell-ack" className="omo-bell-alert" onClick={() => controller?.acknowledgeBells()} title="Clear this desk's visual bell signal only; no command is sent">Acknowledge bell ({state.unreadBells})</button>}
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
            <button data-testid="runtime-manage-toggle" aria-expanded={drawer} onClick={() => setDrawer(!drawer)} title="Find, scrollback, copy, paste and workspaces">{drawer ? 'Manage ▴' : 'Manage ▾'}</button>
        </div>}
        {ws && drawer && <ManageDrawer state={state} controller={controller} locked={locked} />}
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
