import * as React from 'react';
import type { TerminalWorkstation, Workstation } from './room-scene';
import type { HudHub } from './hud-hub';
import type { VoiceHub } from './voice-hub';
import type { FocusMode } from './focus-mode';
import { Icon } from './icons';
import { NOTICES_TOGGLE_EVENT } from './immersive-mode';
import '../../src/browser/immersive.css';

const DESKS: { id: TerminalWorkstation; label: string }[] = [{ id: 'terminal', label: 'Desk one' }, { id: 'terminal-2', label: 'Desk two' }];

/** Keys stay on the world: a click on the pill does not take focus away from the canvas. */
const keepKeys = (event: React.MouseEvent): void => { event.preventDefault(); };

/**
 * omo immersive lane: the one floating glass pill shown while the room fills the window.
 * Room name, desk switcher (same path as clicking that desk's monitor), chat, agent bell, voice and exit.
 * Every control is an explicit click. Nothing here starts an agent, sends input or presses Enter.
 */
export function ImmersivePill(props: {
    roomName: string; activeDesk: Workstation; focus: FocusMode; hud?: HudHub; voice?: VoiceHub;
    bells: Record<string, number>; onExit: () => void;
    /** w2:runtime — every station in the world (switcher order). Absent = the two legacy desks. */
    desks?: { id: string; label: string; slot?: number }[];
}): React.ReactElement {
    const desks = props.desks ?? DESKS; // w2:runtime
    const { hud, voice } = props;
    const chatOpen = !!hud?.chat.state.open, chatUnread = hud?.chat.state.unread ?? 0;
    const unread = hud?.state.unreadNotices ?? 0;
    const view = voice?.state, v = view?.voice;
    const voiceOn = v?.phase === 'on';
    const voiceReady = !!view?.supported && !!view?.joined;
    const voiceTitle = !view?.supported ? 'Voice is not available in this browser'
        : !view.joined ? 'Join a shared room first to use voice'
        : voiceOn ? (v?.muted ? 'Unmute (M)' : 'Mute (M)') : 'Turn on voice';
    return <nav className="omo-immersive-pill" data-testid="immersive-pill" aria-label="Immersive world">
        <span className="omo-immersive-room" title={props.roomName}><i aria-hidden="true" />{props.roomName}</span>
        <span className="omo-immersive-sep" aria-hidden="true" />
        <span className="omo-immersive-desks" role="group" aria-label="Desks">
            {desks.map((desk, i) => <button type="button" key={desk.id} data-testid={`immersive-desk-${desk.id}`} aria-pressed={props.activeDesk === desk.id}
                onMouseDown={keepKeys} onClick={() => props.focus.attachTo(desk.id as TerminalWorkstation)} title={`Go to ${desk.label} (same as clicking its screen)${i < 9 ? ` · Ctrl+${i + 1} while attached` : ''}`}>
                <Icon name="monitor" size={14} />{desk.label}{(props.bells[desk.id] ?? 0) > 0 && <strong className="omo-immersive-count" aria-label={`${props.bells[desk.id]} bells`}>{props.bells[desk.id]}</strong>}
            </button>)}
        </span>
        <span className="omo-immersive-sep" aria-hidden="true" />
        <button type="button" className="omo-immersive-icon" data-testid="immersive-chat" aria-pressed={chatOpen} disabled={!hud}
            title="Room chat (Enter)" aria-label="Room chat"
            onClick={() => { if (!hud) return; const open = !hud.chat.state.open; hud.chat.setOpen(open); if (open) hud.focusChat?.(); }}>
            <Icon name="chat" size={15} />{chatUnread > 0 && <strong className="omo-immersive-count">{chatUnread}</strong>}
        </button>
        <button type="button" className={`omo-immersive-icon${unread > 0 ? ' has-unread' : ''}`} data-testid="immersive-bell" onMouseDown={keepKeys}
            title="Agent notifications" aria-label={`Agent notifications${unread ? `, ${unread} unread` : ''}`}
            onClick={() => window.dispatchEvent(new CustomEvent(NOTICES_TOGGLE_EVENT))}>
            <Icon name="bell" size={15} />{unread > 0 && <strong className="omo-immersive-count">{unread}</strong>}
        </button>
        <button type="button" className="omo-immersive-icon" data-testid="immersive-voice" onMouseDown={keepKeys} disabled={!voiceReady || v?.phase === 'starting'}
            aria-pressed={voiceOn && !v?.muted} title={voiceTitle} aria-label={voiceTitle}
            onClick={() => { if (voiceOn) voice?.voice?.toggleMuted(); else void voice?.voice?.enable(); }}>
            <Icon name={voiceOn && !v?.muted ? 'mic' : 'mic-off'} size={15} />
        </button>
        <span className="omo-immersive-sep" aria-hidden="true" />
        <button type="button" className="omo-immersive-exit" data-testid="immersive-exit" onMouseDown={keepKeys} onClick={props.onExit} title="Leave immersive world (G)">
            <Icon name="collapse" size={14} />Exit <kbd>G</kbd>
        </button>
    </nav>;
}
