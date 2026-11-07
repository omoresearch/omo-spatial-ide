import type { SessionTab } from '../common/runtime-protocol';

/**
 * w2:agents — dsh web helpers. A dsh tab runs `dsh web --no-open --port <port>` on loopback; dsh prints
 * `dsh web: http://127.0.0.1:<port>/?...` with a one-time login token. 'Open on web wall' opens that
 * printed URL when it is on the screen (so the wall gets signed in), else the bare loopback root.
 */
export function dshWebUrl(tab: Pick<SessionTab, 'kind' | 'webUrl'> | undefined, screen: readonly string[] = []): string | undefined {
    if (!tab || tab.kind !== 'dsh' || !tab.webUrl) return undefined;
    const root = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/$/.exec(tab.webUrl);
    if (!root) return undefined;
    const printed = new RegExp(`dsh web: (http://(?:127\\.0\\.0\\.1|localhost):${root[1]}/[^\\s]*)`);
    for (let i = screen.length - 1; i >= 0; i--) {
        const match = printed.exec(screen[i]);
        if (match) return match[1];
    }
    return tab.webUrl;
}

