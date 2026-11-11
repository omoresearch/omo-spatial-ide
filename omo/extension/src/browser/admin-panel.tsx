import * as React from 'react';
import type { WorldOp } from '../common/world-model';
import { ADMIN_EXAMPLES, ADMIN_PROMPT_PLACEHOLDER } from '../common/world-admin-rules';
import { WORLD_ADMIN_PROMPT_MAX } from '../common/world-admin-protocol';
import type { AdminController, AdminEntry, AdminState } from './admin-controller';
import '../../src/browser/admin.css';

/**
 * w2:admin — the in-world Admin console. Ask in plain words; get a proposal (summary + op list,
 * plus ghosts in the room when the world store supports preview); Apply or Discard.
 * Nothing changes without Apply. Hermes is used only after "Use Hermes" + confirm.
 */
const OP_ICON: Record<WorldOp['op'], string> = {
    add: '+', remove: '−', move: '↔', 'update-station': '⚙', resize: '⤢', link: '⛓', rename: '✎', shell: '▢', name: '✎', reshape: '⤡'
};

function time(at: number): string { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function Entry(props: { entry: AdminEntry; active: boolean; busy: boolean; controller: AdminController }): React.ReactElement {
    const { entry, active, controller } = props;
    const plan = entry.plan;
    const proposal = plan?.proposal ?? undefined;
    return <li className={`omo-admin-entry is-${entry.status}${active ? ' is-active' : ''}`} data-testid="admin-entry" data-status={entry.status}>
        <div className="omo-admin-you"><time>{time(entry.at)}</time><b>You</b><span>{entry.prompt}</span></div>
        <div className="omo-admin-reply">
            <b>{entry.planner === 'hermes' ? 'Hermes admin' : 'Admin'}</b>
            {entry.status === 'thinking'
                ? <span className="omo-admin-thinking" role="status">{entry.planner === 'hermes' ? 'Asking Hermes (no tools, one answer)…' : 'Planning…'}</span>
                : <span data-testid="admin-explanation">{plan?.explanation ?? entry.outcome ?? ''}</span>}
            {proposal && <div className="omo-admin-proposal" data-testid="admin-proposal">
                <div className="omo-admin-summary"><span className="omo-admin-kicker">PROPOSAL · {proposal.ops.length} change{proposal.ops.length === 1 ? '' : 's'}</span><strong>{proposal.summary}</strong></div>
                <ol className="omo-admin-ops" data-testid="admin-ops">
                    {proposal.ops.map((op, i) => <li key={i} data-op={op.op}><i aria-hidden="true">{OP_ICON[op.op] ?? '•'}</i><span>{plan?.steps[i] ?? op.op}</span></li>)}
                </ol>
                {plan && plan.notes.length > 0 && <ul className="omo-admin-notes">{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                {entry.status === 'proposed' && <div className="omo-admin-actions">
                    <button type="button" className="omo-admin-apply" data-testid="admin-apply" onClick={() => controller.apply(entry.id)}>Apply</button>
                    <button type="button" className="omo-admin-discard" data-testid="admin-discard" onClick={() => controller.discard(entry.id)}>Discard</button>
                    <small>Nothing changes until you press Apply. Applying never starts an agent.</small>
                </div>}
            </div>}
            {entry.outcome && entry.status !== 'thinking' && (proposal || entry.status === 'failed') && plan?.explanation !== entry.outcome && <p className={`omo-admin-outcome is-${entry.status}`} role="status">{entry.outcome}</p>}
        </div>
    </li>;
}

export function AdminPanel(props: { controller: AdminController; state: AdminState; worldName?: string; previewSupported: boolean }): React.ReactElement | null {
    const { controller, state } = props;
    const [text, setText] = React.useState('');
    const input = React.useRef<HTMLTextAreaElement>(null);
    const log = React.useRef<HTMLOListElement>(null);
    React.useEffect(() => { if (state.open) input.current?.focus({ preventScroll: true }); }, [state.open]);
    React.useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [state.entries.length, state.entries[state.entries.length - 1]?.status]);
    if (!state.open) return null;
    const submit = (): void => { const value = text.trim(); if (!value || state.busy) return; setText(''); void controller.ask(value); };
    const hermesOn = state.useHermes && state.hermesConfirmed;
    return <section className="omo-admin-panel" data-testid="admin-panel" role="dialog" aria-label="World admin"
        onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); controller.toggle(false); } }}
        onPointerDown={event => event.stopPropagation()}>
        <header>
            <span className="omo-admin-glyph" aria-hidden="true">⌬</span>
            <div><strong>World admin</strong><small>{props.worldName ? `Editing “${props.worldName}”` : 'Edit this world in plain words'}</small></div>
            {state.entries.length > 0 && <button type="button" className="omo-admin-clear" onClick={() => controller.clear()} title="Clear the conversation">Clear</button>}
            <button type="button" className="omo-admin-close" data-testid="admin-close" aria-label="Close the admin" onClick={() => controller.toggle(false)}><kbd>Esc</kbd>✕</button>
        </header>
        <ol className="omo-admin-log" ref={log} aria-live="polite">
            {state.entries.length === 0 && <li className="omo-admin-empty">
                <p>Ask for a change. You get a plan first. You choose to apply it.</p>
                <div className="omo-admin-examples">{ADMIN_EXAMPLES.slice(0, 6).map(example => <button type="button" key={example} onClick={() => { setText(example); input.current?.focus(); }}>{example}</button>)}</div>
            </li>}
            {state.entries.map(entry => <Entry key={entry.id} entry={entry} active={entry.id === state.activeId} busy={state.busy} controller={controller} />)}
        </ol>
        {!props.previewSupported && state.entries.some(e => e.status === 'proposed') && <p className="omo-admin-hint">Preview is the change list. Ghosts in the room arrive with the build mode.</p>}
        {state.error && <p className="omo-admin-error" role="alert">{state.error}</p>}
        <div className="omo-admin-hermes">
            <label><input type="checkbox" data-testid="admin-use-hermes" checked={state.useHermes || state.confirmingHermes} disabled={state.busy}
                onChange={event => controller.setUseHermes(event.currentTarget.checked)} /> Use Hermes</label>
            <label className="omo-admin-profile">Profile<input data-testid="admin-profile" value={state.profile} maxLength={64} spellCheck={false} disabled={state.busy}
                onChange={event => controller.setProfile(event.currentTarget.value)} /></label>
            <span className={`omo-admin-planner${hermesOn ? ' is-hermes' : ''}`}>{hermesOn ? `Hermes · ${state.profile}` : 'Built-in planner · no model'}</span>
        </div>
        {state.confirmingHermes && <div className="omo-admin-confirm" data-testid="admin-hermes-confirm" role="alertdialog" aria-label="Confirm Hermes use">
            <p><strong>Use your local Hermes for world plans?</strong></p>
            <p>Each request runs Hermes once with profile “{state.profile || 'default'}”: no tools, no shell, no files, a {90} second limit. It may use your model account. The answer is only a plan; you still press Apply.</p>
            <p className="omo-admin-status">{state.hermes ? state.hermes.message : 'Checking Hermes…'}</p>
            <div className="omo-admin-actions">
                <button type="button" className="omo-admin-apply" data-testid="admin-hermes-yes" disabled={!state.hermes || !state.hermes.available || state.hermes.busy} onClick={() => controller.confirmHermes()}>Use Hermes</button>
                <button type="button" className="omo-admin-discard" onClick={() => controller.cancelHermes()}>Keep built-in</button>
                <button type="button" className="omo-admin-clear" onClick={() => void controller.refreshHermes()}>Check again</button>
            </div>
        </div>}
        <form className="omo-admin-ask" onSubmit={event => { event.preventDefault(); submit(); }}>
            <textarea ref={input} data-testid="admin-prompt" rows={2} maxLength={WORLD_ADMIN_PROMPT_MAX} value={text} placeholder={ADMIN_PROMPT_PLACEHOLDER}
                onChange={event => setText(event.currentTarget.value)}
                onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
            <button type="submit" data-testid="admin-ask" disabled={!text.trim() || state.busy}>{state.busy ? '…' : 'Plan'}</button>
        </form>
    </section>;
}

/** Toolbar button for the header / tool dock. */
export function AdminButton(props: { open: boolean; disabled?: boolean; onClick: () => void }): React.ReactElement {
    return <button type="button" data-testid="admin-toggle" className={`omo-admin-toggle${props.open ? ' active' : ''}`} aria-expanded={props.open} disabled={props.disabled}
        title="World admin (H)" onMouseDown={event => event.preventDefault()} onClick={props.onClick}>⌬ Admin <kbd>H</kbd></button>;
}
