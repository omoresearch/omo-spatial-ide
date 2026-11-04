// Owned local app fixture. Every agent path points to a no-network recorder, never a real CLI.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { ROOT, pause } = require('./world-test-driver.cjs');

async function ownedAppFixture(tag) {
    if (!/^[a-z-]{1,20}$/.test(tag)) throw new Error('Invalid owned fixture tag');
    fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
    const owned = fs.mkdtempSync(path.join(process.env.TMPDIR || path.join(ROOT, 'evidence'), `omo-${tag}-`));
    const project = path.join(owned, 'project');
    const bin = path.join(owned, 'bin');
    const hermesRoot = path.join(owned, 'hermes');
    const agentLog = path.join(owned, 'fixture-agents.jsonl');
    const socket = `omo-owned-${crypto.randomBytes(8).toString('hex')}`;
    let server, env;
    const dispose = async () => {
        if (server?.pid > 1 && server.exitCode === null && server.signalCode === null) {
            try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            for (let n = 0; n < 40 && server.exitCode === null && server.signalCode === null; n++) await pause(100);
            if (server.exitCode === null && server.signalCode === null) {
                try { process.kill(-server.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
                for (let n = 0; n < 20 && server.exitCode === null && server.signalCode === null; n++) await pause(100);
            }
        }
        if (env && /^omo-owned-[a-f0-9]{16}$/.test(socket)) {
            const { discoverRuntime } = require('../lib/node/runtime-discovery');
            const { tmux } = discoverRuntime(env);
            if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
        }
        if (!server || server.exitCode !== null || server.signalCode !== null) fs.rmSync(owned, { recursive: true, force: true });
    };
    try {
        for (const dir of [project, bin, path.join(hermesRoot, 'profiles', 'default')]) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(agentLog, '');
        fs.writeFileSync(path.join(project, 'README.md'), '# Owned spatial IDE test project\n');
        fs.writeFileSync(path.join(hermesRoot, 'profiles', 'default', 'config.yaml'), '# Fixture profile, never a real agent.\n');
        const recorder = `#!/usr/bin/python3
import os, sys, json
with open(${JSON.stringify(agentLog)}, 'a') as f:
    f.write(json.dumps({'kind': os.path.basename(sys.argv[0]), 'argv': sys.argv[1:]}) + '\\n')
print('OWNED FIXTURE AGENT: NO MODEL OR NETWORK CALLS', flush=True)
for line in sys.stdin: pass
`;
        for (const kind of ['hermes', 'claude', 'codex']) fs.writeFileSync(path.join(bin, kind), recorder, { mode: 0o755 });
        const listener = net.createServer();
        await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
        const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
        env = { ...process.env, THEIA_CONFIG_DIR: path.join(owned, 'theia'), OMO_SPATIAL_DATA: path.join(owned, 'runtime'),
            OMO_SPATIAL_TMUX_SOCKET: socket, OMO_SPATIAL_TMUX: process.env.OMO_SPATIAL_TEST_TMUX || process.env.OMO_SPATIAL_TMUX,
            OMO_SPATIAL_HERMES_ROOT: hermesRoot, OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'),
            OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex'),
            OMO_URL: `http://127.0.0.1:${port}` };
        const log = fs.openSync(path.join(ROOT, 'evidence', `${tag}-owned-server.log`), 'a');
        try { server = spawn(process.execPath, [path.join(ROOT, 'scripts/start.cjs'), '--workspace', project, '--port', String(port)], { cwd: ROOT, env, detached: true, shell: false, stdio: ['ignore', log, log] }); }
        finally { fs.closeSync(log); }
        let spawnError; server.on('error', error => { spawnError = error; });
        let ready = false;
        for (let n = 0; n < 150; n++) {
            if (spawnError) throw spawnError;
            if (server.exitCode !== null || server.signalCode !== null) throw new Error('Owned app exited before readiness');
            try { if ((await fetch(env.OMO_URL, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* bounded startup */ }
            await pause(200);
        }
        if (!ready) throw new Error(`Owned ${tag} app did not start; see evidence/${tag}-owned-server.log`);
        return { owned, project, agentLog, env, dispose };
    } catch (error) { await dispose(); throw error; }
}
module.exports = { ownedAppFixture };
