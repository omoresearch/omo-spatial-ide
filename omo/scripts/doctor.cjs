#!/usr/bin/env node
'use strict';
// Filesystem-only preflight. No child_process, runtime host, CLI, Chrome, network or credential reads.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function canonicalPath(file) {
    const absolute = path.resolve(file);
    const root = path.parse(absolute).root;
    const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
    let lexical = root;
    let canonical = root;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const next = path.join(lexical, part);
        let stat;
        try {
            stat = fs.lstatSync(next);
        } catch (error) {
            if (error?.code === 'ENOENT') return path.join(canonical, ...parts.slice(index));
            throw error;
        }
        if (stat.isSymbolicLink()) {
            canonical = fs.realpathSync(next);
            lexical = canonical;
        } else {
            canonical = path.join(canonical, part);
            lexical = next;
        }
    }
    return canonical;
}
function assertSafeDataDir(dataDir, home) {
    let canonicalData;
    let canonicalLegacy;
    try {
        canonicalData = canonicalPath(dataDir);
        canonicalLegacy = canonicalPath(path.join(home, '.local', 'share', 'omo'));
    } catch {
        throw new Error('OMO_SPATIAL_DATA cannot be resolved safely');
    }
    if (canonicalData === canonicalLegacy) {
        throw new Error('OMO_SPATIAL_DATA must not be the Minecraft Omo data directory');
    }
}
// Preserve symlink/.. filesystem semantics used by Python's os.path.join:
// path.resolve/path.join would lexically remove those components too early.
function runtimePath(file, dataDir) { return path.isAbsolute(file) ? file : `${dataDir}${path.sep}${file}`; }
function runtimeWhich(name, envPath, dataDir) {
    // Python's POSIX shutil.which uses os.defpath only when PATH is unset.
    // A wholly empty PATH disables searching; empty entries in a nonempty PATH
    // still mean the Python host's working directory.
    const searchPath = envPath === undefined ? '/bin:/usr/bin' : String(envPath);
    if (!searchPath) return undefined;
    for (const entry of searchPath.split(path.delimiter)) {
        const directory = entry ? runtimePath(entry, dataDir) : dataDir;
        const candidate = `${directory}${path.sep}${name}`;
        if (path.isAbsolute(candidate) && isExecutable(candidate)) return candidate;
    }
    return undefined;
}
function isExecutable(file) { try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; } }
function clean(text) { return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500); }
function collectReport(options = {}) {
    const root = options.root ?? path.resolve(__dirname, '..');
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const nodeVersion = options.nodeVersion ?? process.versions.node;
    const platform = options.platform ?? process.platform;
    const checks = [];
    const add = (id, required, found, detail, fix = '') => checks.push({ id, required, status: found ? 'ok' : required ? 'missing' : 'warning', detail: clean(detail), ...(found ? {} : { fix }) });
    add('node', true, Number(nodeVersion.split('.')[0]) >= 22, `Node.js ${nodeVersion}`, 'Use Node.js 22 or newer.');
    add('platform', false, platform === 'linux', platform === 'linux' ? 'Linux: the verified local alpha platform.' : `${platform}: this host platform is not certified by the Linux acceptance suite.`, 'Use Linux (or a Linux environment). macOS and Windows installation are not certified.');
    const built = isFile(path.join(root, 'browser-app/lib/backend/main.js'));
    add('build', true, built, built ? 'The built Theia backend entry exists.' : 'The Theia application has not been built.', 'Stop any app using this checkout, then install locked dependencies with npm ci and run npm run build from omo/.');
    let discovery, locations;
    try {
        discovery = require(path.join(root, 'extension/lib/node/runtime-discovery.js'));
        locations = discovery.discoverRuntime(env, home);
        assertSafeDataDir(locations.dataDir, home);
        add('runtime', true, isFile(locations.hostScript), isFile(locations.hostScript) ? 'Runtime discovery is built and its host script exists.' : 'The configured Python runtime host script is missing.', 'Check OMO_SPATIAL_HOST_SCRIPT or restore omo/runtime; rebuild from this checkout.');
    } catch (error) {
        locations = undefined;
        const detail = String(error?.message || '').startsWith('OMO_SPATIAL_TMUX_SOCKET') ? 'The runtime tmux socket setting is invalid or reserved.'
            : String(error?.message || '') === 'OMO_SPATIAL_DATA cannot be resolved safely' ? 'The runtime data path cannot be resolved safely. Check symlink targets and permissions.'
            : String(error?.message || '').startsWith('OMO_SPATIAL_DATA') ? 'The runtime data directory conflicts with Minecraft data.'
                : 'Runtime discovery is not built, could not be loaded, or has invalid configuration.';
        add('runtime', true, false, detail, 'Check OMO_SPATIAL_DATA and OMO_SPATIAL_TMUX_SOCKET; they must not use Minecraft data or reserved sockets. If discovery is not built, install dependencies and run npm run compile.');
    }
    if (discovery && locations) {
        add('tmux', true, !!locations.tmux, locations.tmux || 'No executable tmux was found.', 'Install tmux or set OMO_SPATIAL_TMUX to an absolute executable path.');
        add('python', true, !!locations.python, locations.python || 'No executable Python 3 was found.', 'Install Python 3 or set OMO_SPATIAL_PYTHON to an absolute executable path.');
        const bash = discovery.which('bash', env.PATH);
        const git = discovery.which('git', env.PATH);
        add('bash', true, !!bash, bash || 'No executable bash was found on PATH.', 'Install bash and put it on the application PATH.');
        add('git', false, !!git, git || 'Git was not found; project change review needs it.', 'Install git and put it on the application PATH to use Code review.');
        for (const kind of ['hermes', 'claude', 'codex']) {
            const override = env[`OMO_SPATIAL_${kind.toUpperCase()}_BIN`];
            const pinned = kind === 'hermes' ? override : override?.trim();
            const pinnedCandidate = pinned
                ? pinned.includes(path.sep)
                    ? runtimePath(pinned, locations.dataDir)
                    : runtimeWhich(pinned, env.PATH, locations.dataDir)
                : undefined;
            const candidates = pinned ? [pinnedCandidate] : [
                runtimeWhich(kind, env.PATH, locations.dataDir),
                ...(kind === 'hermes' ? [] : [path.join(home, '.local/bin', kind), path.join(home, '.claude/local', kind), path.join(home, '.npm-global/bin', kind), path.join(home, '.bun/bin', kind), `/opt/homebrew/bin/${kind}`, `/usr/local/bin/${kind}`])
            ];
            let binary = candidates.find(candidate => isExecutable(candidate));
            if (binary) { try { binary = fs.realpathSync(binary); } catch { /* It existed at the metadata check; do not execute it to recheck. */ } }
            add(kind, false, !!binary, binary ? `${binary} (not executed; login not checked)` : `${kind} executable not found. This does not block shell use.`, `Install the ${kind} CLI separately, or set OMO_SPATIAL_${kind.toUpperCase()}_BIN. Authenticate in the CLI itself; this check never asks for credentials.`);
        }
    }
    try {
        const web = require(path.join(root, 'extension/lib/node/web-runtime-service.js'));
        const chrome = web.discoverChrome(env, platform, web.defaultChromeCandidates(platform, home));
        add('chrome', false, !!chrome, chrome ? `${chrome} (not launched; sandbox not tested)` : 'No installed Chrome/Chromium executable was found. The web wall is optional.', 'Install Chrome/Chromium or set OMO_SPATIAL_CHROME (or CHROME_PATH) to an absolute executable. Do not disable its sandbox.');
    } catch {
        add('chrome', false, false, 'Browser discovery is not built or could not be loaded.', 'Install dependencies and run npm run compile before checking the optional web wall.');
    }
    return {
        schemaVersion: 1,
        prerequisitesFound: checks.every(check => !check.required || check.status === 'ok'),
        checks,
        limitations: [
            'This is a filesystem-only preflight, not a successful app launch or a native-addon ABI test.',
            'No agent was executed. Authentication, existing profile leases, model access and paid sessions were not tested.',
            'Chrome was not launched. Browser sandbox operation, GPU rendering and media permissions were not tested.',
            'Python/tmux versions and bracketed-paste capability were not executed or certified; unsafe multiline paste still fails closed.',
            'No software was installed, no runtime state was created, and no credential or agent-profile configuration files were read.'
        ]
    };
}
function main(args = process.argv.slice(2), output = console) {
    if (args.includes('--help') || args.includes('-h')) {
        output.log('Usage: npm run doctor -- [--json]\nRead-only filesystem preflight. No installs, agents, browser launches, network calls or credential reads.');
        return 0;
    }
    if (args.some(arg => arg !== '--json')) { output.error('Unknown doctor option. Use --json or --help.'); return 2; }
    const report = collectReport();
    if (args.includes('--json')) output.log(JSON.stringify(report, null, 2));
    else {
        output.log(report.prerequisitesFound ? 'Required local prerequisite files found. Launch is not yet verified.' : 'Local prerequisites are missing or invalid.');
        for (const check of report.checks) {
            output.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
            if (check.fix) output.log(`  Next: ${check.fix}`);
        }
        output.log('\nNot tested:'); for (const note of report.limitations) output.log(`- ${note}`);
    }
    return report.prerequisitesFound ? 0 : 1;
}
if (require.main === module) { try { process.exitCode = main(); } catch { console.error('Setup check could not complete. Check checkout access and rebuild; no tools were launched.'); process.exitCode = 1; } }
module.exports = { collectReport, main };
