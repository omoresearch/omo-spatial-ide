#!/usr/bin/env node
/* t2:regress — run one or more existing real-app tests against a fresh owned server on an owned port.
   Usage: OMO_CI_PORT=3506 node scripts/t2-regress-one.cjs runtime-real-app.cjs [more.cjs ...] */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const evidence = path.join(ROOT, 'evidence');
const port = process.env.OMO_CI_PORT || '3506';
if (Number(port) < 3500 || Number(port) > 3519) throw new Error('t2-regress owns ports 3500-3519 only');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const socket = `omo-spatial-ci-${run}`;
    const runtimeData = path.join(evidence, `ci-runtime-${run}`);
    const log = fs.openSync(path.join(evidence, 't2-regress', `one-server-${port}.log`), 'w');
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(evidence, `ci-theia-profile-${port}`),
        OMO_SPATIAL_DATA: runtimeData, OMO_SPATIAL_TMUX: process.env.OMO_SPATIAL_TEST_TMUX || process.env.OMO_SPATIAL_TMUX,
        OMO_SPATIAL_TMUX_SOCKET: socket, OMO_URL: `http://127.0.0.1:${port}` };
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts/start.cjs'), '--port', port], { cwd: ROOT, env, detached: true, shell: false, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let failed = 0;
    try {
        let ready = false;
        for (let n = 0; n < 150 && !ready; n++) { try { ready = (await fetch(env.OMO_URL, { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ } if (!ready) await pause(200); }
        if (!ready) throw new Error('server not ready');
        for (const name of process.argv.slice(2)) {
            const child = spawn(process.execPath, [path.join(ROOT, "extension/test", name), ...(process.env.T2_ARGS ? process.env.T2_ARGS.split(" ") : [])], { cwd: ROOT, env, shell: false, stdio: 'inherit' });
            const code = await new Promise(resolve => child.once('exit', resolve));
            console.log(`T2-ONE ${name} exit=${code}`); if (code !== 0) failed++;
        }
    } finally {
        try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
        for (let n = 0; n < 40 && server.exitCode === null && server.signalCode === null; n++) await pause(100);
        if (server.exitCode === null && server.signalCode === null) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }
        const { discoverRuntime } = require('../extension/lib/node/runtime-discovery');
        const locations = discoverRuntime(env);
        if (locations.tmux) spawnSync(locations.tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
        fs.rmSync(runtimeData, { recursive: true, force: true });
    }
    process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
