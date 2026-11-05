'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const MARKER = '.omo-ide-bundle.json';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const safeFile = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]*\.vsix$/.test(value);
const safeContentPath = value => typeof value === 'string' && value.length < 4096 && !value.startsWith('/') && !/[\\\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
function allowedUrl(value, redirect = false) {
    try {
        const url = new URL(value);
        const hosts = ['github.com', 'open-vsx.org'];
        const assetHost = redirect && (url.hostname.endsWith('.githubusercontent.com') || url.hostname === 'openvsx.eclipsecontent.org');
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port && (hosts.includes(url.hostname) || assetHost);
    } catch { return false; }
}
function validateLock(value) {
    if (!value || value.version !== 1 || typeof value.vscodeApi !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.vscodeApi)
        || !Array.isArray(value.assets) || !value.assets.length || value.assets.length > 32 || !Array.isArray(value.exclude) || value.exclude.length > 128) throw Error('Invalid extension lock');
    const seen = new Set();
    for (const item of value.assets) {
        if (!item || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item.id || '') || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(item.version || '')
            || !['tar', 'vsix'].includes(item.format) || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !allowedUrl(item.url)
            || !Number.isInteger(item.maxBytes) || item.maxBytes < 1 || item.maxBytes > 100000000
            || (item.platform !== undefined && !/^(linux|darwin|win32)-(x64|arm64)$/.test(item.platform)) || seen.has(item.id)) throw Error('Invalid or duplicate pinned extension artifact');
        seen.add(item.id);
    }
    if (value.exclude.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))) throw Error('Invalid extension exclusion');
    return JSON.parse(JSON.stringify(value));
}
function verifyAsset(bytes, item) {
    if (!Buffer.isBuffer(bytes) || bytes.length > item.maxBytes) throw Error('Extension artifact exceeds its size limit');
    if (digest(bytes) !== item.sha256) throw Error('Extension artifact checksum mismatch');
    return true;
}
function inspectPrepared(root, manifest) {
    try {
        manifest = validateLock(manifest);
        const dir = path.join(root, 'plugins');
        if (fs.lstatSync(dir).isSymbolicLink()) throw Error();
        const marker = path.join(dir, MARKER);
        const markerStat = fs.lstatSync(marker);
        if (!markerStat.isFile() || markerStat.isSymbolicLink() || fs.realpathSync(marker) !== path.resolve(marker) || markerStat.size > 20 * 1024 * 1024) throw Error();
        const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (meta.version !== 2 || meta.lockSha256 !== digest(JSON.stringify(manifest)) || !meta.files || typeof meta.files !== 'object' || !meta.plugins || typeof meta.plugins !== 'object') throw Error();
        const names = Object.keys(meta.files);
        if (!names.length || names.length > 100000 || !Object.keys(meta.plugins).length) throw Error();
        const expectedDirectories = new Set();
        for (const name of names) {
            if (!safeContentPath(name) || !/^[a-f0-9]{64}$/.test(meta.files[name])) throw Error();
            let parent = path.posix.dirname(name);
            while (parent !== '.') {
                expectedDirectories.add(parent);
                parent = path.posix.dirname(parent);
            }
        }
        const actualFiles = new Set();
        const actualDirectories = new Set();
        let entryCount = 0;
        const maxEntries = names.length + expectedDirectories.size + 1;
        const enumerate = (current, relative) => {
            const directory = fs.lstatSync(current);
            if (!directory.isDirectory() || directory.isSymbolicLink() || fs.realpathSync(current) !== path.resolve(current)) throw Error();
            if (relative) actualDirectories.add(relative);
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (++entryCount > maxEntries) throw Error();
                const child = path.join(current, entry.name);
                const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
                const stat = fs.lstatSync(child);
                if (stat.isSymbolicLink()) throw Error();
                if (stat.isDirectory()) {
                    enumerate(child, childRelative);
                } else if (stat.isFile()) {
                    if (childRelative === MARKER && !relative) continue;
                    if (!safeContentPath(childRelative) || fs.realpathSync(child) !== path.resolve(child)) throw Error();
                    actualFiles.add(childRelative);
                } else {
                    throw Error();
                }
            }
        };
        enumerate(dir, '');
        if (actualFiles.size !== names.length || names.some(name => !actualFiles.has(name))
            || actualDirectories.size !== expectedDirectories.size || [...expectedDirectories].some(name => !actualDirectories.has(name))) throw Error();
        for (const name of names) {
            const file = path.join(dir, name), stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file) || stat.size > 100000000 || digest(fs.readFileSync(file)) !== meta.files[name]) throw Error();
        }
        for (const id of Object.keys(meta.plugins)) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || !meta.files[id + '/package.json']) throw Error();
        return { ready: !meta.unsupported?.length, files: names.length, extensions: Object.keys(meta.plugins).length, unsupported: meta.unsupported || [] };
    } catch { return { ready: false, files: 0, reason: 'Pinned IDE extension bundle is missing, changed or incomplete. Run npm run prepare:ide explicitly.' }; }
}
async function download(item) {
    let url = item.url;
    for (let n = 0; n < 6; n++) {
        if (!allowedUrl(url, n > 0)) throw Error('Extension download redirect refused');
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'Omo-IDE-explicit-setup' } });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw Error('Extension redirect missing');
            url = new URL(location, url).href;
            continue;
        }
        if (!response.ok || !response.body) throw Error('Extension artifact download failed');
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > item.maxBytes) { await response.body.cancel(); throw Error('Extension artifact exceeds its size limit'); }
        const chunks = []; let size = 0;
        for await (const value of response.body) {
            size += value.length;
            if (size > item.maxBytes) throw Error('Extension artifact exceeds its size limit');
            chunks.push(value);
        }
        const result = Buffer.concat(chunks);
        verifyAsset(result, item);
        return result;
    }
    throw Error('Too many extension download redirects');
}
function ordinaryDirectory(dir) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== path.resolve(dir)) throw Error('IDE bundle directory must be canonical and not redirected');
}
async function prepareIde(root, manifest, fetchAsset = download) {
    manifest = validateLock(manifest);
    ordinaryDirectory(root);
    const existing = inspectPrepared(root, manifest);
    if (existing.ready) return existing;
    const target = path.join(root, 'plugins');
    if (fs.existsSync(target) || (() => { try { fs.lstatSync(target); return true; } catch { return false; } })()) throw Error('Existing IDE bundle is not the requested verified bundle. Stop the app and inspect it before replacement; no files were removed.');
    const cache = path.join(root, '.cache');
    if (!fs.existsSync(cache)) fs.mkdirSync(cache, { mode: 0o700 });
    ordinaryDirectory(cache);
    const stage = fs.mkdtempSync(path.join(root, '.omo-ide-stage-'));
    const files = {}, plugins = {}, unsupported = [];
    const expand = archive => {
        const report = JSON.parse(execFileSync('python3', [path.join(__dirname, 'ide-vsix.py'), archive, stage], { encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024 }));
        if (plugins[report.id]) throw Error('Duplicate expanded extension identity');
        plugins[report.id] = report.version;
        for (const [name, hash] of Object.entries(report.files)) {
            if (!safeContentPath(name) || files[name]) throw Error('Invalid expanded extension member');
            files[name] = hash;
        }
    };
    try {
        for (const item of manifest.assets) {
            if (item.platform && item.platform !== process.platform + '-' + process.arch) { unsupported.push(item.id + ': ' + item.platform + ' only'); continue; }
            const cached = path.join(cache, item.sha256 + '.' + (item.format === 'tar' ? 'tar.gz' : 'vsix'));
            let bytes;
            if (fs.existsSync(cached)) {
                const stat = fs.lstatSync(cached);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > item.maxBytes) throw Error('Unsafe extension cache entry');
                bytes = fs.readFileSync(cached);
                verifyAsset(bytes, item);
            } else {
                bytes = await fetchAsset(item);
                verifyAsset(bytes, item);
                fs.writeFileSync(cached, bytes, { flag: 'wx', mode: 0o600 });
            }
            if (item.format === 'tar') {
                const extracted = path.join(stage, '.extract');
                const report = JSON.parse(execFileSync('python3', [path.join(__dirname, 'ide-archive.py'), cached, extracted, JSON.stringify(manifest.exclude)], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 }));
                for (const [name, hash] of Object.entries(report)) {
                    if (!safeFile(name) || files[name]) throw Error('Invalid or duplicate bundled extension');
                    if (digest(fs.readFileSync(path.join(extracted, name))) !== hash) throw Error('Bundled VSIX checksum mismatch');
                    expand(path.join(extracted, name));
                    fs.unlinkSync(path.join(extracted, name));
                }
                fs.rmdirSync(extracted);
            } else {
                expand(cached);
                if (plugins[item.id] !== item.version) throw Error('Extension identity or version does not match pinned artifact');
            }
        }
        const meta = { version: 2, lockSha256: digest(JSON.stringify(manifest)), files, plugins, unsupported };
        fs.writeFileSync(path.join(stage, MARKER), JSON.stringify(meta, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
        fs.chmodSync(stage, 0o755);
        fs.renameSync(stage, target);
        return inspectPrepared(root, manifest);
    } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
}
module.exports = { validateLock, verifyAsset, inspectPrepared, prepareIde };
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        if (args.some(arg => !['--check', '--json'].includes(arg))) { console.error('Supported options: --check --json'); process.exitCode = 2; return; }
        const manifest = validateLock(JSON.parse(fs.readFileSync(path.join(ROOT, 'ide-extensions.lock.json'), 'utf8')));
        const result = args.includes('--check') ? inspectPrepared(ROOT, manifest) : await prepareIde(ROOT, manifest);
        console.log(args.includes('--json') ? JSON.stringify(result) : (result.ready ? 'Pinned IDE extensions are ready (' + result.files + ' files).' : result.reason || 'IDE extension platform is not fully supported.'));
        if (!result.ready) process.exitCode = 1;
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
