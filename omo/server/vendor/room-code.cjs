// GENERATED from omo/extension/src/common/room-code.ts (sha256 f52dfbffe71a42ed389a1eb93675f3a06e38e4ec89cb20e471284f8a370c290c). Do not edit.
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomCodeTable = exports.ROOM_CODE_MESSAGES = exports.ROOM_CODE_TABLE_MAX = exports.ROOM_CODE_RE = exports.ROOM_CODE_DIGITS = exports.ROOM_CODE_LETTERS = void 0;
exports.makeRoomCode = makeRoomCode;
exports.isRoomCode = isRoomCode;
exports.normaliseRoomCode = normaliseRoomCode;
exports.ROOM_CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
exports.ROOM_CODE_DIGITS = '23456789';
exports.ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[2-9]{4}$/;
/** At most this many live codes per table (per server); the oldest are dropped first. */
exports.ROOM_CODE_TABLE_MAX = 2000;
/** A random code. `random` returns integers in [0, n) — pass a crypto source on the server. */
function makeRoomCode(random) {
    let letters = '', digits = '';
    for (let i = 0; i < 4; i++)
        letters += exports.ROOM_CODE_LETTERS[random(exports.ROOM_CODE_LETTERS.length)];
    for (let i = 0; i < 4; i++)
        digits += exports.ROOM_CODE_DIGITS[random(exports.ROOM_CODE_DIGITS.length)];
    return `${letters}-${digits}`;
}
function isRoomCode(value) {
    return typeof value === 'string' && exports.ROOM_CODE_RE.test(value);
}
/**
 * Turn what a person typed into the canonical code, or throw a short readable Error.
 * Accepts lower case, spaces and a missing hyphen. A typed I, L, O, 0 or 1 is always a mistake in
 * this alphabet, so it is reported, not guessed.
 */
function normaliseRoomCode(input) {
    const raw = String(input ?? '').trim().toUpperCase().replace(/[\s_–—.]+/g, '-').replace(/-+/g, '-');
    if (!raw)
        throw new Error('Type the room code, like MARS-4827.');
    const compact = raw.replace(/-/g, '');
    if (compact.length !== 8)
        throw new Error('A room code has 4 letters and 4 numbers, like MARS-4827.');
    const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
    if (!exports.ROOM_CODE_RE.test(code)) {
        if (/[IOL01]/.test(compact))
            throw new Error('Room codes never use I, L, O, 0 or 1. Check the code, like MARS-4827.');
        throw new Error('A room code has 4 letters and 4 numbers, like MARS-4827.');
    }
    return code;
}
exports.ROOM_CODE_MESSAGES = {
    unknown: 'That room code was not found. Check the code, or ask the host for a new one.',
    expired: 'That room code has expired. Ask the host for a new one.'
};
/**
 * The server-side table: code -> value (the signed invite) with the invite's own expiry.
 * In memory only: a restarted server forgets its codes (the invite links still work).
 */
class RoomCodeTable {
    constructor(random, now = Date.now) {
        this.random = random;
        this.now = now;
        this.entries = new Map();
    }
    get size() { return this.entries.size; }
    /** Mint a fresh code for `value`, valid until `expiresAt` (ms). */
    issue(value, expiresAt) {
        this.sweep();
        if (!Number.isFinite(expiresAt) || expiresAt <= this.now())
            throw new Error('The invite has already expired.');
        let code = makeRoomCode(this.random);
        for (let i = 0; this.entries.has(code); i++) {
            if (i > 50)
                throw new Error('No free room code. Try again.');
            code = makeRoomCode(this.random);
        }
        while (this.entries.size >= exports.ROOM_CODE_TABLE_MAX) {
            const oldest = this.entries.keys().next().value;
            this.entries.delete(oldest);
        }
        this.entries.set(code, { value, expiresAt });
        return code;
    }
    /** Look a typed code up. Never throws for a wrong code: returns a readable reason. Throws only for a malformed code. */
    lookup(input) {
        const code = normaliseRoomCode(input);
        const entry = this.entries.get(code);
        if (!entry)
            return { ok: false, reason: 'unknown', message: exports.ROOM_CODE_MESSAGES.unknown };
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(code);
            return { ok: false, reason: 'expired', message: exports.ROOM_CODE_MESSAGES.expired };
        }
        return { ok: true, value: entry.value };
    }
    /** Take the code out (it was used). */
    remove(input) { try {
        this.entries.delete(normaliseRoomCode(input));
    }
    catch { /* not a code */ } }
    /** Drop every code whose value matches (an invite was revoked). */
    removeWhere(match) { for (const [code, e] of this.entries)
        if (match(e.value))
            this.entries.delete(code); }
    sweep() { const now = this.now(); for (const [code, e] of this.entries)
        if (e.expiresAt <= now)
            this.entries.delete(code); }
}
exports.RoomCodeTable = RoomCodeTable;
