import * as React from 'react';
import { WebSurfaceController, WebWallState } from './web-surface-controller';

/** Controls only. The browser itself is painted onto the physical wall in the room. */
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
        <div className="omo-console-row"><span role="status" data-testid="web-status">{props.state.phase === 'live' ? props.state.surface?.title || 'Live web page' : props.state.phase === 'idle' ? 'No browser starts until you open a page.' : props.state.phase === 'loading' ? 'Loading the wall…' : props.state.phase === 'checking' ? 'Checking Chrome…' : 'Web wall needs attention'}</span><span className="omo-console-hint">Own sandboxed Chrome profile · click the physical wall to use it · Esc to walk</span></div>
        {props.state.surface && <div className="omo-console-row"><label><input data-testid="web-muted" type="checkbox" checked={props.state.surface.muted} onChange={event=>void props.controller?.setAudio(event.target.checked,props.state.surface!.volume)}/> Muted</label><label>Page volume <input data-testid="web-volume" type="range" min="0" max="1" step="0.05" value={props.state.surface.volume} onChange={event=>void props.controller?.setAudio(props.state.surface!.muted,Number(event.target.value))}/></label></div>}
        {props.state.error && <div className="omo-console-error" role="alert" data-testid="web-error">{props.state.error}</div>}
    </div>;
}
