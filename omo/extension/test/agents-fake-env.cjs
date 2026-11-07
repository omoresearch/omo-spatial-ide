#!/usr/bin/env node
// t2:agents - start (or stop) one isolated Omo app with the no-network fake agent CLIs.
//   node agents-fake-env.cjs start <scratch> <port>   -> prints the env JSON; server pid in <scratch>/server.pid
//   node agents-fake-env.cjs stop <scratch>
// Fake claude/codex/hermes/dsh/node are COPIES of fake-agent-cli.py (the program name picks the behaviour).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const RESERVED = new Set([3190, 3192, 3195, 3198, 3199]);

function setup(scratch, port) {
    if (RESERVED.has(port) || port < 3570 || port > 3589) throw new Error(`port ${port} is outside the t2:agents lane (3570-3589)`);
    const dirs = { bin: path.join(scratch, 'bin'), nodebin: path.join(scratch, 'nodebin'), fake: path.join(scratch, 'fake'), project: path.join(scratch, 'project'),
        hermes: path.join(scratch, 'hermes'), data: path.join(scratch, 'data'), theia: path.join(scratch, 'theia'), plugins: path.join(scratch, 'plugins') };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.join(dirs.hermes, 'profiles', 'default'), { recursive: true });
    fs.writeFileSync(path.join(dirs.hermes, 'profiles', 'default', 'config.yaml'), '# fixture profile, never a real agent\n');
    fs.writeFileSync(path.join(dirs.project, 'README.md'), '# t2 agents probe project\n');
    const cli = fs.readFileSync(path.join(__dirname, 'fake-agent-cli.py'));
    for (const kind of ['claude', 'codex', 'hermes', 'dsh']) fs.writeFileSync(path.join(dirs.bin, kind), cli, { mode: 0o755 });
    fs.writeFileSync(path.join(dirs.nodebin, 'node'), cli, { mode: 0o755 });
    fs.writeFileSync(path.join(dirs.fake, 'node-version'), 'v22.11.0\n');
    for (const f of ['argv.jsonl', 'stdin.jsonl', 'hooks.jsonl']) fs.writeFileSync(path.join(dirs.fake, f), '');
    const db = path.join(dirs.hermes, 'state.db');
    if (!fs.existsSync(db)) {
        const r = spawnSync('/usr/bin/python3', ['-c', [
            'import sqlite3,sys', 'c=sqlite3.connect(sys.argv[1])',
            'c.execute("CREATE TABLE session_turn_leases(conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL)")',
            'c.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, started_at REAL, last_activity_description TEXT)")',
            'c.commit()', 'c.close()'].join('\n'), db], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
    }
    const socket = `omo-t2-agents-${port}`;
    const env = {
        PATH: `${dirs.nodebin}:/home/harry/.local/share/omo/bin:/usr/local/bin:/usr/bin:/bin`, HOME: process.env.HOME, LANG: 'C.UTF-8', TMPDIR: scratch, USER: process.env.USER,
        THEIA_CONFIG_DIR: dirs.theia, OMO_SPATIAL_DATA: dirs.data, OMO_SPATIAL_TMUX_SOCKET: socket, PYTHONDONTWRITEBYTECODE: '1',
        OMO_SPATIAL_PYTHON: '/usr/bin/python3', CHROME_PATH: '/opt/google/chrome/chrome',
        OMO_SPATIAL_HERMES_ROOT: dirs.hermes, OMO_SPATIAL_HERMES_BIN: path.join(dirs.bin, 'hermes'),
        OMO_SPATIAL_CLAUDE_BIN: path.join(dirs.bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(dirs.bin, 'codex'), OMO_SPATIAL_DSH_BIN: path.join(dirs.bin, 'dsh'),
        FAKE_AGENT_DIR: dirs.fake, FAKE_HERMES_ROOT: dirs.hermes
    };
    return { dirs, env, socket, port, db };
}

async function start(scratch, port) {
    const s = setup(scratch, port);
    const log = fs.openSync(path.join(scratch, 'server.log'), 'a');
    // The real backend main (like scripts/w2-render-probe.cjs): start.cjs drops unknown env keys (FAKE_*, OMO_SPATIAL_DSH_BIN).
    const server = spawn(process.execPath, [path.join(ROOT, 'browser-app/lib/backend/main.js'), s.dirs.project, '--hostname', '127.0.0.1', '--port', String(port),
        `--plugins=local-dir:${s.dirs.plugins}`], { env: s.env, detached: true, stdio: ['ignore', log, log] });
    server.unref();
    fs.writeFileSync(path.join(scratch, 'server.pid'), String(server.pid));
    fs.writeFileSync(path.join(scratch, 'env.json'), JSON.stringify(s, null, 2));
    for (let i = 0; i < 300; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) })).ok) return s; } catch { /* starting */ }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('server did not start; see ' + path.join(scratch, 'server.log'));
}

function stop(scratch) {
    const pidFile = path.join(scratch, 'server.pid');
    if (fs.existsSync(pidFile)) { try { process.kill(-Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* gone */ } }
    const envFile = path.join(scratch, 'env.json');
    if (fs.existsSync(envFile)) {
        const { socket } = JSON.parse(fs.readFileSync(envFile, 'utf8'));
        if (/^omo-t2-agents-35[78]\d$/.test(socket)) spawnSync('/home/harry/.local/share/omo/bin/tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    }
}

module.exports = { setup, start, stop };
if (require.main === module) {
    const [cmd, scratch, port] = process.argv.slice(2);
    if (cmd === 'start') start(path.resolve(scratch), Number(port)).then(s => console.log(JSON.stringify(s.env))).catch(e => { console.error(e); process.exitCode = 1; });
    else if (cmd === 'stop') stop(path.resolve(scratch));
    else { console.error('usage: start <scratch> <port> | stop <scratch>'); process.exitCode = 2; }
}
