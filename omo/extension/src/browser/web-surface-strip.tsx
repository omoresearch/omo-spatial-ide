import * as React from 'react';
import { WebSurfaceController, WebWallState } from './web-surface-controller';
import type { WebSurface, WebTab } from '../common/web-runtime-protocol';

/**
 * Controls only. The browser itself is painted onto the physical wall in the room.
 * Tab strip (PARITY "web-wall tabs"): links that open a new window (target=_blank, window.open)
 * become tabs of this wall, up to six; the wall shows the active tab. A tab the leak guard put to
 * sleep (12 live pages across all walls) keeps its title and reloads when picked.
 */
function tabLabel(tab: WebTab): string {
    if (tab.title.trim()) return tab.title.trim();
    try { return new URL(tab.url).host || 'New tab'; } catch { return 'New tab'; }
}
const TAB_LABEL: React.CSSProperties = { maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' };
export function WebTabStrip(props: { surface: WebSurface; controller?: WebSurfaceController }): React.ReactElement | null {
    const tabs = props.surface.tabs ?? [];
    if (tabs.length < 2) return null;
    return <div className="omo-console-tabs omo-web-tabs" role="tablist" aria-label="Web wall tabs" data-testid="web-tabs">
        {tabs.map(tab => <span key={tab.id} className={`omo-console-tab omo-web-tab ${tab.active ? 'active' : ''}`} data-testid={`web-tab-${tab.id}`}>
            <button type="button" role="tab" aria-selected={tab.active} title={tab.url} data-testid="web-tab-select" style={tab.sleeping ? { ...TAB_LABEL, opacity: 0.6, fontStyle: 'italic' } : TAB_LABEL} onClick={() => void props.controller?.selectTab(tab.id)}>
                {tab.loading ? '… ' : ''}{tabLabel(tab)}
            </button>
            <button type="button" className="omo-console-mini" aria-label={`Close tab ${tabLabel(tab)}`} data-testid="web-tab-close" onClick={() => void props.controller?.closeTab(tab.id)}>×</button>
        </span>)}
    </div>;
}
export function WebSurfaceStrip(props: { state: WebWallState; controller?: WebSurfaceController; initialUrl?: string }): React.ReactElement {
    const [url, setUrl] = React.useState(props.initialUrl ?? '');
    React.useEffect(() => { if (props.state.surface?.url) setUrl(props.state.surface.url); }, [props.state.surface?.url]);
    const waiting = props.state.phase === 'checking' || props.state.phase === 'loading';
    return <div className="omo-console-strip" data-testid="web-controls" data-phase={props.state.phase}>
        <form className="omo-console-row" onSubmit={event => { event.preventDefault(); void props.controller?.open(url); }}>
            <label className="omo-web-address">Web address <input data-testid="web-address" aria-label="Web address" value={url} onChange={event => setUrl(event.target.value)} placeholder="localhost:3000 or example.com" spellCheck={false}/></label>
            <button data-testid="web-open" disabled={waiting || !url.trim()}>{props.state.surface ? 'Go' : 'Open wall'}</button>
            <button type="button" data-testid="web-close" disabled={!waiting && !props.state.surface} onClick={()=>void props.controller?.close()}>Close page</button>
        </form>
        {props.state.surface && <WebTabStrip surface={props.state.surface} controller={props.controller}/>}
        <div className="omo-console-row"><span role="status" data-testid="web-status">{props.state.phase === 'live' ? props.state.surface?.title || 'Live web page' : props.state.phase === 'idle' ? 'No browser starts until you open a page.' : props.state.phase === 'loading' ? 'Loading the wall…' : props.state.phase === 'checking' ? 'Checking Chrome…' : 'Web wall needs attention'}</span><span className="omo-console-hint">Own sandboxed Chrome profile · click the physical wall to use it · links that open a new window open as tabs (up to 6) · Esc to walk</span></div>
        {props.state.surface && <div className="omo-console-row"><label><input data-testid="web-muted" type="checkbox" checked={props.state.surface.muted} onChange={event=>void props.controller?.setAudio(event.target.checked,props.state.baseVolume ?? props.state.surface!.volume)}/> Muted</label><label>Page volume <input data-testid="web-volume" type="range" min="0" max="1" step="0.05" value={props.state.baseVolume ?? props.state.surface.volume} onChange={event=>void props.controller?.setAudio(props.state.surface!.muted,Number(event.target.value))}/></label><span data-testid="web-gain">Gain {Math.round((props.state.gain ?? 1) * 100)}% · {Math.round(props.state.distance ?? 0)} units</span></div>}
        {props.state.error && <div className="omo-console-error" role="alert" data-testid="web-error">{props.state.error}</div>}
    </div>;
}
