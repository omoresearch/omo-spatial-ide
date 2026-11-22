/**
 * world-ui — the settings sheet. A right-side glass sheet with five sections that hold the
 * controls that left the world chrome: Share (name, room code / join, remote room), Voice
 * (voice, speech download, voice check, voice settings), Desks (desk switcher, mirror, station
 * recipes), Agents and Room (customise, immersive, keys). The widget passes each section's
 * existing component in, so every control keeps its own logic and test ids.
 * Esc closes. Nothing here starts an agent, sends input or presses Enter.
 */
import * as React from 'react';
import { Icon } from './icons';
import '../../src/browser/world-chrome.css';

export type SheetSection = 'share' | 'voice' | 'desks' | 'agents' | 'room';
export const SHEET_SECTIONS: { id: SheetSection; label: string }[] = [
    { id: 'share', label: 'Share' }, { id: 'voice', label: 'Voice' }, { id: 'desks', label: 'Desks' },
    { id: 'agents', label: 'Agents' }, { id: 'room', label: 'Room' }
];

export function SettingsSheet(props: {
    section: SheetSection; onSection(section: SheetSection): void; onClose(): void;
    children: Partial<Record<SheetSection, React.ReactNode>>;
}): React.ReactElement {
    const box = React.useRef<HTMLElement>(null);
    React.useEffect(() => { box.current?.focus({ preventScroll: true }); }, []);
    return <aside ref={box} tabIndex={-1} className="omo-sheet" data-testid="settings-sheet" data-section={props.section} role="dialog" aria-label="Settings"
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); } }}>
        <header className="omo-sheet-head">
            <strong>Settings</strong>
            <button type="button" className="omo-sheet-close" data-testid="settings-sheet-close" aria-label="Close settings" onClick={props.onClose}><Icon name="x" size={16} /></button>
        </header>
        <nav className="omo-sheet-tabs" role="tablist" aria-label="Settings sections">
            {SHEET_SECTIONS.map(s => <button type="button" role="tab" key={s.id} data-testid={`settings-tab-${s.id}`} aria-selected={props.section === s.id} onClick={() => props.onSection(s.id)}>{s.label}</button>)}
        </nav>
        <div className="omo-sheet-body" role="tabpanel" aria-label={SHEET_SECTIONS.find(s => s.id === props.section)?.label}>
            {props.children[props.section] ?? <p className="omo-sheet-empty">Nothing here yet.</p>}
        </div>
    </aside>;
}
