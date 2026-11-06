import * as React from 'react';
import type { MonitorFrame } from './room-scene';
import { cellRuns, clampGrid, dominantKey, GRID_MAX_COLS, GRID_MAX_ROWS } from './runtime-console-controller';

const BASE = '#091119';
/** Terminal text size in CSS px at 100% comfort: a normal terminal size. A− / A+ scale it; it never grows to fill. */
export const TERM_FONT = 14;
/** Row height in em. Matches .omo-focus-term-row in focus-mode.css. */
export const LINE = 1.4;
/** Screen padding + card padding + card border on both sides, in px (focus-mode.css). */
export const FRAME = { x: 2 * (20 + 20 + 1), y: 2 * (14 + 14 + 1) };

/**
 * Advance of one cell per 1px of font size, measured with the font the element really renders
 * (its computed font-family), again once web fonts settle. Used to work out how many columns fit
 * the box; the column pitch itself is the font's own advance, never a guess.
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
 * Terminal text size: TERM_FONT times the comfort step (A− / A+), to the half px. It does not
 * depend on the box: a bigger box gets more columns and rows (termGrid), never bigger letters.
 */
export function termFont(comfort: number): number {
    const value = Number.isFinite(comfort) && comfort > 0 ? comfort : 1;
    return Math.max(8, Math.round(TERM_FONT * value * 2) / 2);
}

/**
 * The real terminal grid that fits a screen box: box size (less padding and border) divided by the
 * measured cell size. Clamped to a sane minimum (narrow boxes scroll) and the host's maximum.
 */
export function termGrid(width: number, height: number, ratio: number, fontSize: number): { cols: number; rows: number } {
    const cell = Math.max(1, fontSize * (ratio > 0 ? ratio : 0.6)), line = Math.max(1, fontSize * LINE);
    // A hair of slack so sub-pixel rounding never wraps the last column or scrolls the last row.
    return clampGrid((width - FRAME.x - 1) / cell, (height - FRAME.y - 1) / line);
}

/**
 * Every row of the frame, at its own width (the attached view may be larger than the 80 x 22 desk
 * monitor). Missing cell metadata supports older hosts; malformed supplied rows fail closed.
 */
export function frameRows(lines: readonly string[], cells?: readonly (readonly string[])[]): string[][] {
    return lines.slice(-GRID_MAX_ROWS).map((line, i, shown) => {
        if (cells === undefined) return Array.from(line).slice(0, GRID_MAX_COLS);
        const row = Array.isArray(cells) ? cells[lines.length - shown.length + i] : undefined;
        return Array.isArray(row) && row.every(g => typeof g === 'string') ? row.slice(0, GRID_MAX_COLS) : [];
    });
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
export const FocusTerminalView = React.memo(function FocusTerminalView(props: { frame: MonitorFrame; fontSize: number; cols?: number; rows?: number }): React.ReactElement {
    const { frame } = props;
    const rows = frameRows(frame.lines, frame.cells);
    const width = Math.max(props.cols ?? 0, ...rows.map(row => row.length), 1);
    const offset = frame.lines.length - rows.length;
    const grid = frame.cells !== undefined;
    const tc = frame.truecolor && frame.truecolor.foreground.length === frame.truecolor.background.length ? frame.truecolor : undefined;
    const skip = hex(frame.background ? frame.palette?.[dominantKey(frame.background) ?? ''] : undefined) ?? BASE;
    const cursor = frame.cursor?.visible ? { x: frame.cursor.x, y: frame.cursor.y - offset } : undefined;
    return <div className="omo-focus-term" style={{ fontSize: props.fontSize }} data-testid="focus-terminal" data-font-size={String(props.fontSize)}
        data-cols={props.cols !== undefined ? String(props.cols) : undefined} data-rows={props.rows !== undefined ? String(props.rows) : undefined}>
        <div className="omo-focus-term-grid" role="log" aria-label="Attached terminal" aria-live="off" style={{ minWidth: `${width}ch` }}>
            {!rows.length && <div className="omo-focus-term-empty">{frame.status || 'Connecting to this desk…'}</div>}
            {rows.map((row, i) => {
                const direct = tc ? { fg: tc.foreground[offset + i], bg: tc.background[offset + i] } : undefined;
                const runs = cellRuns(row.join(''), frame.foreground?.[offset + i], frame.background?.[offset + i], frame.palette, { fg: '#e0e8eb', bg: BASE }, grid ? row : undefined, direct, GRID_MAX_COLS);
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
