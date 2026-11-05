import * as React from 'react';
import { createPortal } from '@theia/core/shared/react-dom';
import type { TerminalWorkstation, Workstation } from './room-scene';
import type { RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';
import { TAB_NAME_MAX, WORKSPACE_NAME_MAX } from './runtime-console-controller';
import type { DeskShortcut, DeskShortcutDetail } from './first-person-controls';
import type { FocusMode } from './focus-mode';

/**
 * omo keys6 lane: desk keys (Ctrl+Shift+W / N / E / R, or Alt+Shift+…), sent by first-person-controls.ts
 * as 'omo:desk-shortcut'. Each key only opens the desk's EXISTING explicit action:
 *   W  close this tab: requestClose (the usual confirmation; Station Lock refuses). Press again within 5 s to confirm.
 *   N  rename this workspace: a name box, then renameWorkspace.
 *   E  rename this tab: a name box, then renameTab.
 *   R  reconnect this screen: same path as clicking its monitor. Starts nothing.
 * Nothing here starts an agent, sends input or presses Enter.
 */
export const CLOSE_CONFIRM_MS = 5000;
const DESK_LABEL: Record<TerminalWorkstation, string> = { terminal: 'Desk one', 'terminal-2': 'Desk two' };
const isDesk = (station: Workstation | undefined): station is TerminalWorkstation => station === 'terminal' || station === 'terminal-2';

type Desk = { state: RuntimeConsoleState; controller?: RuntimeConsoleController };
export interface ShortcutsLaneProps {
    focus: FocusMode;
    /** The desk that receives keys when no screen is attached. */
    activeDesk: () => Workstation;
    desk: (station: TerminalWorkstation) => Desk;
    /** Same path as clicking the desk's monitor: open or reattach its workspace. Never starts an agent. */
    reconnect: (station: TerminalWorkstation) => void;
}

interface RenameBox { kind: 'workspace' | 'tab'; station: TerminalWorkstation; id: string; name: string; was: string }

/** The name box for N and E. Keys stay in the box until Save, Cancel or Esc; then they go back to the terminal. */
function RenameDialog(props: { box: RenameBox; desk: Desk; onChange: (name: string) => void; onSave: () => void; onCancel: () => void }): React.ReactElement {
    const { box, desk } = props;
    const max = box.kind === 'tab' ? TAB_NAME_MAX : WORKSPACE_NAME_MAX;
    const input = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => { input.current?.focus({ preventScroll: true }); input.current?.select(); }, []);
    const title = box.kind === 'tab' ? 'Rename this tab' : 'Rename this workspace';
    return <div className="omo-keys-rename-backdrop" data-testid="keys-rename" onMouseDown={event => { if (event.target === event.currentTarget) props.onCancel(); }}
        onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); props.onCancel(); } }}>
        <form className="omo-keys-rename" role="dialog" aria-modal="true" aria-label={title} data-kind={box.kind}
            onSubmit={event => { event.preventDefault(); props.onSave(); }}>
            <span className="omo-keys-kicker">{DESK_LABEL[box.station]}</span>
            <label><strong>{title}</strong>
                <input ref={input} data-testid="keys-rename-input" aria-label={box.kind === 'tab' ? 'Tab name' : 'Workspace name'} maxLength={max}
                    value={box.name} onChange={event => props.onChange(event.target.value)} />
            </label>
            <small>Now “{box.was}”. 1 to {max} characters. Only the name changes: nothing running is stopped.</small>
            {desk.state.error && <p className="omo-keys-rename-error" role="alert">{desk.state.error}</p>}
            <div className="omo-keys-rename-actions">
                <button type="button" data-testid="keys-rename-cancel" onClick={props.onCancel}>Cancel <kbd>Esc</kbd></button>
                <button type="submit" className="is-primary" data-testid="keys-rename-save" disabled={desk.state.acting || !box.name.trim() || box.name.trim() === box.was}>Save <kbd>Enter</kbd></button>
            </div>
        </form>
    </div>;
}

export function ShortcutsLane(props: ShortcutsLaneProps): React.ReactElement | null {
    const { focus } = props;
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => focus.subscribe(bump), [focus]);
    const latest = React.useRef(props); latest.current = props;
    const [toast, setToast] = React.useState<{ text: string; tone: 'info' | 'warn'; id: number }>();
    const [rename, setRename] = React.useState<RenameBox>();
    const armed = React.useRef<{ station: TerminalWorkstation; tabId: string; at: number }>();

    const say = React.useCallback((text: string, tone: 'info' | 'warn' = 'info') => setToast({ text, tone, id: Date.now() }), []);
    React.useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(undefined), CLOSE_CONFIRM_MS); return () => window.clearTimeout(id); }, [toast]);

    /** Keys back to the terminal (attached or typing on the monitor), else to the room. */
    const refocus = React.useCallback(() => {
        const c = latest.current.focus.controls; if (!c) return;
        if (c.attached || c.typing) c.focusTerminal(); else c.element.focus({ preventScroll: true });
    }, []);

    const run = React.useCallback((action: DeskShortcut, chord: 'ctrl' | 'alt'): void => {
        const p = latest.current;
        const screen = p.focus.state.screen?.id as Workstation | undefined;
        const station = isDesk(screen) ? screen : p.activeDesk();
        if (!isDesk(station)) { say('Desk keys work on Desk one and Desk two. Nothing was changed.', 'warn'); return; }
        const desk = p.desk(station), label = DESK_LABEL[station], state = desk.state;
        if (action === 'reconnect') {
            if (state.phase === 'live') { say(`${label} is already live. Nothing was started.`); return; }
            p.reconnect(station); refocus();
            say(`Reconnecting ${label}… Same as clicking its monitor. No agent starts.`);
            return;
        }
        const ws = state.workspace;
        if (!ws || !desk.controller) { say(`${label} is not connected. Click its monitor first. Nothing was changed.`, 'warn'); return; }
        const tab = ws.tabs.find(t => t.id === state.activeTabId);
        if (action === 'rename-workspace') { setRename({ kind: 'workspace', station, id: ws.id, name: ws.name, was: ws.name }); return; }
        if (!tab) { say(`${label} has no open tab. Nothing was changed.`, 'warn'); return; }
        if (action === 'rename-tab') { setRename({ kind: 'tab', station, id: tab.id, name: tab.name, was: tab.name }); return; }
        // close-tab: the desk's own confirmation. A locked desk refuses (requestClose says so).
        if (state.stationLocked) { armed.current = undefined; desk.controller.requestClose(tab.id); say(`${label} is locked, so “${tab.name}” was not closed.`, 'warn'); return; }
        if (state.acting) { say(`${label} is busy. Nothing was changed.`, 'warn'); return; }
        const a = armed.current, pending = state.pending;
        if (a && a.station === station && a.tabId === tab.id && Date.now() - a.at <= CLOSE_CONFIRM_MS && pending?.type === 'close' && pending.tabId === tab.id) {
            armed.current = undefined; void desk.controller.confirmPending(); say(`Closing “${tab.name}”…`); return;
        }
        if (pending && !(pending.type === 'close' && pending.tabId === tab.id)) { say(`Answer the question on ${label} first. Nothing was changed.`, 'warn'); return; }
        desk.controller.requestClose(tab.id);
        armed.current = { station, tabId: tab.id, at: Date.now() };
        say(`Close “${tab.name}”? Press ${chord === 'ctrl' ? 'Ctrl' : 'Alt'}+Shift+W again within 5 s to confirm, or choose Cancel.`, 'warn');
    }, [say, refocus]);

    React.useEffect(() => {
        const listener = (event: Event): void => {
            const detail = (event as CustomEvent<DeskShortcutDetail>).detail;
            if (!detail) return;
            detail.handled = true;
            run(detail.action, detail.chord);
        };
        window.addEventListener('omo:desk-shortcut', listener);
        return () => window.removeEventListener('omo:desk-shortcut', listener);
    }, [run]);

    const saveRename = async (): Promise<void> => {
        const box = rename; if (!box) return;
        const controller = latest.current.desk(box.station).controller; if (!controller) return;
        const ok = box.kind === 'tab' ? await controller.renameTab(box.id, box.name) : await controller.renameWorkspace(box.id, box.name);
        if (ok) { setRename(undefined); say(box.kind === 'tab' ? 'Tab renamed.' : 'Workspace renamed.'); refocus(); }
        else bump();
    };
    const cancelRename = (): void => { setRename(undefined); refocus(); };

    const controls = focus.controls;
    const root = controls?.element.closest<HTMLElement>('.omo-root');
    if (!root) return null;
    return createPortal(<div className="omo-keys-lane" data-testid="keys-lane">
        {toast && <div key={toast.id} className={`omo-keys-toast is-${toast.tone}`} role="status" data-testid="keys-toast">{toast.text}</div>}
        {rename && <RenameDialog box={rename} desk={props.desk(rename.station)} onChange={name => setRename({ ...rename, name })} onSave={() => void saveRename()} onCancel={cancelRename} />}
    </div>, root);
}
