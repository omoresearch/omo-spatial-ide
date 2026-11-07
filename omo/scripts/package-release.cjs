#!/usr/bin/env node
/*
 * Package a built Omo Spatial IDE for THIS host's platform/arch (native modules are host-built).
 *
 *   node scripts/package-release.cjs <outDir> [--formats tar,app,dmg,appimage] [--no-node] [--no-tmux]
 *
 * Formats (default: tar + app + dmg on macOS, tar + appimage on Linux):
 *   tar       omo-spatial-ide-<v>-<platform>-<arch>.tar.gz      (./omo CLI launcher and ./omo-app desktop launcher)
 *   app       Omo Spatial IDE.app  (macOS bundle; built on any host, so its layout is testable on Linux)
 *   dmg       Omo-Spatial-IDE-<v>-<platform>-<arch>.dmg          (macOS only: hdiutil; drag to Applications)
 *   appimage  Omo-Spatial-IDE-<v>-<arch>.AppImage                (Linux only: pinned appimagetool + runtime)
 * Every artifact gets a <file>.sha256. The last stdout line is a JSON summary.
 *
 * Bundled runtimes (sha256-pinned in packaging/pins.json, opt out with --no-node / --no-tmux):
 *   vendor/node   official Node.js 22 LTS for this platform, so users do not need to install Node.
 *   vendor/tmux   official tmux static build (tmux/tmux-builds); used only when no tmux is installed.
 * Python 3.11+ stays a prerequisite (the launchers explain how to install it).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGING = path.join(ROOT, 'packaging');
const APP_NAME = 'Omo Spatial IDE';
const BUNDLE_ID = 'space.omo.spatial-ide';

function parseArgs(argv) {
    const out = { outDir: undefined, formats: undefined, node: true, tmux: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--formats' && argv[i + 1]) out.formats = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--no-node') out.node = false;
        else if (a === '--no-tmux') out.tmux = false;
        else if (!a.startsWith('-') && out.outDir === undefined) out.outDir = a;
        else throw new Error(`Unknown option: ${a}`);
    }
    const valid = ['tar', 'app', 'dmg', 'appimage'];
    out.formats = out.formats || (process.platform === 'darwin' ? ['tar', 'app', 'dmg'] : process.platform === 'linux' ? ['tar', 'appimage'] : ['tar']);
    for (const f of out.formats) if (!valid.includes(f)) throw new Error(`Unknown format ${f} (valid: ${valid.join(', ')})`);
    if (out.formats.includes('dmg') && !out.formats.includes('app')) out.formats.push('app');
    return out;
}

const run = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
    return r;
};
const sha256 = file => {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20);
    try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
    return hash.digest('hex');
};
const writeChecksum = file => {
    const sum = sha256(file);
    fs.writeFileSync(`${file}.sha256`, `${sum}  ${path.basename(file)}\n`);
    return sum;
};

/** The platform-neutral payload: built app, plugins, runtime, scripts, launchers, docs. */
function stagePayload(stage, version, platformArch) {
    const must = rel => { const p = path.join(ROOT, rel); if (!fs.existsSync(p)) throw new Error(`Build output missing: ${rel} (run npm run build first)`); return p; };
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const copy = (rel, opts = {}) => fs.cpSync(must(rel), path.join(stage, rel), { recursive: true, dereference: true, filter: opts.filter });
    const noPyc = src => !/__pycache__|\.pyc$/.test(src);
    // Built application (webpack bundles node deps; native modules are copied into lib/backend/native).
    copy('browser-app/lib');
    copy('browser-app/src-gen', { filter: src => !src.endsWith('.map') });
    copy('browser-app/package.json');
    copy('plugins');
    copy('runtime', { filter: src => noPyc(src) && !src.includes(`${path.sep}tests${path.sep}`) });
    for (const rel of ['scripts/start.cjs', 'scripts/runtime-ide-plugins.cjs', 'scripts/doctor.cjs', 'scripts/prepare-ide.cjs', 'ide-extensions.lock.json', 'package.json', 'README.md', 'MAC-SETUP.md', 'SETUP.md']) {
        if (fs.existsSync(path.join(ROOT, rel))) copy(rel);
    }
    // t2:pkg: the standalone room server (shared rooms) and its one dependency, ws, so the package can host rooms.
    for (const rel of ['server/omo-room-server.cjs', 'server/package.json', 'server/README.md', 'server/src', 'server/vendor', 'server/client']) copy(rel);
    const wsDir = path.dirname(require.resolve('ws/package.json', { paths: [path.join(ROOT, 'server'), ROOT] }));
    for (const f of ['package.json', 'index.js', 'wrapper.mjs', 'browser.js', 'LICENSE', 'lib']) {
        if (fs.existsSync(path.join(wsDir, f))) fs.cpSync(path.join(wsDir, f), path.join(stage, 'server', 'node_modules', 'ws', f), { recursive: true, dereference: true });
    }
    fs.copyFileSync(path.join(PACKAGING, 'desktop-launch.cjs'), path.join(stage, 'scripts', 'desktop-launch.cjs'));
    fs.copyFileSync(path.join(PACKAGING, 'omo-app.sh'), path.join(stage, 'omo-app'));
    fs.chmodSync(path.join(stage, 'omo-app'), 0o755);
    fs.mkdirSync(path.join(stage, 'demo-project'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'demo-project', 'README.md'), '# Demo project\n\nOpen your own folder with `./omo --workspace /path/to/project`.\n');
    const mac = platformArch.startsWith('darwin');
    // CLI launcher (the release smoke test and terminal users run this).
    fs.writeFileSync(path.join(stage, 'omo'), `#!/bin/sh
# Omo Spatial IDE ${version} command-line launcher: ./omo [--workspace DIR] [--port N]
# Uses the bundled Node.js (vendor/node) when present, else Node.js 22+ on PATH.
# tmux: an installed tmux wins; else the bundled one (vendor/tmux). Python 3.11+ must be installed.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -s)" in Darwin) PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH;; esac
NODE="$HERE/vendor/node/bin/node"
if [ ! -x "$NODE" ]; then
    NODE="$(command -v node 2>/dev/null || true)"
    [ -n "$NODE" ] || { echo "Omo needs Node.js 22 or newer (macOS: brew install node@22)." >&2; exit 1; }
fi
if [ -z "\${OMO_SPATIAL_TMUX:-}" ] && ! command -v tmux >/dev/null 2>&1; then
    if [ -x "$HERE/vendor/tmux/tmux" ]; then OMO_SPATIAL_TMUX="$HERE/vendor/tmux/tmux"; export OMO_SPATIAL_TMUX
    else echo "Omo needs tmux (macOS: brew install tmux; Debian/Ubuntu: sudo apt install tmux)." >&2; exit 1; fi
fi
exec "$NODE" "$HERE/scripts/start.cjs" "$@"
`, { mode: 0o755 });
    // t2:pkg: room server launcher (same bundled Node.js). ./omo-room-server --help lists the commands.
    fs.writeFileSync(path.join(stage, 'omo-room-server'), `#!/bin/sh
# Omo room server ${version}: shared rooms for people on different computers. See server/README.md.
#   ./omo-room-server create-room --data DIR --id ROOM --owner NAME
#   ./omo-room-server --data DIR --port 8787
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$HERE/vendor/node/bin/node"
if [ ! -x "$NODE" ]; then
    NODE="$(command -v node 2>/dev/null || true)"
    [ -n "$NODE" ] || { echo "omo-room-server needs Node.js 22 or newer." >&2; exit 1; }
fi
exec "$NODE" "$HERE/server/omo-room-server.cjs" "$@"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(stage, 'INSTALL.txt'), `${APP_NAME} ${version} (${platformArch})

${mac ? `Easiest: download the .dmg, open it and drag "${APP_NAME}" to Applications.
Then open it from Applications. It starts a private local server and opens the IDE
in a Chrome app window (or your default browser). Logs: ~/Library/Logs/Omo/omo.log

This tarball is the same app for the terminal:
` : `Easiest: the .AppImage (chmod +x it, then run it). Or use this tarball:
`}
1. Prerequisites: Python 3.11+${mac ? ' (brew install python)' : ' (sudo apt install python3)'}.
   Node.js is bundled (vendor/node). tmux is bundled too (vendor/tmux) and an installed
   tmux is preferred when present. Optional: Google Chrome for the in-world web wall.
2. Unpack:   tar -xzf omo-spatial-ide-${version}-${platformArch}.tar.gz && cd omo-spatial-ide-${version}-${platformArch}
${mac ? '   macOS may quarantine downloaded files:  xattr -dr com.apple.quarantine .\n' : ''}3. Run:      ./omo-app                      (desktop: free port, opens the browser, logs to a file)
   or:       ./omo --workspace /path/to/your/project   (terminal: http://127.0.0.1:3190)
4. Optional: ./omo-room-server hosts shared rooms for people on other computers (server/README.md).

Local single-user IDE: listens only on 127.0.0.1. ${mac ? 'Not code-signed unless the release notes say so. ' : ''}Agents (Hermes, Claude Code,
Codex) are used only if their CLIs are installed and signed in; starting one always asks first.
Third-party licenses for bundled runtimes: vendor/node/LICENSE, vendor/tmux/LICENSES/.
`);
}

/** t2:pkg: files the packaged app needs at run time. A missing one fails the build, not the user's first launch. */
const PAYLOAD_REQUIRED = [
    'omo', 'omo-app', 'omo-room-server', 'scripts/start.cjs', 'scripts/desktop-launch.cjs', 'scripts/runtime-ide-plugins.cjs', 'ide-extensions.lock.json',
    'browser-app/lib/backend/main.js', 'browser-app/lib/frontend/index.html', 'browser-app/src-gen/backend/main.js',
    'runtime/omo_spatial_host.py', 'runtime/prompt_env.py', 'runtime/claude_status_hook.py', 'runtime/claude_with_status.sh', 'runtime/dsh_web_launch.py',
    'runtime/guarded_hermes_exec.py', 'runtime/owned_agent_exec.py', 'runtime/owned_agent_launch.py', 'runtime/owned_pty_process.py', 'runtime/process_identity.py',
    'runtime/bridge/omobridge.py', 'runtime/bridge/tmux.conf',
    'server/omo-room-server.cjs', 'server/src/server.cjs', 'server/src/hub.cjs', 'server/vendor/world-model.cjs', 'server/vendor/presence-protocol.cjs',
    'server/vendor/player-state.cjs', 'server/node_modules/ws/index.js'
];
function verifyPayload(stage) {
    const missing = PAYLOAD_REQUIRED.filter(rel => !fs.existsSync(path.join(stage, rel)));
    if (missing.length) throw new Error(`Package payload incomplete: ${missing.join(', ')}`);
    const tests = path.join(stage, 'runtime', 'tests');
    if (fs.existsSync(tests)) fs.rmSync(tests, { recursive: true, force: true }); // the filter keeps an empty dir
}

/** Copy the pinned runtimes into <stage>/vendor. */
async function addRuntimes(stage, platformArch, opts) {
    const { fetchPinned } = require(path.join(PACKAGING, 'fetch-pinned.cjs'));
    const pins = JSON.parse(fs.readFileSync(path.join(PACKAGING, 'pins.json'), 'utf8'));
    const bundled = {};
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-vendor-'));
    try {
        if (opts.node) {
            const asset = pins.node.assets[platformArch];
            if (!asset) throw new Error(`No pinned Node.js for ${platformArch} (use --no-node)`);
            const archive = await fetchPinned(asset);
            run('tar', ['-xzf', archive, '-C', tmp, `${asset.dir}/bin/node`, `${asset.dir}/LICENSE`]);
            const dest = path.join(stage, 'vendor', 'node');
            fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
            fs.copyFileSync(path.join(tmp, asset.dir, 'bin', 'node'), path.join(dest, 'bin', 'node'));
            fs.chmodSync(path.join(dest, 'bin', 'node'), 0o755);
            fs.copyFileSync(path.join(tmp, asset.dir, 'LICENSE'), path.join(dest, 'LICENSE'));
            fs.writeFileSync(path.join(dest, 'SOURCE.txt'), `Node.js ${pins.node.version} ${platformArch}\n${asset.url}\nsha256 ${asset.sha256}\n`);
            bundled.node = pins.node.version;
        }
        if (opts.tmux) {
            const asset = pins.tmux.assets[platformArch];
            if (asset) {
                const archive = await fetchPinned(asset);
                const licenses = await fetchPinned(pins.tmux.licenses);
                const dest = path.join(stage, 'vendor', 'tmux');
                fs.mkdirSync(path.join(dest, 'LICENSES'), { recursive: true });
                run('tar', ['-xzf', archive, '-C', dest, 'tmux']);
                run('tar', ['-xzf', licenses, '-C', path.join(dest, 'LICENSES')]);
                fs.chmodSync(path.join(dest, 'tmux'), 0o755);
                fs.writeFileSync(path.join(dest, 'SOURCE.txt'), `tmux ${pins.tmux.version} ${platformArch} (official tmux/tmux-builds release)\n${asset.url}\nsha256 ${asset.sha256}\n`);
                bundled.tmux = pins.tmux.version;
            } else {
                console.error(`No pinned tmux build for ${platformArch}; tmux stays a prerequisite.`);
            }
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return bundled;
}

function infoPlist(version) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const entries = {
        CFBundleDevelopmentRegion: 'en',
        CFBundleDisplayName: APP_NAME,
        CFBundleExecutable: APP_NAME,
        CFBundleIconFile: 'omo',
        CFBundleIdentifier: BUNDLE_ID,
        CFBundleInfoDictionaryVersion: '6.0',
        CFBundleName: APP_NAME,
        CFBundlePackageType: 'APPL',
        CFBundleShortVersionString: version,
        CFBundleSignature: '????',
        CFBundleVersion: version,
        LSApplicationCategoryType: 'public.app-category.developer-tools',
        LSMinimumSystemVersion: '11.0',
        NSHighResolutionCapable: true,
        NSHumanReadableCopyright: 'Omo Research. Licensed under EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0.'
    };
    const body = Object.entries(entries).map(([k, v]) => `\t<key>${k}</key>\n\t${typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : `<string>${esc(v)}</string>`}`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

function buildIcons(workDir) {
    run('sh', [path.join(PACKAGING, 'icon', 'build-icon.sh'), workDir], { stdio: ['ignore', 'ignore', 'inherit'] });
    return { icns: path.join(workDir, 'omo.icns'), png256: path.join(workDir, 'omo-256.png') };
}

/** Omo Spatial IDE.app: Contents/{Info.plist, PkgInfo, MacOS/<exe>, Resources/{omo.icns, app/<payload>}}. */
function buildApp(out, stage, version, icons) {
    const app = path.join(out, `${APP_NAME}.app`);
    fs.rmSync(app, { recursive: true, force: true });
    const contents = path.join(app, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist(version));
    fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????');
    fs.copyFileSync(icons.icns, path.join(contents, 'Resources', 'omo.icns'));
    fs.cpSync(stage, path.join(contents, 'Resources', 'app'), { recursive: true, verbatimSymlinks: true });
    const exe = path.join(contents, 'MacOS', APP_NAME);
    fs.writeFileSync(exe, `#!/bin/sh
# ${APP_NAME} ${version}: LaunchServices runs this. The launcher (Resources/app/omo-app) starts the
# local server on a free port with the bundled Node.js and opens it; logs go to ~/Library/Logs/Omo.
CONTENTS="$(cd "$(dirname "$0")/.." && pwd -P)"
exec "$CONTENTS/Resources/app/omo-app" "$@"
`, { mode: 0o755 });
    if (process.platform === 'darwin' && spawnSync('plutil', ['-lint', path.join(contents, 'Info.plist')], { stdio: 'inherit' }).status !== 0) throw new Error('Info.plist failed plutil -lint');
    return app;
}

function buildDmg(out, app, version, platformArch) {
    if (process.platform !== 'darwin') { console.error('dmg: skipped (needs macOS hdiutil)'); return undefined; }
    const dmg = path.join(out, `Omo-Spatial-IDE-${version}-${platformArch}.dmg`);
    run('sh', [path.join(PACKAGING, 'macos', 'make-dmg.sh'), app, dmg]);
    return dmg;
}

function buildAppImage(out, stage, version, icons) {
    if (process.platform !== 'linux') { console.error('appimage: skipped (needs Linux)'); return undefined; }
    const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
    if (arch !== 'x86_64') { console.error(`appimage: skipped (no pinned appimagetool for ${process.arch})`); return undefined; }
    const appimage = path.join(out, `Omo-Spatial-IDE-${version}-${arch}.AppImage`);
    run('sh', [path.join(PACKAGING, 'linux', 'make-appimage.sh'), stage, icons.png256, appimage, version], { env: { ...process.env, NODE: process.execPath } });
    return appimage;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const out = path.resolve(opts.outDir || path.join(ROOT, 'dist'));
    const version = require(path.join(ROOT, 'package.json')).version;
    const platformArch = `${process.platform}-${process.arch}`;
    const name = `omo-spatial-ide-${version}-${platformArch}`;
    const stage = path.join(out, name);
    fs.mkdirSync(out, { recursive: true });
    stagePayload(stage, version, platformArch);
    verifyPayload(stage);
    const bundled = await addRuntimes(stage, platformArch, opts);
    const result = { version, platform: platformArch, stage, bundled, artifacts: {} };
    const record = (kind, file) => { if (file) result.artifacts[kind] = { file, sha256: writeChecksum(file), bytes: fs.statSync(file).size }; };
    let icons;
    const needIcons = opts.formats.some(f => f === 'app' || f === 'appimage');
    const iconDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-icons-'));
    try {
        if (needIcons) icons = buildIcons(iconDir);
        if (opts.formats.includes('tar')) {
            const tarball = path.join(out, `${name}.tar.gz`);
            run('tar', ['-czf', tarball, '-C', out, name]);
            record('tar', tarball);
            // Back-compat with the v0.1.0 workflow/smoke: the old JSON fields.
            result.tarball = tarball; result.sha256 = result.artifacts.tar.sha256; result.bytes = result.artifacts.tar.bytes;
        }
        if (opts.formats.includes('app')) {
            result.app = buildApp(out, stage, version, icons);
            if (opts.formats.includes('dmg')) record('dmg', buildDmg(out, result.app, version, platformArch));
        }
        if (opts.formats.includes('appimage')) record('appimage', buildAppImage(out, stage, version, icons));
    } finally {
        fs.rmSync(iconDir, { recursive: true, force: true });
    }
    console.log(JSON.stringify(result));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, infoPlist, PAYLOAD_REQUIRED };
