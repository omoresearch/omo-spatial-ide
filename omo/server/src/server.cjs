'use strict';
// HTTP(S) + WS(S) front of the Omo room server: join page, invite redemption, health, world read,
// and the authenticated WebSocket. Origin allowlist, per-IP limits, body and frame size caps.
const fs = require('fs');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const U = require('./util.cjs');
const { Hub, CLOSE } = require('./hub.cjs');
const { PROTOCOL_VERSION, LIMITS, parseClient, pose: checkPose } = require('./protocol.cjs');
const { Buckets } = require('./rate.cjs');

const MAX_BODY = 4 * 1024;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

function joinPage() {
    // No inline script: CSP forbids it. The invite is read from the URL fragment, never sent in a URL.
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join an Omo room</title><link rel="stylesheet" href="/join.css">
<main><h1>Join an Omo room</h1>
<p id="intro">You were invited to a shared Omo room. Choose the name other people will see.</p>
<form id="f"><label>Your name<input id="name" maxlength="32" required autocomplete="nickname"></label><button>Join room</button></form>
<p id="status" role="status"></p>
<section id="done" hidden><h2>You joined <span id="room"></span></h2>
<p>This is your room key. It is shown <b>only once</b>. Paste it into Omo (Room → Connect to a room server). Keep it private: anyone with it can enter as you.</p>
<textarea id="token" readonly rows="3"></textarea><button id="copy" type="button">Copy key</button>
<p>Server: <code id="server"></code></p></section></main><script src="/join.js"></script></html>`;
}
const JOIN_CSS = 'body{font:16px system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#e8ecf4;background:#11141c}input,button,textarea{font:inherit;padding:.55rem;margin:.3rem 0;width:100%;box-sizing:border-box}button{cursor:pointer}textarea{font-family:ui-monospace,monospace;font-size:.85rem}code{word-break:break-all}#status{min-height:1.4rem}';
const JOIN_JS = `(function(){var m=/(?:^#|&)invite=([^&]+)/.exec(location.hash);var inv=m?decodeURIComponent(m[1]):'';history.replaceState(null,'',location.pathname);
var st=document.getElementById('status');if(!inv){st.textContent='This link has no invite in it. Ask the room owner for a new link.';document.getElementById('f').hidden=true;return;}
document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();st.textContent='Joining…';
fetch('/api/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invite:inv,name:document.getElementById('name').value})})
.then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})}).then(function(x){if(!x.ok){st.textContent=x.d.error||'Could not join.';return;}
inv='';st.textContent='';document.getElementById('f').hidden=true;document.getElementById('intro').hidden=true;document.getElementById('done').hidden=false;
document.getElementById('room').textContent=x.d.roomName;document.getElementById('token').value=x.d.token;document.getElementById('server').textContent=x.d.wsUrl;})
.catch(function(){st.textContent='Network error. Try again.'})});
document.getElementById('copy').addEventListener('click',function(){var t=document.getElementById('token');t.select();navigator.clipboard&&navigator.clipboard.writeText(t.value);});})();`;

function headers(extra = {}, tls = false) {
    return {
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
        'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
        ...(tls ? { 'strict-transport-security': 'max-age=31536000' } : {}), ...extra
    };
}

function createServer(opts) {
    const { data, port = 0, host = '127.0.0.1', tlsCert, tlsKey, publicUrl, allowOrigins = [], trustProxy = false, log = () => {} } = opts;
    const tls = !!(tlsCert && tlsKey);
    const hub = new Hub({ data, log, publicUrl });
    const ipConns = new Map();
    let total = 0;
    const joinFail = new Buckets({ capacity: 8, perSecond: 1 / 60 });       // 8 failed joins, then 1/min per IP
    const joinRate = new Buckets({ capacity: 30, perSecond: 1 / 10 });      // all join attempts per IP
    const authFail = new Buckets({ capacity: 10, perSecond: 1 / 30 });      // bad tokens per IP
    const upgradeRate = new Buckets({ capacity: 20, perSecond: 1 });
    const httpRate = new Buckets({ capacity: 60, perSecond: 5 });
    const sweeper = setInterval(() => { for (const b of [joinRate, joinFail, authFail, upgradeRate, httpRate, ...Object.values(hub.rate)]) b.sweep(); }, 60_000);
    sweeper.unref();

    const clientIp = req => {
        if (trustProxy) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f.slice(0, 64); }
        return req.socket.remoteAddress || 'unknown';
    };
    const selfOrigin = publicUrl ? new URL(publicUrl).origin : null;
    /** No Origin = non-browser client (the Omo node backend, CLI): allowed, the token still decides. */
    const originOk = origin => {
        if (!origin) return true;
        if (allowOrigins.includes('*')) return true;
        if (origin === selfOrigin || allowOrigins.includes(origin)) return true;
        return LOOPBACK_ORIGIN.test(origin); // the local Omo IDE frontend
    };
    const wsUrlFor = req => {
        if (publicUrl) return publicUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
        return `${tls ? 'wss' : 'ws'}://${req.headers.host || `${host}:${port}`}/ws`;
    };
    const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        res.writeHead(status, headers({ 'content-type': type, 'content-length': Buffer.byteLength(text), ...extra }, tls));
        res.end(text);
    };
    const readBody = req => new Promise((resolve, reject) => {
        const tooBig = () => Object.assign(new Error('Request too large.'), { status: 413, close: true });
        if (Number(req.headers['content-length'] || 0) > MAX_BODY) { req.resume(); reject(tooBig()); return; }
        let size = 0, done = false; const chunks = [];
        req.on('data', c => { if (done) return; size += c.length; if (size > MAX_BODY) { done = true; chunks.length = 0; reject(tooBig()); } else chunks.push(c); });
        req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Body must be JSON.'), { status: 400 })); } });
        req.on('error', reject);
    });

    async function onRequest(req, res) {
        const ip = clientIp(req);
        let url;
        try { url = new URL(req.url, 'http://x'); } catch { send(res, 400, { error: 'Bad URL.' }); return; }
        if (!httpRate.take(ip)) { send(res, 429, { error: 'Slow down.' }, undefined, { 'retry-after': '5' }); return; }
        if (!originOk(req.headers.origin)) { send(res, 403, { error: 'Origin not allowed.' }); return; }
        try {
            if (req.method === 'GET' && url.pathname === '/healthz') { send(res, 200, { ok: true, service: 'omo-room-server', protocol: PROTOCOL_VERSION }); return; }
            if (req.method === 'GET' && url.pathname === '/join') { send(res, 200, joinPage(), 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" }); return; }
            if (req.method === 'GET' && url.pathname === '/join.js') { send(res, 200, JOIN_JS, 'text/javascript; charset=utf-8'); return; }
            if (req.method === 'GET' && url.pathname === '/join.css') { send(res, 200, JOIN_CSS, 'text/css; charset=utf-8'); return; }
            if (req.method === 'POST' && url.pathname === '/api/join') {
                if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { send(res, 415, { error: 'Send JSON.' }); return; }
                if (!joinFail.has(ip) || !joinRate.take(ip)) { send(res, 429, { error: 'Too many join attempts. Wait a minute.' }, undefined, { 'retry-after': '60' }); return; }
                const body = await readBody(req);
                let out;
                try { out = await hub.redeemInvite(String(body.invite || ''), body.name); } catch (e) { joinFail.take(ip); throw e; }
                log('invite redeemed', out.roomId, out.memberId, out.role);
                send(res, 201, { ...out, wsUrl: wsUrlFor(req), protocol: PROTOCOL_VERSION });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/world') {
                const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
                if (!authFail.has(ip)) { send(res, 429, { error: 'Too many failed sign-ins. Wait.' }); return; }
                const auth = m ? await hub.authenticate(m[1]) : null;
                if (!auth) { authFail.take(ip); send(res, 401, { error: 'Sign in with your room key.' }, undefined, { 'www-authenticate': 'Bearer' }); return; }
                send(res, 200, { room: { id: auth.r.rec.id, name: auth.r.rec.name }, role: auth.member.role, world: auth.r.rec.world });
                return;
            }
            send(res, 404, { error: 'Not found.' });
        } catch (e) {
            send(res, e.status || 400, { error: e.message || 'Request failed.' }, undefined, e.close ? { connection: 'close' } : {});
            if (e.close) res.on('finish', () => req.socket.destroy());
        }
    }

    const server = tls
        ? https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey), minVersion: 'TLSv1.2' }, onRequest)
        : http.createServer(onRequest);
    server.headersTimeout = 15_000; server.requestTimeout = 20_000; server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 50;

    const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes, perMessageDeflate: false, clientTracking: false });
    server.on('upgrade', (req, socket, head) => {
        const ip = clientIp(req);
        const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
        let pathname = '';
        try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* fallthrough */ }
        if (pathname !== '/ws') return reject(404, 'Not Found');
        if (!originOk(req.headers.origin)) return reject(403, 'Forbidden');
        if (!upgradeRate.take(ip)) return reject(429, 'Too Many Requests');
        if (total >= LIMITS.maxSocketsTotal || (ipConns.get(ip) || 0) >= LIMITS.maxSocketsPerIp) return reject(503, 'Service Unavailable');
        wss.handleUpgrade(req, socket, head, ws => onSocket(ws, ip));
    });

    function onSocket(ws, ip) {
        total++; ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
        let conn = null, authing = false, alive = true;
        const timer = setTimeout(() => { if (!conn) ws.close(CLOSE.auth, 'Say hello first'); }, LIMITS.helloTimeoutMs);
        ws.on('pong', () => { alive = true; });
        const beat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; try { ws.ping(); } catch { /* closed */ } }, 30_000);
        ws.on('message', async (raw, isBinary) => {
            if (isBinary) { ws.close(CLOSE.policy, 'Text frames only'); return; }
            const text = raw.toString('utf8');
            if (conn) { try { await hub.handle(conn, text); } catch (e) { log('handler error', e.message); hub.fail(conn, undefined, 'Server error.'); } return; }
            if (authing) { ws.close(CLOSE.policy, 'Wait for welcome'); return; }
            authing = true;
            let hello;
            try { hello = parseClient(text, null); } catch (e) { ws.close(CLOSE.policy, e.message.slice(0, 100)); return; }
            if (hello.type !== 'hello') { ws.close(CLOSE.auth, 'Say hello first'); return; }
            if (hello.protocol !== undefined && hello.protocol !== PROTOCOL_VERSION) { ws.close(CLOSE.policy, `Protocol ${PROTOCOL_VERSION} required`); return; }
            if (!authFail.has(ip)) { ws.close(CLOSE.rate, 'Too many failed sign-ins'); return; }
            const auth = await hub.authenticate(hello.token);
            if (!auth) { authFail.take(ip); ws.close(CLOSE.auth, 'Room key not accepted'); return; }
            if (ws.readyState !== 1) return;
            clearTimeout(timer);
            if (hello.pose) { try { hello.pose = checkPose(hello.pose, auth.r.rec.world.shell); } catch { delete hello.pose; } }
            conn = hub.attach(ws, auth, hello, ip);
        });
        ws.on('close', () => {
            clearTimeout(timer); clearInterval(beat);
            total--; const n = (ipConns.get(ip) || 1) - 1; if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);
            if (conn) hub.detach(conn);
        });
        ws.on('error', () => { /* close follows */ });
    }

    return {
        server, hub, wss,
        listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); }),
        close: () => new Promise(resolve => { hub.closeAll(); clearInterval(sweeper); server.close(() => resolve()); setTimeout(resolve, 2000).unref(); })
    };
}

module.exports = { createServer, LOOPBACK_ORIGIN };
