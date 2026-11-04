const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '../..');
const script = path.join(ROOT, 'scripts/doctor.cjs');
function doctor() {
    assert.ok(fs.existsSync(script), 'Read-only setup doctor is not implemented');
    return require(script);
}
function fixture() {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-doctor-'));
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    const marker = path.join(root, 'TOOLS_MUST_NOT_RUN');
    for (const dir of [bin, home, path.join(root, 'extension'), path.join(root, 'runtime'), path.join(root, 'browser-app/lib/backend')]) fs.mkdirSync(dir, { recursive: true });
    // The real discovery code and dependencies are read-only; no fake discovery results.
    fs.symlinkSync(path.join(ROOT, 'extension/lib'), path.join(root, 'extension/lib'), 'dir');
    fs.writeFileSync(path.join(root, 'runtime/omo_spatial_host.py'), '# Owned host fixture; never executed\n');
    fs.writeFileSync(path.join(root, 'browser-app/lib/backend/main.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
    for (const name of ['bash', 'python3', 'tmux', 'git', 'chrome', 'hermes', 'claude', 'codex']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
    const env = { PATH: bin, HOME: home, OMO_SPATIAL_DATA: path.join(root, 'data'), OMO_SPATIAL_TMUX_SOCKET: 'omo-doctor-owned', OMO_SPATIAL_TMUX: path.join(bin, 'tmux'), OMO_SPATIAL_PYTHON: path.join(bin, 'python3'), OMO_SPATIAL_HOST_SCRIPT: path.join(root, 'runtime/omo_spatial_host.py'), OMO_SPATIAL_CHROME: path.join(bin, 'chrome'), OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex'), SOME_API_KEY: 'DOCTOR_MUST_NOT_DISCLOSE_THIS_VALUE' };
    return { root, bin, home, marker, env, options: { root, home, env, nodeVersion: '22.23.4', platform: 'linux' }, dispose() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test('setup doctor finds real filesystem prerequisites without running tools or exposing environment secrets', () => {
    const f = fixture();
    try {
        const report = doctor().collectReport(f.options);
        assert.equal(report.prerequisitesFound, true);
        for (const id of ['node', 'build', 'runtime', 'tmux', 'python', 'bash', 'git', 'chrome', 'hermes', 'claude', 'codex']) assert.equal(report.checks.find(check => check.id === id)?.status, 'ok', id);
        assert.equal(fs.existsSync(f.marker), false, 'No fixture program or app may execute');
        assert.equal(fs.existsSync(path.join(f.root, 'data')), false, 'The doctor must not create runtime state');
        assert.equal(JSON.stringify(report).includes(f.env.SOME_API_KEY), false);
        assert.match(report.limitations.join(' '), /authenticat/i);
        assert.match(report.limitations.join(' '), /sandbox/i);
    } finally { f.dispose(); }
});

test('missing core tools fail; missing optional agents do not block shells', () => {
    const f = fixture();
    try {
        const { collectReport } = doctor();
        for (const kind of ['hermes', 'claude', 'codex', 'chrome']) fs.unlinkSync(path.join(f.bin, kind));
        let report = collectReport(f.options);
        assert.equal(report.prerequisitesFound, true);
        for (const id of ['hermes', 'claude', 'codex', 'chrome']) assert.equal(report.checks.find(c => c.id === id).status, 'warning');
        fs.unlinkSync(path.join(f.bin, 'python3'));
        report = collectReport(f.options);
        assert.equal(report.prerequisitesFound, false);
        assert.equal(report.checks.find(c => c.id === 'python').status, 'missing');
        assert.match(report.checks.find(c => c.id === 'python').fix, /OMO_SPATIAL_PYTHON/);
        fs.unlinkSync(path.join(f.root, 'browser-app/lib/backend/main.js'));
        report = collectReport(f.options);
        assert.equal(report.checks.find(c => c.id === 'build').status, 'missing');
        assert.equal(collectReport({ ...f.options, nodeVersion: '20.1.0' }).checks.find(c => c.id === 'node').status, 'missing');
        assert.equal(fs.existsSync(f.marker), false);
    } finally { f.dispose(); }
});

test('fresh unbuilt checkout reports failures without creating files', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-doctor-empty-'));
    try {
        const report = doctor().collectReport({ root, home: root, env: { PATH: '' }, platform: 'linux', nodeVersion: '22.23.4' });
        assert.equal(report.prerequisitesFound, false);
        assert.equal(report.checks.find(c => c.id === 'build').status, 'missing');
        assert.equal(report.checks.find(c => c.id === 'runtime').status, 'missing');
        assert.deepEqual(fs.readdirSync(root), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unsafe runtime settings fail without echoing their value into the report', () => {
    const f = fixture();
    try {
        const unsafe = '../DOCTOR_PRIVATE_VALUE_DO_NOT_ECHO';
        const report = doctor().collectReport({ ...f.options, env: { ...f.env, OMO_SPATIAL_TMUX_SOCKET: unsafe } });
        assert.equal(report.prerequisitesFound, false);
        assert.equal(report.checks.find(c => c.id === 'runtime').status, 'missing');
        assert.equal(JSON.stringify(report).includes(unsafe), false, 'Invalid config values must not be printed');
    } finally { f.dispose(); }
});

test('doctor rejects canonical aliases of the Minecraft data directory without creating data', () => {
    const f = fixture();
    try {
        const legacy = path.join(f.home, '.local', 'share', 'omo');
        fs.mkdirSync(legacy, { recursive: true });
        const cases = [];
        const alias = path.join(f.root, 'minecraft-alias');
        fs.symlinkSync(legacy, alias, 'dir');
        cases.push(alias);
        const parentAlias = path.join(f.root, 'minecraft-parent-alias');
        fs.symlinkSync(path.dirname(legacy), parentAlias, 'dir');
        cases.push(path.join(parentAlias, path.basename(legacy)));
        for (const data of cases) {
            const report = doctor().collectReport({ ...f.options, env: { ...f.env, OMO_SPATIAL_DATA: data } });
            assert.equal(report.prerequisitesFound, false, data);
            assert.equal(report.checks.find(c => c.id === 'runtime').status, 'missing', data);
            assert.equal(JSON.stringify(report).includes(data), false, 'Reserved data paths must not be disclosed');
        }
        const fresh = path.join(f.root, 'new-parent', 'new-data');
        const freshReport = doctor().collectReport({ ...f.options, env: { ...f.env, OMO_SPATIAL_DATA: fresh } });
        assert.equal(freshReport.checks.find(c => c.id === 'runtime').status, 'ok');
        assert.equal(fs.existsSync(fresh), false, 'Canonical checking must not create normal data dirs');
    } finally { f.dispose(); }
});

test('doctor fails closed for dangling and looping data symlinks', () => {
    const f = fixture();
    try {
        const dangling = path.join(f.root, 'dangling-data');
        fs.symlinkSync(path.join(f.root, 'missing-target'), dangling, 'dir');
        const loopA = path.join(f.root, 'loop-a');
        const loopB = path.join(f.root, 'loop-b');
        fs.symlinkSync(loopB, loopA, 'dir');
        fs.symlinkSync(loopA, loopB, 'dir');
        for (const data of [dangling, loopA]) {
            const report = doctor().collectReport({ ...f.options, env: { ...f.env, OMO_SPATIAL_DATA: data } });
            assert.equal(report.prerequisitesFound, false, data);
            assert.equal(report.checks.find(c => c.id === 'runtime').status, 'missing', data);
            assert.match(report.checks.find(c => c.id === 'runtime').detail, /cannot be resolved safely/i);
            assert.equal(JSON.stringify(report).includes(data), false, 'Unresolvable data paths must not be disclosed');
        }
    } finally { f.dispose(); }
});

test('agent discovery resolves runtime-relative pins and PATH entries without fallback', () => {
    const f = fixture();
    try {
        const dataDir = path.join(f.root, 'data');
        const relativeBin = path.join(dataDir, 'relative-bin');
        fs.mkdirSync(relativeBin, { recursive: true });
        fs.writeFileSync(path.join(relativeBin, 'hermes'), '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(path.join(relativeBin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(path.join(relativeBin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
        const relativeEnv = { ...f.env, OMO_SPATIAL_DATA: dataDir, OMO_SPATIAL_HERMES_BIN: './relative-bin/hermes', OMO_SPATIAL_CLAUDE_BIN: './relative-bin/claude', OMO_SPATIAL_CODEX_BIN: './relative-bin/codex' };
        let report = doctor().collectReport({ ...f.options, env: relativeEnv });
        for (const kind of ['hermes', 'claude', 'codex']) {
            const check = report.checks.find(c => c.id === kind);
            assert.equal(check.status, 'ok', kind);
            assert.match(check.detail, new RegExp(`${kind}\\)? \\(`));
            assert.ok(check.detail.includes(path.join(dataDir, 'relative-bin', kind)), kind);
        }

        for (const kind of ['hermes', 'claude', 'codex']) fs.unlinkSync(path.join(f.bin, kind));
        const pathData = path.join(f.root, 'path-data');
        const pathRelativeBin = path.join(pathData, 'agent-bin');
        fs.mkdirSync(pathRelativeBin, { recursive: true });
        for (const kind of ['hermes', 'claude', 'codex']) fs.writeFileSync(path.join(pathRelativeBin, kind), '#!/bin/sh\n', { mode: 0o755 });
        const pathEnv = { ...f.env, OMO_SPATIAL_DATA: pathData, OMO_SPATIAL_HERMES_BIN: undefined, OMO_SPATIAL_CLAUDE_BIN: undefined, OMO_SPATIAL_CODEX_BIN: undefined, PATH: `${f.bin}${path.delimiter}agent-bin` };
        report = doctor().collectReport({ ...f.options, env: pathEnv });
        for (const kind of ['hermes', 'claude', 'codex']) assert.equal(report.checks.find(c => c.id === kind).status, 'ok', kind);

        const emptyPathData = path.join(f.root, 'empty-path-data');
        fs.mkdirSync(emptyPathData, { recursive: true });
        for (const kind of ['hermes', 'claude', 'codex']) fs.writeFileSync(path.join(emptyPathData, kind), '#!/bin/sh\n', { mode: 0o755 });
        const emptyPathEnv = { ...f.env, OMO_SPATIAL_DATA: emptyPathData, OMO_SPATIAL_HERMES_BIN: undefined, OMO_SPATIAL_CLAUDE_BIN: undefined, OMO_SPATIAL_CODEX_BIN: undefined, PATH: `${f.bin}${path.delimiter}` };
        report = doctor().collectReport({ ...f.options, env: emptyPathEnv });
        for (const kind of ['hermes', 'claude', 'codex']) assert.equal(report.checks.find(c => c.id === kind).status, 'ok', kind);

        report = doctor().collectReport({ ...f.options, env: { ...f.env, OMO_SPATIAL_DATA: dataDir, OMO_SPATIAL_CLAUDE_BIN: './missing/claude' } });
        assert.equal(report.checks.find(c => c.id === 'claude').status, 'warning');

        // Python shutil.which treats a wholly empty PATH as no search, not as
        // an empty component in a nonempty PATH. An unset PATH uses os.defpath.
        const onlyHere = `doctor-only-${path.basename(f.root)}`;
        fs.writeFileSync(path.join(emptyPathData, onlyHere), '#!/bin/sh\n', { mode: 0o755 });
        for (const value of ['', undefined]) {
            report = doctor().collectReport({ ...f.options, env: { ...f.env, OMO_SPATIAL_DATA: emptyPathData, PATH: value, OMO_SPATIAL_HERMES_BIN: onlyHere } });
            assert.equal(report.checks.find(c => c.id === 'hermes').status, 'warning', `No runtime-cwd search for ${String(value)} PATH`);
        }
        const external = path.join(f.root, 'outside');
        fs.mkdirSync(path.join(external, 'child'), { recursive: true });
        fs.writeFileSync(path.join(external, 'linked-agent'), '#!/bin/sh\n', { mode: 0o755 });
        fs.symlinkSync(path.join(external, 'child'), path.join(dataDir, 'linked'), 'dir');
        for (const extra of [
            { OMO_SPATIAL_CLAUDE_BIN: './linked/../linked-agent' },
            { OMO_SPATIAL_CLAUDE_BIN: 'linked-agent', PATH: 'linked/..' }
        ]) {
            report = doctor().collectReport({ ...f.options, env: { ...f.env, OMO_SPATIAL_DATA: dataDir, ...extra } });
            assert.equal(report.checks.find(c => c.id === 'claude').status, 'ok', 'Filesystem symlink/.. resolution must not be replaced with lexical normalisation');
        }
        assert.equal(fs.existsSync(f.marker), false);
    } finally { f.dispose(); }
});

test('CLI JSON is parseable and statuses propagate to the real process exit code', () => {
    const f = fixture();
    try {
        const { spawnSync } = require('node:child_process');
        const ownedScript = path.join(f.root, 'scripts/doctor.cjs');
        fs.mkdirSync(path.dirname(ownedScript), { recursive: true });
        fs.copyFileSync(script, ownedScript);
        // CI runs source tests before the real Theia bundle exists. The CLI must use
        // this test's owned build marker, not depend on the developer's built app.
        const run = (args, env = f.env) => spawnSync(process.execPath, [ownedScript, ...args], { env, encoding: 'utf8', timeout: 5000 });
        let result = run(['--json']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).prerequisitesFound, true);
        assert.equal(result.stdout.includes(f.env.SOME_API_KEY), false);
        result = run(['--json'], { ...f.env, OMO_SPATIAL_TMUX: path.join(f.bin, 'missing-tmux') });
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(result.stdout).checks.find(c => c.id === 'tmux').status, 'missing');
        assert.equal(run(['--install']).status, 2);
        assert.equal(run(['--help']).status, 0);
        assert.equal(fs.existsSync(f.marker), false);
    } finally { f.dispose(); }
});
