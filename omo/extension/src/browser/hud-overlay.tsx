import * as React from 'react';
import { createPortal } from '@theia/core/shared/react-dom';
import type { HudHub, HudView } from './hud-hub';
import type { ChatState } from './chat-controller';
import { ChatPanel } from './chat-panel';
import { colourHex } from './hud-peers';
import { DESK_NAME } from './chat-mentions';
import '../../src/browser/hud.css';

const NOTICE_ICON = { finished: '✓', approval: '⚠', bell: '🔔', interrupted: '⨯', ended: '■' } as const;

/**
 * The on-canvas HUD: toasts (join/leave/mention/agent), the agent notification list with
 * click-to-jump, the who-is-speaking strip, and room chat. Rendered into the scene wrapper so
 * it sits over the 3D view; every control is an explicit click.
 */
export function HudOverlay(props: { hub: HudHub; view: HudView; chat: ChatState; host?: HTMLElement | null }): React.ReactElement | null {
    const { hub, view, chat } = props;
    const [open, setOpen] = React.useState(false);
    const marker = React.useRef<HTMLSpanElement>(null);
    const [found, setFound] = React.useState<HTMLElement | null>(null);
    // The scene wrapper is a sibling that is rebuilt with the room; find it after each commit.
    React.useLayoutEffect(() => {
        const next = props.host ?? marker.current?.closest('.omo-stage')?.querySelector<HTMLElement>('.omo-scene-wrap') ?? null;
        if (next !== found) setFound(next);
    });
    const host = found;
    if (!host) return <span ref={marker} hidden />;
    const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return <><span ref={marker} hidden />{createPortal(<div className="omo-hud-layer" data-testid="hud-layer">
        {view.speaking.length > 0 && <div className="omo-hud-speaking" data-testid="hud-speaking" role="status" aria-label="Who is speaking">
            {view.speaking.map(s => <span key={s.key} data-speaker={s.who} style={{ borderColor: s.who === 'agent' ? '#e9b949' : colourHex(s.colour) }}><i className="omo-hud-wave" aria-hidden="true"><b/><b/><b/></i>{s.name}</span>)}
        </div>}
        <div className="omo-hud-toasts" data-testid="hud-toasts" aria-live="polite">
            {view.toasts.map(t => <button type="button" key={t.id} className={`omo-hud-toast is-${t.kind}`} data-kind={t.kind} style={t.colour ? { borderLeftColor: colourHex(t.colour) } : undefined} onClick={() => hub.dismissToast(t.id)}>{t.text}</button>)}
        </div>
        <div className="omo-hud-notices">
            <button type="button" className="omo-hud-bell" data-testid="hud-notices-toggle" aria-expanded={open} onClick={() => { setOpen(!open); }} title="Agent notifications">
                🔔{view.unreadNotices > 0 && <strong data-testid="hud-notices-unread">{view.unreadNotices}</strong>}
            </button>
            {open && <section className="omo-hud-notice-list" data-testid="hud-notices" aria-label="Agent notifications">
                <header><strong>Agents</strong>{view.notices.length > 0 && <><button type="button" data-testid="hud-notices-read" onClick={() => hub.markAllRead()}>Mark read</button><button type="button" data-testid="hud-notices-clear" onClick={() => hub.clearNotices()}>Clear</button></>}</header>
                {view.notices.length ? <ol>{view.notices.map(n => <li key={n.id} className={`is-${n.kind}${n.read ? ' is-read' : ''}`} data-kind={n.kind} data-desk={n.desk}>
                    <span className="omo-hud-icon" aria-hidden="true">{NOTICE_ICON[n.kind]}</span>
                    <span><b>{n.text}</b><small>{time(n.at)} · {DESK_NAME[n.desk]}</small></span>
                    <button type="button" data-testid="hud-notice-jump" onClick={() => { hub.jump(n); setOpen(false); }}>Go to desk</button>
                </li>)}</ol> : <p>No agent news yet. You will see it here when an agent finishes, rings the bell or shows an approval prompt.</p>}
                <small>Read only. Going to a desk types nothing and approves nothing.</small>
            </section>}
        </div>
        {view.following && <div className="omo-hud-follow" data-testid="hud-following">👣 Following {view.members.find(m => m.id === view.following)?.name ?? '…'} <button type="button" onClick={() => hub.follow(undefined)}>Stop</button></div>}
        <div className="omo-hud-chat"><ChatPanel hub={hub} view={view} chat={chat} /></div>
    </div>, host)}</>;
}
