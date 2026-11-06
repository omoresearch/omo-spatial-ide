#!/usr/bin/env node
/*
 * Package a built Omo Spatial IDE for one platform as a self-contained tarball:
 *   omo-spatial-ide-<version>-<platform>-<arch>.tar.gz
 * Contents: the built browser app (backend + frontend + native modules), the pinned
 * sha256-verified IDE extension bundle, the Python runtime, scripts, docs and a launcher.
 * Node.js 22+, Python 3.11+ and tmux are prerequisites on the target machine (not bundled).
 * Usage: node scripts/package-release.cjs <outDir>
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
const version = require(path.join(ROOT, 'package.json')).version;
const name = `omo-spatial-ide-${version}-${process.platform}-${process.arch}`;
const stage = path.join(out, name);
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
fs.mkdirSync(path.join(stage, 'demo-project'), { recursive: true });
fs.writeFileSync(path.join(stage, 'demo-project', 'README.md'), '# Demo project\n\nOpen your own folder with `./omo --workspace /path/to/project`.\n');
// Launcher.
const launcher = `#!/bin/sh
# Omo Spatial IDE ${version} launcher. Requires Node.js 22+, Python 3.11+ and tmux on PATH.
# macOS: brew install node@22 python tmux bash   (optional: brew install --cask google-chrome)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -s)" in Darwin) PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH;; esac
command -v node >/dev/null 2>&1 || { echo "Omo needs Node.js 22 or newer (macOS: brew install node@22)." >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "Omo needs tmux (macOS: brew install tmux)." >&2; exit 1; }
exec node "$HERE/scripts/start.cjs" "$@"
`;
fs.writeFileSync(path.join(stage, 'omo'), launcher, { mode: 0o755 });
fs.writeFileSync(path.join(stage, 'INSTALL.txt'), `Omo Spatial IDE ${version} (${process.platform}-${process.arch})

1. Prerequisites${process.platform === 'darwin' ? ' (Homebrew):\n     brew install node@22 python tmux bash\n     brew install --cask google-chrome      # optional, for the web wall' : ': Node.js 22+, Python 3.11+, tmux'}
2. Unpack:   tar -xzf ${name}.tar.gz && cd ${name}
${process.platform === 'darwin' ? '   macOS may quarantine downloaded files:  xattr -dr com.apple.quarantine .\n' : ''}3. Run:      ./omo --workspace /path/to/your/project
4. Open http://localhost:3190 in Chrome.

Local single-user IDE: listens only on 127.0.0.1. Not code-signed. Agents (Hermes, Claude Code,
Codex) are used only if their CLIs are installed and signed in; starting one always asks first.
`);
// Tarball + checksum.
const tarball = path.join(out, `${name}.tar.gz`);
const tar = spawnSync('tar', ['-czf', tarball, '-C', out, name], { stdio: 'inherit' });
if (tar.status !== 0) throw new Error('tar failed');
const sha = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
fs.writeFileSync(`${tarball}.sha256`, `${sha}  ${path.basename(tarball)}\n`);
console.log(JSON.stringify({ tarball, sha256: sha, bytes: fs.statSync(tarball).size, stage }));
