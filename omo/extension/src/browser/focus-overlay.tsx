import * as React from 'react';
import { createPortal } from '@theia/core/shared/react-dom';
import type { MonitorFrame, TerminalWorkstation } from './room-scene';
import type { RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';
import { FocusMode } from './focus-mode';
import { FOCUS_STATIONS } from './focus-screen';
import { FocusTerminalView, termFont, useCellRatio } from './focus-terminal-view';
import { ConsoleAlerts, FocusTabs } from './runtime-console-strip';
import { Icon } from './icons';
import '../../src/browser/focus-mode.css';

export interface FocusOverlayProps {
    focus: FocusMode;
    frames: Record<TerminalWorkstation, MonitorFrame>;
    desk: (station: TerminalWorkstation) => { state: RuntimeConsoleState; controller?: RuntimeConsoleController };
}

const DESK_LABEL: Record<TerminalWorkstation, string> = { terminal: 'Desk one', 'terminal-2': 'Desk two' };

/** Live size of an element, for fitting the terminal text to it. */
function useSize(ref: React.RefObject<HTMLElement>): { width: number; height: number } | undefined {
    const [size, setSize] = React.useState<{ width: number; height: number }>();
    React.useLayoutEffect(() => {
        const el = ref.current; if (!el) return;
        const read = (): void => {
            const width = Math.round(el.clientWidth), height = Math.round(el.clientHeight);
            setSize(old => old && old.width === width && old.height === height ? old : { width, height });
        };
        read();
        if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', read); return () => window.removeEventListener('resize', read); }
        const observer = new ResizeObserver(read); observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return size;
}

/** The DOM text selection, when it lies inside this element. */
function selectionIn(el: HTMLElement | null): string {
    const selection = window.getSelection(), text = selection?.toString() ?? '';
    return text && el && selection?.anchorNode && el.contains(selection.anchorNode) ? text : '';
}

/**
 * Right-click menu of the attached terminal. Copy writes the DOM selection; Paste reads the clipboard
 * only on this explicit click and sends it through the controller's paste rules (size limit,
 * multi-line only with bracketed paste, never an added Enter).
 */
function TerminalMenu(props: { at: { x: number; y: number }; screen: HTMLElement | null; controller?: RuntimeConsoleController; close: () => void; refocus: () => void }): React.ReactElement {
    const { screen, controller } = props;
    const selected = selectionIn(screen);
    const menu = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        const away = (event: Event): void => { if (!menu.current?.contains(event.target as Node)) props.close(); };
        window.addEventListener('pointerdown', away, true); window.addEventListener('blur', props.close);
        return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', props.close); };
    }, [props.close]);
    const done = (): void => { props.close(); props.refocus(); };
    const copy = (): void => { if (selected) void navigator.clipboard?.writeText(selected).catch(() => undefined); done(); };
    const paste = async (): Promise<void> => {
        props.close();
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch { /* Permission refused: Ctrl+V still works. */ }
        if (text) await controller?.paste(text);
        props.refocus();
    };
    const selectAll = (): void => {
        const grid = screen?.querySelector('.omo-focus-term-grid'), selection = window.getSelection();
        if (grid && selection) { const range = document.createRange(); range.selectNodeContents(grid); selection.removeAllRanges(); selection.addRange(range); }
        props.close(); props.refocus();
    };
    const clear = (): void => { window.getSelection()?.removeAllRanges(); done(); };
    const item = (id: string, label: string, keys: string, run: () => void, disabled = false): React.ReactElement =>
        <button type="button" role="menuitem" data-testid={`focus-menu-${id}`} disabled={disabled} onClick={run}><span>{label}</span><kbd>{keys}</kbd></button>;
    return <div ref={menu} className="omo-focus-menu" role="menu" aria-label="Terminal" data-testid="focus-menu" style={{ left: props.at.x, top: props.at.y }}
        onMouseDown={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}>
        {item('copy', 'Copy', 'Ctrl+Shift+C', copy, !selected)}
        {item('paste', 'Paste', 'Ctrl+V', () => void paste(), !controller)}
        <hr />
        {item('select-all', 'Select all', '', selectAll)}
        {item('clear', 'Clear selection', '', clear, !selected)}
    </div>;
}

/**
 * One desk in the work area: its tabs strip, its live terminal and its alerts.
 * The active pane receives keys (through the world canvas). Clicking the other pane moves the keys there.
 */
function FocusPane(props: { station: TerminalWorkstation; frame: MonitorFrame; desk: { state: RuntimeConsoleState; controller?: RuntimeConsoleController };
    active: boolean; split: boolean; comfort: number; typing: boolean; activate: () => void; refocus: () => void }): React.ReactElement {
    const { station, desk, active } = props;
    const screen = React.useRef<HTMLDivElement>(null);
    const size = useSize(screen);
    const ratio = useCellRatio(screen);
    const fontSize = size ? termFont(size.width, size.height, ratio, props.comfort) : 16;
    const [menu, setMenu] = React.useState<{ x: number; y: number }>();
    const closeMenu = React.useCallback(() => setMenu(undefined), []);
    const idle = desk.state.phase === 'idle' && !props.frame.lines.length;
    const back = (): void => active ? props.refocus() : props.activate();
    const wheel = (event: React.WheelEvent): void => { void desk.controller?.wheel(-Math.sign(event.deltaY) * 3); };
    const contextMenu = (event: React.MouseEvent): void => {
        if (!active || idle) return;
        event.preventDefault();
        const box = screen.current!.getBoundingClientRect();
        setMenu({ x: Math.min(event.clientX - box.left, box.width - 220), y: Math.min(event.clientY - box.top, box.height - 170) });
    };
    return <section className={`omo-focus-pane ${active ? 'is-active' : 'is-passive'}`} data-testid={`focus-pane-${station}`} data-active={String(active)} aria-label={DESK_LABEL[station]}>
        {props.split && <div className="omo-focus-pane-head">
            <button type="button" className="omo-focus-pane-label" data-testid={`focus-pane-label-${station}`} aria-pressed={active} onClick={back}
                title={active ? 'Keys go to this desk' : `Move the keys to ${DESK_LABEL[station]}`}><span>{DESK_LABEL[station]}</span>{active && props.typing
                    ? <small className="is-keys"><Icon name="keyboard" size={13} />Keys here</small> : <small><Icon name="keyboard" size={13} />{active ? 'Click to type' : 'Move keys here'}</small>}</button>
            <FocusTabs state={desk.state} controller={desk.controller} agents={active} onPicked={back} />
        </div>}
        <div ref={screen} className="omo-focus-screen" data-testid={active ? 'focus-screen-active' : undefined}
            onPointerUp={event => { if (event.button === 0) (active ? props.refocus : props.activate)(); }} onWheel={wheel} onContextMenu={contextMenu}>
            {idle ? <div className="omo-focus-pane-idle" data-testid={`focus-pane-idle-${station}`}>
                    <Icon name="monitor" size={28} />
                    <strong>{DESK_LABEL[station]} is not open yet</strong>
                    <span className="omo-focus-pane-idle-action" role="button" aria-label={`Open ${DESK_LABEL[station]} here`}><Icon name="keyboard" size={14} />Open {DESK_LABEL[station]} here</span>
                    <small>The keys move here too. Same as clicking its monitor in the room. No agent starts.</small>
                </div>
                : <FocusTerminalView frame={props.frame} fontSize={fontSize} />}
            {menu && <TerminalMenu at={menu} screen={screen.current} controller={desk.controller} close={closeMenu} refocus={props.refocus} />}
        </div>
        <ConsoleAlerts state={desk.state} controller={desk.controller} onDone={back} />
    </section>;
}

/**
 * The bar's "⋯" menu: less-used view settings (text size, split, whole monitor). Opening it never
 * takes the keys: the terminal keeps them, and every item hands them straight back.
 */
function BarMenu(props: { focus: FocusMode; full: boolean; split: boolean; toggleWindow: () => void; refocus: () => void }): React.ReactElement {
    const { focus, full, split } = props;
    const [open, setOpen] = React.useState(false);
    const box = React.useRef<HTMLSpanElement>(null);
    React.useEffect(() => {
        if (!open) return;
        const away = (event: Event): void => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
        const close = (): void => setOpen(false);
        window.addEventListener('pointerdown', away, true); window.addEventListener('blur', close);
        return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', close); };
    }, [open]);
    const run = (action: () => void, keep = false): void => { action(); if (!keep) setOpen(false); props.refocus(); };
    const monitor = !!document.fullscreenElement;
    return <span ref={box} className="omo-focus-more">
        <button type="button" data-testid="focus-more" aria-haspopup="menu" aria-expanded={open} aria-label="More view options" title="More: text size, split, whole monitor"
            onMouseDown={event => event.preventDefault()} onClick={() => setOpen(!open)}><Icon name="more" size={16} /></button>
        {open && <div className="omo-focus-menu omo-focus-more-menu" role="menu" aria-label="View options" data-testid="focus-more-menu" onMouseDown={event => event.preventDefault()}>
            <div className="omo-focus-menu-row" role="group" aria-label="Text size">
                <span><Icon name="type" size={15} />Text size</span>
                <span className="omo-focus-comfort">
                    <button type="button" role="menuitem" data-testid="focus-text-smaller" aria-label="Smaller text" title="Smaller text (Ctrl+Shift+−)" onClick={() => run(() => focus.stepComfort(-1), true)}>A−</button>
                    <output data-testid="focus-text-size" title="Text size (saved on this device)">{Math.round(focus.comfort * 100)}%</output>
                    <button type="button" role="menuitem" data-testid="focus-text-larger" aria-label="Larger text" title="Larger text (Ctrl+Shift+=)" onClick={() => run(() => focus.stepComfort(1), true)}>A+</button>
                </span>
            </div>
            {full && <><hr />
                <button type="button" role="menuitemcheckbox" aria-checked={split} data-testid="focus-split-toggle" onClick={() => run(() => focus.setSplit(!focus.split))}>
                    <span><Icon name={split ? 'single' : 'split'} size={15} />{split ? 'One desk' : 'Both desks side by side'}</span><kbd /></button>
                {document.fullscreenEnabled && <button type="button" role="menuitemcheckbox" aria-checked={monitor} data-testid="focus-window-toggle" onClick={() => run(props.toggleWindow)}>
                    <span><Icon name={monitor ? 'window' : 'monitor'} size={15} />{monitor ? 'Back to the window' : 'Use the whole monitor'}</span><kbd /></button>}
            </>}
            {!full && <><hr />
                <button type="button" role="menuitem" data-testid="focus-menu-full" onClick={() => run(() => focus.setFull(true))}>
                    <span><Icon name="maximize" size={15} />Full-window terminal</span><kbd>Ctrl+Shift+F</kbd></button></>}
        </div>}
    </span>;
}

/**
 * Focus-mode layer. Lives in the scene wrapper (portal) so the world widget only mounts it.
 * Attached: one work area over the whole scene (the room fades behind a vignette). Full: the
 * whole window, optionally both desks side by side. Each pane shows the desk's tmux tabs and its
 * live frame as sharp DOM text. It never sends input: keys and paste stay on the
 * world canvas, so Enter and paste rules are unchanged.
 */
export function FocusOverlay(props: FocusOverlayProps): React.ReactElement | null {
    const { focus } = props;
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => focus.subscribe(bump), [focus]);
    React.useEffect(() => { focus.sync(); });
    // The scene can be rebuilt without a widget render; re-bind cheaply until it is there.
    React.useEffect(() => { const id = window.setInterval(() => focus.sync(), 500); return () => window.clearInterval(id); }, [focus]);
    const state = focus.state;
    const controls = focus.controls;
    const station = state.screen?.id as TerminalWorkstation | undefined;
    const attached = state.phase === 'attaching' || state.phase === 'attached';
    const shown = attached && !!station;
    const box = React.useRef<HTMLDivElement>(null);

    // Another desk took the keys (station switch, mirror, task panel): leave this screen.
    React.useEffect(() => {
        if (shown && station && focus.activeStation() !== station) focus.exit();
    });

    // Full screen copies its own DOM selection with Ctrl+Shift+C.
    React.useEffect(() => {
        focus.copySelection = () => {
            const selection = window.getSelection(), text = selection?.toString() ?? '';
            if (!shown || !text || !box.current || !selection?.anchorNode || !box.current.contains(selection.anchorNode)) return false;
            void navigator.clipboard?.writeText(text).catch(() => undefined);
            return true;
        };
        return () => { focus.copySelection = undefined; };
    }, [focus, shown]);

    // Alt+1..9 and Ctrl+Tab: tabs of the desk that has the keys, through the explicit selectTab action.
    const deskOf = props.desk;
    React.useEffect(() => {
        focus.tabRequest = slot => {
            const active = focus.activeStation();
            if (!(FOCUS_STATIONS as readonly string[]).includes(active)) return false;
            const { state: desk, controller } = deskOf(active as TerminalWorkstation);
            const tabs = desk.workspace?.tabs ?? [];
            if (!controller || !tabs.length || desk.acting || desk.pending) return false;
            const at = Math.max(0, tabs.findIndex(t => t.id === desk.activeTabId));
            const tab = slot === 'next' ? tabs[(at + 1) % tabs.length] : slot === 'previous' ? tabs[(at + tabs.length - 1) % tabs.length] : tabs[slot - 1];
            if (!tab) { focus.say(`This desk has ${tabs.length} tab${tabs.length === 1 ? '' : 's'} · Alt+1 to Alt+${Math.min(9, tabs.length)} picks one.`); return true; }
            if (tab.id !== desk.activeTabId) void controller.selectTab(tab.id);
            return true;
        };
        return () => { focus.tabRequest = undefined; };
    }, [focus, deskOf]);

    // Chrome hides while attached (CSS keys off this attribute). React does not own it.
    React.useEffect(() => {
        const root = controls?.element.closest<HTMLElement>('.omo-root');
        if (!root) return;
        root.dataset.focus = state.phase; root.dataset.focusFull = String(attached && state.full);
        return () => { delete root.dataset.focus; delete root.dataset.focusFull; };
    }, [controls, state.phase, state.full, attached]);

    // The Monitor button state follows the browser's own full screen.
    React.useEffect(() => {
        if (!shown || !state.full) return;
        document.addEventListener('fullscreenchange', bump);
        return () => document.removeEventListener('fullscreenchange', bump);
    }, [shown, state.full]);

    // Leaving full screen also leaves the browser's Fullscreen API.
    React.useEffect(() => {
        if ((!shown || !state.full) && document.fullscreenElement && box.current?.contains(document.fullscreenElement) !== false) void document.exitFullscreen?.().catch(() => undefined);
    }, [shown, state.full]);

    const host = controls?.element.closest<HTMLElement>('.omo-scene-wrap');
    if (!host || !controls?.enabled) return null;
    if (!shown || !station) {
        return createPortal(<button type="button" className="omo-focus-launch" data-testid="focus-full-launch" title="Full-screen terminal (F)"
            onClick={() => focus.fullScreenActive()}><Icon name="maximize" size={14} />Full-screen terminal <kbd>F</kbd></button>, host);
    }

    const refocus = (): void => {
        // Keep a fresh text selection for Ctrl+Shift+C; otherwise give the keys back to the terminal.
        if (window.getSelection()?.toString()) { controls.element.focus({ preventScroll: true }); return; }
        controls.focusTerminal();
    };
    const toggleWindow = (): void => {
        if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); controls.focusTerminal(); return; }
        void box.current?.requestFullscreen?.().then(() => controls.focusTerminal(), () => controls.focusTerminal());
    };
    const settled = state.phase === 'attached';
    const split = state.full && focus.split;
    const panes = split ? FOCUS_STATIONS : [station];
    const desk = props.desk(station);
    // One bar says it all: project, desk, tabs, live state and bell. Text only when not plainly live.
    const live = desk.state.phase === 'live';
    const status = live ? '' : desk.state.statusText;
    const bells = props.frames[station].unreadBells ?? 0;
    // A click on the layer's own margin must not take focus away from the terminal.
    const keepFocus = (event: React.MouseEvent): void => { if (event.target === event.currentTarget) event.preventDefault(); };
    const layer = <div ref={box} className={`omo-focus-layer ${state.full ? 'is-full' : 'is-screen'} ${settled ? 'is-settled' : ''} ${split ? 'is-split' : ''}`}
        data-testid="focus-layer" data-station={station} data-phase={state.phase} data-full={String(state.full)} data-split={String(split)}
        data-comfort={String(focus.comfort)} onMouseDown={keepFocus}>
        <div className="omo-focus-bar" role="toolbar" aria-label="Attached screen" onMouseDown={keepFocus}>
            <span className={`omo-focus-dot ${live ? 'is-live' : ''}`} title={live ? 'Live' : status} aria-hidden="true" />
            <strong className="omo-focus-project" data-testid="focus-project">{desk.state.workspace?.name ?? 'Omo'}</strong>
            <span className="omo-focus-desks" role="group" aria-label="Switch desk">
                {FOCUS_STATIONS.map((s, i) => <button key={s} type="button" data-testid={`focus-desk-${s}`} aria-pressed={s === station}
                    title={`${DESK_LABEL[s]} (Ctrl+${i + 1})`} aria-label={DESK_LABEL[s]} onClick={() => focus.switchTo(s)}><span className="omo-focus-desk-name">{DESK_LABEL[s]}</span><span className="omo-focus-desk-short" aria-hidden="true">{i + 1}</span><kbd>⌃{i + 1}</kbd></button>)}
            </span>
            {!split && <><span className="omo-focus-sep" aria-hidden="true" /><FocusTabs state={desk.state} controller={desk.controller} onPicked={refocus} /></>}
            <span className="omo-focus-fill" />
            {bells > 0 && <span className="omo-focus-bell" data-testid="focus-bell" title={`This desk rang its bell ${bells} time${bells === 1 ? '' : 's'}`}><Icon name="bell" size={14} />{bells}</span>}
            {status && <span className="omo-focus-status" role="status" data-testid="focus-status">{status}</span>}
            <span className={`omo-focus-keys ${controls.typing ? 'is-on' : ''}`} data-testid="focus-keys" data-typing={String(controls.typing)}
                title={controls.typing ? `Your keystrokes go to the terminal on ${DESK_LABEL[station]}` : 'Click the screen to send keys to this terminal'}>
                <Icon name="keyboard" size={15} />{controls.typing ? <><span className="omo-focus-keys-lead">Keys <span aria-hidden="true">→</span><span className="omo-sr"> to</span> </span>{DESK_LABEL[station]}</> : 'Click to type'}</span>
            <button type="button" data-testid="focus-full-toggle" aria-pressed={state.full} onClick={() => focus.setFull(!state.full)}
                title={state.full ? 'Back to the desk screen (Esc)' : 'Full-window terminal (Ctrl+Shift+F)'} aria-label={state.full ? 'Desk view' : 'Full screen'}><Icon name={state.full ? 'minimize' : 'maximize'} size={15} /><span className="omo-focus-label">{state.full ? 'Desk view' : 'Full screen'}</span></button>
            <button type="button" data-testid="focus-exit" onClick={() => focus.exit()} title="Walk away (Esc)" aria-label="Walk away (Esc)"><Icon name="walk" size={15} /><span className="omo-focus-label">Walk</span><kbd>Esc</kbd></button>
            <BarMenu focus={focus} full={state.full} split={split} toggleWindow={toggleWindow} refocus={refocus} />
            <span className="omo-focus-sep is-end" aria-hidden="true" />
        </div>
        <div className="omo-focus-panes" onMouseDown={keepFocus}>
            {panes.map(s => <FocusPane key={s} station={s} frame={props.frames[s]} desk={props.desk(s)} active={s === station} split={split}
                comfort={focus.comfort} typing={controls.typing} refocus={refocus} activate={() => focus.switchTo(s)} />)}
        </div>
    </div>;
    // The stage is a CSS container, which traps position: fixed. Full window mounts on the root
    // instead (still inside .omo-root, so the design tokens apply) and covers the whole window.
    const root = state.full ? controls.element.closest<HTMLElement>('.omo-root') : undefined;
    return createPortal(layer, root ?? host);
}
