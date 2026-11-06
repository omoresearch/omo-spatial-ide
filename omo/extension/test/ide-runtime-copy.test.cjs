const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareIde, inspectPrepared } = require('../../scripts/prepare-ide.cjs');
const {
    createPrivatePluginCopy,
    cleanupPrivatePluginDir,
    verifyPrivatePluginCopy,
} = require('../../scripts/runtime-ide-plugins.cjs');

function fixture() {
    const packed = spawnSync(process.env.PYTHON || 'python3', ['-c', `import io,zipfile,json,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('extension/package.json',json.dumps({'publisher':'ms-python','name':'debugpy','version':'1.0.0','engines':{'vscode':'^1.90.0'}}))
 z.writestr('extension/README.md','Owned inert debugger fixture')
sys.stdout.buffer.write(b.getvalue())
`]);
    assert.equal(packed.status, 0, packed.stderr.toString());
    const bytes = packed.stdout;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ide-runtime-'));
    const config = path.join(root, 'theia-config');
    const manifest = {
        version: 1,
        vscodeApi: '1.108.2',
        exclude: [],
        assets: [{
            id: 'ms-python.debugpy', version: '1.0.0', format: 'vsix',
            url: 'https://open-vsx.org/api/ms-python/debugpy/1.0.0/file/debugpy.vsix',
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'), maxBytes: bytes.length + 1,
        }],
    };
    return { root, config, manifest, bytes, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('private runtime copy is separate, writable for debugger IPC, and leaves source immutable', async () => {
    const f = fixture();
    try {
        await prepareIde(f.root, f.manifest, async () => f.bytes);
        const source = path.join(f.root, 'plugins');
        const runtime = createPrivatePluginCopy(f.root, f.config, f.manifest);
        assert.notEqual(runtime.pluginDir, source);
        assert.ok(runtime.pluginDir.startsWith(f.config + path.sep));
        assert.equal(verifyPrivatePluginCopy(runtime.pluginDir, f.manifest).ready, true);

        const ipcDir = path.join(runtime.pluginDir, 'ms-python.debugpy', '.noConfigDebugAdapterEndpoints');
        fs.mkdirSync(ipcDir, { recursive: true });
        fs.writeFileSync(path.join(ipcDir, 'endpoint.json'), '{}');
        assert.equal(inspectPrepared(f.root, f.manifest).ready, true);
        assert.equal(fs.existsSync(path.join(source, 'ms-python.debugpy', '.noConfigDebugAdapterEndpoints')), false);
    } finally { f.dispose(); }
});

test('each boot receives a new clean private copy and cleanup preserves Theia state and adjacent dirs', async () => {
    const f = fixture();
    try {
        await prepareIde(f.root, f.manifest, async () => f.bytes);
        const userExtensions = path.join(f.config, 'extensions');
        const globalStorage = path.join(f.config, 'globalStorage');
        const adjacent = path.join(f.config, 'keep-adjacent');
        fs.mkdirSync(userExtensions, { recursive: true });
        fs.mkdirSync(globalStorage, { recursive: true });
        fs.mkdirSync(adjacent, { recursive: true });
        fs.writeFileSync(path.join(adjacent, 'keep.txt'), 'keep');

        const first = createPrivatePluginCopy(f.root, f.config, f.manifest);
        fs.mkdirSync(path.join(first.pluginDir, 'ms-python.debugpy', '.noConfigDebugAdapterEndpoints'), { recursive: true });
        fs.writeFileSync(path.join(first.pluginDir, 'ms-python.debugpy', '.noConfigDebugAdapterEndpoints', 'old.json'), '{}');
        const second = createPrivatePluginCopy(f.root, f.config, f.manifest);
        assert.notEqual(first.pluginDir, second.pluginDir);
        assert.equal(fs.existsSync(path.join(second.pluginDir, 'ms-python.debugpy', '.noConfigDebugAdapterEndpoints')), false);

        cleanupPrivatePluginDir(first.pluginDir);
        cleanupPrivatePluginDir(second.pluginDir);
        assert.equal(fs.existsSync(first.pluginDir), false);
        assert.equal(fs.existsSync(second.pluginDir), false);
        assert.equal(fs.existsSync(userExtensions), true);
        assert.equal(fs.existsSync(globalStorage), true);
        assert.equal(fs.existsSync(adjacent), true);
        assert.equal(fs.readFileSync(path.join(adjacent, 'keep.txt'), 'utf8'), 'keep');
    } finally { f.dispose(); }
});

test('unknown source files prevent a private launch copy and do not create runtime state', async () => {
    const f = fixture();
    try {
        await prepareIde(f.root, f.manifest, async () => f.bytes);
        fs.writeFileSync(path.join(f.root, 'plugins', 'unknown-source.txt'), 'unsafe');
        assert.throws(() => createPrivatePluginCopy(f.root, f.config, f.manifest), /bundle|changed|incomplete/i);
        assert.equal(fs.existsSync(f.config), false);
    } finally { f.dispose(); }
});

test('cleanup leaves an unsafe changed-owner runtime directory untouched', async () => {
    const f = fixture();
    try {
        await prepareIde(f.root, f.manifest, async () => f.bytes);
        const runtime = createPrivatePluginCopy(f.root, f.config, f.manifest);
        const adjacent = path.join(f.config, 'keep-adjacent');
        fs.mkdirSync(adjacent);
        fs.writeFileSync(path.join(runtime.pluginDir, 'marker'), 'do not traverse');
        let ownershipChanged = false;
        if (typeof process.getuid === 'function' && process.getuid() !== 0) {
            try {
                fs.chownSync(runtime.pluginDir, process.getuid() + 1, process.getgid());
                ownershipChanged = true;
            } catch { /* The test runner may not have chown permission. */ }
        }
        cleanupPrivatePluginDir(runtime.pluginDir);
        assert.equal(fs.existsSync(runtime.pluginDir), ownershipChanged);
        assert.equal(fs.existsSync(adjacent), true);
    } finally { f.dispose(); }
});
