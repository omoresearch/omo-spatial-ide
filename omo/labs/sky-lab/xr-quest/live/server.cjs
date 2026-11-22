#!/usr/bin/env node
/*
 * Omo sky live server: serves the baked-render penthouse page and gives each desk monitor a REAL persistent shell.
 *   node live/server.cjs [--port 3671]
 * - Binds 127.0.0.1 only. Prints `token=<48 hex>` and the URL to open (token in ?live=, stripped by the page).
 * - Each screen terminal = one tmux session on the private socket, attached through node-pty. Sessions are made on
 *   demand: the first desks are desk-0..2, free screens are s-<4..16 [a-z0-9]> (at most MAX_SESSIONS in total).
 *   Closing the page only detaches: the shell, its jobs and its screen survive reloads.
 * - /live/ws?desk=desk-N&token=T  : terminal stream (rejects wrong/missing token 401, foreign Origin 403).
 * - /live/api/sessions             : [{session,pid}] (header x-live-token).
 * - /live/api/layout  GET / PUT    : the free-screen layout (JSON file LIVE_LAYOUT, default live/state/layout.json).
 *                                    GET -> {screens:null} until the first save. PUT is validated (max 32 screens).
 * - /live/api/close?id=ID  POST    : a screen was closed: its tmux session is killed.
 * - /live/api/frameable?url=U      : can U be shown in an iframe? (reads X-Frame-Options / CSP frame-ancestors).
 * - Any request whose Host is not 127.0.0.1:<port> / localhost:<port> gets 403 (DNS-rebinding guard).
 * Shell only: this server never starts an agent CLI.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const NM = '~/dev/omo-skyscraper/omo/node_modules';
const pty = require(NM + '/node-pty');
const { WebSocketServer } = require(NM + '/ws');
const { tmuxBin } = require('./tmuxbin.cjs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', process.env.LIVE_PORT || 3671));
const LANE = path.resolve(__dirname, '..');
const LAB = path.resolve(LANE, '..');
const THREE_DIR = '~/dev/omo-skyscraper/omo/node_modules/three';
const TMUX = tmuxBin(), SOCK = process.env.LIVE_SOCK || 'omo-xr-quest';
const TOKEN = /^[0-9a-f]{48}$/.test(process.env.LIVE_TOKEN || '') ? process.env.LIVE_TOKEN : crypto.randomBytes(24).toString('hex');
const COLS = 80, ROWS = 24;
const HOME_DIR = process.env.LIVE_CWD || path.join(LANE, 'live', 'workspace');
fs.mkdirSync(HOME_DIR, { recursive: true });
const SESSION_RE = /^(desk-[0-2]|s-[a-z0-9]{4,16})$/, MAX_SESSIONS = 24;
const LAYOUT = process.env.LIVE_LAYOUT || path.join(LANE, 'live', 'state', 'layout.json');
fs.mkdirSync(path.dirname(LAYOUT), { recursive: true });
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
function validLayout(L) {   // returns the cleaned layout or null
    if (!L || !Array.isArray(L.screens) || L.screens.length > 32) return null;
    const ids = new Set(), out = [];
    for (const s of L.screens) {
        if (!s || typeof s.id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(s.id) || ids.has(s.id)) return null;
        if (!['term', 'web', 'stream'].includes(s.kind)) return null;
        if (s.kind === 'term' && !SESSION_RE.test(s.id)) return null;
        if (!Array.isArray(s.pos) || s.pos.length !== 3 || !s.pos.every(v => num(v, -1000, 1000))) return null;
        if (!num(s.rotY, -20, 20) || !num(s.w, 0.2, 12) || !num(s.h, 0.1, 8)) return null;
        if (s.url !== undefined && (typeof s.url !== 'string' || s.url.length > 2048)) return null;
        ids.add(s.id);
        out.push({ id: s.id, kind: s.kind, pos: s.pos, rotY: s.rotY, w: s.w, h: s.h, anchor: s.anchor === 'wall' ? 'wall' : 'float', n: Number.isInteger(s.n) && s.n > 0 && s.n < 1000 ? s.n : 1, ...(s.url !== undefined ? { url: s.url } : {}) });
    }
    return { screens: out, saved: Date.now() };
}
const readBody = (req, max = 65536) => new Promise((res, rej) => { let b = ''; req.on('data', d => { b += d; if (b.length > max) { rej(new Error('too big')); req.destroy(); } }); req.on('end', () => res(b)); req.on('error', rej); });
const sessionCount = () => (tmux('list-sessions', '-F', '#{session_name}').stdout || '').split('\n').filter(Boolean).length;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.splat': 'application/octet-stream', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const EXTRA_HOSTS = (process.env.LIVE_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean);  // e.g. harry-linux.tail7cc31d.ts.net:8445
const okHost = (h) => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || EXTRA_HOSTS.includes(h);
const okOrigin = (o) => !o || o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}` || EXTRA_HOSTS.some(h => o === `https://${h}`);
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCK, ...a], { encoding: 'utf8' });

function ensureSession(desk) {
    if (tmux('has-session', '-t', '=' + desk).status === 0) return;
    const r = tmux('-f', '/dev/null', 'new-session', '-d', '-s', desk, '-x', String(COLS), '-y', String(ROWS), '-c', HOME_DIR);
    if (r.status !== 0) throw new Error('tmux new-session failed: ' + r.stderr);
    for (const o of [['status', 'off'], ['history-limit', '5000'], ['default-terminal', 'xterm-256color'], ['window-size', 'manual']]) tmux('set-option', '-g', ...o);
    tmux('resize-window', '-t', desk, '-x', String(COLS), '-y', String(ROWS));
}

async function frameable(url) {
    let u; try { u = new URL(url); } catch { return { ok: false, message: 'That is not a valid web address.' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, message: 'Only http(s) pages can be shown.' };
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === PORT) return { ok: true };
    try {
        const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
        const r = await fetch(u, { method: 'GET', redirect: 'follow', signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 omo-sky-live frame check' } });
        clearTimeout(to); try { await r.body?.cancel(); } catch {}
        const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
        const csp = (r.headers.get('content-security-policy') || '').toLowerCase();
        const fa = /frame-ancestors([^;]*)/.exec(csp);
        if (xfo.includes('deny') || xfo.includes('sameorigin') || (fa && !/(^|\s)\*(\s|$)/.test(fa[1]) && !fa[1].includes('127.0.0.1'))) return { ok: false, message: `${u.hostname} does not allow being shown inside other pages. Try another address.` };
        return { ok: true };
    } catch (e) { return { ok: false, message: `Could not reach ${u.hostname}.` }; }
}

const server = http.createServer(async (req, res) => {
    if (!okHost(req.headers.host)) { res.writeHead(403); return res.end('forbidden host'); }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/live/api/')) {
        if (req.headers['x-live-token'] !== TOKEN) { res.writeHead(401); return res.end('{}'); }
        res.setHeader('content-type', 'application/json');
        if (url.pathname === '/live/api/sessions') {
            const out = tmux('list-panes', '-a', '-F', '#{session_name} #{pane_pid}').stdout || '';
            return res.end(JSON.stringify({ panes: out.trim().split('\n').filter(Boolean).map(l => { const [session, pid] = l.split(' '); return { session, pid: Number(pid) }; }) }));
        }
        if (url.pathname === '/live/api/frameable') return res.end(JSON.stringify(await frameable(url.searchParams.get('url') || '')));
        if (url.pathname === '/live/api/layout' && req.method === 'GET') {
            try { return res.end(fs.readFileSync(LAYOUT, 'utf8')); } catch { return res.end('{"screens":null}'); }
        }
        if (url.pathname === '/live/api/layout' && req.method === 'PUT') {
            let L; try { L = validLayout(JSON.parse(await readBody(req))); } catch { L = null; }
            if (!L) { res.writeHead(400); return res.end('{"ok":false}'); }
            fs.writeFileSync(LAYOUT + '.tmp', JSON.stringify(L, null, 1)); fs.renameSync(LAYOUT + '.tmp', LAYOUT);
            return res.end(JSON.stringify({ ok: true, n: L.screens.length }));
        }
        if (url.pathname === '/live/api/close' && req.method === 'POST') {
            const id = url.searchParams.get('id') || '';
            if (!SESSION_RE.test(id)) { res.writeHead(400); return res.end('{"ok":false}'); }
            const killed = tmux('kill-session', '-t', '=' + id).status === 0;
            return res.end(JSON.stringify({ ok: true, killed }));
        }
        res.writeHead(404); return res.end('{}');
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let p = decodeURIComponent(url.pathname), file;
    if (p.startsWith('/three/')) file = path.join(THREE_DIR, p.slice(7)); else file = path.join(LANE, p === '/' ? 'index.html' : p);
    file = path.normalize(file);
    if (!(file.startsWith(LANE + path.sep) || file.startsWith(THREE_DIR + path.sep)) || /\/live\/(workspace|state)\//.test(file)) { res.writeHead(403); return res.end(); }
    // vendor/ symlinks point at sibling lab folders (cc0-assets, splat-world-model): allow those, read-only, and nothing else
    try { const real = fs.realpathSync(file); if (!(real.startsWith(LAB + path.sep) || real.startsWith(THREE_DIR + path.sep))) { res.writeHead(403); return res.end(); } } catch {}
    fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b); });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
    const deny = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    if (!okHost(req.headers.host)) return deny(403, 'Forbidden');
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== '/live/ws') return deny(404, 'Not Found');
    const t = url.searchParams.get('token') || '';
    if (t.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN))) return deny(401, 'Unauthorized');
    if (!okOrigin(req.headers.origin)) return deny(403, 'Forbidden');
    const desk = url.searchParams.get('desk');
    if (!SESSION_RE.test(desk || '')) return deny(400, 'Bad Request');
    if (tmux('has-session', '-t', '=' + desk).status !== 0 && sessionCount() >= MAX_SESSIONS) return deny(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, ws => attach(ws, desk));
});

function attach(ws, desk) {
    ensureSession(desk);
    const env = { ...process.env, TERM: 'xterm-256color' }; delete env.TMUX;
    const p = pty.spawn(TMUX, ['-L', SOCK, 'attach-session', '-t', '=' + desk], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: HOME_DIR, env });
    p.onData(d => { if (ws.readyState === 1) ws.send(d); });
    p.onExit(() => { try { ws.close(); } catch {} });
    ws.on('message', m => { const s = m.toString(); if (s.length <= 4096) p.write(s); });
    ws.on('close', () => { try { p.kill(); } catch {} });   // detaches the tmux client only; the session lives on
}

server.listen(PORT, '127.0.0.1', () => {
    console.log(`token=${TOKEN}`);
    console.log(`open http://127.0.0.1:${PORT}/?live=${TOKEN}`);
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); process.exit(0); });
