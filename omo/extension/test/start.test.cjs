const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { options } = require('../../scripts/start.cjs');

test('portable launcher uses the real bundled project without a developer-specific path', () => {
    const result = options([], {});
    assert.equal(result.workspace, path.resolve(__dirname, '../../demo-project'));
    assert.equal(result.port, '3190');
});
test('launcher accepts a chosen existing workspace and explicit port without shell parsing', () => {
    const result = options(['--workspace', __dirname, '--port', '03200'], {});
    assert.equal(result.workspace, __dirname);
    assert.equal(result.port, '3200');
    assert.equal(options([], { OMO_SPATIAL_PORT: '3201' }).port, '3201');
});
test('launcher rejects invalid ports, non-directories, network-bind overrides and incomplete flags', () => {
    for (const port of ['0', '65536', '-1', '31.5', '3190;echo injected']) assert.throws(() => options(['--port', port], {}));
    assert.throws(() => options(['--workspace', __filename], {}), /existing directory/);
    for (const args of [['--workspace'], ['--port'], ['--hostname', '0.0.0.0'], ['--public']]) assert.throws(() => options(args, {}), /option/);
});
test('launcher help is executable and invalid options fail with a real nonzero exit', () => {
    const launcher = path.resolve(__dirname, '../../scripts/start.cjs');
    const help = spawnSync(process.execPath, [launcher, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /127\.0\.0\.1/);
    const invalid = spawnSync(process.execPath, [launcher, '--hostname', '0.0.0.0'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Unknown or incomplete option/);
});
