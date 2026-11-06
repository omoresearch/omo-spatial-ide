const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { backendArguments, applicationEnvironment } = require('../../scripts/start.cjs');
test('normal startup uses only this bundle and keeps explicit controls, not arbitrary parent env', () => {
    const args = backendArguments({ workspace: '/owned/project', port: '3199' });
    assert.equal(args.filter(arg => arg.startsWith('--plugins=')).length, 1);
    assert.ok(args.some(arg => arg.startsWith('--plugins=local-dir:') && arg.endsWith('/omo/plugins')));
    const source = {
        PATH: '/owned/bin',
        HOME: '/owned/home',
        THEIA_CONFIG_DIR: '/owned/config',
        OMO_SPATIAL_DATA: '/owned/data',
        OMO_SPATIAL_TMUX_SOCKET: 'owned-socket',
        OMO_SPATIAL_TMUX: '/owned/bin/tmux',
        OMO_SPATIAL_PYTHON: '/owned/bin/python3',
        OMO_SPATIAL_HOST_SCRIPT: '/owned/runtime/host.py',
        OMO_SPATIAL_CHROME: '/owned/bin/chrome',
        CHROME_PATH: '/owned/bin/chrome',
        OMO_SPATIAL_WEB_AUDIO: '1',
        OMO_SPATIAL_HERMES_ROOT: '/owned/hermes',
        OMO_SPATIAL_HERMES_BIN: '/owned/bin/hermes',
        OMO_SPATIAL_CLAUDE_BIN: '/owned/bin/claude',
        OMO_SPATIAL_CODEX_BIN: '/owned/bin/codex',
        OMO_SPATIAL_FAULT: 'fixture',
        HERMES_HOME: '/parent/hermes',
        OMO_DATA: '/parent/omo-data',
        OMO_TMUX_SOCKET: 'omo',
        OMO_TMUX: '/parent/tmux',
        TMUX: '/parent/tmux-client',
        OPENAI_API_KEY: 'inert-parent-key',
        NODE_OPTIONS: '--require=/parent/injected.js',
        PYTHONPATH: '/parent/python',
        SSH_AUTH_SOCK: '/parent/agent.sock',
        KEEP_THIS: 'unknown-parent-setting',
        THEIA_PLUGINS: 'private-parent',
        THEIA_DEFAULT_PLUGINS: 'private-parent',
        HERMES_SESSION_ID: 'parent'
    };
    const env = applicationEnvironment(source);
    assert.equal(env.PATH, source.PATH);
    assert.equal(env.HOME, source.HOME);
    assert.equal(env.THEIA_CONFIG_DIR, source.THEIA_CONFIG_DIR);
    assert.equal(env.CHROME_PATH, source.CHROME_PATH);
    for (const key of [
        'OMO_SPATIAL_DATA', 'OMO_SPATIAL_TMUX_SOCKET', 'OMO_SPATIAL_TMUX', 'OMO_SPATIAL_PYTHON',
        'OMO_SPATIAL_HOST_SCRIPT', 'OMO_SPATIAL_CHROME', 'OMO_SPATIAL_WEB_AUDIO', 'OMO_SPATIAL_HERMES_ROOT',
        'OMO_SPATIAL_HERMES_BIN', 'OMO_SPATIAL_CLAUDE_BIN', 'OMO_SPATIAL_CODEX_BIN', 'OMO_SPATIAL_FAULT'
    ]) assert.equal(env[key], source[key], `explicit application control ${key} must be preserved`);
    for (const key of [
        'HERMES_HOME', 'HERMES_SESSION_ID', 'OMO_DATA', 'OMO_TMUX_SOCKET', 'OMO_TMUX', 'TMUX', 'OPENAI_API_KEY',
        'NODE_OPTIONS', 'PYTHONPATH', 'SSH_AUTH_SOCK', 'KEEP_THIS', 'THEIA_PLUGINS', 'THEIA_DEFAULT_PLUGINS'
    ]) assert.equal(env[key], undefined, `parent-only setting ${key} must not cross the app boundary`);
    assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
});
test('the application includes a matched-version extension host, language tools and debugger', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'browser-app/package.json'), 'utf8'));
    for (const name of ['plugin-ext', 'plugin-ext-vscode', 'vsx-registry', 'debug', 'console', 'bulk-edit', 'callhierarchy', 'keymaps', 'outline-view', 'typehierarchy', 'userstorage', 'variable-resolver']) {
        assert.equal(pkg.dependencies['@theia/' + name], '1.74.3', 'Missing maintained IDE capability: ' + name);
    }
    assert.equal(pkg.dependencies['@theia/git'], undefined, 'Git must use the maintained builtin extension, not a nonexistent package version');
    assert.equal(pkg.theia.frontend.config.preferences['security.workspace.trust.enabled'], true);
});
