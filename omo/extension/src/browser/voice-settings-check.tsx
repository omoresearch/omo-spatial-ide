import * as React from 'react';
import type { RoomVoiceState } from './voice-controller';
import { defaultIceConfig } from './voice-controller';
import type { OmoVoiceSettingsService, VoiceIceConfig } from '../common/voice-settings-protocol';
import { IceGatherResult, LoopbackHandle, gatherIce, iceVerdict, recordClip, startLoopback } from './voice-check';

/**
 * Voice check (w2 voice lane): ICE candidate types, WebRTC loopback, record-and-play 3 s.
 * Every test starts from a click. Nothing is sent to other people or uploaded.
 */
export function VoiceCheckPanel(props: { state: RoomVoiceState; settings?: OmoVoiceSettingsService; onClose(): void }): React.ReactElement {
    const prefs = props.state.prefs;
    const [ice, setIce] = React.useState<IceGatherResult>();
    const [iceConfig, setIceConfig] = React.useState<VoiceIceConfig>();
    const [iceBusy, setIceBusy] = React.useState(false);
    const [loop, setLoop] = React.useState<{ handle: LoopbackHandle; state: string; path?: string; level: number }>();
    const [rec, setRec] = React.useState<{ phase: 'idle' | 'recording' | 'ready' | 'playing'; url?: string; bytes?: number; level: number }>({ phase: 'idle', level: 0 });
    const [error, setError] = React.useState('');
    const loopRef = React.useRef<LoopbackHandle>();
    const urlRef = React.useRef<string>();
    React.useEffect(() => () => { loopRef.current?.stop(); if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
    React.useEffect(() => {
        if (!loop) return;
        const timer = window.setInterval(() => { void loop.handle.path().then(path => setLoop(l => l && l.handle === loop.handle ? { ...l, path, level: l.handle.level() } : l)); }, 300);
        return () => window.clearInterval(timer);
    }, [loop?.handle]);

    const config = async (): Promise<VoiceIceConfig> => {
        try { return props.settings ? await props.settings.iceConfig() : defaultIceConfig(); } catch { return defaultIceConfig(); }
    };
    const runIce = async () => {
        setIceBusy(true); setError('');
        try { const c = await config(); setIceConfig(c); setIce(await gatherIce(c)); }
        catch (e) { setError(`ICE test failed: ${String(e)}`); } finally { setIceBusy(false); }
    };
    const toggleLoop = async () => {
        if (loop) { loop.handle.stop(); loopRef.current = undefined; setLoop(undefined); return; }
        setError('');
        try {
            const c = await config(); setIceConfig(c);
            const handle = await startLoopback(c, prefs, prefs.outputId, state => setLoop(l => l && l.handle === handle ? { ...l, state } : l));
            loopRef.current = handle;
            setLoop({ handle, state: 'connecting', level: 0 });
        } catch (e) { setError(`Loopback failed: ${e instanceof Error ? e.message : String(e)}`); }
    };
    const record = async () => {
        setError('');
        if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = undefined; }
        setRec({ phase: 'recording', level: 0 });
        try {
            const clip = await recordClip(prefs, 3000, level => setRec(r => r.phase === 'recording' ? { ...r, level } : r));
            urlRef.current = clip.url;
            setRec({ phase: 'ready', url: clip.url, bytes: clip.bytes, level: 0 });
        } catch (e) { setRec({ phase: 'idle', level: 0 }); setError(`Recording failed: ${e instanceof Error ? e.message : String(e)}`); }
    };
    const play = () => {
        if (!rec.url) return;
        const audio = new Audio(rec.url);
        const setSink = (audio as unknown as { setSinkId?(id: string): Promise<void> }).setSinkId;
        if (prefs.outputId && setSink) void setSink.call(audio, prefs.outputId).catch(() => undefined);
        setRec(r => ({ ...r, phase: 'playing' }));
        audio.onended = () => setRec(r => ({ ...r, phase: 'ready' }));
        void audio.play().catch(e => { setRec(r => ({ ...r, phase: 'ready' })); setError(`Playback failed: ${String(e)}`); });
    };

    return <section className="omo-voice-check-panel" data-testid="voice-check" aria-label="Voice check">
        <header><strong>Voice check</strong><button data-testid="voice-check-close" onClick={() => { loop?.handle.stop(); props.onClose(); }}>Close</button></header>
        <div className="omo-voice-check-row">
            <button data-testid="voice-check-ice" disabled={iceBusy} onClick={() => { void runIce(); }}>{iceBusy ? 'Testing network…' : 'Test network (ICE)'}</button>
            {ice && <span data-testid="voice-check-ice-result" data-host={ice.counts.host} data-srflx={ice.counts.srflx} data-relay={ice.counts.relay} data-prflx={ice.counts.prflx}>
                <b className="omo-cand is-host">host {ice.counts.host}</b> <b className="omo-cand is-srflx">srflx {ice.counts.srflx}</b> <b className="omo-cand is-relay">relay {ice.counts.relay}</b> · {ice.ms} ms
            </span>}
        </div>
        {ice && iceConfig && <>
            <p data-testid="voice-check-ice-verdict">{iceVerdict(ice, iceConfig)}</p>
            <details><summary>Candidates ({ice.candidates.length}){ice.errors.length ? ` · ${ice.errors.length} server errors` : ''}</summary>
                <ul className="omo-voice-candidates">{ice.candidates.map((c, i) => <li key={i}><b className={`omo-cand is-${c.type}`}>{c.type}</b> {c.protocol} {c.address}{c.url ? ` via ${c.url}` : ''}</li>)}
                    {ice.errors.map((e, i) => <li key={`e${i}`} className="omo-error">{e}</li>)}</ul>
            </details>
        </>}
        <div className="omo-voice-check-row">
            <button data-testid="voice-check-loopback" aria-pressed={!!loop} onClick={() => { void toggleLoop(); }}>{loop ? 'Stop loopback' : 'Loopback test (hear yourself)'}</button>
            {loop && <span data-testid="voice-check-loopback-state" data-state={loop.state} data-path={loop.path ?? ''}>Link: {loop.state}{loop.path ? ` · path ${loop.path}` : ''}
                <span className="omo-voice-input-meter is-inline"><i style={{ width: `${Math.min(100, Math.round(loop.level * 600))}%` }}/></span></span>}
        </div>
        {loop && <small>Your voice goes through a real WebRTC link inside this tab{iceConfig?.iceTransportPolicy === 'relay' ? ' and your TURN relay' : ''}, then to your speaker. Use headphones to avoid feedback.</small>}
        <div className="omo-voice-check-row">
            <button data-testid="voice-check-record" disabled={rec.phase === 'recording' || rec.phase === 'playing'} onClick={() => { void record(); }}>{rec.phase === 'recording' ? 'Recording 3 s…' : 'Record 3 s'}</button>
            <button data-testid="voice-check-play" disabled={rec.phase !== 'ready'} onClick={play}>{rec.phase === 'playing' ? 'Playing…' : 'Play it back'}</button>
            {rec.phase === 'recording' && <span className="omo-voice-input-meter is-inline"><i style={{ width: `${Math.min(100, Math.round(rec.level * 600))}%` }}/></span>}
            {rec.bytes !== undefined && <small data-testid="voice-check-record-result" data-bytes={rec.bytes}>{Math.round(rec.bytes / 1024)} KB recorded on this computer only.</small>}
        </div>
        {error && <span role="alert" className="omo-error" data-testid="voice-check-error">{error}</span>}
    </section>;
}
