import * as React from 'react';
import type { MonitorFrame } from './room-scene';
import { cellRuns, dominantKey, MONITOR_COLS, MONITOR_ROWS } from './runtime-console-controller';
import { visibleMonitorCells } from '../common/monitor-selection';

const BASE = '#091119';
/** Smallest default terminal text size in CSS px at 100%: small panes never go below it (they scroll). */
export const TERM_FONT = 16;
/** Largest default size at 100%: on big screens the text stops here and the card still fills the pane. */
export const TERM_FONT_MAX = 24;
/** Row height in em. Matches .omo-focus-term-row in focus-mode.css. */
const LINE = 1.4;
/** Screen padding + card padding + card border on both sides, in px (focus-mode.css). */
const FRAME = { x: 2 * (20 + 20 + 1), y: 2 * (14 + 14 + 1) };

/**
 * Advance of one cell per 1px of font size, measured with the font the element really renders
 * (its computed font-family), again once web fonts settle. Only used to cap the size so the
 * 80 columns fit; the column pitch itself is the font's own advance, never a guess.
 */
export function useCellRatio(ref: React.RefObject<HTMLElement>): number {
    const [ratio, setRatio] = React.useState(0.6);
    React.useEffect(() => {
        let live = true;
        const measure = (): void => {
            const el = ref.current, ctx = document.createElement('canvas').getContext('2d');
            if (!live || !el || !ctx) return;
            ctx.font = `100px ${getComputedStyle(el).fontFamily}`;
            const width = ctx.measureText('0'.repeat(10)).width / 1000;
            if (width > 0.3 && width < 1) setRatio(width);
        };
        measure();
        void document.fonts?.ready.then(measure);
        document.fonts?.addEventListener?.('loadingdone', measure);
        return () => { live = false; document.fonts?.removeEventListener?.('loadingdone', measure); };
    }, [ref]);
    return ratio;
}

/**
 * Terminal text size. At 100% the 80 x 22 grid grows to fill the pane (between TERM_FONT and
 * TERM_FONT_MAX), so there is no empty band under the terminal. A− / A+ scale that; it never
 * grows past what fits the box.
 */
export function termFont(width: number, height: number, ratio: number, comfort: number): number {
    const fits = Math.min((width - FRAME.x) / (MONITOR_COLS * ratio), (height - FRAME.y) / (MONITOR_ROWS * LINE));
    const base = Math.max(TERM_FONT, Math.min(TERM_FONT_MAX, fits));
    return Math.max(8, Math.floor(Math.min(base * comfort, fits)));
}

function hex(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const v = value.startsWith('#') ? value : `#${value}`;
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
}

/** Text of one colour. `fixed`: a wide or combined glyph whose box is pinned to its terminal columns. */
interface Segment { x: number; text: string; fg: string; bg: string; cols: number; fixed: boolean }

/** Merge a row's cells into plain monospace runs. Only glyphs whose width differs from their columns get a box. */
function segments(runs: ReturnType<typeof cellRuns>, grid: boolean): Segment[] {
    const out: Segment[] = [];
    for (const run of runs) {
        if (grid && run.text === '') continue;
        // Non-ASCII glyphs may come from a fallback font with another advance: pin them to their columns.
        const chars = Array.from(run.text).length, cols = run.glyphColumns ?? chars, fixed = grid && (cols !== chars || /[^\x20-\x7e]/.test(run.text));
        const last = out[out.length - 1];
        if (last && !fixed && !last.fixed && last.fg === run.fg && last.bg === run.bg && last.x + last.cols === run.x) { last.text += run.text; last.cols += cols; }
        else out.push({ x: run.x, text: run.text, fg: run.fg, bg: run.bg, cols, fixed });
    }
    return out;
}

/**
 * Crisp DOM rendering of the same live frame the monitor texture shows. Rows are plain monospace
 * text (no letter spacing, no per-cell boxes), so letters sit at the font's natural pitch.
 * Read-only: keys still go to the world canvas, so all input rules stay in one place.
 */
export const FocusTerminalView = React.memo(function FocusTerminalView(props: { frame: MonitorFrame; fontSize: number }): React.ReactElement {
    const { frame } = props;
    const rows = visibleMonitorCells(frame.lines, frame.cells);
    const offset = frame.lines.length - rows.length;
    const grid = frame.cells !== undefined;
    const tc = frame.truecolor && frame.truecolor.foreground.length === frame.truecolor.background.length ? frame.truecolor : undefined;
    const skip = hex(frame.background ? frame.palette?.[dominantKey(frame.background) ?? ''] : undefined) ?? BASE;
    const cursor = frame.cursor?.visible ? { x: frame.cursor.x, y: frame.cursor.y - offset } : undefined;
    return <div className="omo-focus-term" style={{ fontSize: props.fontSize }} data-testid="focus-terminal" data-font-size={String(props.fontSize)}>
        <div className="omo-focus-term-grid" role="log" aria-label="Attached terminal" aria-live="off">
            {!rows.length && <div className="omo-focus-term-empty">{frame.status || 'Connecting to this desk…'}</div>}
            {rows.map((row, i) => {
                const direct = tc ? { fg: tc.foreground[offset + i], bg: tc.background[offset + i] } : undefined;
                const runs = cellRuns(row.join(''), frame.foreground?.[offset + i], frame.background?.[offset + i], frame.palette, { fg: '#e0e8eb', bg: BASE }, grid ? row : undefined, direct);
                const at = cursor?.y === i ? cursor.x : -1;
                return <div key={i} className="omo-focus-term-row">{segments(runs, grid).map(seg => {
                    const bg = seg.bg.toLowerCase() !== skip && seg.bg !== BASE ? seg.bg : undefined;
                    const style: React.CSSProperties = { color: seg.fg, background: bg, width: seg.fixed ? `${seg.cols}ch` : undefined };
                    if (at < seg.x || at >= seg.x + seg.cols) return <span key={seg.x} className={seg.fixed ? 'omo-focus-cell' : undefined} style={style}>{seg.text}</span>;
                    if (seg.fixed) return <span key={seg.x} className="omo-focus-cell is-cursor" style={style}>{seg.text}</span>;
                    const chars = Array.from(seg.text), c = at - seg.x;
                    return <span key={seg.x} style={style}>{chars.slice(0, c).join('')}<span className="is-cursor">{chars[c] ?? ' '}</span>{chars.slice(c + 1).join('')}</span>;
                })}{at >= row.length && <span className="is-cursor" style={{ marginLeft: `${at - row.length}ch` }}> </span>}</div>;
            })}
        </div>
    </div>;
});
