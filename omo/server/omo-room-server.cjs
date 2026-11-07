#!/usr/bin/env node
'use strict';
// Omo room server — shared rooms for people on different computers.
//
//   node omo/server/omo-room-server.cjs --data DIR --port N [--host H] [--tls-cert F --tls-key F]
//        [--public-url https://omo.example.ts.net] [--allow-origin URL]... [--trust-proxy] [--allow-plain-http]
//   node omo/server/omo-room-server.cjs create-room --data DIR --id ROOM [--name TEXT] [--owner NAME] [--theme station|jungle] [--world FILE]
//   node omo/server/omo-room-server.cjs invite      --data DIR --room ROOM [--role member|builder|viewer] [--ttl 24h] [--note TEXT] [--public-url URL]
//   node omo/server/omo-room-server.cjs invites     --data DIR --room ROOM
//   node omo/server/omo-room-server.cjs revoke      --data DIR --room ROOM --invite ID
//   node omo/server/omo-room-server.cjs rooms       --data DIR
//   node omo/server/omo-room-server.cjs reset-owner --data DIR --room ROOM      (server must be stopped)
//
// Secrets (owner token, invite links) are printed ONCE to stdout and never written to disk or logs.
const fs = require('fs');
const path = require('path');
const U = require('./src/util.cjs');
const { DataDir, createRoom, issueInvite } = require('./src/store.cjs');

const FLAGS_WITH_VALUE = new Set(['data', 'port', 'host', 'tls-cert', 'tls-key', 'public-url', 'allow-origin', 'id', 'name', 'owner', 'theme', 'world', 'room', 'role', 'ttl', 'note', 'invite']);
function parseArgs(argv) {
    const out = { _: [], 'allow-origin': [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
        if (FLAGS_WITH_VALUE.has(k)) {
            const v = inline !== undefined ? inline : argv[++i];
            if (v === undefined) throw new Error(`--${k} needs a value.`);
            if (k === 'allow-origin') out[k].push(v); else out[k] = v;
        } else out[k] = true;
    }
    return out;
}
const die = msg => { process.stderr.write(`omo-room-server: ${msg}\n`); process.exit(2); };
const need = (a, k) => { if (!a[k]) die(`--${k} is required.`); return a[k]; };
const isLoopback = h => h === '127.0.0.1' || h === 'localhost' || h === '::1';

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 15).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n'); return; }
    const a = parseArgs(argv);
    const cmd = a._[0] || 'serve';
    const data = new DataDir(need(a, 'data'));

    if (cmd === 'create-room') {
        let world;
        if (a.world) world = JSON.parse(fs.readFileSync(a.world, 'utf8'));
        const theme = a.theme || 'station';
        if (!['station', 'jungle'].includes(theme)) die('--theme is station or jungle.');
        const out = await createRoom(data, { id: need(a, 'id'), name: a.name, ownerName: a.owner, theme, world });
        process.stdout.write([
            `Room created: ${out.room.id} (${out.room.name})`,
            `Owner: ${out.room.members[out.ownerId].name} (${out.ownerId})`,
            '',
            'OWNER KEY (shown once, not stored; keep it private):',
            out.ownerToken,
            ''
        ].join('\n') + '\n');
        return;
    }
    if (cmd === 'invite') {
        const roomId = need(a, 'room');
        if (!data.exists(roomId)) die(`No room ${roomId}.`);
        const room = data.read(roomId);
        const out = issueInvite(data, room, { role: a.role || 'member', ttlMs: U.parseDuration(a.ttl, 24 * 3600e3), note: a.note, createdBy: 'cli', publicUrl: a['public-url'] });
        process.stdout.write([
            `Invite ${out.record.id}: role ${out.record.role}, single use, expires ${new Date(out.record.expiresAt).toISOString()}`,
            out.link ? `Link (send privately): ${out.link}` : 'No --public-url given; send the invite code and the server address:',
            ...(a['public-url'] ? [`Omo app link (paste into Remote room → Join): ${require('./src/ide-wire.cjs').ideInviteLink(new URL(a['public-url']).origin, roomId, out.token)}`] : []), // t2:pkg
            `Invite code: ${out.token}`,
            ''
        ].join('\n') + '\n');
        return;
    }
    if (cmd === 'invites') {
        const roomId = need(a, 'room');
        const room = data.read(roomId), now = Date.now();
        for (const x of data.readInviteRecords(roomId)) {
            const status = x.revokedAt || room.revokedInvites[x.id] ? 'revoked' : x.usedAt || room.usedInvites[x.id] ? 'used' : x.expiresAt <= now ? 'expired' : 'open';
            process.stdout.write(`${x.id}  ${x.role.padEnd(7)}  ${status.padEnd(7)}  expires ${new Date(x.expiresAt).toISOString()}${x.note ? `  ${x.note}` : ''}\n`);
        }
        return;
    }
    if (cmd === 'revoke') {
        const roomId = need(a, 'room'), id = need(a, 'invite');
        if (!U.INVITE_ID_RE.test(id)) die('Bad invite id.');
        const rec = data.readInviteRecords(roomId).find(x => x.id === id);
        if (!rec) die(`No invite ${id} in ${roomId}.`);
        data.writeInviteRecord(roomId, { ...rec, revokedAt: Date.now() });
        data.audit({ event: 'invite-revoked', room: roomId, invite: id, by: 'cli' });
        process.stdout.write(`Revoked ${id}.\n`);
        return;
    }
    if (cmd === 'rooms') {
        for (const id of data.listRooms()) {
            const r = data.read(id);
            process.stdout.write(`${id}  "${r.name}"  members ${Object.keys(r.members).length}  world rev ${r.world.revision}  entities ${r.world.entities.length}\n`);
        }
        return;
    }
    if (cmd === 'reset-owner') {
        const holder = data.lockHolder();
        if (holder) die(`Stop the room server (pid ${holder}) first.`);
        const roomId = need(a, 'room');
        const room = data.read(roomId);
        const owner = Object.values(room.members).find(m => m.role === 'owner');
        if (!owner) die('Room has no owner.');
        const secret = U.newSecret();
        owner.tokenHash = await U.hashSecret(secret);
        data.write(room);
        data.audit({ event: 'owner-reset', room: roomId, member: owner.id, by: 'cli' });
        process.stdout.write(`New OWNER KEY for ${roomId} (old key no longer works; shown once):\n${U.formatToken(roomId, owner.id, secret)}\n`);
        return;
    }
    if (cmd !== 'serve') die(`Unknown command ${cmd}. Use --help.`);

    // ---------- serve ----------
    const port = Number(need(a, 'port'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) die('--port must be 0–65535.');
    const host = a.host || '127.0.0.1';
    const tls = !!(a['tls-cert'] || a['tls-key']);
    if (tls && !(a['tls-cert'] && a['tls-key'])) die('--tls-cert and --tls-key go together.');
    if (!tls && !isLoopback(host) && !a['allow-plain-http']) {
        die(`Refusing plain HTTP on ${host}. Use --tls-cert/--tls-key, keep --host 127.0.0.1 behind Tailscale Serve or a TLS reverse proxy, or pass --allow-plain-http (only on an encrypted private network such as a Tailscale address).`);
    }
    if (a['public-url']) { try { const u = new URL(a['public-url']); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { die('--public-url must be an http(s) URL.'); } }
    const { createServer } = require('./src/server.cjs');
    const release = data.acquireLock();
    const quiet = !!a.quiet;
    const log = (...parts) => { if (!quiet) process.stderr.write(`${new Date().toISOString()} ${parts.join(' ')}\n`); };
    const app = createServer({
        data, port, host, tlsCert: a['tls-cert'], tlsKey: a['tls-key'], publicUrl: a['public-url'],
        allowOrigins: a['allow-origin'], trustProxy: !!a['trust-proxy'], log
    });
    const addr = await app.listen();
    const scheme = tls ? 'https' : 'http';
    process.stdout.write(JSON.stringify({ service: 'omo-room-server', url: `${scheme}://${host.includes(':') ? `[${host}]` : host}:${addr.port}`, ws: `${tls ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${addr.port}/ws`, port: addr.port, pid: process.pid, data: data.dir, rooms: data.listRooms().length }) + '\n');
    const stop = async sig => { log('stopping on', sig); await app.close(); release(); process.exit(0); };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch(e => die(e.message));
