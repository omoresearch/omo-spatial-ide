import * as React from 'react';
import { createPortal } from '@theia/core/shared/react-dom';
import type { MonitorFrame, TerminalWorkstation } from './room-scene';
import type { RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';
import { FocusMode } from './focus-mode';
import { FOCUS_STATIONS } from './focus-screen';
import { FocusTerminalView, fitFont } from './focus-terminal-view';
import { ConsoleAlerts, FocusTabs } from './runtime-console-strip';
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

/**
 * One desk in the work area: its tabs strip, its live terminal and its alerts.
 * The active pane receives keys (through the world canvas). Clicking the other pane moves the keys there.
 */
function FocusPane(props: { station: TerminalWorkstation; frame: MonitorFrame; desk: { state: RuntimeConsoleState; controller?: RuntimeConsoleController };
    active: boolean; split: boolean; comfort: number; typing: boolean; activate: () => void; refocus: () => void }): React.ReactElement {
    const { station, desk, active } = props;
    const screen = React.useRef<HTMLDivElement>(null);
    const size = useSize(screen);
    const fontSize = size ? Math.max(6, fitFont(size.width, size.height) * props.comfort) : 14;
    const idle = desk.state.phase === 'idle' && !props.frame.lines.length;
    const back = (): void => active ? props.refocus() : props.activate();
    const wheel = (event: React.WheelEvent): void => { void desk.controller?.wheel(-Math.sign(event.deltaY) * 3); };
    return <section className={`omo-focus-pane ${active ? 'is-active' : 'is-passive'}`} data-testid={`focus-pane-${station}`} data-active={String(active)} aria-label={DESK_LABEL[station]}>
        <div className="omo-focus-pane-head">
            {props.split && <button type="button" className="omo-focus-pane-label" data-testid={`focus-pane-label-${station}`} aria-pressed={active} onClick={back}
                title={active ? 'Keys go to this desk' : `Move the keys to ${DESK_LABEL[station]}`}>{DESK_LABEL[station]}<small>{active ? (props.typing ? 'keys here' : 'click to type') : 'click to type here'}</small></button>}
            <FocusTabs state={desk.state} controller={desk.controller} agents={active} onPicked={back} />
        </div>
        <div ref={screen} className="omo-focus-screen" data-testid={active ? 'focus-screen-active' : undefined}
            onPointerUp={active ? props.refocus : props.activate} onWheel={wheel}>
            {idle ? <div className="omo-focus-pane-idle">Click to use {DESK_LABEL[station]} here · same as clicking its monitor. No agent starts.</div>
                : <FocusTerminalView frame={props.frame} fontSize={fontSize} />}
        </div>
        <ConsoleAlerts state={desk.state} controller={desk.controller} onDone={back} />
    </section>;
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
            onClick={() => focus.fullScreenActive()}>⛶ Full-screen terminal <kbd>F</kbd></button>, host);
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
    // A click on the layer's own margin must not take focus away from the terminal.
    const keepFocus = (event: React.MouseEvent): void => { if (event.target === event.currentTarget) event.preventDefault(); };
    const layer = <div ref={box} className={`omo-focus-layer ${state.full ? 'is-full' : 'is-screen'} ${settled ? 'is-settled' : ''} ${split ? 'is-split' : ''}`}
        data-testid="focus-layer" data-station={station} data-phase={state.phase} data-full={String(state.full)} data-split={String(split)}
        data-comfort={String(focus.comfort)} onMouseDown={keepFocus}>
        <div className="omo-focus-bar" role="toolbar" aria-label="Attached screen" onMouseDown={keepFocus}>
            <span className="omo-focus-dot" aria-hidden="true" />
            <span className="omo-focus-desks" role="group" aria-label="Switch desk">
                {FOCUS_STATIONS.map((s, i) => <button key={s} type="button" data-testid={`focus-desk-${s}`} aria-pressed={s === station}
                    title={`${DESK_LABEL[s]} (Ctrl+${i + 1})`} onClick={() => focus.switchTo(s)}>{DESK_LABEL[s]}<kbd>⌃{i + 1}</kbd></button>)}
            </span>
            <span className="omo-focus-status" role="status">{props.desk(station).state.statusText}</span>
            <span className="omo-focus-keys">{controls.typing ? 'Keys go to this terminal' : 'Click the screen to type'}</span>
            <span className="omo-focus-comfort" role="group" aria-label="Text size">
                <button type="button" data-testid="focus-text-smaller" aria-label="Smaller text" title="Smaller text" onClick={() => focus.stepComfort(-1)}>A−</button>
                <span data-testid="focus-text-size" title="Comfort text size (saved on this device)">{Math.round(focus.comfort * 100)}%</span>
                <button type="button" data-testid="focus-text-larger" aria-label="Larger text" title="Larger text" onClick={() => focus.stepComfort(1)}>A+</button>
            </span>
            {state.full && <button type="button" data-testid="focus-split-toggle" aria-pressed={split} onClick={() => focus.setSplit(!focus.split)}
                title={split ? 'One desk' : 'Desk one and Desk two side by side'}>{split ? '▭ One desk' : '◫ Split'}</button>}
            <button type="button" data-testid="focus-full-toggle" aria-pressed={state.full} onClick={() => focus.setFull(!state.full)}
                title={state.full ? 'Back to the desk screen (Esc)' : 'Full-window terminal (Ctrl+Shift+F)'}>{state.full ? '▢ Desk view' : '⛶ Full screen'}</button>
            {state.full && document.fullscreenEnabled && <button type="button" data-testid="focus-window-toggle" aria-pressed={!!document.fullscreenElement} onClick={toggleWindow} title="Use the whole monitor (browser full screen)">{document.fullscreenElement ? '⤡ Window' : '⤢ Monitor'}</button>}
            <button type="button" data-testid="focus-exit" onClick={() => focus.exit()} title="Walk away (Esc)">Esc · Walk</button>
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
