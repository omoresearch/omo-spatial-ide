import * as React from 'react';
import type { VoiceHub, VoiceHubView } from './voice-hub';
import { AgentGlyph } from './agent-glyphs';
import { VoiceSettingsPanel } from './voice-settings-panel';
import { VoiceCheckPanel } from './voice-settings-check';
import type { VoicePeerState } from './voice-controller';
import '../../src/browser/voice.css';

import { DESK_NAME } from './chat-mentions'; // w2:runtime: names of every world station
const ACTIVITY: Record<string, string> = { working: 'working', idle: 'idle', background: 'running', sleeping: 'asleep', interrupted: 'interrupted', exited: 'ended' };

/** Room voice, talk-to-agent dictation, read-aloud and the agent roster. Every switch is an explicit click. */
export function VoicePanel(props: { hub: VoiceHub; view: VoiceHubView }): React.ReactElement {
    const { hub, view } = props;
    const v = view.voice, d = view.dictation;
    const voiceOn = v.phase === 'on';
    const holdTalk = (held: boolean) => (event: React.PointerEvent) => { event.preventDefault(); hub.voice?.setPushHeld(held); };
    const holdDictate = (event: React.PointerEvent) => { event.preventDefault(); hub.startDictation(view.aimed ?? undefined); };
    const [open, setOpen] = React.useState<'' | 'settings' | 'check'>('');
    const toggle = (which: 'settings' | 'check') => setOpen(open === which ? '' : which);
    return <section className="omo-voice-panel" data-testid="voice-panel" data-voice-phase={v.phase} data-transmitting={String(v.transmitting)} aria-label="Voice and agents">
        <div className="omo-voice-row">
            <strong>Room voice</strong>
            {!view.supported ? <small>This browser has no microphone or WebRTC support.</small>
                : !voiceOn ? <button data-testid="voice-enable" disabled={!view.joined || v.phase === 'starting'} title={view.joined ? 'Ask for microphone permission and join room voice' : 'Join a shared room first'} onClick={() => { void hub.voice?.enable(); }}>{v.phase === 'starting' ? 'Starting…' : '🎙 Turn on voice'}</button>
                : <>
                    <button data-testid="voice-disable" onClick={() => { void hub.voice?.disable(); }}>Turn off</button>
                    <span className="omo-voice-seg" role="group" aria-label="Talk mode">
                        <button data-testid="voice-mode-push" aria-pressed={v.mode === 'push'} onClick={() => hub.voice?.setMode('push')}>Push-to-talk (V)</button>
                        <button data-testid="voice-mode-open" aria-pressed={v.mode === 'open'} onClick={() => hub.voice?.setMode('open')}>Open mic</button>
                    </span>
                    <button data-testid="voice-mute" aria-pressed={v.muted} onClick={() => hub.voice?.toggleMuted()}>{v.muted ? '🔇 Muted (M)' : '🔈 Mute (M)'}</button>
                    {v.mode === 'push' && <button data-testid="voice-ptt" className={v.pushHeld ? 'is-held' : ''} onPointerDown={holdTalk(true)} onPointerUp={holdTalk(false)} onPointerLeave={holdTalk(false)}>Hold to talk</button>}
                    <label className="omo-voice-check"><input type="checkbox" data-testid="voice-proximity" checked={v.proximity} onChange={e => hub.voice?.setProximity(e.target.checked)}/> Distance volume</label>
                    <span className={`omo-voice-meter ${v.transmitting ? 'is-live' : ''} ${v.speaking ? 'is-speaking' : ''}`} data-testid="voice-self" aria-label={v.transmitting ? 'Your microphone is live' : 'Your microphone is not sending'}><i style={{ width: `${Math.min(100, Math.round(v.level * 900))}%` }}/>{v.transmitting ? (v.speaking ? 'Speaking' : 'Live') : v.muted ? 'Muted' : 'Not sending'}</span>
                </>}
            {view.supported && <span className="omo-voice-tools">
                <button data-testid="voice-settings-toggle" aria-expanded={open === 'settings'} onClick={() => toggle('settings')}>⚙ Settings</button>
                <button data-testid="voice-check-toggle" aria-expanded={open === 'check'} onClick={() => toggle('check')}>Voice check</button>
            </span>}
            {voiceOn && <span className="omo-voice-peers" data-testid="voice-peers">{v.peers.length ? v.peers.map(p => <PeerChip key={p.id} peer={p} hub={hub}/>) : <small>No one else has voice on yet.</small>}</span>}
        </div>
        <div className="omo-voice-row">
            <strong>Talk to agents</strong>
            {d.availability === 'unsupported' ? <small data-testid="dictation-unsupported">{d.notice || 'On-device speech recognition is not available in this browser.'}</small>
                : d.availability === 'checking' ? <small>Checking on-device speech…</small>
                : d.availability === 'downloadable' || d.availability === 'downloading' ? <button data-testid="dictation-install" disabled={d.availability === 'downloading'} onClick={() => { void hub.dictation.installModel(); }}>{d.availability === 'downloading' ? 'Downloading speech model…' : 'Download on-device speech'}</button>
                : d.phase === 'off' || d.phase === 'error' ? <button data-testid="dictation-enable" onClick={() => hub.dictation.enable()}>🗣 Turn on dictation</button>
                : <>
                    <button data-testid="dictation-disable" onClick={() => hub.dictation.disable()}>Turn off</button>
                    <button data-testid="dictation-hold" className={d.phase === 'listening' ? 'is-held' : ''} disabled={!view.aimed} title={view.aimed ? `Dictate into ${DESK_NAME[view.aimed]}` : 'Look at an agent monitor'} onPointerDown={holdDictate} onPointerUp={() => hub.finishDictation()} onPointerLeave={() => { if (d.phase === 'listening') hub.finishDictation(); }}>Hold T to dictate{view.aimed ? ` · ${DESK_NAME[view.aimed]}` : ''}</button>
                    {d.phase === 'listening' && <span className="omo-voice-interim" data-testid="dictation-interim">“{d.interim || '…'}” → {d.targetLabel}</span>}
                </>}
            <label className="omo-voice-check"><input type="checkbox" data-testid="readaloud-toggle" disabled={!view.readAloud.supported} checked={view.readAloud.enabled} onChange={e => hub.setReadAloud(e.target.checked)}/> Read replies to dictation aloud</label>
            {view.readAloud.speaking && <button data-testid="readaloud-stop" onClick={() => hub.readAloud.stop()}>Stop reading</button>}
            <small>Drafts are never sent: press Enter yourself.</small>
        </div>
        {open === 'settings' && <VoiceSettingsPanel voice={hub.voice} state={v} settings={hub.settings} onClose={() => setOpen('')}/>}
        {open === 'check' && <VoiceCheckPanel state={v} settings={hub.settings} onClose={() => setOpen('')}/>}
        {view.agents.length > 0 && <div className="omo-voice-row omo-agent-roster" data-testid="agent-roster">
            <strong>Agents here</strong>
            {view.agents.map(a => <span key={a.key} className={`omo-agent-chip is-${a.kind} is-${a.activity}`} data-agent-key={a.key} data-activity={a.activity}><AgentGlyph kind={a.kind} />{a.label} <em>{DESK_NAME[a.desk]} · {ACTIVITY[a.activity]}{a.speaking ? ' · speaking' : ''}</em></span>)}
        </div>}
        {(v.error || d.error) && <span role="alert" className="omo-error" data-testid="voice-error">{v.error || d.error}</span>}
        {!v.error && !d.error && (d.notice || v.notice) && <small role="status" data-testid="voice-notice">{d.phase === 'listening' ? '' : d.notice || v.notice}</small>}
    </section>;
}

function side(direction?: number): string {
    if (direction === undefined) return '';
    const a = Math.abs(direction);
    return a <= 30 ? 'ahead' : a >= 150 ? 'behind' : direction > 0 ? 'right' : 'left';
}

/** One voice peer: status, link path, and this user's own volume / mute for them (local only). */
function PeerChip(props: { peer: VoicePeerState; hub: VoiceHub }): React.ReactElement {
    const { peer: p, hub } = props;
    const title = `${p.connection}${p.path ? ` · ${p.path}` : ''}${p.rttMs !== undefined ? ` · ${p.rttMs} ms` : ''} · ${Math.round(p.volume * 100)}% playback${p.distance !== undefined ? ` · ${p.distance} m ${side(p.direction)}` : ''}${p.restarts ? ` · ${p.restarts} reconnects` : ''}`;
    return <span data-peer-id={p.id} data-speaking={String(p.speaking)} data-connection={p.connection} data-path={p.path ?? ''} data-volume={p.volume}
        className={`omo-voice-peer ${p.speaking ? 'is-speaking' : p.muted ? 'is-muted' : ''} ${p.connection === 'connected' ? 'is-connected' : 'is-linking'}`} title={title}>
        <span className="omo-voice-peer-name">{p.speaking ? '♪ ' : p.muted ? '✕ ' : ''}{p.name}{p.connection !== 'connected' && <em> · {p.connection === 'waiting' || p.connection === 'new' ? 'linking…' : p.connection}</em>}</span>
        <input type="range" min={0} max={200} step={5} value={Math.round(p.personalVolume * 100)} aria-label={`Volume for ${p.name}`} data-testid="voice-peer-volume"
            onChange={e => hub.voice?.setPersonVolume(p.id, Number(e.target.value) / 100)}/>
        <button data-testid="voice-peer-mute" aria-pressed={p.personalMuted} title={p.personalMuted ? `Unmute ${p.name} for me` : `Mute ${p.name} for me`} onClick={() => hub.voice?.setPersonMuted(p.id, !p.personalMuted)}>{p.personalMuted ? '🔇' : '🔈'}</button>
    </span>;
}
