/**
 * Voice network settings (w2 voice lane): STUN/TURN for room voice across NATs.
 *
 * Stored by the backend in the Theia config dir (`omo-voice.json`, mode 0600). Never part of a
 * WorldSpec, a room snapshot or any export. The frontend only ever sees:
 *   - `VoiceNetworkView` (secrets masked: `hasCredential`), for the settings panel;
 *   - `VoiceIceConfig`, the RTCIceServer list the browser needs to open its own TURN allocation.
 *     With a coturn shared secret (`use-auth-secret`), the backend mints short-lived credentials
 *     (TURN REST API: username = "<expiry>:omo", credential = base64(HMAC-SHA1(secret, username)))
 *     so the long-term secret never leaves the backend.
 * Default: public STUN only (no relay; audio stays peer to peer).
 */
export const OMO_VOICE_SETTINGS_PATH = '/services/omo-voice-settings';
export const OmoVoiceSettingsService = Symbol('OmoVoiceSettingsService');
export const VOICE_SETTINGS_FILE = 'omo-voice.json';

export const DEFAULT_STUN_URLS: readonly string[] = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
export const VOICE_MAX_URLS = 4;
/** Lifetime of minted TURN REST credentials. The browser refreshes before expiry. */
export const TURN_REST_TTL_S = 12 * 3600;

export type StunMode = 'default' | 'custom' | 'off';
export type TurnAuthMode = 'static' | 'rest-secret';

export interface VoiceTurnStored { urls: string[]; mode: TurnAuthMode; username?: string; credential?: string; secret?: string }
export interface VoiceNetworkStored { version: 1; stun: StunMode; stunUrls: string[]; turn?: VoiceTurnStored; relayOnly: boolean }

export interface VoiceNetworkView {
    stun: StunMode;
    stunUrls: string[];
    turn?: { urls: string[]; mode: TurnAuthMode; username?: string; hasCredential: boolean };
    relayOnly: boolean;
    /** Where the settings live (for the panel's footnote). A local path; never shared with peers. */
    file: string;
}

export interface VoiceNetworkUpdate {
    stun: StunMode;
    stunUrls?: string[];
    /** null = remove TURN. `credential` / `secret` undefined = keep the stored value. */
    turn?: { urls: string[]; mode: TurnAuthMode; username?: string; credential?: string; secret?: string } | null;
    relayOnly: boolean;
}

export interface VoiceIceServer { urls: string[]; username?: string; credential?: string }
export interface VoiceIceConfig { iceServers: VoiceIceServer[]; iceTransportPolicy: 'all' | 'relay'; /** ms epoch; refresh before this. */ expiresAt?: number; hasTurn: boolean }

export interface OmoVoiceSettingsService {
    get(): Promise<VoiceNetworkView>;
    save(update: VoiceNetworkUpdate): Promise<VoiceNetworkView>;
    iceConfig(): Promise<VoiceIceConfig>;
}

export const DEFAULT_VOICE_NETWORK: VoiceNetworkStored = { version: 1, stun: 'default', stunUrls: [], relayOnly: false };

const HOST = /^(?:\[[0-9a-fA-F:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

/** RFC 7064/7065 URI, restricted: stun:host[:port], turn(s):host[:port][?transport=udp|tcp]. */
export function iceUrl(raw: unknown, allowed: ReadonlyArray<'stun' | 'stuns' | 'turn' | 'turns'>): string {
    if (typeof raw !== 'string') throw new Error('Server address must be text.');
    const url = raw.trim();
    const m = /^(stuns?|turns?):([^?\s/@]+?)(?::(\d{1,5}))?(\?transport=(udp|tcp))?$/.exec(url);
    if (!m) throw new Error(`"${url.slice(0, 80)}" is not a STUN/TURN address. Use e.g. turn:turn.example.com:3478?transport=udp`);
    const scheme = m[1] as 'stun' | 'stuns' | 'turn' | 'turns';
    if (!allowed.includes(scheme)) throw new Error(`"${url.slice(0, 80)}" must start with ${allowed.map(a => a + ':').join(' or ')}`);
    if (!HOST.test(m[2])) throw new Error(`"${m[2].slice(0, 60)}" is not a valid host name.`);
    if (m[3] !== undefined) { const port = Number(m[3]); if (port < 1 || port > 65535) throw new Error(`Port ${m[3]} is out of range.`); }
    if (m[4] && scheme.startsWith('stun')) throw new Error('STUN addresses take no ?transport.');
    return url;
}

function urls(input: unknown, allowed: ReadonlyArray<'stun' | 'stuns' | 'turn' | 'turns'>, what: string): string[] {
    if (!Array.isArray(input)) throw new Error(`${what} must be a list.`);
    const out = [...new Set(input.map(u => iceUrl(u, allowed)))];
    if (out.length > VOICE_MAX_URLS) throw new Error(`At most ${VOICE_MAX_URLS} ${what}.`);
    return out;
}

function text(input: unknown, what: string, max = 256): string | undefined {
    if (input === undefined || input === null || input === '') return undefined;
    if (typeof input !== 'string' || input.length > max || /[\u0000-\u001f\u007f]/u.test(input)) throw new Error(`${what} must be at most ${max} plain characters.`);
    return input;
}

/** Validates an update and merges kept secrets from `previous`. Throws a user-readable Error. */
export function voiceNetworkMerge(update: VoiceNetworkUpdate, previous: VoiceNetworkStored): VoiceNetworkStored {
    if (!update || typeof update !== 'object') throw new Error('Invalid voice settings.');
    if (update.stun !== 'default' && update.stun !== 'custom' && update.stun !== 'off') throw new Error('Invalid STUN mode.');
    const out: VoiceNetworkStored = { version: 1, stun: update.stun, stunUrls: update.stun === 'custom' ? urls(update.stunUrls ?? [], ['stun', 'stuns'], 'STUN servers') : [], relayOnly: update.relayOnly === true };
    if (out.stun === 'custom' && !out.stunUrls.length) throw new Error('Add at least one STUN server, or choose the default.');
    const t = update.turn === undefined ? (previous.turn ? { ...previous.turn } : undefined) : update.turn;
    if (t) {
        if (t.mode !== 'static' && t.mode !== 'rest-secret') throw new Error('Invalid TURN sign-in mode.');
        const turnUrls = urls(t.urls, ['turn', 'turns'], 'TURN servers');
        if (!turnUrls.length) throw new Error('Add a TURN server address, or remove TURN.');
        const same = previous.turn && previous.turn.mode === t.mode;
        const turn: VoiceTurnStored = { urls: turnUrls, mode: t.mode };
        if (t.mode === 'static') {
            turn.username = text(t.username, 'TURN user name');
            turn.credential = text(t.credential, 'TURN password', 512) ?? (same ? previous.turn!.credential : undefined);
            if (!turn.username || !turn.credential) throw new Error('A TURN server needs a user name and password (or use a shared secret).');
        } else {
            turn.username = text(t.username, 'TURN user label', 64);
            if (turn.username && turn.username.includes(':')) throw new Error('The TURN user label cannot contain ":".');
            turn.secret = text(t.secret, 'TURN shared secret', 512) ?? (same ? previous.turn!.secret : undefined);
            if (!turn.secret) throw new Error('Enter the coturn static-auth-secret.');
        }
        out.turn = turn;
    }
    if (out.relayOnly && !out.turn) throw new Error('"Relay only" needs a TURN server.');
    return out;
}

/** Reads a stored file leniently: anything invalid falls back to defaults (and keeps working). */
export function voiceNetworkParse(raw: unknown): VoiceNetworkStored {
    try {
        const r = raw as VoiceNetworkStored;
        if (!r || r.version !== 1) return { ...DEFAULT_VOICE_NETWORK };
        return voiceNetworkMerge({ stun: r.stun, stunUrls: r.stunUrls, relayOnly: r.relayOnly, turn: r.turn ? { ...r.turn } : null }, { ...DEFAULT_VOICE_NETWORK });
    } catch { return { ...DEFAULT_VOICE_NETWORK }; }
}

export function voiceNetworkView(stored: VoiceNetworkStored, file: string): VoiceNetworkView {
    const view: VoiceNetworkView = { stun: stored.stun, stunUrls: [...stored.stunUrls], relayOnly: stored.relayOnly, file };
    if (stored.turn) view.turn = { urls: [...stored.turn.urls], mode: stored.turn.mode, ...(stored.turn.username ? { username: stored.turn.username } : {}), hasCredential: !!(stored.turn.credential || stored.turn.secret) };
    return view;
}

/** Builds the browser ICE config. `hmac` is injected (node crypto on the backend). */
export function voiceIceConfig(stored: VoiceNetworkStored, now: number, hmac: (secret: string, message: string) => string): VoiceIceConfig {
    const iceServers: VoiceIceServer[] = [];
    const stun = stored.stun === 'default' ? [...DEFAULT_STUN_URLS] : stored.stun === 'custom' ? stored.stunUrls : [];
    if (stun.length) iceServers.push({ urls: [...stun] });
    let expiresAt: number | undefined;
    if (stored.turn) {
        if (stored.turn.mode === 'static') iceServers.push({ urls: [...stored.turn.urls], username: stored.turn.username, credential: stored.turn.credential });
        else {
            const expiry = Math.floor(now / 1000) + TURN_REST_TTL_S;
            const username = `${expiry}:${stored.turn.username || 'omo'}`;
            iceServers.push({ urls: [...stored.turn.urls], username, credential: hmac(stored.turn.secret!, username) });
            expiresAt = expiry * 1000;
        }
    }
    return { iceServers, iceTransportPolicy: stored.relayOnly && stored.turn ? 'relay' : 'all', hasTurn: !!stored.turn, ...(expiresAt ? { expiresAt } : {}) };
}
