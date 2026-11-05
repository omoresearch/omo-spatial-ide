import * as React from 'react';
import { PRESENCE_COLOURS } from '../common/presence-protocol';
import type { PresenceColour } from '../common/presence-protocol';
import type { HudHub, HudView } from './hud-hub';
import type { ChatLine, ChatState } from './chat-controller';
import { CHAT_HELP } from './chat-controller';
import { colourHex } from './hud-peers';
import { EMOTE_TEXT } from './chat-controller';
import { Icon } from './icons';

function Line(props: { line: ChatLine }): React.ReactElement {
    const { line } = props;
    const time = new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return <li className={`omo-chat-line is-${line.kind}${line.self ? ' is-self' : ''}${line.mentionsMe ? ' is-mention' : ''}`} data-kind={line.kind} data-from={line.from ?? ''}>
        <time>{time}</time>
        {line.kind === 'text' && <b style={{ color: colourHex(line.colour) }}>{line.self ? 'You' : line.fromName}</b>}
        {/* Plain text only: React escapes it, nothing is parsed as markup or links. */}
        <span>{line.kind === 'emote' && line.emote ? line.text.replace(EMOTE_TEXT[line.emote].glyph, '').trim() : line.text}</span>
    </li>;
}

const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
/** True while a desk screen is attached: chat then opens as a drawer and leaves the keys on the terminal. */
const attachedNow = (): boolean => !!document.querySelector('[data-testid="focus-layer"].is-screen');

/** Room chat: log, one-line input, colour picker and the member list with Go to / Follow. */
export function ChatPanel(props: { hub: HudHub; view: HudView; chat: ChatState }): React.ReactElement {
    const { hub, view, chat } = props;
    const [text, setText] = React.useState('');
    const input = React.useRef<HTMLInputElement>(null);
    const log = React.useRef<HTMLOListElement>(null);
    React.useEffect(() => {
        hub.focusChat = prefill => { if (prefill !== undefined) setText(prefill); window.setTimeout(() => input.current?.focus(), 0); };
        return () => { hub.focusChat = undefined; };
    }, [hub]);
    React.useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [chat.lines.length, chat.open]);
    // Attached: open/close without taking the keys; the drawer takes them only when its box is clicked.
    const quiet = React.useRef(false);
    const toggleQuiet = React.useCallback((): void => { quiet.current = true; hub.chat.setOpen(!hub.chat.state.open); }, [hub]);
    React.useEffect(() => {
        const listener = (): void => toggleQuiet();
        window.addEventListener('omo:chat-toggle', listener);
        return () => window.removeEventListener('omo:chat-toggle', listener);
    }, [toggleQuiet]);
    // Opening the panel means the user wants to type: focus the box once it exists (not for a quiet drawer open).
    React.useEffect(() => { if (chat.open && !quiet.current) input.current?.focus(); quiet.current = false; }, [chat.open]);
    const keepKeys = (event: React.MouseEvent): void => { if (attachedNow()) event.preventDefault(); };
    const self = view.members.find(m => m.id === view.selfId);
    const submit = (event: React.FormEvent): void => { event.preventDefault(); void hub.chat.submit(text).then(ok => { if (ok) setText(''); }); };
    const others = view.members.filter(m => m.id !== view.selfId);
    if (!chat.open) return <button type="button" className="omo-chat-toggle" data-testid="chat-open" onMouseDown={keepKeys}
        onClick={() => { if (attachedNow()) { toggleQuiet(); return; } hub.chat.setOpen(true); hub.focusChat?.(); }} title="Room chat (Enter · Ctrl+Shift+M over a screen)">
        <Icon name="chat" size={15} />Chat{chat.unread > 0 && <strong data-testid="chat-unread">{chat.unread}</strong>}
    </button>;
    return <section className="omo-chat-panel" data-testid="chat-panel" aria-label="Room chat">
        <header>
            <strong>Room chat</strong>
            <small className="omo-chat-drawer-hint">Ctrl+Shift+M</small>
            {view.joined && <span className="omo-chat-colours" role="group" aria-label="Your name colour">{PRESENCE_COLOURS.map((c: PresenceColour) => <button type="button" key={c} data-testid={`chat-colour-${c}`} aria-pressed={self?.colour === c} title={c} style={{ background: colourHex(c) }} onClick={() => void hub.chat.setColour(c)} />)}</span>}
            <button type="button" data-testid="chat-close" aria-label="Close chat" title="Close chat (Esc)" onMouseDown={keepKeys}
                onClick={() => { const back = attachedNow() && document.activeElement === input.current; hub.chat.setOpen(false); if (back) (document.querySelector(CANVAS) as HTMLElement | null)?.focus(); }}><Icon name="x" size={15} /></button>
        </header>
        {others.length > 0 && <ul className="omo-chat-members" data-testid="chat-members">{others.map(m => <li key={m.id} data-member-id={m.id}>
            <i style={{ background: colourHex(m.colour) }} />{m.name}{m.voice?.speaking && <Icon name="volume" size={13} className="omo-chat-speaking" label="Speaking" />}
            <button type="button" data-testid="chat-tp" title={`Stand next to ${m.name} (moves only you)`} onClick={() => hub.teleport(m.id)}>Go to</button>
            <button type="button" data-testid="chat-follow" aria-pressed={view.following === m.id} title={`Follow ${m.name}`} onClick={() => hub.follow(view.following === m.id ? undefined : m.id)}>{view.following === m.id ? 'Stop' : 'Follow'}</button>
            <button type="button" data-testid="chat-mention" title={`Mention ${m.name}`} onClick={() => { setText(t => `${t}@${m.name.replace(/\s+/g, '-')} `); input.current?.focus(); }}>@</button>
        </li>)}</ul>}
        <ol className="omo-chat-log" ref={log} data-testid="chat-log" aria-live="polite">
            {chat.lines.length ? chat.lines.map(line => <Line key={line.id} line={line} />) : <li className="omo-chat-line is-system"><span>{view.joined ? 'No messages yet.' : 'Join a shared room to chat with people.'} {CHAT_HELP}</span></li>}
        </ol>
        <form onSubmit={submit} className="omo-chat-form">
            <input ref={input} data-testid="chat-input" aria-label="Chat message" maxLength={500} value={text} placeholder={view.joined ? 'Say something · @desk1 to draft for your agent · /wave' : '@desk1 … drafts for your agent · join a room to chat'}
                onChange={event => setText(event.target.value)}
                onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' || (event.ctrlKey && event.shiftKey && event.code === 'KeyM')) { event.preventDefault(); hub.chat.setOpen(false); (document.querySelector(CANVAS) as HTMLElement | null)?.focus(); } }} />
            <button data-testid="chat-send" disabled={chat.sending || !text.trim()}>{text.trim().startsWith('@') ? 'Draft' : 'Send'}</button>
            <span className="omo-chat-emotes">{(['wave', 'cheer', 'thumbsup', 'clap'] as const).map(e => <button type="button" key={e} data-testid={`chat-emote-${e}`} disabled={!view.joined || chat.sending} title={`Send /${e} to the room`} onClick={() => void hub.chat.submit(`/${e}`)}>{{ wave: 'Wave', cheer: 'Cheer', thumbsup: '+1', clap: 'Clap' }[e]}</button>)}</span>
        </form>
        {chat.error && <p role="alert" className="omo-error" data-testid="chat-error">{chat.error}</p>}
        <small>Chat goes only to people in this room and is not saved. @agent lines stay on this device as a draft; Enter is never pressed.</small>
    </section>;
}
