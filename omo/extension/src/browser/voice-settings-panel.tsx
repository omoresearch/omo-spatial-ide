import * as React from 'react';
import type { RoomVoiceController, RoomVoiceState } from './voice-controller';
import type { OmoVoiceSettingsService, StunMode, TurnAuthMode, VoiceNetworkView } from '../common/voice-settings-protocol';
import { DEFAULT_STUN_URLS, iceUrl } from '../common/voice-settings-protocol';

/**
 * Voice settings (w2 voice lane): devices + processing (this browser, localStorage) and
 * network STUN/TURN (backend, Theia config dir, 0600). Secrets are write-only here: the panel
 * shows "saved" and never reads a password or shared secret back.
 */
export function VoiceSettingsPanel(props: { voice?: RoomVoiceController; state: RoomVoiceState; settings?: OmoVoiceSettingsService; onClose(): void }): React.ReactElement {
    const { voice, state } = props;
    const p = state.prefs;
    React.useEffect(() => { void voice?.refreshDevices(); }, [voice]);
    const on = state.phase === 'on';
    return <section className="omo-voice-settings" data-testid="voice-settings" aria-label="Voice settings">
        <header><strong>Voice settings</strong><button data-testid="voice-settings-close" onClick={props.onClose}>Close</button></header>
        <fieldset>
            <legend>Devices</legend>
            <label>Microphone
                <select data-testid="voice-input-device" value={p.inputId} onChange={e => { void voice?.setInput({ inputId: e.target.value }); }}>
                    <option value="">System default</option>
                    {state.devices.inputs.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
            </label>
            <label>Speaker
                <select data-testid="voice-output-device" value={p.outputId} disabled={!state.devices.outputSelectable} title={state.devices.outputSelectable ? '' : 'This browser uses the system speaker'} onChange={e => { void voice?.setOutput(e.target.value); }}>
                    <option value="">System default</option>
                    {state.devices.outputs.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
            </label>
            {!on && state.devices.inputs.every(d => /^Microphone \d+$/.test(d.label)) && <small>Device names show after you allow the microphone once.</small>}
            <div className="omo-voice-input-meter" data-testid="voice-input-meter" aria-label="Microphone input level" data-level={state.level.toFixed(3)}>
                <i style={{ width: `${Math.min(100, Math.round(state.level * 600))}%` }} className={state.level > 0.02 ? 'is-loud' : ''}/>
                <span>{on ? (state.level > 0.02 ? 'Input: hearing you' : 'Input: quiet') : 'Turn on voice to see the input level'}</span>
            </div>
        </fieldset>
        <fieldset>
            <legend>Sound processing</legend>
            <label className="omo-voice-check"><input type="checkbox" data-testid="voice-echo" checked={p.echoCancellation} onChange={e => { void voice?.setInput({ echoCancellation: e.target.checked }); }}/> Echo cancellation</label>
            <label className="omo-voice-check"><input type="checkbox" data-testid="voice-noise" checked={p.noiseSuppression} onChange={e => { void voice?.setInput({ noiseSuppression: e.target.checked }); }}/> Noise suppression</label>
            <label className="omo-voice-check"><input type="checkbox" data-testid="voice-agc" checked={p.autoGainControl} onChange={e => { void voice?.setInput({ autoGainControl: e.target.checked }); }}/> Automatic gain</label>
            <label className="omo-voice-check"><input type="checkbox" data-testid="voice-spatial" checked={state.spatial} onChange={e => voice?.setSpatial(e.target.checked)}/> 3D voices (direction from avatars)</label>
            <label className="omo-voice-check"><input type="checkbox" data-testid="voice-proximity-settings" checked={state.proximity} onChange={e => voice?.setProximity(e.target.checked)}/> Quieter with distance</label>
            <small>Use headphones with echo cancellation off. Turn echo cancellation on for laptop speakers.</small>
        </fieldset>
        <VoiceNetworkSettings settings={props.settings} onSaved={() => { void voice?.reloadNetwork(); }} state={state}/>
    </section>;
}

interface Draft { stun: StunMode; stunUrls: string; turnOn: boolean; turnUrls: string; mode: TurnAuthMode; username: string; credential: string; relayOnly: boolean }

function draftOf(view: VoiceNetworkView): Draft {
    return { stun: view.stun, stunUrls: view.stunUrls.join('\n'), turnOn: !!view.turn, turnUrls: view.turn?.urls.join('\n') ?? '', mode: view.turn?.mode ?? 'rest-secret', username: view.turn?.username ?? '', credential: '', relayOnly: view.relayOnly };
}
const lines = (text: string) => text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);

export function VoiceNetworkSettings(props: { settings?: OmoVoiceSettingsService; state: RoomVoiceState; onSaved(): void }): React.ReactElement {
    const [view, setView] = React.useState<VoiceNetworkView>();
    const [draft, setDraft] = React.useState<Draft>();
    const [status, setStatus] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        let live = true;
        props.settings?.get().then(v => { if (live) { setView(v); setDraft(draftOf(v)); } }).catch(error => { if (live) setStatus(`Could not read voice network settings: ${String(error)}`); });
        return () => { live = false; };
    }, [props.settings]);
    if (!props.settings) return <fieldset><legend>Network</legend><small>Public STUN only (no settings service).</small></fieldset>;
    if (!draft || !view) return <fieldset><legend>Network</legend><small>{status || 'Reading…'}</small></fieldset>;
    const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setStatus(''); };
    const urlError = (() => {
        try {
            if (draft.stun === 'custom') lines(draft.stunUrls).forEach(u => iceUrl(u, ['stun', 'stuns']));
            if (draft.turnOn) lines(draft.turnUrls).forEach(u => iceUrl(u, ['turn', 'turns']));
            return '';
        } catch (error) { return error instanceof Error ? error.message : String(error); }
    })();
    const save = async () => {
        setBusy(true); setStatus('');
        try {
            const next = await props.settings!.save({
                stun: draft.stun, stunUrls: lines(draft.stunUrls), relayOnly: draft.turnOn && draft.relayOnly,
                turn: draft.turnOn ? { urls: lines(draft.turnUrls), mode: draft.mode, username: draft.username.trim() || undefined, ...(draft.credential ? draft.mode === 'static' ? { credential: draft.credential } : { secret: draft.credential } : {}) } : null
            });
            setView(next); setDraft(draftOf(next)); setStatus('Saved. Voice links switch to the new servers now.');
            props.onSaved();
        } catch (error) { setStatus(String(error instanceof Error ? error.message : error).replace(/^Error: /, '')); }
        finally { setBusy(false); }
    };
    const keep = view.turn?.hasCredential && view.turn.mode === draft.mode;
    return <fieldset data-testid="voice-network">
        <legend>Network (works across the internet)</legend>
        <label>Address discovery (STUN)
            <select data-testid="voice-stun-mode" value={draft.stun} onChange={e => set({ stun: e.target.value as StunMode })}>
                <option value="default">Public STUN (default)</option>
                <option value="custom">My own STUN servers</option>
                <option value="off">Off (same network only)</option>
            </select>
        </label>
        {draft.stun === 'default' && <small>{DEFAULT_STUN_URLS.join(' · ')}. These servers see your public IP address, never audio.</small>}
        {draft.stun === 'custom' && <textarea data-testid="voice-stun-urls" rows={2} placeholder="stun:stun.example.com:3478" value={draft.stunUrls} onChange={e => set({ stunUrls: e.target.value })}/>}
        <label className="omo-voice-check"><input type="checkbox" data-testid="voice-turn-on" checked={draft.turnOn} onChange={e => set({ turnOn: e.target.checked })}/> Use my TURN relay (coturn) for strict NATs and firewalls</label>
        {draft.turnOn && <>
            <textarea data-testid="voice-turn-urls" rows={2} placeholder={'turn:turn.example.com:3478?transport=udp\nturns:turn.example.com:5349?transport=tcp'} value={draft.turnUrls} onChange={e => set({ turnUrls: e.target.value })}/>
            <label>Sign-in
                <select data-testid="voice-turn-mode" value={draft.mode} onChange={e => set({ mode: e.target.value as TurnAuthMode, credential: '' })}>
                    <option value="rest-secret">Shared secret (coturn use-auth-secret) — recommended</option>
                    <option value="static">User name and password</option>
                </select>
            </label>
            <label>{draft.mode === 'static' ? 'User name' : 'User label (optional)'}
                <input data-testid="voice-turn-username" value={draft.username} autoComplete="off" onChange={e => set({ username: e.target.value })}/>
            </label>
            <label>{draft.mode === 'static' ? 'Password' : 'Shared secret'}
                <input data-testid="voice-turn-credential" type="password" autoComplete="new-password" value={draft.credential} placeholder={keep ? 'Saved — leave empty to keep' : ''} onChange={e => set({ credential: e.target.value })}/>
            </label>
            {draft.mode === 'rest-secret' && <small>The secret stays on this computer. Omo gives the browser a short-lived sign-in (12 h) made from it.</small>}
            <label className="omo-voice-check"><input type="checkbox" data-testid="voice-relay-only" checked={draft.relayOnly} onChange={e => set({ relayOnly: e.target.checked })}/> Relay only (hide my IP address from peers)</label>
        </>}
        <div className="omo-voice-settings-actions">
            <button data-testid="voice-network-save" disabled={busy || !!urlError} onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save network settings'}</button>
            <span data-testid="voice-network-status" role="status" className={urlError || /could not|must|need|enter|add|invalid|not a|out of range/i.test(status) ? 'omo-error' : ''}>{urlError || status}</span>
        </div>
        <small>Saved in {view.file} on this computer. Never in the room file, never shared with peers. Now: {props.state.network.hasTurn ? 'TURN on' : 'no TURN'}{props.state.network.relayOnly ? ' · relay only' : ''} · {props.state.network.stunServers} STUN.</small>
    </fieldset>;
}
