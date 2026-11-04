/* Real app/PTY/Git fixtures only. Agent programs below are explicit no-network recorders, not providers. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, CANVAS, openWorld, walkTo, clickStation } = require('./world-test-driver.cjs');
const { DESK_ONE } = require('./world-navigation-targets.cjs');
const { ownedAppFixture } = require('./owned-app-fixture.cjs');
(async () => {
    let fixture, world;
    const previous = process.env.OMO_URL;
    const checks = [];
    const check = (label, value = true) => { assert.ok(value, label); checks.push(label); console.log('PASS:', label); };
    try {
        fixture = await ownedAppFixture('task-review');
        assert.ok(fs.realpathSync(fixture.project).startsWith(fs.realpathSync(fixture.owned) + path.sep));
        assert.notEqual(fs.realpathSync(fixture.project), ROOT);
        const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
        for (const key of Object.keys(gitEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete gitEnv[key];
        const git = args => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(fixture.owned, 'no-hooks')}`, '-C', fixture.project, ...args], { env: gitEnv, encoding: 'utf8' });
        git(['init', '-q']); git(['config', 'user.name', 'Owned task-review fixture']); git(['config', 'user.email', 'task-review@example.test']);
        git(['add', '--', 'README.md']); git(['commit', '-qm', 'Owned baseline']);
        assert.equal(git(['rev-parse', '--show-toplevel']).trim(), fixture.project);
        const head = git(['rev-parse', 'HEAD']); const index = fs.readFileSync(path.join(fixture.project, '.git', 'index'));
        const events = path.join(fixture.owned, 'events.jsonl'); fs.writeFileSync(events, '');
        const result = path.join(fixture.project, 'fixture-task-result.txt');
        const program = `#!/usr/bin/python3
# Owned deterministic lifecycle fixture. No SDK, model or network calls.
import os, sys, json
kind = os.path.basename(sys.argv[0])
def record(event, **fields):
    with open(${JSON.stringify(events)}, 'a') as f: f.write(json.dumps(dict(event=event, kind=kind, **fields)) + '\\n')
record('launch')
print('TASK-REVIEW-FIXTURE-READY-' + kind, flush=True)
for line in sys.stdin:
    text = line.rstrip('\\n')
    record('input', text=text)
    with open(${JSON.stringify(result)}, 'w') as f: f.write('OWNED FIXTURE OUTPUT ' + kind + '\\n' + text + '\\n')
    print('TASK-REVIEW-FIXTURE-WROTE-' + kind, flush=True)
`;
        for (const kind of ['hermes', 'claude', 'codex']) fs.writeFileSync(path.join(fixture.owned, 'bin', kind), program, { mode: 0o755 });
        const records = event => fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r => r.event === event);
        process.env.OMO_URL = fixture.env.OMO_URL; world = await openWorld('task-review'); const p = world.page;
        await walkTo(p, DESK_ONE.x, DESK_ONE.z); await clickStation(p, 'terminal');
        await p.waitForSelector('[data-testid="runtime-console"][data-phase="live"]');
        const tabs = {}; const decisions = { claude: 'accepted', hermes: 'changes-requested', codex: 'accepted' };
        const phase = value => p.waitForSelector(`[data-testid="task-run-phase"][data-phase="${value}"]`);
        const enabled = async testid => p.$eval(`[data-testid="${testid}"]`, e => !e.disabled).catch(() => false);
        async function setDraft(text) { await p.click('[data-testid="agent-task-input"]'); await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control'); await p.keyboard.type(text); }
        for (const [position, kind] of ['claude', 'hermes', 'codex'].entries()) {
            const beforeLaunch = records('launch').length;
            await p.click(`[data-testid="runtime-new-${kind}"]`); await p.waitForSelector('[data-testid="runtime-confirm"]');
            assert.equal(records('launch').length, beforeLaunch);
            await p.click('[data-testid="runtime-confirm-yes"]');
            await p.waitForFunction(kind => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('TASK-REVIEW-FIXTURE-READY-' + kind), {}, kind);
            tabs[kind] = await p.$eval('[data-testid="runtime-console"] [role="tab"][aria-selected="true"]', e => e.dataset.testid.slice('runtime-tab-'.length));
            if (!await p.$('[data-testid="agent-task-input"]')) await p.click('[data-testid="runtime-task-toggle"]');
            await p.waitForSelector('[data-testid="agent-task-input"]');
            assert.equal(await p.$('[data-testid="task-run-phase"]'), null);
            check(`${kind}: explicit launch confirmation and no other tab's task record`);
            const text = `Owned ${kind} lifecycle task: inspect café; no provider calls`;
            if (kind === 'hermes') await p.evaluate(() => {
                const original = Storage.prototype.setItem;
                window.__restoreTaskRunStorage = () => { Storage.prototype.setItem = original; };
                Storage.prototype.setItem = function (key, value) { if (this === sessionStorage && key.startsWith('omo.agent-task-run.v1:')) throw new DOMException('Owned denial', 'QuotaExceededError'); return original.call(this, key, value); };
            });
            const inputsBefore = records('input').length;
            const beforeFile = fs.existsSync(result) ? fs.readFileSync(result) : undefined;
            await setDraft(text); await p.click('[data-testid="agent-task-paste"]');
            await p.waitForSelector('[data-testid="agent-task-notice"]');
            assert.ok(await p.$('[data-testid="task-run-panel"]'), 'Successful exact-target paste must create the latest task record');
            await phase('prepared');
            assert.equal(await p.$eval('[data-testid="task-run-text"]', e => e.textContent), text);
            assert.equal(records('input').length, inputsBefore);
            check(`${kind}: successful paste records exact text without submitting`);
            assert.equal(await enabled('task-run-accept'), false); assert.equal(await enabled('task-run-changes'), false);
            await setDraft('Unsent follow-up: must not replace the pasted task');
            assert.equal(await p.$eval('[data-testid="task-run-text"]', e => e.textContent), text);
            if (kind === 'hermes') {
                await p.waitForSelector('[data-testid="task-run-storage-warning"]');
                check('Denied task-record storage keeps the usable record in memory with a visible warning');
                await p.evaluate(() => window.__restoreTaskRunStorage());
            }
            await p.click('[data-testid="task-run-submitted"]'); await phase('submitted');
            assert.equal(records('input').length, inputsBefore);
            if (beforeFile) assert.deepEqual(fs.readFileSync(result), beforeFile); else assert.equal(fs.existsSync(result), false);
            check(`${kind}: submission report sends no terminal input and does not claim verified execution`);
            // Physical terminal Enter is the only action that makes the deterministic fixture write.
            await clickStation(p, 'terminal'); await p.keyboard.press('Enter');
            await p.waitForFunction(kind => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('TASK-REVIEW-FIXTURE-WROTE-' + kind), {}, kind);
            assert.equal(records('input').length, inputsBefore + 1); assert.equal(records('input').at(-1).text, text);
            const bytes = fs.readFileSync(result); assert.ok(bytes.toString().includes(text));
            check(`${kind}: real physical Enter delivers the original task and creates the owned project edit`);
            if (position === 0) {
                const parked = path.join(fixture.owned, 'parked-git'); fs.renameSync(path.join(fixture.project, '.git'), parked);
                try {
                    await p.click('[data-testid="task-run-review"]'); await p.waitForSelector('[data-testid="git-review-panel"][data-phase="error"]');
                    await p.click('[data-testid="git-review-close"]'); await phase('submitted');
                    assert.equal(await enabled('task-run-accept'), false);
                    check('A real failed project review cannot unlock a task decision');
                } finally { fs.renameSync(parked, path.join(fixture.project, '.git')); }
            }
            await p.click('[data-testid="task-run-review"]'); await p.waitForSelector('[data-testid="git-review-panel"][data-phase="ready"]');
            await p.click('[data-review-path="fixture-task-result.txt"]');
            await p.waitForFunction(text => document.querySelector('[data-testid="git-review-patch"]').textContent.includes(text), {}, text);
            await p.click('[data-testid="git-review-close"]'); await phase('review-ready');
            await p.click(`[data-testid="${decisions[kind] === 'accepted' ? 'task-run-accept' : 'task-run-changes'}"]`); await phase(decisions[kind]);
            assert.equal(records('input').length, inputsBefore + 1);
            assert.equal(records('launch').length, beforeLaunch + 1);
            assert.deepEqual(fs.readFileSync(result), bytes); assert.equal(git(['rev-parse', 'HEAD']), head);
            assert.deepEqual(fs.readFileSync(path.join(fixture.project, '.git', 'index')), index);
            check(`${kind}: real patch review and explicit ${decisions[kind]} decision do not mutate Git, files or terminal input`);
        }
        const launched = records('launch').length; const received = records('input').length;
        await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForSelector(`${CANVAS}[data-navigation="walk"]`);
        await walkTo(p, DESK_ONE.x, DESK_ONE.z); await clickStation(p, 'terminal'); await p.waitForSelector('[data-testid="runtime-console"][data-phase="live"]');
        if (!await p.$('[data-testid="agent-task-input"]')) await p.click('[data-testid="runtime-task-toggle"]');
        for (const kind of ['claude', 'hermes', 'codex']) {
            await p.click(`[data-testid="runtime-tab-${tabs[kind]}"]`); await phase(decisions[kind]);
            assert.ok((await p.$eval('[data-testid="task-run-text"]', e => e.textContent)).includes(`Owned ${kind} lifecycle task`));
        }
        assert.equal(records('launch').length, launched); assert.equal(records('input').length, received);
        check('All three isolated task records and user decisions survive reload without relaunch or resubmission');
        fs.writeFileSync(path.join(ROOT, 'evidence/task-review-real-app.json'), JSON.stringify({ pass: true, checks, fixtureOnly: true, providerCalls: 0, ownedProject: true, realGitReview: true, launches: launched, receivedTasks: received }, null, 2));
    } catch (error) {
        if (world) fs.writeFileSync(path.join(ROOT, 'evidence/task-review-app-failure.txt'), await world.page.evaluate(() => document.body.innerText).catch(() => ''));
        throw error;
    } finally {
        if (previous === undefined) delete process.env.OMO_URL; else process.env.OMO_URL = previous;
        try { if (world) await world.dispose(); } finally { if (fixture) await fixture.dispose(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
