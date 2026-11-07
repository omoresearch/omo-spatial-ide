import * as React from 'react';
import type { AgentSignalsService, ClaudeStatusPlan } from '../common/agent-signals-protocol';

/**
 * w2:agents — 'Enable Claude status' button.
 *
 * Shows the exact hook JSON and the target file in the Omo data dir, and writes it only after the
 * user presses the confirm button. Omo-started Claude tabs then load it with `claude --settings`.
 * The user's own ~/.claude settings are never read or changed.
 */
export function ClaudeStatusPanel(props: { service: Pick<AgentSignalsService, 'claudeStatus' | 'enableClaudeStatus' | 'disableClaudeStatus'> }): React.ReactElement {
    const [plan, setPlan] = React.useState<ClaudeStatusPlan>();
    const [confirm, setConfirm] = React.useState<'enable' | 'disable'>();
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const load = React.useCallback(async () => {
        try { setPlan(await props.service.claudeStatus()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }, [props.service]);
    React.useEffect(() => { void load(); }, [load]);
    const act = async (fn: () => Promise<ClaudeStatusPlan>): Promise<void> => {
        setBusy(true); setError('');
        try { setPlan(await fn()); setConfirm(undefined); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    };
    return <section className="omo-claude-status" data-testid="claude-status" aria-label="Claude status">
        <div className="omo-console-row">
            <span className="omo-console-label">Claude status</span>
            <span className="omo-console-hint" data-testid="claude-status-state">{plan ? (plan.enabled ? 'on' : plan.foreign ? 'blocked' : 'off') : 'checking…'}</span>
            {plan && !plan.enabled && !plan.foreign && !confirm && <button type="button" data-testid="claude-status-enable" disabled={busy} onClick={() => setConfirm('enable')}>Enable Claude status…</button>}
            {plan?.enabled && !confirm && <button type="button" data-testid="claude-status-disable" disabled={busy} onClick={() => setConfirm('disable')}>Turn off…</button>}
        </div>
        {plan && <p className="omo-console-hint" data-testid="claude-status-detail">{plan.detail}</p>}
        {plan && confirm === 'enable' && <div className="omo-console-confirm" role="alertdialog" aria-label="Confirm Claude status" data-testid="claude-status-confirm">
            <p>Omo will write this file:</p>
            <code data-testid="claude-status-file" style={{ overflowWrap: 'anywhere' }}>{plan.settingsFile}</code>
            <p>with exactly this content:</p>
            <pre data-testid="claude-status-json" style={{ maxHeight: 180, overflow: 'auto', fontSize: 10, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{plan.json}</pre>
            <p>Each hook runs <code>{plan.hookScript}</code>. It adds one line (event name, notification type, session id, time) to <code>{plan.eventsFile}</code>. It never saves prompts, tool input or output.
                Only Claude tabs that Omo starts or revives after this load the file, with <code>claude --settings</code>. Your own ~/.claude settings are not changed. Tabs already running are not changed.</p>
            <button className="omo-console-go" data-testid="claude-status-confirm-yes" disabled={busy} onClick={() => void act(() => props.service.enableClaudeStatus({ confirmedWrite: true, json: plan.json }))}>Write this file</button>
            <button data-testid="claude-status-confirm-no" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button>
        </div>}
        {plan && confirm === 'disable' && <div className="omo-console-confirm" role="alertdialog" aria-label="Turn off Claude status" data-testid="claude-status-confirm">
            <p>Remove <code>{plan.settingsFile}</code>? New Claude tabs then start without <code>--settings</code>. Tabs already running keep their hooks until they end.</p>
            <button className="omo-console-go" data-testid="claude-status-confirm-yes" disabled={busy} onClick={() => void act(() => props.service.disableClaudeStatus({ confirmedRemove: true }))}>Remove file</button>
            <button data-testid="claude-status-confirm-no" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button>
        </div>}
        {error && <div className="omo-console-error" role="alert" data-testid="claude-status-error">{error}</div>}
    </section>;
}
