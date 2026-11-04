import { normalizeWebUrl } from './web-url';

export interface TerminalLink { text: string; url: string }
/** Visible plain-text HTTP(S) links only. Never fetch, execute, unwrap, or repair terminal output. */
export function terminalLinks(lines: readonly string[]): TerminalLink[] {
    const result: TerminalLink[] = [], seen = new Set<string>();
    // Match the physical monitor's 80 x 22 viewport; do not turn a clipped URL into a destination.
    for (const line of lines.slice(-22)) {
        for (const match of line.slice(0, 81).matchAll(/https?:\/\/[^\s<>"']+/gi)) {
            const text = match[0], end = match.index! + text.length;
            if (end > 80 || (end === 80 && !/\s/.test(line.charAt(80)))) continue;
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
