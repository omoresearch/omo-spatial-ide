import * as React from 'react';
import type { HudHub } from './hud-hub';
import type { VoiceHub } from './voice-hub';
import type { PresenceState } from './presence-controller';
import { colourHex } from './hud-peers';
import { Icon } from './icons';
import { NOTICES_TOGGLE_EVENT } from './immersive-mode';
import '../../src/browser/immersive.css';
import '../../src/browser/world-chrome.css';

/** Keys stay on the world: a click on the bar does not take focus away from the canvas. */
const keepKeys = (event: React.MouseEvent): void => { event.preventDefault(); };

export type WorldView = 'world' | 'tasks' | 'code';

/**
 * world-ui — the ONE slim floating top bar shown while the room fills the window (44 px glass).
 *   left:   the room name + the people in the room (click = share and join)
 *   centre: World / Tasks / Code (one segmented control)
 *   right:  voice, agent notifications, settings, share, ⌘K
 * Everything else (name, room code / join, desks, station recipes, agents, speech, voice check,
 * settings, customise) lives in the ⌘K palette and the settings sheet.
 * Every control is an explicit click. Nothing here starts an agent, sends input or presses Enter.
 */
export function WorldTopBar(props: {
    roomName: string; view: WorldView; presence: PresenceState; hud?: HudHub; voice?: VoiceHub; error?: string;
    onView(view: WorldView): void; onShare(): void; onPalette(): void; onSettings(): void;
}): React.ReactElement {
    const { hud, voice } = props;
    const unread = hud?.state.unreadNotices ?? 0;
    const view = voice?.state, v = view?.voice;
    const voiceOn = v?.phase === 'on';
    const voiceReady = !!view?.supported && !!view?.joined;
    const voiceTitle = !view?.supported ? 'Voice is not available in this browser'
        : !view.joined ? 'Voice: join a shared room first (opens Share)'
        : voiceOn ? (v?.muted ? 'Unmute (M)' : 'Mute (M)') : 'Turn on voice';
    const snapshot = props.presence.phase === 'joined' ? props.presence.snapshot : undefined;
    const members = snapshot?.members ?? [];
    const shown = members.slice(0, 3);
    const peopleTitle = snapshot ? `${members.length} in ${snapshot.roomId} · Share and join` : 'Just you · Share this room';
    const views: { id: WorldView; label: string; testid: string }[] = [
        { id: 'world', label: 'World', testid: 'topbar-view-world' },
        { id: 'tasks', label: 'Tasks', testid: 'topbar-view-tasks' },
        { id: 'code', label: 'Code', testid: 'topbar-view-code' }
    ];
    const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    return <nav className="omo-topbar" data-testid="world-topbar" aria-label="World">
        <div className="omo-topbar-side is-left">
            <span className="omo-topbar-room" data-testid="topbar-room" title={props.roomName}><i aria-hidden="true" />{props.roomName}</span>
            <button type="button" className="omo-topbar-people" data-testid="topbar-people" onMouseDown={keepKeys} onClick={props.onShare} title={peopleTitle} aria-label={peopleTitle}>
                {shown.length ? shown.map(m => <span key={m.id} className="omo-topbar-avatar" style={{ background: colourHex(m.colour) }} aria-hidden="true">{(m.name || '?').slice(0, 1).toUpperCase()}</span>)
                    : <Icon name="users" size={16} />}
                {members.length > 3 && <span className="omo-topbar-more">+{members.length - 3}</span>}
                {!snapshot && <span className="omo-topbar-people-label">Just you</span>}
            </button>
        </div>
        <div className="omo-topbar-views" role="tablist" aria-label="View">
            {views.map(item => <button type="button" role="tab" key={item.id} data-testid={item.testid} aria-selected={props.view === item.id}
                onMouseDown={keepKeys} onClick={() => props.onView(item.id)}>{item.label}</button>)}
        </div>
        <div className="omo-topbar-side is-right">
            <button type="button" className="omo-topbar-icon" data-testid="topbar-voice" onMouseDown={keepKeys}
                aria-pressed={voiceOn && !v?.muted} title={voiceTitle} aria-label={voiceTitle}
                onClick={() => { if (!voiceReady) { props.onShare(); return; } if (voiceOn) voice?.voice?.toggleMuted(); else void voice?.voice?.enable(); }}>
                <Icon name={voiceOn && !v?.muted ? 'mic' : 'mic-off'} size={16} />
            </button>
            <button type="button" className={`omo-topbar-icon${unread > 0 ? ' has-unread' : ''}`} data-testid="topbar-bell" onMouseDown={keepKeys}
                title="Agent notifications" aria-label={`Agent notifications${unread ? `, ${unread} unread` : ''}`}
                onClick={() => window.dispatchEvent(new CustomEvent(NOTICES_TOGGLE_EVENT))}>
                <Icon name="bell" size={16} />{unread > 0 && <strong className="omo-topbar-count">{unread}</strong>}
            </button>
            <button type="button" className="omo-topbar-icon" data-testid="topbar-settings" onMouseDown={keepKeys} onClick={props.onSettings} title="Settings" aria-label="Settings">
                <Icon name="more" size={16} />
            </button>
            <button type="button" className="omo-topbar-share" data-testid="topbar-share" onMouseDown={keepKeys} onClick={props.onShare}>Share</button>
            <button type="button" className="omo-topbar-k" data-testid="topbar-palette" onMouseDown={keepKeys} onClick={props.onPalette} title="Command palette" aria-label="Command palette">
                <kbd>{mac ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd>
            </button>
        </div>
        {props.error && <div className="omo-topbar-alert" role="alert" data-testid="topbar-alert">{props.error}</div>}
    </nav>;
}
