#!/usr/bin/env node
/*
 * Omo sky multiplayer room server: link-share join, avatars (pose relay), proximity-voice signalling, text chat.
 *   node mp/server.cjs [--port 3672] [--host 127.0.0.1|<tailscale 100.x ip>] [--live-port 3671]
 * - Binds 127.0.0.1 by default. --host takes ONE loopback or Tailscale (100.64.0.0/10) address; 0.0.0.0 / LAN are refused.
 * - One room per run. Prints `room=<id>`, `host-key=<48 hex>` and `share-base=http://<host>:<port>/?room=<id>`.
 * - Serves the penthouse page READ-ONLY from an allowlist (index.html, baked/, vendor/, /three/, mp/*.js, ui/*, live/live.js).
 *   It has NO terminal endpoints and never sees the live server's token: guests get the room, avatars and voice only.
 * - /mp/ws  JSON text frames. First frame must be hello with ONE of:
 *     host:<host-key>  -> role host (may mint invites)      invite:<signed link token> -> role guest
 *     member:<signed member token> -> rejoin as the same guest (page reload)
 *   Then: pose, voice, signal (WebRTC offer/answer/ice/bye, audio only), chat, invite (host), ping.
 *   There is deliberately no message type for terminals, desks or screens.
 * - Invites are HMAC-SHA256 signed (per-run secret), expire (default 24 h) and may be one-use.
 * - Foreign Host header -> 403 (DNS rebinding). Foreign Origin on the socket -> 403.
 * Protocol and checks are ported from Kaviru's omo/server/src (protocol.cjs, hub.cjs, rate.cjs, presence-protocol).
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), net = require('node:net');
const NM = '~/dev/omo-skyscraper/omo/node_modules';
const { WebSocketServer } = require(NM + '/ws');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', process.env.MP_PORT || 3672));
const HOST = arg('--host', process.env.MP_HOST || '127.0.0.1');
const LIVE_PORT = Number(arg('--live-port', process.env.LIVE_PORT || 3671));
const INVITE_TTL_MS = Number(arg('--invite-hours', 24)) * 3600e3;
const LANE = path.resolve(__dirname, '..');
const LAB = path.resolve(LANE, '..');
const THREE_DIR = '~/dev/omo-skyscraper/omo/node_modules/three';

function allowedBind(h) {
    if (!net.isIPv4(h)) return false;
    const [a, b] = h.split('.').map(Number);
    return a === 127 || (a === 100 && b >= 64 && b <= 127);   // loopback or Tailscale CGNAT range only
}
if (!allowedBind(HOST)) { console.error(`Refusing to listen on ${HOST}: use 127.0.0.1 (default) or your Tailscale 100.x address.`); process.exit(2); }

const SECRET = crypto.randomBytes(32);
const ROOM = crypto.randomBytes(4).toString('hex');
const HOST_KEY = crypto.randomBytes(24).toString('hex');
// --public-url https://<machine>.<tailnet>.ts.net : the address guests use when Tailscale Serve (tailnet-only HTTPS) is in front.
const PUBLIC_ARG = arg('--public-url', process.env.MP_PUBLIC_URL || '');
if (PUBLIC_ARG && !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(PUBLIC_ARG)) { console.error('--public-url must be https://<machine>.<tailnet>.ts.net (Tailscale Serve, tailnet only)'); process.exit(2); }
const PUBLIC = PUBLIC_ARG || `http://${HOST}:${PORT}`;
const LIVE_ORIGINS = String(arg('--live-origins', process.env.MP_LIVE_ORIGINS || '')).split(',').filter(Boolean);
const LIMITS = { maxOnline: 8, smallFrame: 4 * 1024, bigFrame: 20 * 1024, helloMs: 10000, chatMax: 300, chatBacklog: 30 };
const COLOURS = ['#5fb4ff', '#ff7a6b', '#5fe0b5', '#ffc04d', '#b48cff', '#ff6fc4', '#a6e35a', '#e0c9a0'];
const CLOSE = { auth: 4001, replaced: 4009, rate: 4029, full: 4030, policy: 1008 };
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SESSION_RE = /^[a-f0-9]{8,32}$/;
const MEMBER_RE = /^m_[a-f0-9]{16}$/;
// From Kaviru's util.cjs: chat/status text that looks like a secret, a token or a host path is refused.
const SECRETISH = [/sk-[A-Za-z0-9_-]{12,}/, /gh[pousr]_[A-Za-z0-9]{16,}/, /github_pat_/i, /AKIA[0-9A-Z]{12,}/, /xox[abprs]-/i, /-----BEGIN/,
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{32,}/, /\b(password|passwd|secret|token|api[_-]?key|bearer)\b\s*[:=]/i,
    /(^|[\s'"(])(~\/|\/(home|Users|root|etc|var|tmp|opt|mnt|srv)\/)/, /[A-Za-z]:\\/];
const looksSecret = (t) => SECRETISH.some(re => re.test(t));

const TYPES = { '.xml': 'application/xml', '.STL': 'model/stl', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.splat': 'application/octet-stream', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const hostNames = new Set([`${HOST}:${PORT}`, ...(HOST.startsWith('127.') ? [`127.0.0.1:${PORT}`, `localhost:${PORT}`] : []), ...(PUBLIC_ARG ? [new URL(PUBLIC_ARG).host] : [])]);
const okHost = (h) => hostNames.has(h);
const origins = new Set([...[...hostNames].map(h => 'http://' + h), ...(PUBLIC_ARG ? [PUBLIC_ARG] : []), `http://127.0.0.1:${LIVE_PORT}`, `http://localhost:${LIVE_PORT}`, ...LIVE_ORIGINS]);
const okOrigin = (o) => !o || origins.has(o);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[mp]', ...a);

// ------------------------------------------------------------------------------------------ signed tokens
const b64u = (s) => Buffer.from(s).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function sign(kind, payload) { const body = b64u(JSON.stringify(payload)); return `${kind}.${body}.${mac(kind + '.' + body)}`; }
function verify(kind, token) {
    if (typeof token !== 'string' || token.length > 600) return null;
    const parts = token.split('.'); if (parts.length !== 3 || parts[0] !== kind) return null;
    const want = Buffer.from(mac(kind + '.' + parts[1])), got = Buffer.from(parts[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try { const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); return p && p.r === ROOM ? p : null; } catch { return null; }
}
const usedInvites = new Set();
function mintInvite(oneUse) {
    const i = crypto.randomBytes(6).toString('hex');
    return `${PUBLIC}/?room=${ROOM}#invite=${sign('v1', { r: ROOM, i, one: !!oneUse, exp: Date.now() + INVITE_TTL_MS })}`;
}

// ------------------------------------------------------------------------------------------ rate limits (Kaviru's rate.cjs)
class Buckets {
    constructor(capacity, perSecond) { this.capacity = capacity; this.perSecond = perSecond; this.map = new Map(); }
    take(key) {
        const now = Date.now(); let b = this.map.get(key);
        if (!b) { b = { tokens: this.capacity, at: now }; this.map.set(key, b); }
        else { b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.perSecond); b.at = now; }
        if (b.tokens < 1) return false; b.tokens -= 1; return true;
    }
}
const RATE = { pose: new Buckets(60, 30), signal: new Buckets(300, 60), chat: new Buckets(8, 0.8), misc: new Buckets(30, 5) };

// ------------------------------------------------------------------------------------------ validation (Kaviru's protocol.cjs)
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
function displayName(input) {
    if (typeof input !== 'string') throw new Error('Name must be text.');
    const name = input.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 32 || CONTROL_RE.test(name)) throw new Error('Name must be 1–32 characters without control characters.');
    return name;
}
function pose(p) {   // room: x 0..18, z -12..0, floor 0, ceiling 3.4 (a margin for the lifts/terrace)
    if (!isObj(p) || !num(p.x, -6, 24) || !num(p.z, -18, 6) || !num(p.y, -3, 6) || !num(p.yaw, -100, 100) || !num(p.pitch, -1.6, 1.6)) throw new Error('Invalid room position.');
    const lv = num(p.lv, 0, 1) ? Math.round(p.lv * 100) / 100 : 0;
    const r = (v) => Math.round(v * 1000) / 1000;
    return { x: r(p.x), y: r(p.y), z: r(p.z), yaw: r(p.yaw), pitch: r(p.pitch), lv };
}
function voiceStatus(s) {
    if (s === null) return null;
    if (!isObj(s) || typeof s.session !== 'string' || !SESSION_RE.test(s.session) || typeof s.muted !== 'boolean' || typeof s.deaf !== 'boolean') throw new Error('Invalid voice status.');
    return { session: s.session, muted: s.muted || s.deaf, deaf: s.deaf };
}
function signal(m) {
    if (typeof m.to !== 'string' || !MEMBER_RE.test(m.to) || typeof m.toSession !== 'string' || !SESSION_RE.test(m.toSession) || typeof m.session !== 'string' || !SESSION_RE.test(m.session)) throw new Error('Invalid voice signal address.');
    if (!['offer', 'answer', 'ice', 'bye'].includes(m.kind)) throw new Error('Invalid voice signal kind.');
    if (typeof m.data !== 'string' || m.data.length > 16 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(m.data)) throw new Error('Invalid voice signal payload.');
    if ((m.kind === 'offer' || m.kind === 'answer') && /^m=(?!audio)/m.test(m.data)) throw new Error('Room voice carries audio only.');
    return { to: m.to, toSession: m.toSession, session: m.session, kind: m.kind, data: m.data };
}
function parse(text) {
    if (typeof text !== 'string') throw new Error('Text frames only.');
    let m; try { m = JSON.parse(text); } catch { throw new Error('Frames are JSON.'); }
    if (!isObj(m) || typeof m.type !== 'string') throw new Error('Missing message type.');
    if (m.type !== 'signal' && text.length > LIMITS.smallFrame) throw new Error('Message too large.');
    const id = typeof m.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(m.id) ? m.id : undefined;
    switch (m.type) {
        case 'hello': return { type: 'hello', host: m.host, invite: m.invite, member: m.member, name: displayName(m.name) };
        case 'ping': return { type: 'ping', id };
        case 'pose': return { type: 'pose', p: pose(m.p) };
        case 'voice': return { type: 'voice', status: voiceStatus(m.status === undefined ? null : m.status) };
        case 'signal': return { type: 'signal', id, s: signal(m) };
        case 'chat': {
            if (typeof m.text !== 'string' || CONTROL_RE.test(m.text)) throw new Error('Chat is one line of plain text.');
            const t = m.text.trim(); if (!t || t.length > LIMITS.chatMax) throw new Error(`Chat lines are 1–${LIMITS.chatMax} characters.`);
            return { type: 'chat', id, text: t };
        }
        case 'invite': return { type: 'invite', id, oneUse: m.oneUse === true };
        default: throw new Error(`Unknown message type ${String(m.type).slice(0, 40)}.`);
    }
}

// ------------------------------------------------------------------------------------------ room
const conns = new Map();       // member id -> conn
const members = new Map();     // member id -> { id, name, colour, role } (survives reconnects)
const chat = [];
const send = (c, o) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); };
const broadcast = (o, except) => { const s = JSON.stringify(o); for (const c of conns.values()) if (c.member.id !== except && c.ws.readyState === 1) c.ws.send(s); };
const presence = (c) => ({ id: c.member.id, name: c.member.name, colour: c.member.colour, role: c.member.role, voice: c.voice, p: c.pose });
function pickColour() { const used = new Set([...conns.values()].map(c => c.member.colour)); return COLOURS.find(c => !used.has(c)) || COLOURS[members.size % COLOURS.length]; }

function hello(c, m) {
    let member;
    if (m.host !== undefined) {
        const t = String(m.host); if (t.length !== HOST_KEY.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(HOST_KEY))) return deny(c, 'That host key is not valid.');
        member = [...members.values()].find(x => x.role === 'host');
        if (!member) { member = { id: 'm_' + crypto.randomBytes(8).toString('hex'), role: 'host' }; members.set(member.id, member); }
    } else if (m.member !== undefined) {
        const p = verify('v1m', m.member); member = p && members.get(p.m);
        if (!member || member.role !== 'guest') return deny(c, 'This seat has expired. Ask the host for a new link.');
    } else if (m.invite !== undefined) {
        const p = verify('v1', m.invite);
        if (!p) return deny(c, 'This invite link is not valid for this room.');
        if (!(p.exp > Date.now())) return deny(c, 'This invite link has expired. Ask the host for a new one.');
        if (p.one && usedInvites.has(p.i)) return deny(c, 'This one-use invite link was already used. Ask the host for a new one.');
        if (conns.size >= LIMITS.maxOnline) return deny(c, `The room is full (${LIMITS.maxOnline} people).`, CLOSE.full);
        if (p.one) usedInvites.add(p.i);
        member = { id: 'm_' + crypto.randomBytes(8).toString('hex'), role: 'guest', invite: p.i };
        members.set(member.id, member);
    } else return deny(c, 'Join with a share link.');
    if (!conns.has(member.id) && conns.size >= LIMITS.maxOnline) return deny(c, `The room is full (${LIMITS.maxOnline} people).`, CLOSE.full);
    member.name = m.name; if (!member.colour) member.colour = pickColour();
    const old = conns.get(member.id); if (old) { old.replaced = true; old.ws.close(CLOSE.replaced, 'Opened in another tab'); }
    c.member = member; c.voice = null; c.pose = null; conns.set(member.id, c);
    clearTimeout(c.helloTimer);
    const memberToken = member.role === 'guest' ? sign('v1m', { r: ROOM, m: member.id }) : undefined;
    send(c, { type: 'welcome', room: ROOM, self: { id: member.id, name: member.name, colour: member.colour, role: member.role }, memberToken, members: [...conns.values()].filter(x => x !== c).map(presence), chat });
    broadcast({ type: 'join', member: presence(c) }, member.id);
    log(`join ${member.id} ${member.role} "${member.name}" (${conns.size} online)`);
}
function deny(c, error, code = CLOSE.auth) { send(c, { type: 'error', code: 'auth', error }); log(`refused: ${error}`); c.ws.close(code, 'refused'); }
function fail(c, id, error, code) { c.strikes++; send(c, { type: 'error', id, code, error }); if (c.strikes > 60) c.ws.close(CLOSE.policy, 'Too many bad frames'); }
const limited = (c, bucket) => { if (RATE[bucket].take(c.member.id)) return false; fail(c, undefined, 'Slow down.', 'rate'); return true; };

function handle(c, text) {
    let m;
    try { m = parse(text); } catch (e) { return fail(c, undefined, e.message, 'bad-request'); }
    if (!c.member) { if (m.type !== 'hello') return fail(c, undefined, 'Say hello first.', 'hello'); return hello(c, m); }
    const me = c.member;
    switch (m.type) {
        case 'hello': return fail(c, undefined, 'Already joined.', 'bad-request');
        case 'ping': return send(c, { type: 'pong', id: m.id, at: Date.now() });
        case 'pose': if (limited(c, 'pose')) return; c.pose = m.p; return broadcast({ type: 'pose', id: me.id, p: m.p }, me.id);
        case 'voice': {
            if (limited(c, 'misc')) return;
            const prev = c.voice && c.voice.session; c.voice = m.status;
            if (prev && prev !== (m.status && m.status.session)) broadcast({ type: 'signal', from: me.id, fromSession: prev, kind: 'bye', data: '' }, me.id);
            return broadcast({ type: 'update', member: presence(c) });
        }
        case 'signal': {
            if (limited(c, 'signal')) return;
            const s = m.s;
            if (!c.voice || c.voice.session !== s.session) return fail(c, m.id, 'Join voice first.', 'voice-off');
            const t = conns.get(s.to);
            if (!t || t === c || !t.voice || t.voice.session !== s.toSession) return;   // stale peer: drop quietly
            return send(t, { type: 'signal', from: me.id, fromSession: s.session, kind: s.kind, data: s.data });
        }
        case 'chat': {
            if (limited(c, 'chat')) return;
            if (looksSecret(m.text)) return fail(c, m.id, 'That message looks like it holds a secret, a token or a file path. It was not sent.', 'secret');
            const msg = { id: crypto.randomBytes(6).toString('hex'), from: me.id, name: me.name, colour: me.colour, at: Date.now(), text: m.text };
            chat.push(msg); if (chat.length > LIMITS.chatBacklog) chat.shift();
            return broadcast({ type: 'chat', message: msg });
        }
        case 'invite': {
            if (me.role !== 'host') return fail(c, m.id, 'Only the host can make share links.', 'forbidden');
            if (limited(c, 'misc')) return;
            log(`invite minted (${m.oneUse ? 'one-use' : 'reusable'})`);
            return send(c, { type: 'invite', id: m.id, link: mintInvite(m.oneUse) });
        }
    }
}

// ------------------------------------------------------------------------------------------ http (read-only allowlist)
const ALLOW = [/^\/$/, /^\/index\.html$/, /^\/baked\/[\w.-]+$/, /^\/vendor\/[\w./-]+$/, /^\/mp\/[\w-]+\.(js|css)$/, /^\/touch\/[\w-]+\.(js|css)$/, /^\/(social|screens|flat|avatars)\/[\w-]+\.(js|css)$/, /^\/avatars\/fonts\/[\w-]+\.woff2$/, /^\/avatars\/rp1\/mjcf\/robot_24dof\.xml$/, /^\/avatars\/rp1\/lod\/(hand\/(left|right)\/)?[\w-]+\.STL$/, /^\/screens\/media\/[\w.-]+\.(mp4|webm)$/, /^\/ui\/[\w-]+\.(js|css)$/, /^\/ui\/fonts\/[\w-]+\.woff2$/, /^\/live\/vendor\/xterm\.js$/, /^\/live\/live\.js$/, /^\/three\/(build|examples\/jsm)\/[\w./-]+$/];
const server = http.createServer((req, res) => {
    if (!okHost(req.headers.host)) { res.writeHead(403); return res.end('forbidden host'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const url = new URL(req.url, PUBLIC);
    let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p.includes('..') || !ALLOW.some(re => re.test(p)) || /\.(cjs|sh|md|blend|py)$/.test(p)) { res.writeHead(403); return res.end(); }
    let file = p.startsWith('/three/') ? path.join(THREE_DIR, p.slice(7)) : path.join(LANE, p === '/' ? 'index.html' : p);
    file = path.normalize(file);
    if (!(file.startsWith(LANE + path.sep) || file.startsWith(THREE_DIR + path.sep))) { res.writeHead(403); return res.end(); }
    try { const real = fs.realpathSync(file); if (!(real.startsWith(LAB + path.sep) || real.startsWith(THREE_DIR + path.sep))) { res.writeHead(403); return res.end(); } } catch {}
    fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(b); });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.bigFrame });
server.on('upgrade', (req, socket, head) => {
    const no = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    if (!okHost(req.headers.host)) return no(403, 'Forbidden');
    if (new URL(req.url, PUBLIC).pathname !== '/mp/ws') return no(404, 'Not Found');
    if (!okOrigin(req.headers.origin)) return no(403, 'Forbidden');
    wss.handleUpgrade(req, socket, head, ws => {
        const c = { ws, member: null, voice: null, pose: null, strikes: 0 };
        c.helloTimer = setTimeout(() => { if (!c.member) ws.close(CLOSE.auth, 'No hello'); }, LIMITS.helloMs);
        ws.on('message', (d, isBinary) => { if (isBinary) return fail(c, undefined, 'Text frames only.', 'bad-request'); handle(c, d.toString()); });
        ws.on('close', () => {
            clearTimeout(c.helloTimer);
            if (!c.member || conns.get(c.member.id) !== c) return;
            conns.delete(c.member.id);
            if (c.voice) broadcast({ type: 'signal', from: c.member.id, fromSession: c.voice.session, kind: 'bye', data: '' });
            broadcast({ type: 'leave', id: c.member.id });
            log(`leave ${c.member.id} (${conns.size} online)`);
        });
        ws.on('error', () => {});
    });
});

server.listen(PORT, HOST, () => {
    console.log(`room=${ROOM}`);
    console.log(`host-key=${HOST_KEY}`);
    console.log(`share-base=${PUBLIC}/?room=${ROOM}`);
    console.log(`host: open the live page with  &mp=${HOST}:${PORT}#mphost=${HOST_KEY}  (or run node mp/host.cjs)`);
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { for (const c of conns.values()) c.ws.close(1001, 'Server shutting down'); server.close(); process.exit(0); });
