/**
 * Address policy for in-world web surfaces. Only plain http(s) pages: no javascript:, file:, data:,
 * browser-internal or other schemes, and no embedded user names or passwords. A bare domain becomes
 * https; a loopback host (localhost, 127.0.0.1, [::1]) without a scheme becomes http, for local dev servers.
 */
export const MAX_URL_LENGTH = 2048;

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const LOOPBACK_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;
// host[:port][/...], where host is a dotted name, an IPv4 address, or a bracketed IPv6 address.
const BARE_HOST_RE = /^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?(?:[/?#]|$)/;

export function normalizeWebUrl(input: unknown): string {
    if (typeof input !== 'string') {
        throw new Error('URL must be a string');
    }
    const raw = input.trim();
    if (!raw) {
        throw new Error('URL is empty');
    }
    if (raw.length > MAX_URL_LENGTH) {
        throw new Error(`URL is longer than ${MAX_URL_LENGTH} characters`);
    }
    // Control characters and whitespace inside an address are never a valid page address.
    if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
        throw new Error('URL contains whitespace or control characters');
    }
    let candidate = raw;
    const scheme = SCHEME_RE.exec(raw);
    // "localhost:3000" and "example.com:8443" parse as a scheme; they are host:port, not schemes.
    const looksLikeHostPort = scheme && /^[^/]+:\d{1,5}(?:[/?#]|$)/.test(raw);
    if (scheme && !looksLikeHostPort) {
        const name = scheme[1].toLowerCase();
        if (name !== 'http' && name !== 'https') {
            throw new Error(`URL scheme "${name}:" is not allowed; only http and https pages can be opened`);
        }
        if (!/^https?:\/\//i.test(raw)) {
            throw new Error('URL must have the form http(s)://host/...');
        }
    } else if (raw.startsWith('/')) {
        throw new Error('URL needs a host name');
    } else if (raw.includes('@') && !/[/?#]/.test(raw.split('@')[0])) {
        throw new Error('URL must not contain a user name or password (credentials are never sent from Omo)');
    } else if (LOOPBACK_RE.test(raw)) {
        candidate = `http://${raw}`;
    } else if (BARE_HOST_RE.test(raw)) {
        candidate = `https://${raw}`;
    } else {
        throw new Error(`"${raw.slice(0, 80)}" is not a web address`);
    }
    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        throw new Error(`"${raw.slice(0, 80)}" is not a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`URL scheme "${url.protocol}" is not allowed`);
    }
    if (url.username || url.password) {
        throw new Error('URL must not contain a user name or password (credentials are never sent from Omo)');
    }
    if (!url.hostname) {
        throw new Error('URL needs a host name');
    }
    return url.href;
}

/** True for addresses the policy accepts as already-normalized http(s) URLs (used for page-initiated navigations). */
export function isAllowedWebUrl(href: string): boolean {
    try {
        return /^https?:\/\//i.test(href) && normalizeWebUrl(href) === new URL(href).href;
    } catch {
        return false;
    }
}
