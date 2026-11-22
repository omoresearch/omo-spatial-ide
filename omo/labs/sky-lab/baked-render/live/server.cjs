#!/usr/bin/env node
/*
 * Omo sky live server: serves the baked-render penthouse page and gives each desk monitor a REAL persistent shell.
 *   node live/server.cjs [--port 3671]
 * - Binds 127.0.0.1 only. Prints `token=<48 hex>` and the URL to open (token in ?live=, stripped by the page).
 * - Each desk = one tmux session (desk-0..2) on the private socket `-L omo-sky-live`, attached through node-pty.
 *   Closing the page only detaches: the shell, its jobs and its screen survive reloads.
 * - /live/ws?desk=desk-N&token=T  : terminal stream (rejects wrong/missing token 401, foreign Origin 403).
 * - /live/api/sessions             : [{session,pid}] (header x-live-token).
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
const TMUX = tmuxBin(), SOCK = 'omo-sky-live';
const TOKEN = crypto.randomBytes(24).toString('hex');
const COLS = 80, ROWS = 24;
const HOME_DIR = process.env.LIVE_CWD || path.join(process.env.HOME, 'dev', 'omo-sky-lab', 'baked-render', 'live', 'workspace');
fs.mkdirSync(HOME_DIR, { recursive: true });
const DESKS = new Set(['desk-0', 'desk-1', 'desk-2']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.splat': 'application/octet-stream', '.css': 'text/css', '.svg': 'image/svg+xml' };
const okHost = (h) => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
const okOrigin = (o) => !o || o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}`;
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCK, ...a], { encoding: 'utf8' });

function ensureSession(desk) {
    if (tmux('has-session', '-t', desk).status === 0) return;
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
        res.writeHead(404); return res.end('{}');
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let p = decodeURIComponent(url.pathname), file;
    if (p.startsWith('/three/')) file = path.join(THREE_DIR, p.slice(7)); else file = path.join(LANE, p === '/' ? 'index.html' : p);
    file = path.normalize(file);
    if (!(file.startsWith(LANE + path.sep) || file.startsWith(THREE_DIR + path.sep)) || /\/live\/workspace\//.test(file)) { res.writeHead(403); return res.end(); }
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
    if (!DESKS.has(desk)) return deny(400, 'Bad Request');
    wss.handleUpgrade(req, socket, head, ws => attach(ws, desk));
});

function attach(ws, desk) {
    ensureSession(desk);
    const env = { ...process.env, TERM: 'xterm-256color' }; delete env.TMUX;
    const p = pty.spawn(TMUX, ['-L', SOCK, 'attach-session', '-t', desk], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: HOME_DIR, env });
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
