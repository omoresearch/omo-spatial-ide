import * as React from 'react';
import type { PresenceState } from './presence-controller';
export function PresenceStrip(props:{state:PresenceState;onJoin(code:string,name:string):void;onLeave():void;deskRoom?:string}):React.ReactElement {
    const [code,setCode]=React.useState('');
    const [name,setName]=React.useState('Builder');
    const joined=props.state.phase==='joined';
    return <section className="omo-presence-bar" data-testid="presence-bar" data-phase={props.state.phase} aria-label="Local shared-room presence">
        {joined?<><strong>Room: {props.state.snapshot?.roomId}</strong><button data-testid="presence-leave" onClick={props.onLeave}>Leave room</button></>:<>
            <label>Name <input data-testid="presence-name" aria-label="Your shared-room display name" maxLength={32} value={name} onChange={event=>setName(event.target.value)}/></label>
            <label>Room code <input data-testid="presence-code" aria-label="Shared room code" maxLength={32} placeholder="e.g. our-workshop" value={code} onChange={event=>setCode(event.target.value)}/></label>
            <button data-testid="presence-join" disabled={props.state.phase==='joining'} onClick={()=>props.onJoin(code,name)}>{props.state.phase==='joining'?'Joining…':'Join room'}</button>
        </>}
        <span className="omo-presence-members" data-testid="presence-members">{props.state.snapshot?.members.map(member=><span key={member.id} data-peer-id={member.id}>{member.name}{member.id===props.state.snapshot?.selfId?' (you)':''}</span>)}</span>
        <small>{props.deskRoom?`Personal desks: ${props.deskRoom} · `:''}Local trusted clients only · No terminal sharing</small>
        {props.state.error&&<span role="alert" className="omo-error">{props.state.error}</span>}
    </section>;
}
