'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateLock, inspectPrepared } = require('./prepare-ide.cjs');

const MARKER = '.omo-ide-bundle.json';
const RUNTIME_PREFIX = '.omo-ide-runtime-';
const createdRuntimeDirs = new Set();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const safeContentPath = value => typeof value === 'string' && value.length < 4096 && !value.startsWith('/') && !/[\\\x00-\x1f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'));

function canonicalRegular(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) throw Error('IDE plugin tree contains an unsafe file');
    return stat;
}
function canonicalDirectory(dir) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== path.resolve(dir)) throw Error('IDE plugin tree contains an unsafe directory');
    return stat;
}
function expectedDirectories(files) {
    const result = new Set();
    for (const name of files) {
        let parent = path.posix.dirname(name);
        while (parent !== '.') {
            result.add(parent);
            parent = path.posix.dirname(parent);
        }
    }
    return result;
}
function metadataFor(dir, manifest) {
    validateLock(manifest);
    const marker = path.join(dir, MARKER);
    canonicalRegular(marker);
    const bytes = fs.readFileSync(marker);
    const meta = JSON.parse(bytes.toString('utf8'));
    if (meta.version !== 2 || meta.lockSha256 !== digest(JSON.stringify(manifest)) || !meta.files || typeof meta.files !== 'object'
        || !meta.plugins || typeof meta.plugins !== 'object') throw Error('IDE plugin metadata is not the requested pinned bundle');
    const names = Object.keys(meta.files);
    if (!names.length || names.length > 100000 || !Object.keys(meta.plugins).length) throw Error('IDE plugin metadata is incomplete');
    for (const name of names) if (!safeContentPath(name) || !/^[a-f0-9]{64}$/.test(meta.files[name])) throw Error('IDE plugin metadata has an unsafe file');
    for (const id of Object.keys(meta.plugins)) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || !meta.files[id + '/package.json']) throw Error('IDE plugin metadata has an unsafe extension');
    return { bytes, meta, names, dirs: expectedDirectories(names) };
}
function inspectTree(dir, manifest, expectedMarker) {
    try {
        canonicalDirectory(dir);
        const metadata = metadataFor(dir, manifest);
        if (expectedMarker && digest(metadata.bytes) !== digest(expectedMarker)) throw Error('Copied IDE plugin metadata changed');
        const actualFiles = new Set();
        const actualDirs = new Set();
        let entries = 0;
        const maxEntries = metadata.names.length + metadata.dirs.size + 1;
        const visit = (current, relative) => {
            canonicalDirectory(current);
            if (relative) actualDirs.add(relative);
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (++entries > maxEntries) throw Error('Copied IDE plugin tree has unknown entries');
                const child = path.join(current, entry.name);
                const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
                const stat = fs.lstatSync(child);
                if (stat.isSymbolicLink()) throw Error('Copied IDE plugin tree contains a symlink');
                if (stat.isDirectory()) visit(child, childRelative);
                else if (stat.isFile()) {
                    if (childRelative !== MARKER && !safeContentPath(childRelative)) throw Error('Copied IDE plugin tree contains an unknown file');
                    if (childRelative !== MARKER) actualFiles.add(childRelative);
                    canonicalRegular(child);
                } else throw Error('Copied IDE plugin tree contains a special file');
            }
        };
        visit(dir, '');
        if (actualFiles.size !== metadata.names.length || metadata.names.some(name => !actualFiles.has(name))
            || actualDirs.size !== metadata.dirs.size || [...metadata.dirs].some(name => !actualDirs.has(name))) throw Error('Copied IDE plugin tree has unknown files or directories');
        for (const name of metadata.names) {
            const file = path.join(dir, name);
            const stat = canonicalRegular(file);
            if (stat.size > 100000000 || digest(fs.readFileSync(file)) !== metadata.meta.files[name]) throw Error('Copied IDE plugin file checksum mismatch');
        }
        return { ready: true, files: metadata.names.length, extensions: Object.keys(metadata.meta.plugins).length };
    } catch (error) {
        return { ready: false, reason: error?.message || 'Copied IDE plugin tree is not verified' };
    }
}
function ensureConfigDir(configDir) {
    if (typeof configDir !== 'string' || !configDir) throw Error('THEIA_CONFIG_DIR must be a non-empty path');
    const absolute = path.resolve(configDir);
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    canonicalDirectory(absolute);
    return absolute;
}
function sameOwner(stat) {
    return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}
function safeOwnedTree(dir) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameOwner(stat) || fs.realpathSync(dir) !== path.resolve(dir)) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        const childStat = fs.lstatSync(child);
        if (childStat.isSymbolicLink() || !sameOwner(childStat) || fs.realpathSync(child) !== path.resolve(child)) return false;
        if (childStat.isDirectory() && !safeOwnedTree(child)) return false;
        if (!childStat.isDirectory() && !childStat.isFile()) return false;
    }
    return true;
}
function cleanupPrivatePluginDir(pluginDir) {
    const absolute = path.resolve(pluginDir);
    if (!createdRuntimeDirs.has(absolute)) return false;
    try { fs.lstatSync(absolute); } catch (error) { if (error?.code === 'ENOENT') { createdRuntimeDirs.delete(absolute); return true; } return false; }
    let safe = false;
    try { safe = safeOwnedTree(absolute); } catch { return false; }
    if (!safe) return false;
    try {
        fs.rmSync(absolute, { recursive: true, force: false });
        createdRuntimeDirs.delete(absolute);
        return true;
    } catch { return false; }
}
function createPrivatePluginCopy(appRoot, configDir, manifest) {
    const sourceRoot = path.resolve(appRoot);
    const source = path.join(sourceRoot, 'plugins');
    const sourceResult = inspectPrepared(sourceRoot, manifest);
    if (!sourceResult.ready) throw Error(sourceResult.reason || 'Pinned IDE extension bundle is not verified');
    canonicalDirectory(source);
    const sourceMetadata = metadataFor(source, manifest);
    const config = ensureConfigDir(configDir);
    const target = fs.mkdtempSync(path.join(config, RUNTIME_PREFIX));
    createdRuntimeDirs.add(path.resolve(target));
    try {
        fs.chmodSync(target, 0o700);
        fs.copyFileSync(path.join(source, MARKER), path.join(target, MARKER), fs.constants.COPYFILE_EXCL);
        for (const name of sourceMetadata.names.sort()) {
            const sourceFile = path.join(source, name);
            const sourceStat = canonicalRegular(sourceFile);
            const destination = path.join(target, name);
            const parent = path.dirname(destination);
            if (!fs.existsSync(parent)) {
                const missing = [];
                for (let current = parent; current !== target && !fs.existsSync(current); current = path.dirname(current)) missing.push(current);
                for (const dir of missing.reverse()) fs.mkdirSync(dir, { mode: 0o755 });
            }
            canonicalDirectory(parent);
            fs.copyFileSync(sourceFile, destination, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(destination, sourceStat.mode & 0o777);
        }
        const checked = inspectTree(target, manifest, sourceMetadata.bytes);
        if (!checked.ready) throw Error(checked.reason || 'Fresh IDE plugin runtime copy failed verification');
        return { pluginDir: target, sourceDir: source, files: checked.files, extensions: checked.extensions };
    } catch (error) {
        cleanupPrivatePluginDir(target);
        throw error;
    }
}
function verifyPrivatePluginCopy(pluginDir, manifest) { return inspectTree(path.resolve(pluginDir), manifest); }
module.exports = { createPrivatePluginCopy, verifyPrivatePluginCopy, cleanupPrivatePluginDir };
