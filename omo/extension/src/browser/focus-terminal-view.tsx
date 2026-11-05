import * as React from 'react';
import type { MonitorFrame } from './room-scene';
import { cellRuns, dominantKey, MONITOR_COLS, MONITOR_ROWS } from './runtime-console-controller';
import { visibleMonitorCells } from '../common/monitor-selection';

const BASE = '#091119';
export const FOCUS_FONT = `'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace`;
const LINE = 1.3;
let glyphRatio = 0;
/** Width of one monospace cell per 1px of font size, measured once for the real font. */
function cellRatio(): number {
    if (glyphRatio) return glyphRatio;
    const c = document.createElement('canvas').getContext('2d');
    if (c) { c.font = `100px ${FOCUS_FONT}`; glyphRatio = (c.measureText('M').width || 60) / 100; }
    return glyphRatio || 0.6;
}
/** Largest font that fits the 80 x 22 grid plus the title row into a box. */
export function fitFont(width: number, height: number): number {
    const padX = 0.05, padY = 0.06;
    const byWidth = width * (1 - padX * 2) / (MONITOR_COLS * cellRatio());
    const byHeight = height * (1 - padY * 2) / ((MONITOR_ROWS + 1.6) * LINE);
    return Math.max(6, Math.min(byWidth, byHeight));
}

function hex(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const v = value.startsWith('#') ? value : `#${value}`;
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
}

/**
 * Crisp DOM rendering of the same live frame the monitor texture shows. Read-only:
 * keys still go to the world canvas, so all input rules stay in one place.
 */
export const FocusTerminalView = React.memo(function FocusTerminalView(props: { frame: MonitorFrame; fontSize: number }): React.ReactElement {
    const { frame } = props;
    const rows = visibleMonitorCells(frame.lines, frame.cells);
    const offset = frame.lines.length - rows.length;
    const tc = frame.truecolor && frame.truecolor.foreground.length === frame.truecolor.background.length ? frame.truecolor : undefined;
    const skip = hex(frame.background ? frame.palette?.[dominantKey(frame.background) ?? ''] : undefined) ?? BASE;
    const cursor = frame.cursor?.visible ? { x: frame.cursor.x, y: frame.cursor.y - offset } : undefined;
    return <div className="omo-focus-term" style={{ fontSize: props.fontSize, fontFamily: FOCUS_FONT, lineHeight: LINE }} data-testid="focus-terminal">
        <div className="omo-focus-term-title">
            <span>{frame.title ?? 'OMO / LIVE PROJECT TERMINAL'}</span>
            <span className={frame.unreadBells ? 'is-bell' : ''}>{frame.unreadBells ? `BELL (${frame.unreadBells})` : frame.status ?? ''}</span>
        </div>
        <div className="omo-focus-term-grid" role="log" aria-label="Attached terminal" aria-live="off">
            {!rows.length && <div className="omo-focus-term-empty">{frame.status || 'Connecting to this desk…'}</div>}
            {rows.map((row, i) => {
                const fallback = { fg: '#e0e8eb', bg: BASE };
                const direct = tc ? { fg: tc.foreground[offset + i], bg: tc.background[offset + i] } : undefined;
                const runs = cellRuns(row.join(''), frame.foreground?.[offset + i], frame.background?.[offset + i], frame.palette, fallback, frame.cells === undefined ? undefined : row, direct);
                return <div key={i} className="omo-focus-term-row">{runs.map(run => {
                    if (frame.cells !== undefined && run.text === '') return null;
                    const span = run.glyphColumns ?? Array.from(run.text).length;
                    const isCursor = cursor?.y === i && cursor.x >= run.x && cursor.x < run.x + span;
                    const bg = run.bg.toLowerCase() !== skip && run.bg !== BASE ? run.bg : undefined;
                    const style: React.CSSProperties = { color: run.fg, background: bg, width: frame.cells !== undefined ? `${span}ch` : undefined };
                    if (isCursor && frame.cells !== undefined) return <span key={run.x} className="omo-focus-cell is-cursor" style={style}>{run.text}</span>;
                    if (isCursor) {
                        const chars = Array.from(run.text), at = cursor!.x - run.x;
                        return <span key={run.x} style={style}>{chars.slice(0, at).join('')}<span className="is-cursor">{chars[at] ?? ' '}</span>{chars.slice(at + 1).join('')}</span>;
                    }
                    return <span key={run.x} className={frame.cells !== undefined ? 'omo-focus-cell' : undefined} style={style}>{run.text}</span>;
                })}{cursor?.y === i && cursor.x >= Array.from(row).length && <span className="is-cursor" style={{ marginLeft: `${cursor.x - row.length}ch` }}> </span>}</div>;
            })}
        </div>
    </div>;
});
