/** world-ui — pure logic of the ⌘K palette (unit-tested; no CSS, no React). */
import type { IconName } from './icons';

export interface PaletteCommand {
    id: string;
    label: string;
    group: string;
    hint?: string;
    keys?: string;
    icon?: IconName;
    disabled?: boolean;
    run(): void;
}

/** Every word of the query must appear in the label, group or hint (case-insensitive). */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [...commands];
    return commands.filter(c => { const text = `${c.label} ${c.group} ${c.hint ?? ''}`.toLowerCase(); return words.every(w => text.includes(w)); });
}

/** True when the key event should open the palette. `typing` = keys go to a terminal screen. */
export function isPaletteKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, typing: boolean): boolean {
    if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) return false;
    if (event.metaKey && !event.ctrlKey) return true;
    return event.ctrlKey && !event.metaKey && !typing;
}

export const PALETTE_TOGGLE_EVENT = 'omo:palette-toggle';
