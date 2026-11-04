import { normalizeWebUrl } from './web-url';
import { visibleMonitorCells } from './monitor-selection';

export interface TerminalLink { text: string; url: string }
/** Visible plain-text HTTP(S) links only. Never fetch, execute, unwrap, or repair terminal output. */
export function terminalLinks(lines: readonly string[], cells?: readonly (readonly string[])[]): TerminalLink[] {
    const result: TerminalLink[] = [], seen = new Set<string>();
    const grid = cells === undefined ? undefined : visibleMonitorCells(lines,cells);
    // Match the physical monitor's 80 x 22 viewport; do not turn a clipped URL into a destination.
    for (const [index,plain] of lines.slice(-22).entries()) {
        const row = grid?.[index], line = row ? row.join('') : plain;
        // An older host cannot prove non-ASCII column widths. Do not guess a destination.
        if (!row && /[^\x20-\x7e]/.test(line)) continue;
        for (const match of (row ? line : line.slice(0,81)).matchAll(/https?:\/\/[^\s<>"']+/gi)) {
            const text = match[0], end = match.index! + text.length;
            if (row ? (row.length >= 80 && end === line.length && !/\s/.test(row[79])) : (end > 80 || (end === 80 && !/\s/.test(line.charAt(80))))) continue;
            try {
                const url = normalizeWebUrl(text);
                if (seen.has(url)) continue;
                seen.add(url); result.push({ text, url });
                if (result.length === 8) return result;
            } catch { /* invalid or credential-bearing destinations never become controls */ }
        }
    }
    return result;
}
