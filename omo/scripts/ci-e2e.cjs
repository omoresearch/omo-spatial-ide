#!/usr/bin/env node
/* Start the real local application for CI, exercise its own UI, then stop only our process group. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const evidence = path.join(ROOT, 'evidence');
const port = '3199';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    fs.mkdirSync(evidence, { recursive: true });
    const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const socket = `omo-spatial-ci-${run}`;
    const runtimeData = path.join(evidence, `ci-runtime-${run}`);
    const log = fs.openSync(path.join(evidence, 'ci-real-app-server.log'), 'a');
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(evidence, 'ci-theia-profile'),
        OMO_SPATIAL_DATA: runtimeData, OMO_SPATIAL_TMUX: process.env.OMO_SPATIAL_TEST_TMUX || process.env.OMO_SPATIAL_TMUX,
        OMO_SPATIAL_TMUX_SOCKET: socket, OMO_URL: `http://127.0.0.1:${port}` };
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts/start.cjs'), '--port', port], {
        cwd: ROOT, env, detached: true, shell: false, stdio: ['ignore', log, log]
    });
    fs.closeSync(log);
    let spawnError; server.on('error', error => { spawnError = error; });
    try {
        let ready = false;
        for (let n = 0; n < 150; n++) {
            if (spawnError) throw spawnError;
            if (server.exitCode !== null) throw new Error(`Real Theia server exited early (${server.exitCode}); see evidence/ci-real-app-server.log`);
            try { const response = await fetch(env.OMO_URL, { signal: AbortSignal.timeout(500) }); if (response.ok) { ready = true; break; } } catch { /* bounded startup wait */ }
            await pause(200);
        }
        if (!ready) throw new Error('Real Theia server did not become ready; see evidence/ci-real-app-server.log');
        for (const name of ['runtime-real-app.cjs', 'bell-real-app.cjs', 'physical-selection-real-app.cjs', 'unicode-real-app.cjs', 'git-review-real-app.cjs', 'agent-task-real-app.cjs', 'task-review-real-app.cjs', 'room-layout-real-app.cjs', 'room-preset-real-app.cjs', 'shared-room-real-app.cjs']) {
            const child = spawn(process.execPath, [path.join(ROOT, 'extension/test', name)], { cwd: ROOT, env, shell: false, stdio: 'inherit' });
            const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', value => resolve(value)); });
            if (code !== 0) throw new Error(`Real app ${name} failed with exit ${code}`);
        }
    } finally {
        if (server.pid > 1) {
            try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            for (let n = 0; n < 40 && server.exitCode === null && server.signalCode === null; n++) await pause(100);
            if (server.exitCode === null && server.signalCode === null) { try { process.kill(-server.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
        }
        // Unlike the real user's app, the ephemeral CI host must leave no test shells.
        const { discoverRuntime } = require('../extension/lib/node/runtime-discovery');
        const locations = discoverRuntime(env);
        if (/^omo-spatial-ci-[a-f0-9]{12}$/.test(socket) && locations.tmux) spawnSync(locations.tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
        fs.rmSync(runtimeData, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error.message);
    const file = path.join(evidence, 'ci-real-app-server.log');
    if (fs.existsSync(file)) console.error('Real app server diagnostics:\n' + fs.readFileSync(file, 'utf8').split('\n').slice(-60).join('\n'));
    process.exitCode = 1;
});
