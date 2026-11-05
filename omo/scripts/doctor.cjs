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
    const mac = platform === 'darwin';
    // macOS: supported code paths exist but have not been executed on a Mac yet. Warn "unverified"; never fail.
    add('platform', false, platform === 'linux', platform === 'linux' ? 'Linux: the verified local alpha platform.'
        : mac ? 'macOS: unverified. macOS support is implemented but has not yet been executed on macOS.'
            : `${platform}: this host platform is not certified by the Linux acceptance suite.`,
    mac ? 'Follow omo/MAC-SETUP.md (Homebrew tmux, python, bash, git) and report the verification checklist results.'
        : 'Use Linux (or a Linux environment). macOS and Windows installation are not certified.');
    const brewPrefixes = mac ? ['/opt/homebrew', '/usr/local'].filter(prefix => isExecutable(path.join(prefix, 'bin', 'brew'))) : [];
    if (mac) add('homebrew', false, brewPrefixes.length > 0, brewPrefixes.length ? `Homebrew at ${brewPrefixes.join(', ')} (not executed)` : 'Homebrew was not found in /opt/homebrew or /usr/local.', 'Install Homebrew from https://brew.sh, then: brew install node@22 tmux python bash git');
    const brewHint = (formula, otherwise) => `Install it with Homebrew (brew install ${formula}) or ${otherwise}`;
    const built = isFile(path.join(root, 'browser-app/lib/backend/main.js'));
    add('build', true, built, built ? 'The built Theia backend entry exists.' : 'The Theia application has not been built.', 'Stop any app using this checkout, then install locked dependencies with npm ci and run npm run build from omo/.');
    let discovery, locations;
    try {
        discovery = require(path.join(root, 'extension/lib/node/runtime-discovery.js'));
        locations = discovery.discoverRuntime(env, home, platform);
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
        // The PATH the runtime host will really use (macOS: Homebrew bin directories first).
        const searchPath = locations.searchPath ?? env.PATH;
        add('tmux', true, !!locations.tmux, locations.tmux || 'No executable tmux was found.', mac ? brewHint('tmux', 'set OMO_SPATIAL_TMUX to an absolute executable path.') : 'Install tmux or set OMO_SPATIAL_TMUX to an absolute executable path.');
        add('python', true, !!locations.python, locations.python || 'No executable Python 3 was found.', mac ? brewHint('python', 'set OMO_SPATIAL_PYTHON to an absolute Python 3.11+ executable.') : 'Install Python 3 or set OMO_SPATIAL_PYTHON to an absolute executable path.');
        const bash = locations.bash ?? discovery.which('bash', searchPath);
        const git = discovery.which('git', searchPath);
        add('bash', true, !!bash, bash || 'No executable bash was found on PATH.', mac ? 'Install bash with Homebrew (brew install bash).' : 'Install bash and put it on the application PATH.');
        add('git', false, !!git, git || 'Git was not found; project change review needs it.', mac ? 'Install git (xcode-select --install, or brew install git) to use Code review.' : 'Install git and put it on the application PATH to use Code review.');
        if (mac) {
            // Filesystem-only: versions are inferred from the location, never by executing anything.
            // /usr/bin/python3 is Apple's Command Line Tools Python (3.9); owned agent starts need 3.11+.
            const applePython = !!locations.python && /^\/usr\/bin\/python3(\.\d+)?$/.test(locations.python);
            add('python-version', false, !!locations.python && !applePython, applePython
                ? `${locations.python} is Apple's Command Line Tools Python (3.9); Omo needs Python 3.11 or newer.`
                : locations.python ? `${locations.python} (version not executed; Python 3.11 or newer is required)` : 'No Python found.',
            'brew install python, make sure /opt/homebrew/bin (or /usr/local/bin) is on PATH, or set OMO_SPATIAL_PYTHON to a Python 3.11+ executable.');
            // /bin/bash on macOS is bash 3.2. The shell profile is written to work on it, but Homebrew bash is preferred.
            const appleBash = bash === '/bin/bash';
            add('bash-version', false, !!bash && !appleBash, appleBash ? '/bin/bash is macOS bash 3.2 (2007); tabs will work but Homebrew bash is preferred.'
                : bash ? `${bash} (version not executed)` : 'No bash found.', 'brew install bash; Omo puts Homebrew bin directories ahead of /bin automatically.');
        }
        for (const kind of ['hermes', 'claude', 'codex']) {
            const override = env[`OMO_SPATIAL_${kind.toUpperCase()}_BIN`];
            const pinned = kind === 'hermes' ? override : override?.trim();
            const pinnedCandidate = pinned
                ? pinned.includes(path.sep)
                    ? runtimePath(pinned, locations.dataDir)
                    : runtimeWhich(pinned, searchPath, locations.dataDir)
                : undefined;
            const candidates = pinned ? [pinnedCandidate] : [
                runtimeWhich(kind, searchPath, locations.dataDir),
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
        add('chrome', false, !!chrome, chrome ? `${chrome} (not launched; sandbox not tested)` : 'No installed Chrome/Chromium executable was found. The web wall is optional.', mac ? 'Install Google Chrome into /Applications (or brew install --cask google-chrome / chromium), or set OMO_SPATIAL_CHROME to the executable inside the .app bundle. Do not disable its sandbox.' : 'Install Chrome/Chromium or set OMO_SPATIAL_CHROME (or CHROME_PATH) to an absolute executable. Do not disable its sandbox.');
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
