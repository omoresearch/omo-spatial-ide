import * as React from 'react';
import type { GitReviewState } from './git-review-controller';
export function GitReviewPanel(props:{state:GitReviewState;onSelect(path:string):void;onRefresh():void;onClose():void;onOpenFile(uri:string):void;onOpenProject():void}):React.ReactElement {
    const host=React.useRef<HTMLElement>(null);
    React.useEffect(()=>{host.current?.focus();},[]);
    const selected=props.state.snapshot?.changes.find(change=>change.path===props.state.selected);
    return <section ref={host} tabIndex={-1} className="omo-git-review" data-testid="git-review-panel" data-phase={props.state.phase} aria-label="Read-only project change review" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();props.onClose();}}}>
        <header><div><h2>Review project changes</h2><p>Read-only · Working tree versus HEAD · Staged and unstaged changes combined</p></div><button data-testid="git-review-refresh" disabled={props.state.phase==='loading'} onClick={props.onRefresh}>Refresh saved changes</button><button onClick={props.onOpenProject}>Open project file</button><button data-testid="git-review-close" onClick={props.onClose}>Back to world</button></header>
        {props.state.error&&<p role="alert" className="omo-error">{props.state.error}</p>}
        <div className="omo-git-review-body"><nav aria-label="Changed project files"><p>{props.state.snapshot?`${props.state.snapshot.branch} · ${props.state.snapshot.head?.slice(0,10)??'No commit yet'}`:'Reading project Git status…'}</p>
            {props.state.snapshot?.changes.map(change=><button key={change.path} data-review-path={change.path} aria-pressed={props.state.selected===change.path} onClick={()=>props.onSelect(change.path)}><code>{change.status}</code><span>{change.path}</span></button>)}
            {props.state.snapshot&&!props.state.snapshot.changes.length&&<p>No saved Git changes in this project.</p>}
            {props.state.snapshot?.truncated&&<p role="status">Showing the first 200 changes. Narrow the project folder to review more.</p>}
        </nav><article><div className="omo-git-review-file"><strong>{props.state.selected??'Choose a changed file'}</strong><button data-testid="git-review-open-file" disabled={!selected?.uri||props.state.loadingPatch} onClick={()=>{if(selected?.uri)props.onOpenFile(selected.uri);}}>Open file in editor</button></div>
            <pre data-testid="git-review-patch" aria-label="Read-only unified Git patch">{props.state.loadingPatch?'Reading patch…':props.state.patch?(props.state.patch.patch||'No net working-tree difference versus HEAD. The index can still differ.'): 'Choose a changed file to read its patch. File contents are not prefetched.'}</pre>
        </article></div><p className="omo-git-review-note">This is a snapshot of saved files. Refresh after edits. No stage, commit, accept or revert action is performed. Terminal and agent sessions keep running.</p>
    </section>;
}
