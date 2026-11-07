'use strict';
// Room persistence. Layout under the data dir (dir 0700, files 0600):
//   rooms/<roomId>.json            room file. ONLY the running server writes it (atomic temp+rename).
//                                  The CLI writes it only to create a room, or when no server holds the lock.
//   rooms/<roomId>.invites/<id>.json  invite records (no secrets). Written by the CLI and the server.
//   server.lock                    pid of the server that owns this data dir.
//   audit.log                      JSON lines: room created, invite issued/used/revoked, role changes. No secrets.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util.cjs');
const W = require('../vendor/world-model.cjs');
const { canonicalWorld } = require('./world-guard.cjs');

const ROOM_FILE_VERSION = 1;

class DataDir {
    constructor(dir) {
        this.dir = path.resolve(dir);
        this.roomsDir = path.join(this.dir, 'rooms');
        U.ensureDir(this.dir);
        U.ensureDir(this.roomsDir);
    }
    roomFile(id) { if (!U.ROOM_ID_RE.test(id)) throw new Error('Bad room id.'); return path.join(this.roomsDir, `${id}.json`); }
    inviteDir(id) { if (!U.ROOM_ID_RE.test(id)) throw new Error('Bad room id.'); return path.join(this.roomsDir, `${id}.invites`); }
    exists(id) { return U.ROOM_ID_RE.test(id) && fs.existsSync(this.roomFile(id)); }
    listRooms() { return fs.readdirSync(this.roomsDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(id => U.ROOM_ID_RE.test(id)).sort(); }
    read(id) {
        const raw = JSON.parse(fs.readFileSync(this.roomFile(id), 'utf8'));
        if (!raw || raw.fileVersion !== ROOM_FILE_VERSION || raw.id !== id) throw new Error(`Room file ${id} is not a version ${ROOM_FILE_VERSION} room.`);
        raw.members ??= {}; raw.usedInvites ??= {}; raw.revokedInvites ??= {};
        return raw;
    }
    write(room) { U.atomicWriteJson(this.roomFile(room.id), room); }
    audit(event) {
        const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
        fs.appendFileSync(path.join(this.dir, 'audit.log'), line, { mode: 0o600 });
    }
    writeInviteRecord(roomId, record) {
        const dir = this.inviteDir(roomId); U.ensureDir(dir);
        U.atomicWriteJson(path.join(dir, `${record.id}.json`), record);
    }
    readInviteRecords(roomId) {
        const dir = this.inviteDir(roomId);
        if (!fs.existsSync(dir)) return [];
        const out = [];
        for (const f of fs.readdirSync(dir)) {
            if (!/^i_[a-f0-9]{16}\.json$/.test(f)) continue;
            try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip a torn record */ }
        }
        return out.sort((a, b) => a.createdAt - b.createdAt);
    }
    // ---- single-server lock ----
    lockFile() { return path.join(this.dir, 'server.lock'); }
    lockHolder() {
        try {
            const pid = Number(fs.readFileSync(this.lockFile(), 'utf8').trim());
            if (!Number.isInteger(pid) || pid <= 0) return null;
            try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : null; }
        } catch { return null; }
    }
    acquireLock() {
        const holder = this.lockHolder();
        if (holder && holder !== process.pid) throw new Error(`Another room server (pid ${holder}) is using ${this.dir}.`);
        U.atomicWriteJson(this.lockFile(), process.pid);
        const release = () => { try { if (this.lockHolder() === process.pid) fs.unlinkSync(this.lockFile()); } catch { /* ignore */ } };
        process.on('exit', release);
        return release;
    }
}

/** Create a room with an owner. Returns { room, ownerToken } — the token is shown ONCE and only its scrypt hash is kept. */
async function createRoom(data, { id, name, ownerName, theme = 'station', world }) {
    if (!U.ROOM_ID_RE.test(id || '')) throw new Error('Room id must be 3–32 lowercase letters, numbers or hyphens.');
    if (data.exists(id)) throw new Error(`Room ${id} already exists.`);
    const roomName = U.roomName(name || id);
    let spec = world ? JSON.parse(JSON.stringify(world)) : W.worldFromRoomV1({ theme, projectName: roomName });
    spec.revision = 0;
    const valid = W.validateWorld(spec);
    if (!valid.ok) throw new Error(`World is invalid: ${valid.error}`);
    spec = canonicalWorld(spec);
    const ownerId = U.newMemberId(), secret = U.newSecret(), now = Date.now();
    const room = {
        fileVersion: ROOM_FILE_VERSION, id, name: roomName, createdAt: now,
        inviteKey: crypto.randomBytes(32).toString('hex'),
        world: spec,
        members: { [ownerId]: { id: ownerId, name: U.displayName(ownerName || 'Owner'), role: 'owner', tokenHash: await U.hashSecret(secret), createdAt: now, lastSeenAt: 0, via: 'create-room' } },
        usedInvites: {}, revokedInvites: {}
    };
    // O_EXCL on a temp + link() so two concurrent creators cannot both win.
    const file = data.roomFile(id), tmp = `${file}.${process.pid}.create.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(room, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try { fs.linkSync(tmp, file); } catch (e) { fs.unlinkSync(tmp); if (e.code === 'EEXIST') throw new Error(`Room ${id} already exists.`); throw e; }
    fs.unlinkSync(tmp); fs.chmodSync(file, 0o600);
    data.audit({ event: 'room-created', room: id, owner: ownerId });
    return { room, ownerId, ownerToken: U.formatToken(id, ownerId, secret) };
}

/** Sign an invite and write its (secret-free) record. Works offline (CLI) and in the server. */
function issueInvite(data, room, { role = 'member', ttlMs = 24 * 3600e3, createdBy = 'cli', note, publicUrl }) {
    if (!U.INVITE_ROLES.includes(role)) throw new Error(`Invite role must be one of ${U.INVITE_ROLES.join(', ')}. Rooms have exactly one owner.`);
    if (!Number.isFinite(ttlMs) || ttlMs < 60e3 || ttlMs > 30 * 864e5) throw new Error('Invites last between 1 minute and 30 days.');
    const id = U.newInviteId(), createdAt = Date.now(), expiresAt = createdAt + ttlMs;
    const token = U.signInvite(Buffer.from(room.inviteKey, 'hex'), { v: 1, r: room.id, i: id, role, exp: expiresAt });
    const record = { id, role, createdAt, expiresAt, createdBy, note: U.label(note, 80) };
    data.writeInviteRecord(room.id, record);
    data.audit({ event: 'invite-issued', room: room.id, invite: id, role, expiresAt, by: createdBy });
    const base = publicUrl ? publicUrl.replace(/\/+$/, '') : null;
    // The invite rides in the URL FRAGMENT so it never reaches proxy or server access logs.
    return { record, token, link: base ? `${base}/join#invite=${token}` : null };
}

module.exports = { DataDir, createRoom, issueInvite, ROOM_FILE_VERSION };
