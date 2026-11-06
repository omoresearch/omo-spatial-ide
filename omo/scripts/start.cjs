#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createPrivatePluginCopy, cleanupPrivatePluginDir } = require('./runtime-ide-plugins.cjs');

function options(args, env = process.env) {
    let workspace = path.resolve(__dirname, '../demo-project');
    let port = env.OMO_SPATIAL_PORT || '3190';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help' || args[i] === '-h') return { help: true };
        if (args[i] === '--workspace' && args[i + 1]) workspace = path.resolve(args[++i]);
        else if (args[i] === '--port' && args[i + 1]) port = args[++i];
        else throw new Error(`Unknown or incomplete option: ${args[i]}`);
    }
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Port must be a number from 1 to 65535.');
    if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Workspace must be an existing directory.');
    return { workspace: fs.realpathSync(workspace), port: String(Number(port)) };
}

function backendArguments(selected, privatePluginDir = path.resolve(__dirname, '../plugins')) {
    return [path.resolve(__dirname, '../browser-app/lib/backend/main.js'), selected.workspace,
        '--hostname', '127.0.0.1', '--port', selected.port,
        `--plugins=local-dir:${privatePluginDir}`];
}

const OS_ENV_KEYS = Object.freeze([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'USERPROFILE'
]);
const APP_ENV_KEYS = Object.freeze([
    'THEIA_CONFIG_DIR', 'CHROME_PATH',
    'OMO_SPATIAL_DATA', 'OMO_SPATIAL_TMUX_SOCKET', 'OMO_SPATIAL_TMUX', 'OMO_SPATIAL_PYTHON',
    'OMO_SPATIAL_HOST_SCRIPT', 'OMO_SPATIAL_CHROME', 'OMO_SPATIAL_WEB_AUDIO', 'OMO_SPATIAL_FAULT',
    'OMO_SPATIAL_HERMES_ROOT', 'OMO_SPATIAL_HERMES_BIN', 'OMO_SPATIAL_CLAUDE_BIN', 'OMO_SPATIAL_CODEX_BIN'
]);

function applicationEnvironment(source = process.env) {
    const env = {};
    for (const key of [...OS_ENV_KEYS, ...APP_ENV_KEYS]) {
        if (source[key] !== undefined) env[key] = source[key];
    }
    env.THEIA_CONFIG_DIR = source.THEIA_CONFIG_DIR || path.join(os.homedir(), '.config', 'omo-spatial-ide');
    try { fs.mkdirSync(env.THEIA_CONFIG_DIR, { recursive: true, mode: 0o700 }); env.THEIA_CONFIG_DIR = fs.realpathSync(env.THEIA_CONFIG_DIR); } catch { /* validated again when the private plugin copy is made */ }
    // Pinned Python plugin files must not be mutated by debugger bytecode output.
    env.PYTHONDONTWRITEBYTECODE = '1';
    return env;
}

function main(args = process.argv.slice(2)) {
    const selected = options(args);
    if (selected.help) {
        console.log('Usage: npm start -- [--workspace /path/to/project] [--port 3190]\nLocal single-user IDE. Listens only on 127.0.0.1. Default: the bundled demo project.');
        return;
    }
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Omo requires Node.js 22 or newer.');
    // Canonical roots: macOS /var, /tmp and some install paths are symlinks to /private/...; the strict
    // per-entry symlink checks below then apply inside the canonical tree.
    const appRoot = fs.realpathSync(path.resolve(__dirname, '..'));
    const backend = path.join(appRoot, 'browser-app/lib/backend/main.js');
    if (!fs.existsSync(backend)) throw new Error('Build the application first: npm run build');
    const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'ide-extensions.lock.json'), 'utf8'));
    const env = applicationEnvironment();
    const runtime = createPrivatePluginCopy(appRoot, env.THEIA_CONFIG_DIR, manifest);
    let child;
    let finished = false;
    const finish = status => {
        if (finished) return;
        finished = true;
        process.exitCode = status;
        if (!cleanupPrivatePluginDir(runtime.pluginDir)) console.error(`Could not safely remove private IDE runtime copy: ${runtime.pluginDir}`);
    };
    try {
        child = spawn(process.execPath, backendArguments(selected, runtime.pluginDir), { env, stdio: 'inherit', shell: false });
        let stopping = false;
        for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!stopping) { stopping = true; child.kill(signal); } });
        child.on('error', error => { console.error(error.message); finish(1); });
        child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
    } catch (error) {
        cleanupPrivatePluginDir(runtime.pluginDir);
        throw error;
    }
}
if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
module.exports = { options, backendArguments, applicationEnvironment };
