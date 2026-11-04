export interface MonitorCell { row: number; col: number }
export interface SelectionSpan { row: number; from: number; to: number }
export type SelectionUnit = 'char' | 'word' | 'line';
// Same path/token characters as the vendored Minecraft bridge's termcore.WORD.
// Continuations come from the terminal parser, never from guessed Unicode widths.
const WORD = /[\p{L}\p{N}_\-./~:@%+#?=&,]/u;
const COLS = 80, ROWS = 22;
const bound = (n: number, max: number): number => Math.max(0, Math.min(max, Math.floor(Number.isFinite(n) ? n : 0)));
const cell = (p: MonitorCell): MonitorCell => ({ row: bound(p.row, ROWS - 1), col: bound(p.col, COLS - 1) });
export function visibleMonitorLines(lines: string[]): string[] { return lines.slice(-ROWS).map(line => Array.from(line).slice(0, COLS).join('')); }
/** Missing metadata supports older hosts. Malformed supplied rows fail closed. */
export function visibleMonitorCells(lines: readonly string[], cells?: readonly (readonly string[])[]): string[][] {
    const offset = Math.max(0, lines.length - ROWS);
    return lines.slice(-ROWS).map((line,i) => {
        if (cells === undefined) return Array.from(line).slice(0,COLS);
        const row = Array.isArray(cells) ? cells[offset+i] : undefined;
        return Array.isArray(row) && row.slice(0,COLS).every(g => typeof g === 'string') ? row.slice(0,COLS) : [];
    });
}
/** Whole-glyph boundaries in terminal columns; an empty cell continues the glyph on its left. */
export function monitorCellSpan(row: readonly string[], column: number): { from: number; to: number } {
    let from = bound(column,COLS-1);
    while (from > 0 && row[from] === '') from--;
    let to = from+1; while (to < Math.min(row.length,COLS) && row[to] === '') to++;
    return {from,to};
}
/** Pick only the terminal text grid, never the monitor bezel or title. UV comes from the actual screen mesh. */
export function monitorCell(u: number, v: number, width: number, clamp = false): MonitorCell | undefined {
    if (![u, v, width].every(Number.isFinite) || width <= 0 || u < 0 || u > 1 || v < 0 || v > 1) return undefined;
    const col = Math.floor((u * 1024 - 24) / width), row = Math.floor(((1 - v) * 576 - 53) / 22);
    if (!clamp && (col < 0 || col >= COLS || row < 0 || row >= ROWS)) return undefined;
    return cell({ row, col });
}
/** Local visible-frame selection only. It never sends terminal input or requests scrollback. */
export class MonitorSelection {
    private rows: string[][];
    private anchor: MonitorCell;
    private focus: MonitorCell;
    private active = true;
    constructor(lines: string[], anchor: MonitorCell, private unit: SelectionUnit = 'char', cells?: string[][]) { this.rows = visibleMonitorCells(lines,cells); this.anchor = cell(anchor); this.focus = this.anchor; }
    extend(point: MonitorCell): void { this.focus = cell(point); }
    refresh(lines: string[], cells?: string[][]): boolean { if (JSON.stringify(visibleMonitorCells(lines,cells)) !== JSON.stringify(this.rows)) this.active = false; return this.active; }
    spans(): SelectionSpan[] {
        if (!this.active) return [];
        const [start, end] = this.anchor.row * COLS + this.anchor.col <= this.focus.row * COLS + this.focus.col ? [this.anchor, this.focus] : [this.focus, this.anchor];
        let left = monitorCellSpan(this.rows[start.row] ?? [],start.col).from, right = monitorCellSpan(this.rows[end.row] ?? [],end.col).to-1;
        if (this.unit === 'line') { left = 0; right = COLS - 1; }
        if (this.unit === 'word') {
            const first = this.rows[start.row] ?? [], last = this.rows[end.row] ?? [];
            while (left > 0) {
                const previous = monitorCellSpan(first,left-1);
                if (!WORD.test(first[left] ?? '') || !WORD.test(first[previous.from] ?? '')) break;
                left = previous.from;
            }
            while (right+1 < last.length) {
                const current = monitorCellSpan(last,right), next = monitorCellSpan(last,right+1);
                if (!WORD.test(last[current.from] ?? '') || !WORD.test(last[next.from] ?? '')) break;
                right = next.to-1;
            }
        }
        return Array.from({ length: end.row - start.row + 1 }, (_, i) => ({ row: start.row + i, from: i === 0 ? left : 0, to: start.row + i === end.row ? right + 1 : COLS }));
    }
    text(): string { return this.spans().map(span => (this.rows[span.row] ?? []).slice(span.from, span.to).join('').replace(/ +$/, '')).join('\n'); }
}
