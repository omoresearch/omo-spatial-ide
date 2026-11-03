#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

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

function main(args = process.argv.slice(2)) {
    const selected = options(args);
    if (selected.help) {
        console.log('Usage: npm start -- [--workspace /path/to/project] [--port 3190]\nLocal single-user IDE. Listens only on 127.0.0.1. Default: the bundled demo project.');
        return;
    }
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Omo requires Node.js 22 or newer.');
    const backend = path.resolve(__dirname, '../browser-app/lib/backend/main.js');
    if (!fs.existsSync(backend)) throw new Error('Build the application first: npm run build');
    const env = { ...process.env, THEIA_CONFIG_DIR: process.env.THEIA_CONFIG_DIR || path.join(os.homedir(), '.config', 'omo-spatial-ide') };
    // The IDE is not the parent agent's conversation. Never inherit its routing identity.
    for (const key of ['HERMES_SESSION_ID', 'HERMES_PARENT_SESSION_ID', 'HERMES_CONVERSATION_ID', 'HERMES_SOURCE_PLATFORM', 'HERMES_SOURCE_CHAT_ID']) delete env[key];
    const child = spawn(process.execPath, [backend, selected.workspace, '--hostname', '127.0.0.1', '--port', selected.port], { env, stdio: 'inherit', shell: false });
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!stopping) { stopping = true; child.kill(signal); } });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
module.exports = { options };
