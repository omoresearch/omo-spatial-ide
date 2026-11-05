import * as React from 'react';
import { createPortal } from '@theia/core/shared/react-dom';
import type { MonitorFrame, TerminalWorkstation } from './room-scene';
import type { RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';
import type { ScreenRect } from './first-person-controls';
import { FocusMode } from './focus-mode';
import { FocusTerminalView, fitFont } from './focus-terminal-view';
import { ConsoleAlerts } from './runtime-console-strip';
import '../../src/browser/focus-mode.css';

export interface FocusOverlayProps {
    focus: FocusMode;
    frames: Record<TerminalWorkstation, MonitorFrame>;
    desk: (station: TerminalWorkstation) => { state: RuntimeConsoleState; controller?: RuntimeConsoleController };
}

const sameRect = (a: ScreenRect | undefined, b: ScreenRect | undefined): boolean =>
    !!a && !!b && Math.abs(a.left - b.left) < .5 && Math.abs(a.top - b.top) < .5 && Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5;

/**
 * Focus-mode layer. Lives in the scene wrapper (portal) so the world widget only mounts it.
 * Shows the attached desk's live frame as sharp DOM text, aligned over the physical screen,
 * or over the whole window in full screen. It never sends input: keys and paste stay on the
 * world canvas, so Enter and paste rules are unchanged.
 */
export function FocusOverlay(props: FocusOverlayProps): React.ReactElement | null {
    const { focus } = props;
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => focus.subscribe(bump), [focus]);
    React.useEffect(() => { focus.sync(); });
    const state = focus.state;
    const controls = focus.controls;
    const station = state.screen?.id as TerminalWorkstation | undefined;
    const attached = state.phase === 'attaching' || state.phase === 'attached';
    const shown = attached && !!station;
    const [rect, setRect] = React.useState<ScreenRect>();
    const box = React.useRef<HTMLDivElement>(null);

    // Follow the screen while the camera flies; the flight is ~260 ms, then it stays put.
    React.useEffect(() => {
        if (!shown || state.full || !controls) { setRect(undefined); return; }
        let frame = 0, last: ScreenRect | undefined;
        const tick = (): void => {
            const next = controls.screenRect();
            if (next && !sameRect(next, last)) { last = next; setRect(next); }
            frame = requestAnimationFrame(tick);
        };
        tick();
        return () => cancelAnimationFrame(frame);
    }, [shown, state.full, controls, station]);

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

    // Full window sizes its text from the window; follow resizes and the browser's own full screen.
    React.useEffect(() => {
        if (!shown || !state.full) return;
        window.addEventListener('resize', bump); document.addEventListener('fullscreenchange', bump);
        return () => { window.removeEventListener('resize', bump); document.removeEventListener('fullscreenchange', bump); };
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

    const desk = props.desk(station);
    const frame = props.frames[station];
    const refocus = (): void => {
        // Keep a fresh text selection for Ctrl+Shift+C; otherwise give the keys back to the terminal.
        if (window.getSelection()?.toString()) { controls.element.focus({ preventScroll: true }); return; }
        controls.focusTerminal();
    };
    const wheel = (event: React.WheelEvent): void => { void desk.controller?.wheel(-Math.sign(event.deltaY) * 3); };
    const toggleWindow = (): void => {
        if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); controls.focusTerminal(); return; }
        void box.current?.requestFullscreen?.().then(() => controls.focusTerminal(), () => controls.focusTerminal());
    };
    const label = station === 'terminal' ? 'Desk one' : 'Desk two';
    const settled = state.phase === 'attached';
    let style: React.CSSProperties | undefined;
    let fontSize = 14;
    if (state.full) {
        fontSize = fitFont(window.innerWidth, window.innerHeight - 52);
    } else if (rect) {
        style = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        fontSize = fitFont(rect.width, rect.height);
    }
    const layer = <div ref={box} className={`omo-focus-layer ${state.full ? 'is-full' : 'is-screen'} ${settled ? 'is-settled' : ''}`}
        data-testid="focus-layer" data-station={station} data-phase={state.phase} data-full={String(state.full)}>
        <div className="omo-focus-bar" role="toolbar" aria-label="Attached screen">
            <span className="omo-focus-dot" aria-hidden="true" />
            <strong>{label}</strong>
            <span className="omo-focus-status" role="status">{desk.state.statusText}</span>
            <span className="omo-focus-keys">{controls.typing ? 'Keys go to this terminal' : 'Click the screen to type'}</span>
            <button type="button" data-testid="focus-full-toggle" aria-pressed={state.full} onClick={() => focus.setFull(!state.full)}
                title={state.full ? 'Back to the desk screen (Esc)' : 'Full-window terminal (Ctrl+Shift+F)'}>{state.full ? '▢ Desk view' : '⛶ Full screen'}</button>
            {state.full && document.fullscreenEnabled && <button type="button" data-testid="focus-window-toggle" aria-pressed={!!document.fullscreenElement} onClick={toggleWindow} title="Use the whole monitor (browser full screen)">{document.fullscreenElement ? '⤡ Window' : '⤢ Monitor'}</button>}
            <button type="button" data-testid="focus-exit" onClick={() => focus.exit()} title="Walk away (Esc)">Esc · Walk</button>
        </div>
        <div className="omo-focus-screen" style={style} onPointerUp={refocus} onWheel={wheel}>
            <FocusTerminalView frame={frame} fontSize={fontSize} />
        </div>
        <ConsoleAlerts state={desk.state} controller={desk.controller} onDone={() => controls.focusTerminal()} />
    </div>;
    // The stage is a CSS container, which traps position: fixed. Full window mounts on the root
    // instead (still inside .omo-root, so the design tokens apply) and covers the whole window.
    const root = state.full ? controls.element.closest<HTMLElement>('.omo-root') : undefined;
    return createPortal(layer, root ?? host);
}
