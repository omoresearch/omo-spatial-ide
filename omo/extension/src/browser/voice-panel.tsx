import * as React from 'react';
import type { VoiceHub, VoiceHubView } from './voice-hub';
import { AgentGlyph } from './agent-glyphs';
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
            {voiceOn && <span className="omo-voice-peers" data-testid="voice-peers">{v.peers.length ? v.peers.map(p => <span key={p.id} data-peer-id={p.id} data-speaking={String(p.speaking)} className={p.speaking ? 'is-speaking' : p.muted ? 'is-muted' : ''} title={`${p.connection} · ${Math.round(p.volume * 100)}% volume${p.distance !== undefined ? ` · ${p.distance} m` : ''}`}>{p.speaking ? '♪ ' : p.muted ? '✕ ' : ''}{p.name}</span>) : <small>No one else has voice on yet.</small>}</span>}
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
        {view.agents.length > 0 && <div className="omo-voice-row omo-agent-roster" data-testid="agent-roster">
            <strong>Agents here</strong>
            {view.agents.map(a => <span key={a.key} className={`omo-agent-chip is-${a.kind} is-${a.activity}`} data-agent-key={a.key} data-activity={a.activity}><AgentGlyph kind={a.kind} />{a.label} <em>{DESK_NAME[a.desk]} · {ACTIVITY[a.activity]}{a.speaking ? ' · speaking' : ''}</em></span>)}
        </div>}
        {(v.error || d.error) && <span role="alert" className="omo-error" data-testid="voice-error">{v.error || d.error}</span>}
        {!v.error && !d.error && (d.notice || v.notice) && <small role="status" data-testid="voice-notice">{d.phase === 'listening' ? '' : d.notice || v.notice}</small>}
    </section>;
}
