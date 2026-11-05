// Real Theia UI + real Git/JS/Python adapters; every agent executable remains a no-network fixture.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ownedAppFixture } = require('./owned-app-fixture.cjs');
const { openWorld, pause, ROOT } = require('./world-test-driver.cjs');
const checks = [];
async function until(predicate, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await pause(150); }
    throw Error('Timed out: ' + label);
}
(async () => {
    let app, ui;
    try {
        app = await ownedAppFixture('ide-tooling');
        process.env.OMO_URL = app.env.OMO_URL;
        const git = (...args) => {
            const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: app.project, encoding: 'utf8', timeout: 10000 });
            assert.equal(result.status, 0, result.stderr);
            return result.stdout.trim();
        };
        git('init', '-b', 'main');
        for (const [key, value] of [['user.name', 'Owned IDE QA'], ['user.email', 'ide-qa@example.invalid'], ['core.hooksPath', '/dev/null'], ['commit.gpgsign', 'false']]) git('config', key, value);
        fs.writeFileSync(path.join(app.project, 'answer.js'), 'module.exports = 41;\n');
        fs.writeFileSync(path.join(app.project, 'debug.js'), "const value = 42;\nrequire('node:fs').writeFileSync('debug-js-result.txt',String(value));\n");
        fs.writeFileSync(path.join(app.project, 'debug.py'), "value = 42\nwith open('debug-python-result.txt','w') as file:\n    file.write(str(value))\n");
        fs.mkdirSync(path.join(app.project, '.vscode'));
        fs.writeFileSync(path.join(app.project, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [
            { name: 'Owned JS breakpoint', type: 'pwa-node', request: 'launch', program: '${workspaceFolder}/debug.js', stopOnEntry: true, console: 'internalConsole' },
            { name: 'Owned Python breakpoint', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/debug.py', python: '/usr/bin/python3', stopOnEntry: true, console: 'internalConsole' }
        ] }));
        git('add', '.'); git('commit', '-m', 'Owned test baseline');
        const baseline = git('rev-parse', 'HEAD');
        ui = await openWorld('ide-tooling-browser');
        const page = ui.page;
        const input = 'input[aria-label="Type to narrow down results."]';
        async function shortcut(key, shift = false) {
            await page.keyboard.down('Control');
            if (shift) await page.keyboard.down('Shift');
            try { await page.keyboard.press(key); }
            finally { if (shift) await page.keyboard.up('Shift'); await page.keyboard.up('Control'); }
        }
        async function palette(label) {
            await page.keyboard.press('Escape'); await shortcut('KeyP', true);
            await page.waitForSelector(input, { visible: true }); await page.focus(input); await shortcut('KeyA');
            await page.keyboard.type('>' + label, { delay: 10 });
            await page.waitForFunction(label => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].some(row => row.textContent.includes(label) && row.getClientRects().length), {}, label);
            await page.keyboard.press('Enter');
        }
        fs.writeFileSync(path.join(app.project, 'answer.js'), 'module.exports = 42;\n');
        // Readiness: the built-in Git extension must have discovered the repository (branch in the status bar)
        // before its commands act; earlier the palette Enter could land before discovery and stage nothing.
        await until(() => page.evaluate(() => /\bmain\b/.test(document.querySelector('#theia-statusBar')?.innerText || '')), 'Git repository discovered', 60000);
        // Staging is idempotent: if the Git extension had not finished activating, issue the explicit command again.
        for (let attempt = 0; ; attempt++) {
            await palette('Git: Stage All Changes');
            try { await until(() => git('diff', '--cached', '--name-only') === 'answer.js', 'real Git stage', 8000); break; }
            catch (error) { if (attempt === 4) throw error; await pause(1500); }
        }
        assert.match(git('diff', '--cached'), /module\.exports = 42/);
        checks.push('Builtin Git provider stages the exact owned file through the real command palette');
        await shortcut('KeyG', true);
        await page.waitForSelector('textarea.theia-scm-input-message', { visible: true });
        await page.type('textarea.theia-scm-input-message', 'Owned IDE UI commit');
        await shortcut('Enter');
        await until(() => git('rev-parse', 'HEAD') !== baseline, 'SCM UI commit');
        assert.equal(git('log', '-1', '--format=%s'), 'Owned IDE UI commit');
        assert.equal(git('status', '--porcelain'), '');
        checks.push('Actual SCM message and commit action create the requested commit with a clean owned worktree');
        await page.keyboard.press('F5');
        await page.waitForFunction(() => document.body.innerText.includes('PAUSED ON BREAKPOINT') && document.body.innerText.includes('debug.js'));
        assert.equal(fs.existsSync(path.join(app.project, 'debug-js-result.txt')), false);
        checks.push('Real JavaScript debugger pauses before execution with the source call stack visible');
        await page.keyboard.press('F5');
        await until(() => fs.existsSync(path.join(app.project, 'debug-js-result.txt')), 'JavaScript debugger continue');
        assert.equal(fs.readFileSync(path.join(app.project, 'debug-js-result.txt'), 'utf8'), '42');
        await until(async () => fs.existsSync(path.join(app.project, 'debug-js-result.txt')) && await page.evaluate(() => {
            const session = [...document.querySelectorAll('.theia-debug-session')].find(element => element.textContent.includes('Owned JS breakpoint'));
            return !session || /\bStopped\b/.test(session.textContent);
        }), 'JavaScript debug session normal stop');
        checks.push('JavaScript continue executes the actual owned program');
        await palette('Debug: Select and Start Debugging');
        await page.waitForSelector(input, { visible: true }); await page.focus(input); await shortcut('KeyA');
        await page.keyboard.type('debug Owned Python breakpoint');
        const choice = await page.waitForFunction(() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find(row => row.textContent.includes('Owned Python breakpoint') && row.getClientRects().length));
        await choice.asElement().click();
        await page.waitForFunction(() => document.body.innerText.includes('PAUSED ON ENTRY') && document.body.innerText.includes('debug.py'));
        assert.equal(fs.existsSync(path.join(app.project, 'debug-python-result.txt')), false);
        checks.push('Real Python debugpy adapter pauses at entry with the source call stack visible');
        await page.keyboard.press('F5');
        await until(() => fs.existsSync(path.join(app.project, 'debug-python-result.txt')), 'Python debugger continue');
        assert.equal(fs.readFileSync(path.join(app.project, 'debug-python-result.txt'), 'utf8'), '42');
        checks.push('Python continue executes the actual owned program');
        assert.equal(fs.readFileSync(app.agentLog, 'utf8'), '');
        assert.equal(git('remote'), '');
        checks.push('All agent recorder logs stay empty; no real agent is launched and no Git remote is configured');
        const report = { passed: true, checks, checkCount: checks.length, agentLaunches: 0 };
        fs.writeFileSync(path.join(ROOT, 'evidence/ide-tooling-real-app.json'), JSON.stringify(report, null, 2));
        for (const check of checks) console.log('PASS: ' + check);
    } catch (error) {
        if (ui) fs.writeFileSync(path.join(ROOT, 'evidence/ide-tooling-failed.txt'), await ui.page.evaluate(() => document.body.innerText).catch(() => 'Page unavailable'));
        fs.writeFileSync(path.join(ROOT, 'evidence/ide-tooling-real-app.json'), JSON.stringify({ passed: false, checks, error: error.message }, null, 2));
        throw error;
    } finally { await ui?.dispose(); await app?.dispose(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
