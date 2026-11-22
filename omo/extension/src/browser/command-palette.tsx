/**
 * world-ui — the ⌘K command palette. Every control that left the world chrome lives here
 * (views, desks, room code / join, share, station recipes, agents, voice and speech, settings,
 * customise, build mode, camera, chat, key sheet, leave immersive).
 *
 * Open: ⌘K anywhere on the world; Ctrl+K only while not typing on a screen (Ctrl+K is the shell's
 * kill-line, so it is never taken from a terminal). Esc closes. Arrow keys move, Enter runs.
 * A command only does what its label says. Nothing here types into a terminal, presses Enter in
 * one or starts an agent.
 */
import * as React from 'react';
import { Icon } from './icons';
import '../../src/browser/world-tokens.css'; // world-ui: the one overlay token file
import '../../src/browser/world-chrome.css';

export { filterCommands, isPaletteKey, PALETTE_TOGGLE_EVENT } from './command-palette-core';
export type { PaletteCommand } from './command-palette-core';
import { filterCommands } from './command-palette-core';
import type { PaletteCommand } from './command-palette-core';

export function CommandPalette(props: { open: boolean; commands: readonly PaletteCommand[]; onClose(): void }): React.ReactElement | null {
    const [query, setQuery] = React.useState('');
    const [active, setActive] = React.useState(0);
    const input = React.useRef<HTMLInputElement>(null);
    const list = React.useRef<HTMLOListElement>(null);
    const shown = React.useMemo(() => filterCommands(props.commands, query), [props.commands, query]);
    React.useEffect(() => { if (props.open) { setQuery(''); setActive(0); window.setTimeout(() => input.current?.focus({ preventScroll: true }), 0); } }, [props.open]);
    React.useEffect(() => { setActive(a => Math.min(a, Math.max(0, shown.length - 1))); }, [shown.length]);
    React.useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
    if (!props.open) return null;
    const run = (command: PaletteCommand | undefined): void => {
        if (!command || command.disabled) return;
        props.onClose();
        window.setTimeout(() => command.run(), 0);
    };
    const onKey = (event: React.KeyboardEvent): void => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); props.onClose(); return; }
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(a => (a + 1) % Math.max(1, shown.length)); return; }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive(a => (a - 1 + shown.length) % Math.max(1, shown.length)); return; }
        if (event.key === 'Enter') { event.preventDefault(); run(shown[active]); }
    };
    let lastGroup = '';
    return <div className="omo-palette-scrim" data-testid="command-palette-scrim" onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); props.onClose(); } }}>
        <section className="omo-palette" role="dialog" aria-modal="true" aria-label="Command palette" data-testid="command-palette" onKeyDown={onKey}>
            <div className="omo-palette-search">
                <Icon name="type" size={16} />
                <input ref={input} data-testid="command-palette-input" aria-label="Type a command" placeholder="Type a command or search…" value={query}
                    role="combobox" aria-expanded="true" aria-controls="omo-palette-list" aria-activedescendant={shown[active] ? `omo-cmd-${shown[active].id}` : undefined}
                    onChange={event => { setQuery(event.target.value); setActive(0); }} />
                <kbd>Esc</kbd>
            </div>
            <ol ref={list} id="omo-palette-list" className="omo-palette-list" role="listbox" aria-label="Commands">
                {shown.length === 0 && <li className="omo-palette-empty">No command matches “{query}”.</li>}
                {shown.map((command, i) => {
                    const head = command.group !== lastGroup ? command.group : ''; lastGroup = command.group;
                    return <React.Fragment key={command.id}>
                        {head && <li className="omo-palette-group" role="presentation">{head}</li>}
                        <li id={`omo-cmd-${command.id}`} role="option" aria-selected={i === active} aria-disabled={command.disabled || undefined}
                            className="omo-palette-item" data-testid="palette-item" data-command={command.id}
                            onMouseMove={() => setActive(i)} onMouseDown={event => event.preventDefault()} onClick={() => run(command)}>
                            <span className="omo-palette-icon" aria-hidden="true">{command.icon && <Icon name={command.icon} size={16} />}</span>
                            <span className="omo-palette-label">{command.label}{command.hint && <small>{command.hint}</small>}</span>
                            {command.keys && <kbd>{command.keys}</kbd>}
                        </li>
                    </React.Fragment>;
                })}
            </ol>
        </section>
    </div>;
}
