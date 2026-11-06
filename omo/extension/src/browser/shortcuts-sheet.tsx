import * as React from 'react';
import { Icon } from './icons';

/**
 * omo keys6 lane: the key sheet (F1, or ? when not typing). One list of every working key.
 * Keep it in step with first-person-controls.ts, focus-overlay.tsx, hud-hub.ts and voice-hub.ts.
 */
export interface ShortcutRow { keys: string[][]; what: string; note?: string }
export interface ShortcutGroup { id: string; title: string; when: string; rows: ShortcutRow[] }

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
    { id: 'walk', title: 'Walking', when: 'In the room, not typing', rows: [
        { keys: [['W', 'A', 'S', 'D']], what: 'Walk' },
        { keys: [['←', '→', '↑', '↓']], what: 'Turn and look' },
        { keys: [['Drag']], what: 'Look around' },
        { keys: [['L']], what: 'Mouse look on or off', note: 'Esc gives the mouse back' },
        { keys: [['Click a screen']], what: 'Attach to that desk screen' },
        { keys: [['F']], what: 'Full-screen terminal on the nearest desk' },
        { keys: [['G'], ['Alt', 'Shift', 'G']], what: 'Immersive world: the room fills the window', note: 'G again brings the panels back · Esc keeps it' },
        { keys: [['Enter'], ['/']], what: 'Room chat' },
        { keys: [['Ctrl', 'Shift', 'M']], what: 'Room chat drawer' },
        { keys: [['V']], what: 'Hold to talk', note: 'when voice is on' },
        { keys: [['M']], what: 'Mute or unmute', note: 'when voice is on' },
        { keys: [['T']], what: 'Hold to dictate a draft', note: 'never presses Enter' },
    ] },
    { id: 'screen', title: 'On a screen', when: 'Attached or typing on a monitor', rows: [
        { keys: [['Esc']], what: 'Leave full screen, then walk away', note: 'immersive world stays on' },
        { keys: [['Ctrl', 'Shift', 'F']], what: 'Full screen on or off' },
        { keys: [['Ctrl', '1'], ['Ctrl', '2']], what: 'Go to Desk one or Desk two' },
        { keys: [['Ctrl', 'Shift', '='], ['Ctrl', 'Shift', '−']], what: 'Bigger or smaller text', note: 'saved on this device' },
        { keys: [['Right-click']], what: 'Copy, Paste, Select all, Find' },
        { keys: [['Wheel']], what: 'Scroll back through history' },
    ] },
    { id: 'tabs', title: 'Tabs and desk', when: 'Attached or typing on a monitor', rows: [
        { keys: [['Ctrl', 'Tab'], ['Ctrl', 'Shift', 'Tab']], what: 'Next or previous tab' },
        { keys: [['Alt', '1…9']], what: 'Go to that tab' },
        { keys: [['Ctrl', 'Shift', 'T']], what: 'New shell tab', note: 'agents always ask first' },
        { keys: [['Ctrl', 'Shift', 'W']], what: 'Close this tab', note: 'asks first · press again within 5 s to confirm · a locked desk refuses' },
        { keys: [['Ctrl', 'Shift', 'N']], what: 'Rename this workspace' },
        { keys: [['Ctrl', 'Shift', 'E']], what: 'Rename this tab' },
        { keys: [['Ctrl', 'Shift', 'R']], what: 'Reconnect this screen', note: 'starts nothing' },
        { keys: [['Ctrl', 'Shift', 'P']], what: 'Workspace list in Manage' },
    ] },
    { id: 'text', title: 'Terminal text', when: 'Typing on a monitor', rows: [
        { keys: [['Ctrl', 'C'], ['Ctrl', 'R'], ['Ctrl', 'W']], what: 'Go to the program, as in any terminal' },
        { keys: [['Ctrl', 'V']], what: 'Paste', note: 'safe rules · never adds Enter' },
        { keys: [['Shift', 'Drag']], what: 'Select text on the world screen', note: 'Shift+double or triple click: word or line' },
        { keys: [['Ctrl', 'Shift', 'C']], what: 'Copy the selection' },
        { keys: [['F1']], what: 'This key sheet', note: '? works too when you are not typing' },
    ] },
];

/** The browser keeps some Ctrl+Shift keys in a normal tab. Alt+Shift+the same letter always works. */
export const BROWSER_KEPT_NOTE = 'In a normal browser tab, Chrome keeps Ctrl+Shift+W, Ctrl+Shift+N, Ctrl+Shift+T and Ctrl+Tab for itself. Use Alt+Shift+W, N or T instead, or use the Monitor button in full screen, where Omo asks the browser for those keys.';

function Chord(props: { keys: string[] }): React.ReactElement {
    return <span className="omo-keys-chord">{props.keys.map((k, i) => <React.Fragment key={i}>{i > 0 && <span className="omo-keys-plus" aria-hidden="true">+</span>}<kbd>{k}</kbd></React.Fragment>)}</span>;
}

export function ShortcutsSheet(props: { attached: boolean; onClose: () => void }): React.ReactElement {
    const close = React.useRef<HTMLButtonElement>(null);
    const card = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => { close.current?.focus({ preventScroll: true }); }, []);
    const keyDown = (event: React.KeyboardEvent): void => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'F1' || event.key === '?') { event.preventDefault(); props.onClose(); return; }
        // Keep Tab inside the dialog.
        if (event.key === 'Tab' && card.current) {
            const items = Array.from(card.current.querySelectorAll<HTMLElement>('button, [tabindex="0"]'));
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    };
    const order = props.attached ? ['screen', 'tabs', 'text', 'walk'] : ['walk', 'screen', 'tabs', 'text'];
    const groups = order.map(id => SHORTCUT_GROUPS.find(g => g.id === id)!);
    return <div className="omo-keys-backdrop" data-testid="keys-sheet" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }} onKeyDown={keyDown}>
        <div ref={card} className="omo-keys-sheet" role="dialog" aria-modal="true" aria-labelledby="omo-keys-title">
            <header className="omo-keys-head">
                <div>
                    <span className="omo-keys-kicker"><Icon name="keyboard" size={13} className="omo-keys-kicker-icon" />Omo keys</span>
                    <h2 id="omo-keys-title">Every shortcut</h2>
                    <p>{props.attached ? 'You are on a screen. Desk keys act on this desk only.' : 'You are walking. Click a desk screen to use the screen keys.'}</p>
                </div>
                <button ref={close} type="button" className="omo-keys-close" data-testid="keys-sheet-close" onClick={props.onClose} aria-label="Close the key sheet"><kbd>Esc</kbd><Icon name="x" size={14} /></button>
            </header>
            <div className="omo-keys-grid">
                {groups.map(group => <section key={group.id} className="omo-keys-group" data-testid={`keys-group-${group.id}`} aria-label={group.title}>
                    <h3>{group.title}<small>{group.when}</small></h3>
                    <ul>
                        {group.rows.map(row => <li key={row.what}>
                            <span className="omo-keys-combo">{row.keys.map((k, i) => <React.Fragment key={i}>{i > 0 && <span className="omo-keys-or">or</span>}<Chord keys={k} /></React.Fragment>)}</span>
                            <span className="omo-keys-what">{row.what}{row.note && <small>{row.note}</small>}</span>
                        </li>)}
                    </ul>
                </section>)}
            </div>
            <footer className="omo-keys-foot" data-testid="keys-sheet-note">
                <p>{BROWSER_KEPT_NOTE}</p>
                <p>No key starts an agent. Agent tabs always ask first, and Omo never presses Enter for you.</p>
            </footer>
        </div>
    </div>;
}
