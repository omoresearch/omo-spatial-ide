'use strict';
// Small Node client for the Omo room server, for the Omo node backend (or scripts) to use.
// It holds the room key in memory only. It never sends terminal data: the server has no such message.
//
//   const { RoomClient } = require('omo/server/client/room-client.cjs');
//   const c = new RoomClient({ url: 'wss://omo.example.ts.net/ws', token, name: 'Harry', onMessage: m => ... });
//   await c.connect();                         // resolves with the welcome message
//   await c.request({ type: 'world-ops', baseRevision: c.world.revision, ops: [...] });
//   c.send({ type: 'pose', pose: { x, z, yaw, pitch } });
//   c.close();
const path = require('path');
const WebSocket = require(require.resolve('ws', { paths: [__dirname, path.resolve(__dirname, '../..')] }));

const PROTOCOL_VERSION = 1;
/** Close codes after which a reconnect cannot help. */
const FATAL = new Set([4001, 4003, 4009, 4040, 1008]);

class RoomClient {
    constructor({ url, token, name, colour, pose, ca, rejectUnauthorized = true, onMessage = () => {}, onState = () => {}, reconnect = true }) {
        if (!/^wss?:\/\//.test(url || '')) throw new Error('Room server URL must start with wss:// (or ws:// for a local test).');
        this.url = url; this.token = token; this.hello = { name, colour, pose };
        this.tls = { ca, rejectUnauthorized };
        this.onMessage = onMessage; this.onState = onState; this.reconnect = reconnect;
        this.ws = null; this.pending = new Map(); this.seq = 0; this.closedByUser = false; this.backoff = 1000;
        this.world = null; this.self = null; this.presence = new Map();
    }
    connect() {
        this.closedByUser = false;
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url, { ...this.tls, perMessageDeflate: false, maxPayload: 256 * 1024, handshakeTimeout: 10_000 });
            this.ws = ws; this.onState('connecting');
            let welcomed = false;
            ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token: this.token, ...Object.fromEntries(Object.entries(this.hello).filter(([, v]) => v !== undefined)) })));
            ws.on('message', raw => {
                let m; try { m = JSON.parse(raw.toString()); } catch { return; }
                this.track(m);
                if (m.type === 'welcome' && !welcomed) { welcomed = true; this.backoff = 1000; this.onState('open'); resolve(m); }
                if ((m.type === 'reply' || m.type === 'error') && m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
                this.onMessage(m);
            });
            ws.on('close', (code, reason) => {
                for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ type: 'error', error: 'Disconnected.', code: 'closed' }); }
                this.pending.clear();
                this.onState('closed', { code, reason: reason.toString() });
                if (!welcomed) reject(new Error(`Room server closed the connection (${code} ${reason.toString() || ''}).`.trim()));
                if (welcomed && this.reconnect && !this.closedByUser && !FATAL.has(code)) {
                    const wait = this.backoff; this.backoff = Math.min(this.backoff * 2, 30_000);
                    setTimeout(() => { if (!this.closedByUser) this.connect().catch(() => {}); }, wait + Math.floor(Math.random() * 500)).unref?.();
                }
            });
            ws.on('error', e => { if (!welcomed) reject(e); });
        });
    }
    track(m) {
        switch (m.type) {
            case 'welcome': this.world = m.world; this.self = m.self; this.presence = new Map(m.presence.map(p => [p.id, p])); break;
            case 'world': this.world = m.world; break;
            case 'self': this.self = m.self; break;
            case 'presence-join': case 'presence-update': this.presence.set(m.member.id, m.member); break;
            case 'presence-leave': this.presence.delete(m.id); break;
            case 'pose': { const p = this.presence.get(m.id); if (p) p.pose = m.pose; break; }
            default: break;
        }
    }
    send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
    request(m, timeoutMs = 10_000) {
        const id = `c${++this.seq}`;
        return new Promise(resolve => {
            const timer = setTimeout(() => { this.pending.delete(id); resolve({ type: 'error', error: 'No reply.', code: 'timeout' }); }, timeoutMs);
            this.pending.set(id, { resolve, timer });
            this.send({ ...m, id });
        });
    }
    close() { this.closedByUser = true; this.ws?.close(1000); }
}

/** Redeem an invite over HTTPS. Returns { roomId, roomName, memberId, role, name, token, wsUrl }. */
async function redeemInvite(baseUrl, invite, name, fetchImpl = globalThis.fetch) {
    const res = await fetchImpl(new URL('/api/join', baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite, name }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Join failed (${res.status}).`);
    return body;
}

module.exports = { RoomClient, redeemInvite, PROTOCOL_VERSION };
