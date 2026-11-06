const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateLock, verifyAsset, inspectPrepared, prepareIde } = require('../../scripts/prepare-ide.cjs');
const packed = spawnSync('python3', ['-c', `import io,zipfile,json,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n z.writestr('extension/package.json',json.dumps({'publisher':'fixture','name':'extension','version':'1.0.0','engines':{'vscode':'^1.90.0'}}))\n z.writestr('extension/README.md','Owned inert extension fixture')\nsys.stdout.buffer.write(b.getvalue())\n`]);
assert.equal(packed.status, 0);
const data = packed.stdout;
const sha = crypto.createHash('sha256').update(data).digest('hex');
const asset = { id: 'fixture.extension', version: '1.0.0', format: 'vsix', url: 'https://open-vsx.org/api/fixture/extension/1.0.0/file/fixture.extension-1.0.0.vsix', sha256: sha, maxBytes: 1000 };
const manifest = () => ({ version: 1, vscodeApi: '1.108.2', exclude: [], assets: [{ ...asset }] });
test('extension lock accepts only pinned bounded HTTPS artifacts from known registries', () => {
    assert.equal(validateLock(manifest()).assets[0].sha256, sha);
    for (const patch of [{ sha256: 'bad' }, { maxBytes: 0 }, { maxBytes: 100000001 }, { id: '../escape' }, { url: 'http://open-vsx.org/archive' }, { url: 'https://user:secret@open-vsx.org/archive' }, { url: 'https://localhost/archive' }, { format: 'executable' }]) {
        const value = manifest(); Object.assign(value.assets[0], patch);
        assert.throws(() => validateLock(value));
    }
    const duplicate = manifest(); duplicate.assets.push({ ...asset });
    assert.throws(() => validateLock(duplicate));
});
test('artifact verification refuses changed or oversized bytes before extraction', () => {
    assert.equal(verifyAsset(data, asset), true);
    assert.throws(() => verifyAsset(Buffer.from('different'), asset), /checksum/i);
    assert.throws(() => verifyAsset(data, { ...asset, maxBytes: 1 }), /limit|large/i);
});
test('offline readiness inspection does not create directories or download anything', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ide-inspect-'));
    try {
        const before = fs.readdirSync(dir);
        const result = inspectPrepared(dir, manifest());
        assert.equal(result.ready, false);
        assert.deepEqual(fs.readdirSync(dir), before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('official Eclipse artifact redirects work but private-host redirects never receive a request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ide-redirect-'));
    const original = global.fetch;
    const calls = [];
    try {
        global.fetch = async url => {
            calls.push(new URL(url).hostname);
            return calls.length === 1
                ? new Response(null, { status: 302, headers: { location: 'https://openvsx.eclipsecontent.org/fixture.vsix' } })
                : new Response(data, { status: 200 });
        };
        const result = await prepareIde(dir, manifest());
        assert.equal(result.ready, true);
        assert.deepEqual(calls, ['open-vsx.org', 'openvsx.eclipsecontent.org']);
        assert.equal(inspectPrepared(dir, manifest()).ready, true);
    } finally { global.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); }
    const denied = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ide-denied-'));
    try {
        calls.length = 0;
        global.fetch = async url => { calls.push(new URL(url).hostname); return new Response(null, { status: 302, headers: { location: 'https://localhost/private' } }); };
        await assert.rejects(() => prepareIde(denied, manifest()), /redirect refused/i);
        assert.deepEqual(calls, ['open-vsx.org']);
        assert.equal(fs.existsSync(path.join(denied, 'plugins')), false);
    } finally { global.fetch = original; fs.rmSync(denied, { recursive: true, force: true }); }
});
test('system plugins are expanded to manifest-root directories rather than unusable VSIX files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ide-system-'));
    try {
        await prepareIde(dir, manifest(), async () => data);
        assert.ok(fs.existsSync(path.join(dir, 'plugins/fixture.extension/package.json')), 'Theia system plugin resolver requires an expanded package directory');
        assert.equal(fs.readdirSync(path.join(dir, 'plugins')).some(name => name.endsWith('.vsix')), false);
        assert.equal(inspectPrepared(dir, manifest()).ready, true);
        fs.writeFileSync(path.join(dir, 'plugins/fixture.extension/README.md'), 'changed');
        assert.equal(inspectPrepared(dir, manifest()).ready, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('prepared bundle rejects unknown files, directories, nested content, special files and symlinks without writes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ide-enumeration-'));
    const fetchAsset = async () => data;
    try {
        await prepareIde(dir, manifest(), fetchAsset);
        const plugins = path.join(dir, 'plugins');
        const before = () => JSON.stringify(fs.readdirSync(plugins, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()]));
        const readme = path.join(plugins, 'fixture.extension', 'README.md');
        const readmeContents = fs.readFileSync(readme);
        fs.rmSync(readme);
        assert.equal(inspectPrepared(dir, manifest()).ready, false, 'missing listed file must fail');
        fs.writeFileSync(readme, readmeContents);
        assert.equal(inspectPrepared(dir, manifest()).ready, true, 'restored listed file must pass');
        fs.writeFileSync(path.join(plugins, 'extra.txt'), 'unknown');
        assert.equal(inspectPrepared(dir, manifest()).ready, false, 'unknown file must fail');
        const beforePrepare = before();
        await assert.rejects(() => prepareIde(dir, manifest(), async () => { throw new Error('must not download'); }), /existing IDE bundle/i);
        assert.equal(before(), beforePrepare, 'rejected existing bundle must not be changed');
        fs.rmSync(path.join(plugins, 'extra.txt'));

        fs.mkdirSync(path.join(plugins, 'unknown-directory'));
        assert.equal(inspectPrepared(dir, manifest()).ready, false, 'unknown empty directory must fail');
        fs.rmSync(path.join(plugins, 'unknown-directory'), { recursive: true });

        fs.mkdirSync(path.join(plugins, 'unknown-directory'));
        fs.writeFileSync(path.join(plugins, 'unknown-directory', 'nested.txt'), 'unknown nested content');
        assert.equal(inspectPrepared(dir, manifest()).ready, false, 'unknown nested content must fail');
        fs.rmSync(path.join(plugins, 'unknown-directory'), { recursive: true });

        fs.symlinkSync(path.join(plugins, 'fixture.extension', 'package.json'), path.join(plugins, 'unknown-link'));
        assert.equal(inspectPrepared(dir, manifest()).ready, false, 'symlink must fail');
        fs.rmSync(path.join(plugins, 'unknown-link'));

        spawnSync('python3', ['-c', 'import os,sys; os.mkfifo(sys.argv[1])', path.join(plugins, 'unknown-fifo')]);
        assert.equal(inspectPrepared(dir, manifest()).ready, false, 'special file must fail');
        fs.rmSync(path.join(plugins, 'unknown-fifo'));

        assert.equal(inspectPrepared(dir, manifest()).ready, true, 'restored owned fixture must pass');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('VSIX absolute paths hidden behind a doubled separator are refused before any member is written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ide-vsix-path-'));
    try {
        const escape = path.join(dir, 'escape.txt');
        const packedBad = spawnSync('python3', ['-c', `import io,zipfile,json,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n z.writestr('extension/package.json',json.dumps({'publisher':'fixture','name':'extension','version':'1.0.0'}))\n z.writestr('extension/'+sys.argv[1],'must not escape staging')\nsys.stdout.buffer.write(b.getvalue())\n`, escape]);
        assert.equal(packedBad.status, 0);
        const value = manifest(); value.assets[0].sha256 = crypto.createHash('sha256').update(packedBad.stdout).digest('hex');
        await assert.rejects(() => prepareIde(dir, value, async () => packedBad.stdout));
        assert.equal(fs.existsSync(escape), false);
        assert.equal(fs.existsSync(path.join(dir, 'plugins')), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('archive helper rejects path traversal and links without writing outside its target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ide-archive-'));
    try {
        const result = spawnSync('python3', ['-c', `import tarfile,io,sys\np=sys.argv[1]\nwith tarfile.open(p,'w:gz') as t:\n m=tarfile.TarInfo('../escape.vsix');m.size=1;t.addfile(m,io.BytesIO(b'x'))\n`, path.join(dir, 'bad.tar.gz')]);
        assert.equal(result.status, 0);
        const extract = spawnSync('python3', [path.resolve(__dirname, '../../scripts/ide-archive.py'), path.join(dir, 'bad.tar.gz'), path.join(dir, 'target'), '[]'], { encoding: 'utf8' });
        assert.notEqual(extract.status, 0);
        assert.equal(fs.existsSync(path.join(dir, 'escape.vsix')), false);
        assert.equal(fs.existsSync(path.join(dir, 'target')), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
