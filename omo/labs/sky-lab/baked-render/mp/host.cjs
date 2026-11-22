#!/usr/bin/env node
/*
 * Start a multiplayer penthouse as the host:  node mp/host.cjs [--host <tailscale 100.x ip>] [--live-port 3671] [--mp-port 3672]
 * Starts live/server.cjs (your real desk terminals, 127.0.0.1 only, token stays on this machine) and mp/server.cjs
 * (the room: page + avatars + voice signalling; 127.0.0.1 by default, or ONE Tailscale address with --host).
 * Prints the URL YOU open. In the page, press 'Share link' to copy the guest link. Ctrl+C stops both.
 */
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LIVE_PORT = arg('--live-port', '3671'), MP_PORT = arg('--mp-port', '3672'), HOST = arg('--host', '127.0.0.1');
const kids = [];
function run(file, args, re) {
    const p = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'inherit'] }); kids.push(p);
    let out = '';
    return new Promise((res, rej) => {
        p.stdout.on('data', d => { out += d; const m = re.exec(out); if (m) res(m[1]); });
        p.on('exit', c => rej(new Error(`${path.basename(file)} exited ${c}: ${out}`)));
    });
}
(async () => {
    const token = await run(path.join(__dirname, '..', 'live', 'server.cjs'), ['--port', LIVE_PORT], /token=([0-9a-f]{48})/);
    const key = await run(path.join(__dirname, 'server.cjs'), ['--port', MP_PORT, '--host', HOST, '--live-port', LIVE_PORT], /host-key=([0-9a-f]{48})/);
    console.log(`\nHost: open  http://127.0.0.1:${LIVE_PORT}/?live=${token}&mp=${HOST}:${MP_PORT}#mphost=${key}`);
    console.log(`Then press 'Share link' (top right) and send the copied http://${HOST}:${MP_PORT}/?room=...#invite=... link.`);
    if (HOST !== '127.0.0.1') console.log(`Note: on a plain-http Tailscale address browsers block the microphone. For voice, give guests https: e.g. 'tailscale serve --bg --https=443 http://${HOST}:${MP_PORT}' (tailnet only, NOT funnel).`);
})().catch(e => { console.error(e.message); stop(1); });
function stop(code = 0) { for (const k of kids) try { k.kill('SIGTERM'); } catch {} setTimeout(() => process.exit(code), 200); }
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => stop(0));
