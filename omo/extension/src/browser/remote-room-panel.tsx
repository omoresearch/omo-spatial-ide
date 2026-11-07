import * as React from 'react';
import { createPortal } from 'react-dom';
import type { RemoteRoomController, RemoteRoomView } from './remote-room-controller';
import type { SavedRemoteRoom } from '../common/remote-room-protocol';

/**
 * Remote room panel (w2 mp-client lane): connection chip, "Join a remote room" (paste invite link),
 * "Host a room" (server URL + owner token), saved rooms, reconnect, invite link, leave.
 * Secrets typed here go to the IDE backend once; the panel never stores them.
 */
const PHASE_LABEL: Record<RemoteRoomView['status']['phase'], string> = {
    idle: 'Local', connecting: 'Connecting…', joined: 'Remote · live', reconnecting: 'Reconnecting…', failed: 'Not connected'
};

export function RemoteRoomChip(props: { view: RemoteRoomView; open: boolean; onToggle(): void }): React.ReactElement {
    const s = props.view.status;
    const label = s.phase === 'joined' ? `${s.roomName ?? s.roomId} · ${s.members.length} here`
        : s.phase === 'reconnecting' ? `Reconnecting${props.view.retryIn !== undefined ? ` in ${props.view.retryIn}s` : '…'}`
            : PHASE_LABEL[s.phase];
    return <button type="button" className="omo-remote-chip" data-testid="remote-room-chip" data-phase={s.phase} aria-expanded={props.open}
        title={s.server ? `${s.server} · room ${s.roomId}` : 'Join or host a remote room'} onClick={props.onToggle}>
        <i aria-hidden="true" className="omo-remote-dot" />{s.phase === 'idle' ? 'Remote room' : label}
    </button>;
}

/** Floating layer on document.body under the chip, so no dock or HUD layer can cover it. */
export function RemoteRoomPopover(props: { anchor: HTMLElement | null; children: React.ReactNode }): React.ReactElement | null {
    const [pos, setPos] = React.useState<{ top: number; left: number }>();
    React.useLayoutEffect(() => {
        const place = (): void => { const r = props.anchor?.getBoundingClientRect(); if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 436)) }); };
        place(); window.addEventListener('resize', place); const t = window.setInterval(place, 500);
        return () => { window.removeEventListener('resize', place); window.clearInterval(t); };
    }, [props.anchor]);
    if (!pos || typeof document === 'undefined') return null;
    return createPortal(<div className="omo-world-widget omo-remote-layer" style={{ top: pos.top, left: pos.left }}>{props.children}</div>, document.body);
}

export function RemoteRoomPanel(props: { controller: RemoteRoomController; view: RemoteRoomView; onClose(): void }): React.ReactElement {
    const { controller, view } = props;
    const s = view.status;
    const [tab, setTab] = React.useState<'join' | 'host'>('join');
    const [name, setName] = React.useState('Builder');
    const [link, setLink] = React.useState('');
    const [server, setServer] = React.useState('');
    const [ownerToken, setOwnerToken] = React.useState('');
    const [roomId, setRoomId] = React.useState('');
    const [roomName, setRoomName] = React.useState('');
    const [seed, setSeed] = React.useState(true);
    const live = s.phase === 'joined' || s.phase === 'reconnecting' || s.phase === 'connecting';
    const busy = view.busy || s.phase === 'connecting';

    return <section className="omo-remote-panel" data-testid="remote-room-panel" aria-label="Remote room">
        <header><strong>Remote room</strong><button type="button" aria-label="Close" onClick={props.onClose}>×</button></header>
        {live ? <div className="omo-remote-live">
            <p data-testid="remote-room-status" role="status">
                {s.phase === 'joined' ? <>Connected to <b>{s.roomName ?? s.roomId}</b> on {s.server}{s.role === 'owner' ? ' · you host this room' : ''}.</>
                    : s.phase === 'reconnecting' ? <>Connection lost. {view.retryIn !== undefined ? `Trying again in ${view.retryIn}s.` : 'Trying again…'} {s.error}</>
                        : 'Connecting…'}
            </p>
            {s.phase === 'joined' && <ul className="omo-remote-members" data-testid="remote-room-members">{s.members.map(m => <li key={m.id}>
                {m.name}{m.id === s.selfId ? ' (you)' : ''}{m.role === 'owner' ? ' · host' : ''}
                {m.agents?.length ? <small> · {m.agents.map(a => `${a.label} ${a.activity}`).join(', ')}</small> : null}
            </li>)}</ul>}
            <div className="omo-remote-actions">
                {s.phase === 'reconnecting' && <button type="button" data-testid="remote-room-retry" onClick={() => void controller.reconnectNow()}>Try now</button>}
                {s.role === 'owner' && s.phase === 'joined' && <button type="button" data-testid="remote-room-invite" onClick={() => void controller.createInvite()}>Create invite link</button>}
                <button type="button" data-testid="remote-room-leave" onClick={() => controller.leave()}>Leave room</button>
            </div>
            {view.invite && <label className="omo-field">Invite link (valid until {new Date(view.invite.expiresAt).toLocaleString()})
                <input readOnly data-testid="remote-room-invite-link" value={view.invite.link} onFocus={e => e.currentTarget.select()} /></label>}
            <small>Shared: the room, avatars, chat, voice and the world layout. Not shared: your terminals and agents stay on this computer.</small>
        </div> : <>
            <nav className="omo-remote-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'join'} data-testid="remote-tab-join" onClick={() => setTab('join')}>Join a remote room</button>
                <button type="button" role="tab" aria-selected={tab === 'host'} data-testid="remote-tab-host" onClick={() => setTab('host')}>Host a room</button>
            </nav>
            <label className="omo-field">Your name<input data-testid="remote-room-name" maxLength={32} value={name} onChange={e => setName(e.target.value)} /></label>
            {tab === 'join' ? <form onSubmit={e => { e.preventDefault(); void controller.joinInvite(link, name); }}>
                <label className="omo-field">Invite link<input data-testid="remote-room-link" placeholder="https://rooms.example.com/omo-room/join/our-room#invite=…" value={link} onChange={e => setLink(e.target.value)} autoComplete="off" spellCheck={false} /></label>
                <button type="submit" className="omo-primary" data-testid="remote-room-join" disabled={busy || !link.trim() || !name.trim()}>{busy ? 'Connecting…' : 'Join room'}</button>
            </form> : <form onSubmit={e => { e.preventDefault(); void controller.hostRoom({ server, ownerToken, roomId, roomName: roomName || undefined, seedCurrent: seed }, name).then(() => setOwnerToken('')); }}>
                <label className="omo-field">Room server<input data-testid="remote-room-server" placeholder="https://rooms.example.com" value={server} onChange={e => setServer(e.target.value)} spellCheck={false} /></label>
                <label className="omo-field">Owner token<input type="password" data-testid="remote-room-owner-token" value={ownerToken} onChange={e => setOwnerToken(e.target.value)} autoComplete="off" /></label>
                <label className="omo-field">Room code<input data-testid="remote-room-code" placeholder="our-room" maxLength={32} value={roomId} onChange={e => setRoomId(e.target.value.toLowerCase())} /></label>
                <label className="omo-field">Room name (optional)<input data-testid="remote-room-title" maxLength={120} value={roomName} onChange={e => setRoomName(e.target.value)} /></label>
                <label className="omo-check"><input type="checkbox" checked={seed} onChange={e => setSeed(e.target.checked)} /> Start a new room from my current room layout</label>
                <button type="submit" className="omo-primary" data-testid="remote-room-host" disabled={busy || !server.trim() || !ownerToken.trim() || !roomId.trim() || !name.trim()}>{busy ? 'Connecting…' : 'Host room'}</button>
                <small>The owner token is used once to open the room. It is not saved.</small>
            </form>}
            {view.saved.length > 0 && <div className="omo-remote-saved" data-testid="remote-room-saved"><span>Rooms you joined before</span>
                {view.saved.map((room: SavedRemoteRoom) => <div key={`${room.server}|${room.roomId}`}>
                    <button type="button" disabled={busy || !name.trim()} onClick={() => void controller.rejoin(room, name)}>{room.roomName} <small>{room.server.replace(/^https?:\/\//, '')}</small></button>
                    <button type="button" aria-label={`Forget ${room.roomName}`} title="Forget this room on this computer" onClick={() => void controller.forget(room)}>Forget</button>
                </div>)}
            </div>}
        </>}
        {(view.error || (s.phase === 'failed' && s.error)) && <p role="alert" className="omo-error" data-testid="remote-room-error">{view.error || s.error}</p>}
    </section>;
}
