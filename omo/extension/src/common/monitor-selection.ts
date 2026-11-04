export interface MonitorCell { row: number; col: number }
export interface SelectionSpan { row: number; from: number; to: number }
export type SelectionUnit = 'char' | 'word' | 'line';
// Same path/token characters as the vendored Minecraft bridge's termcore.WORD.
// Wide-cell placeholder handling is deliberately not inferred from plain text.
const WORD = /[\p{L}\p{N}_\-./~:@%+#?=&,]/u;
const COLS = 80, ROWS = 22;
const bound = (n: number, max: number): number => Math.max(0, Math.min(max, Math.floor(Number.isFinite(n) ? n : 0)));
const cell = (p: MonitorCell): MonitorCell => ({ row: bound(p.row, ROWS - 1), col: bound(p.col, COLS - 1) });
export function visibleMonitorLines(lines: string[]): string[] { return lines.slice(-ROWS).map(line => Array.from(line).slice(0, COLS).join('')); }
/** Pick only the terminal text grid, never the monitor bezel or title. UV comes from the actual screen mesh. */
export function monitorCell(u: number, v: number, width: number, clamp = false): MonitorCell | undefined {
    if (![u, v, width].every(Number.isFinite) || width <= 0 || u < 0 || u > 1 || v < 0 || v > 1) return undefined;
    const col = Math.floor((u * 1024 - 24) / width), row = Math.floor(((1 - v) * 576 - 53) / 22);
    if (!clamp && (col < 0 || col >= COLS || row < 0 || row >= ROWS)) return undefined;
    return cell({ row, col });
}
/** Local visible-frame selection only. It never sends terminal input or requests scrollback. */
export class MonitorSelection {
    private lines: string[];
    private anchor: MonitorCell;
    private focus: MonitorCell;
    private active = true;
    constructor(lines: string[], anchor: MonitorCell, private unit: SelectionUnit = 'char') { this.lines = visibleMonitorLines(lines); this.anchor = cell(anchor); this.focus = this.anchor; }
    extend(point: MonitorCell): void { this.focus = cell(point); }
    refresh(lines: string[]): boolean { if (JSON.stringify(visibleMonitorLines(lines)) !== JSON.stringify(this.lines)) this.active = false; return this.active; }
    spans(): SelectionSpan[] {
        if (!this.active) return [];
        const [start, end] = this.anchor.row * COLS + this.anchor.col <= this.focus.row * COLS + this.focus.col ? [this.anchor, this.focus] : [this.focus, this.anchor];
        let left = start.col, right = end.col;
        if (this.unit === 'line') { left = 0; right = COLS - 1; }
        if (this.unit === 'word') {
            const first = Array.from(this.lines[start.row] ?? ''), last = Array.from(this.lines[end.row] ?? '');
            if (WORD.test(first[left] ?? '')) while (left > 0 && WORD.test(first[left-1])) left--;
            if (WORD.test(last[right] ?? '')) while (right+1 < last.length && WORD.test(last[right+1])) right++;
        }
        return Array.from({ length: end.row - start.row + 1 }, (_, i) => ({ row: start.row + i, from: i === 0 ? left : 0, to: start.row + i === end.row ? right + 1 : COLS }));
    }
    text(): string { return this.spans().map(span => Array.from(this.lines[span.row] ?? '').slice(span.from, span.to).join('').replace(/ +$/, '')).join('\n'); }
}
