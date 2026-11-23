/**
 * promise:share — short human room codes ("MARS-4827").
 *
 * A room code is a SHORT NAME for an invite that already exists on the room server. The code is pure
 * randomness from an unambiguous alphabet: it carries no token, no room id and no signature, so
 * reading it tells nothing about the invite behind it. Only the server's table maps code -> signed
 * invite, and an entry lives exactly as long as its invite (same expiry, single use, removed on use).
 *
 * Format: 4 letters, a hyphen, 4 digits. Letters skip I, L and O; digits skip 0 and 1, so a code read
 * aloud or copied from a screen cannot be mistaken. 23^4 x 8^4 ≈ 1.1 billion codes; the server also
 * rate-limits wrong guesses per address.
 *
 * Pure module (no Node or DOM APIs) so the IDE, the tests and the room server (vendored) share it.
 */

export const ROOM_CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_DIGITS = '23456789';
export const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[2-9]{4}$/;
/** At most this many live codes per table (per server); the oldest are dropped first. */
export const ROOM_CODE_TABLE_MAX = 2000;

/** A random code. `random` returns integers in [0, n) — pass a crypto source on the server. */
export function makeRoomCode(random: (n: number) => number): string {
    let letters = '', digits = '';
    for (let i = 0; i < 4; i++) letters += ROOM_CODE_LETTERS[random(ROOM_CODE_LETTERS.length)];
    for (let i = 0; i < 4; i++) digits += ROOM_CODE_DIGITS[random(ROOM_CODE_DIGITS.length)];
    return `${letters}-${digits}`;
}

export function isRoomCode(value: unknown): value is string {
    return typeof value === 'string' && ROOM_CODE_RE.test(value);
}

/**
 * Turn what a person typed into the canonical code, or throw a short readable Error.
 * Accepts lower case, spaces and a missing hyphen. A typed I, L, O, 0 or 1 is always a mistake in
 * this alphabet, so it is reported, not guessed.
 */
export function normaliseRoomCode(input: string): string {
    const raw = String(input ?? '').trim().toUpperCase().replace(/[\s_–—.]+/g, '-').replace(/-+/g, '-');
    if (!raw) throw new Error('Type the room code, like MARS-4827.');
    const compact = raw.replace(/-/g, '');
    if (compact.length !== 8) throw new Error('A room code has 4 letters and 4 numbers, like MARS-4827.');
    const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
    if (!ROOM_CODE_RE.test(code)) {
        if (/[IOL01]/.test(compact)) throw new Error('Room codes never use I, L, O, 0 or 1. Check the code, like MARS-4827.');
        throw new Error('A room code has 4 letters and 4 numbers, like MARS-4827.');
    }
    return code;
}

export type RoomCodeLookup<T> = { ok: true; value: T } | { ok: false; reason: 'unknown' | 'expired'; message: string };

export const ROOM_CODE_MESSAGES = {
    unknown: 'That room code was not found. Check the code, or ask the host for a new one.',
    expired: 'That room code has expired. Ask the host for a new one.'
} as const;

/**
 * The server-side table: code -> value (the signed invite) with the invite's own expiry.
 * In memory only: a restarted server forgets its codes (the invite links still work).
 */
export class RoomCodeTable<T> {
    private entries = new Map<string, { value: T; expiresAt: number }>();
    constructor(private readonly random: (n: number) => number, private readonly now: () => number = Date.now) {}

    get size(): number { return this.entries.size; }

    /** Mint a fresh code for `value`, valid until `expiresAt` (ms). */
    issue(value: T, expiresAt: number): string {
        this.sweep();
        if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('The invite has already expired.');
        let code = makeRoomCode(this.random);
        for (let i = 0; this.entries.has(code); i++) { if (i > 50) throw new Error('No free room code. Try again.'); code = makeRoomCode(this.random); }
        while (this.entries.size >= ROOM_CODE_TABLE_MAX) { const oldest = this.entries.keys().next().value as string; this.entries.delete(oldest); }
        this.entries.set(code, { value, expiresAt });
        return code;
    }

    /** Look a typed code up. Never throws for a wrong code: returns a readable reason. Throws only for a malformed code. */
    lookup(input: string): RoomCodeLookup<T> {
        const code = normaliseRoomCode(input);
        const entry = this.entries.get(code);
        if (!entry) return { ok: false, reason: 'unknown', message: ROOM_CODE_MESSAGES.unknown };
        if (entry.expiresAt <= this.now()) { this.entries.delete(code); return { ok: false, reason: 'expired', message: ROOM_CODE_MESSAGES.expired }; }
        return { ok: true, value: entry.value };
    }

    /** Take the code out (it was used). */
    remove(input: string): void { try { this.entries.delete(normaliseRoomCode(input)); } catch { /* not a code */ } }
    /** Drop every code whose value matches (an invite was revoked). */
    removeWhere(match: (value: T) => boolean): void { for (const [code, e] of this.entries) if (match(e.value)) this.entries.delete(code); }
    sweep(): void { const now = this.now(); for (const [code, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(code); }
}
