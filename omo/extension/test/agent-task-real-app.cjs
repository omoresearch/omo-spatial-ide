/* Full Theia UI + real tmux/PTY, with explicitly pinned fixture-only agents. No model calls. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { ROOT, CANVAS, openWorld, walkTo, clickStation, pause } = require('./world-test-driver.cjs');
const { DESK_ONE } = require('./world-navigation-targets.cjs');

(async () => {
    let world, server, owned, env;
    const previousUrl = process.env.OMO_URL;
    const token = crypto.randomBytes(6).toString('hex');
    const socket = `omo-task-test-${token}`;
    const checks = [];
    const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS:', label); };
    try {
        fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
        owned = fs.mkdtempSync(path.join(process.env.TMPDIR || path.join(ROOT, 'evidence'), 'omo-task-app-'));
        const project = path.join(owned, 'project');
        const bin = path.join(owned, 'bin');
        const agentLog = path.join(owned, 'received.jsonl');
        const launchLog = path.join(owned, 'launched.jsonl');
        const hermesRoot = path.join(owned, 'hermes');
        for (const dir of [project, bin, path.join(hermesRoot, 'profiles', 'default')]) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(hermesRoot, 'profiles', 'default', 'config.yaml'), '# Owned fixture; never a real Hermes profile.\n');
        fs.writeFileSync(agentLog, ''); fs.writeFileSync(launchLog, '');
        const fixture = `#!/usr/bin/python3
# Terminal fixture only. Does not import or call an agent SDK, model or network client.
import os, sys, json
kind = os.path.basename(sys.argv[0])
with open(${JSON.stringify(launchLog)}, 'a') as f:
    f.write(json.dumps({'kind': kind, 'argv': sys.argv[1:]}) + '\\n')
print('FIXTURE-READY-' + kind, flush=True)
while True:
    line = sys.stdin.readline()
    if not line: break
    with open(${JSON.stringify(agentLog)}, 'a') as f:
        f.write(json.dumps({'kind': kind, 'text': line.rstrip('\\n')}) + '\\n')
    print('FIXTURE-RECEIVED-' + kind, flush=True)
`;
        for (const kind of ['hermes', 'claude', 'codex']) fs.writeFileSync(path.join(bin, kind), fixture, { mode: 0o755 });
        const git = args => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(owned, 'no-hooks')}`, '-C', project, ...args], { encoding: 'utf8' });
        git(['init', '-q']); git(['config', 'user.name', 'Owned Task Fixture']); git(['config', 'user.email', 'tasks@example.test']);
        const resultFile = path.join(project, 'fixture-result.txt');
        fs.writeFileSync(resultFile, 'OWNED_BASELINE\n'); git(['add', '--', '.']); git(['commit', '-qm', 'owned baseline']);
        assert.equal(git(['rev-parse', '--show-toplevel']).trim(), project);
        const head = git(['rev-parse', 'HEAD']);
        const index = fs.readFileSync(path.join(project, '.git', 'index'));
        const listener = net.createServer();
        await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
        const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
        env = { ...process.env, THEIA_CONFIG_DIR: path.join(owned, 'theia'),
            OMO_SPATIAL_DATA: path.join(owned, 'runtime'), OMO_SPATIAL_TMUX_SOCKET: socket,
            OMO_SPATIAL_TMUX: process.env.OMO_SPATIAL_TEST_TMUX || process.env.OMO_SPATIAL_TMUX,
            OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex'),
            OMO_SPATIAL_HERMES_ROOT: hermesRoot, OMO_URL: `http://127.0.0.1:${port}` };
        const log = fs.openSync(path.join(ROOT, 'evidence/agent-task-owned-server.log'), 'a');
        server = spawn(process.execPath, [path.join(ROOT, 'scripts/start.cjs'), '--workspace', project, '--port', String(port)], { cwd: ROOT, env, detached: true, shell: false, stdio: ['ignore', log, log] });
        fs.closeSync(log); let spawnError; server.on('error', error => { spawnError = error; });
        let ready = false;
        for (let n = 0; n < 150; n++) {
            if (spawnError) throw spawnError;
            if (server.exitCode !== null || server.signalCode !== null) throw new Error('Owned task application exited before readiness');
            try { if ((await fetch(env.OMO_URL, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* bounded startup */ }
            await pause(200);
        }
        assert.ok(ready, 'Owned task app must start');
        process.env.OMO_URL = env.OMO_URL;
        world = await openWorld('agent-task-owned');
        const p = world.page;
        const errors = []; p.on('pageerror', error => errors.push(error.message));
        await walkTo(p, DESK_ONE.x, DESK_ONE.z); await clickStation(p, 'terminal');
        await p.waitForSelector('[data-testid="runtime-console"][data-phase="live"]');
        check('The full world exposes a task entry point', await p.$('[data-testid="runtime-task-toggle"]'));
        await p.click('[data-testid="runtime-task-toggle"]');
        check('A shell is not an agent task destination', !await p.$('[data-testid="agent-task-input"]'));
        await p.click('[data-testid="runtime-task-toggle"]');
        const launches = () => fs.readFileSync(launchLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        const received = () => fs.readFileSync(agentLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        const draft = `Fixture-only task ${token}: inspect café and propose a change`;
        const ids = {};
        async function currentTab() { return p.$eval('[data-testid="runtime-console"] [role="tab"][aria-selected="true"]', e => e.dataset.testid.slice('runtime-tab-'.length)); }
        async function setDraft(text) {
            await p.click('[data-testid="agent-task-input"]');
            await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control');
            await p.keyboard.type(text);
        }
        for (const kind of ['claude', 'hermes', 'codex']) {
            const before = launches().length;
            await p.click(`[data-testid="runtime-new-${kind}"]`); await p.waitForSelector('[data-testid="runtime-confirm"]');
            check(`${kind} requires explicit launch confirmation`, launches().length === before);
            await p.click('[data-testid="runtime-confirm-yes"]');
            await p.waitForFunction(kind => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('FIXTURE-READY-' + kind), { timeout: 20000 }, kind);
            ids[kind] = await currentTab();
            if (!await p.$('[data-testid="agent-task-input"]')) await p.click('[data-testid="runtime-task-toggle"]');
            await p.waitForSelector('[data-testid="agent-task-input"]');
            check(`${kind} has an isolated empty draft`, await p.$eval('[data-testid="agent-task-input"]', e => e.value === ''));
            const pose = await p.$eval(CANVAS, e => [e.dataset.playerX, e.dataset.playerZ]);
            if (kind === 'hermes') await p.evaluate(() => {
                const original = Storage.prototype.setItem;
                window.__taskFixtureRestoreStorage = () => { Storage.prototype.setItem = original; delete window.__taskFixtureRestoreStorage; };
                Storage.prototype.setItem = function (key, value) { if (this === window.sessionStorage) throw new DOMException('Owned fixture storage denial', 'QuotaExceededError'); return original.call(this, key, value); };
            });
            await setDraft(kind === 'claude' ? draft : `Only ${kind} draft ${token}`);
            if (kind === 'hermes') {
                check('Storage denial retains the native textarea text with a visible memory-only warning', await p.$eval('[data-testid="agent-task-drawer"]', e => e.textContent.includes('memory only') && !!e.querySelector('textarea').value));
                await p.evaluate(() => window.__taskFixtureRestoreStorage());
                await setDraft(`Only ${kind} draft ${token}`);
            }
            check('Writing a native task draft does not walk or send input', JSON.stringify(await p.$eval(CANVAS, e => [e.dataset.playerX, e.dataset.playerZ])) === JSON.stringify(pose) && received().length === 0);
        }
        await p.click(`[data-testid="runtime-tab-${ids.claude}"]`);
        await p.waitForSelector('[data-testid="runtime-console"][data-phase="live"]');
        await p.waitForFunction(value => document.querySelector('[data-testid="agent-task-input"]')?.value === value, {}, draft);
        check('Switching agents restores the selected tab draft', true);
        await setDraft('first line\nsecond line');
        await p.waitForFunction(() => document.querySelector('[data-testid="agent-task-paste"]').disabled);
        check('Multiline task text is blocked without real bracketed paste', received().length === 0);
        await setDraft(draft);
        await p.waitForFunction(() => !document.querySelector('[data-testid="agent-task-paste"]').disabled);
        await p.click('[data-testid="agent-task-paste"]');
        await p.waitForFunction(value => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes(value), {}, draft);
        check('Actual PTY text reaches the physical terminal without submitting the task', received().length === 0);
        await p.waitForFunction(() => /without Enter|no Enter/.test(document.querySelector('[data-testid="agent-task-notice"]')?.textContent || ''));
        check('Pasting retains the draft and makes no completion claim', await p.$eval('[data-testid="agent-task-input"]', (e, value) => e.value === value, draft));
        await clickStation(p, 'terminal'); await p.keyboard.press('Enter');
        for (let n = 0; n < 50 && received().length === 0; n++) await pause(100);
        assert.deepEqual(received(), [{ kind: 'claude', text: draft }]);
        check('Only the explicit physical-terminal Enter submits the exact draft to the selected fixture', true);
        fs.writeFileSync(resultFile, 'FIXTURE_CHANGE_FOR_READ_ONLY_REVIEW\n');
        await p.click('[data-testid="agent-task-review"]');
        await p.waitForSelector('[data-testid="git-review-panel"][data-phase="ready"]');
        await p.click('[data-review-path="fixture-result.txt"]');
        await p.waitForFunction(() => document.querySelector('[data-testid="git-review-patch"]').textContent.includes('+FIXTURE_CHANGE_FOR_READ_ONLY_REVIEW'));
        assert.equal(received().length, 1);
        assert.deepEqual(fs.readFileSync(path.join(project, '.git', 'index')), index); assert.equal(git(['rev-parse', 'HEAD']), head);
        check('Task review shortcut reads actual project changes without submitting more input or changing Git', true);
        await p.click('[data-testid="git-review-close"]');
        await p.reload({ waitUntil: 'domcontentloaded' });
        await p.waitForSelector(`${CANVAS}[data-navigation="walk"]`);
        await walkTo(p, DESK_ONE.x, DESK_ONE.z); await clickStation(p, 'terminal');
        await p.waitForSelector('[data-testid="runtime-console"][data-phase="live"]');
        await p.click(`[data-testid="runtime-tab-${ids.claude}"]`);
        await p.waitForSelector('[data-testid="runtime-console"][data-phase="live"]');
        await p.click('[data-testid="runtime-task-toggle"]');
        await p.waitForFunction(value => document.querySelector('[data-testid="agent-task-input"]')?.value === value, {}, draft);
        check('This browser tab keeps the per-agent draft across reload without relaunching a process', launches().length === 3);
        check('Task controls stay above, not over, the physical world', await p.evaluate(() => document.querySelector('[data-testid="runtime-console"]').getBoundingClientRect().bottom <= document.querySelector('canvas[data-testid="omo-world-canvas"]').getBoundingClientRect().top + 1));
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(ROOT, 'evidence/agent-task-real-app.json'), JSON.stringify({ pass: true, fixtureAgentsOnly: true, providerCalls: 0, ownedProject: true, ownedApp: true, checks }, null, 2));
    } catch (error) {
        if (world) fs.writeFileSync(path.join(ROOT, 'evidence/agent-task-app-failure.txt'), await world.page.evaluate(() => document.body.innerText).catch(() => ''));
        throw error;
    } finally {
        try { if (world) await world.dispose(); } finally {
            if (previousUrl === undefined) delete process.env.OMO_URL; else process.env.OMO_URL = previousUrl;
            if (server?.pid > 1 && server.exitCode === null && server.signalCode === null) {
                try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
                for (let n = 0; n < 40 && server.exitCode === null && server.signalCode === null; n++) await pause(100);
                if (server.exitCode === null && server.signalCode === null) {
                    try { process.kill(-server.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
                    for (let n = 0; n < 20 && server.exitCode === null && server.signalCode === null; n++) await pause(100);
                }
            }
            if (env && /^omo-task-test-[a-f0-9]{12}$/.test(socket)) {
                const { discoverRuntime } = require('../lib/node/runtime-discovery');
                const { tmux } = discoverRuntime(env); if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
            }
            if (owned && (!server || server.exitCode !== null || server.signalCode !== null)) fs.rmSync(owned, { recursive: true, force: true });
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
