'use strict';
// Shared helpers for the Omo room server: ids, tokens, scrypt hashing, atomic files, input checks.
// Nothing here logs or returns a secret except the explicit "show once" token paths.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

const ROLES = Object.freeze(['viewer', 'member', 'builder', 'owner']);
const INVITE_ROLES = Object.freeze(['viewer', 'member', 'builder']);
const rank = role => ROLES.indexOf(role);
const atLeast = (role, min) => rank(role) >= 0 && rank(role) >= rank(min);

const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const MEMBER_ID_RE = /^m_[a-f0-9]{16}$/;
const INVITE_ID_RE = /^i_[a-f0-9]{16}$/;
const TOKEN_PREFIX = 'omo1';
const INVITE_PREFIX = 'omoinv1';
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const b64u = buf => Buffer.from(buf).toString('base64url');
const randomHex = bytes => crypto.randomBytes(bytes).toString('hex');
const newMemberId = () => `m_${randomHex(8)}`;
const newInviteId = () => `i_${randomHex(8)}`;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
    const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- bearer tokens: omo1.<roomId>.<memberId>.<32 random bytes b64url>; only an scrypt hash is stored ----
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function newSecret() { return b64u(crypto.randomBytes(32)); }
function formatToken(roomId, memberId, secret) { return `${TOKEN_PREFIX}.${roomId}.${memberId}.${secret}`; }
function parseToken(token) {
    if (typeof token !== 'string' || token.length > 200) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;
    const [, roomId, memberId, secret] = parts;
    if (!ROOM_ID_RE.test(roomId) || !MEMBER_ID_RE.test(memberId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    return { roomId, memberId, secret };
}
async function hashSecret(secret) {
    const salt = b64u(crypto.randomBytes(16));
    const key = await scryptAsync(secret, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${b64u(key)}`;
}
async function verifySecret(secret, record) {
    const [scheme, N, r, p, salt, expected] = String(record || '').split('$');
    if (scheme !== 'scrypt' || !salt || !expected) return false;
    try {
        const key = await scryptAsync(secret, salt, SCRYPT.keylen, { N: Number(N), r: Number(r), p: Number(p) });
        return safeEqual(b64u(key), expected);
    } catch { return false; }
}

// ---- invites: omoinv1.<payload b64url>.<HMAC-SHA256 b64url>; the record in the room file makes them single-use ----
function signInvite(key, payload) {
    const body = b64u(JSON.stringify(payload));
    const sig = b64u(crypto.createHmac('sha256', key).update(`${INVITE_PREFIX}.${body}`).digest());
    return `${INVITE_PREFIX}.${body}.${sig}`;
}
function verifyInvite(key, token) {
    if (typeof token !== 'string' || token.length > 600) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== INVITE_PREFIX) return null;
    const expected = b64u(crypto.createHmac('sha256', key).update(`${INVITE_PREFIX}.${parts[1]}`).digest());
    if (!safeEqual(parts[2], expected)) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
    if (!payload || payload.v !== 1 || !ROOM_ID_RE.test(payload.r) || !INVITE_ID_RE.test(payload.i) || !INVITE_ROLES.includes(payload.role) || !Number.isFinite(payload.exp)) return null;
    return payload;
}

// ---- files: data dir 0700, files 0600, write-to-temp + fsync + rename + fsync(dir) ----
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
}
function atomicWriteJson(file, value) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomHex(4)}.tmp`);
    const data = JSON.stringify(value, null, 2) + '\n';
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
    fs.chmodSync(file, 0o600);
    try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* some filesystems refuse dir fsync */ }
}

// ---- input checks ----
function displayName(input) {
    if (typeof input !== 'string') throw new Error('Name must be text.');
    const name = input.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 32 || CONTROL_RE.test(name)) throw new Error('Name must be 1–32 characters without control characters.');
    return name;
}
function roomName(input) {
    if (typeof input !== 'string') throw new Error('Room name must be text.');
    const name = input.trim();
    if (!name || name.length > 120 || CONTROL_RE.test(name)) throw new Error('Room name must be 1–120 characters.');
    return name;
}
function label(input, max = 80) {
    if (input === undefined || input === null || input === '') return undefined;
    if (typeof input !== 'string' || CONTROL_RE.test(input) || input.trim().length > max) throw new Error(`Labels are one line of at most ${max} characters.`);
    return input.trim() || undefined;
}
/** Status text must not look like a secret, a token or a host path. It is broadcast to everyone in the room. */
const SECRETISH = [
    /sk-[A-Za-z0-9_-]{12,}/, /gh[pousr]_[A-Za-z0-9]{16,}/, /github_pat_/i, /AKIA[0-9A-Z]{12,}/, /xox[abprs]-/i, /-----BEGIN/,
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{32,}/, /\b(password|passwd|secret|token|api[_-]?key|bearer)\b\s*[:=]/i,
    /\bomo1\./, /\bomoinv1\./, /(^|[\s'"(])(~\/|\/(home|Users|root|etc|var|tmp|opt|mnt|srv)\/)/, /[A-Za-z]:\\/
];
function looksSecret(text) { return SECRETISH.some(re => re.test(text)); }

function parseDuration(input, fallbackMs) {
    if (input === undefined || input === null || input === '') return fallbackMs;
    if (typeof input === 'number') return input;
    const m = /^(\d+)\s*(s|m|h|d)?$/.exec(String(input).trim());
    if (!m) throw new Error(`Bad duration ${input}. Use e.g. 30m, 24h, 7d.`);
    return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] || 'm'];
}

module.exports = {
    ROLES, INVITE_ROLES, rank, atLeast, ROOM_ID_RE, MEMBER_ID_RE, INVITE_ID_RE, CONTROL_RE,
    b64u, randomHex, newMemberId, newInviteId, sha256, safeEqual,
    newSecret, formatToken, parseToken, hashSecret, verifySecret, signInvite, verifyInvite,
    ensureDir, atomicWriteJson, displayName, roomName, label, looksSecret, parseDuration
};
