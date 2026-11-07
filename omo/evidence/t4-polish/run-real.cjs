#!/usr/bin/env node
/* t4:polish — start the real local app on an owned port (3540-3559), run the named real-app checks, stop only our process group.
 * Usage: OMO_CI_PORT=3541 node evidence/t4-polish/run-real.cjs extension/test/<file>.cjs [...more] */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const evidence = path.join(ROOT, 'evidence');
const port = process.env.OMO_CI_PORT || '3541';
if (!/^35(4\d|5\d)$/.test(port)) { console.error('Use a port from 3540 to 3559.'); process.exit(2); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const socket = `omo-spatial-ci-${run}`;
    const runtimeData = path.join(evidence, `ci-runtime-${run}`);
    const log = fs.openSync(path.join(evidence, 't4-polish', `server-${port}.log`), 'a');
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(evidence, `t4-theia-${run}`), OMO_SPATIAL_DATA: runtimeData,
        OMO_SPATIAL_TMUX: process.env.OMO_SPATIAL_TEST_TMUX || process.env.OMO_SPATIAL_TMUX, OMO_SPATIAL_TMUX_SOCKET: socket, OMO_URL: `http://127.0.0.1:${port}` };
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts/start.cjs'), '--port', port], { cwd: ROOT, env, detached: true, shell: false, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let failed = 0;
    try {
        let ready = false;
        for (let n = 0; n < 300 && !ready; n++) { if (server.exitCode !== null) throw new Error('server exited early'); try { ready = (await fetch(env.OMO_URL, { signal: AbortSignal.timeout(500) })).ok; } catch { /* bounded */ } if (!ready) await pause(200); }
        if (!ready) throw new Error('server not ready');
        for (const name of process.argv.slice(2)) {
            const child = spawn(process.execPath, [path.resolve(ROOT, name)], { cwd: ROOT, env, shell: false, stdio: 'inherit' });
            const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
            console.log(`RUNNER ${code === 0 ? 'PASS' : 'FAIL'} ${name} (exit ${code})`);
            if (code !== 0) failed++;
        }
    } finally {
        if (server.pid > 1) {
            try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
            for (let n = 0; n < 40 && server.exitCode === null && server.signalCode === null; n++) await pause(100);
            if (server.exitCode === null && server.signalCode === null) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }
        }
        const { discoverRuntime } = require(path.join(ROOT, 'extension/lib/node/runtime-discovery'));
        const locations = discoverRuntime(env);
        if (locations.tmux) spawnSync(locations.tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
        fs.rmSync(runtimeData, { recursive: true, force: true });
        fs.rmSync(env.THEIA_CONFIG_DIR, { recursive: true, force: true });
    }
    process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
