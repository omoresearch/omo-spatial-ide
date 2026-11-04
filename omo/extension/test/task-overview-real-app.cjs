// Actual app + real PTY with one explicitly pinned no-network fixture agent.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ownedAppFixture } = require('./owned-app-fixture.cjs');
const { ROOT, CANVAS, openWorld, walkTo, clickStation, pause } = require('./world-test-driver.cjs');
const { DESK_ONE } = require('./world-navigation-targets.cjs');

(async () => {
    let fixture, world;
    const checks = [];
    try {
        fixture = await ownedAppFixture('task-overview');
        const received = path.join(fixture.owned, 'received.jsonl');
        fs.writeFileSync(received, '');
        fs.writeFileSync(path.join(fixture.owned, 'bin/claude'), `#!/usr/bin/python3
import json,sys
with open(${JSON.stringify(fixture.agentLog)},'a') as f: f.write(json.dumps({'kind':'claude','fixture':True})+'\\n')
print('OWNED FIXTURE AGENT: NO MODEL OR NETWORK CALLS',flush=True)
for line in sys.stdin:
    with open(${JSON.stringify(received)},'a') as f: f.write(json.dumps({'text':line})+'\\n')
`, { mode: 0o755 });
        process.env.OMO_URL = fixture.env.OMO_URL;
        world = await openWorld('task-overview');
        const p = world.page;
        await p.click('[data-testid="task-overview-toggle"]');
        await p.waitForSelector('[data-testid="task-overview-panel"]');
        assert.match(await p.$eval('[data-testid="task-overview-panel"]', e => e.textContent), /No task-run records/);
        assert.equal(fs.readFileSync(fixture.agentLog, 'utf8'), '');
        checks.push('Empty overview opens in the actual room without starting an agent');
        await p.click('[data-testid="task-overview-close"]');
        await walkTo(p, DESK_ONE.x, DESK_ONE.z);
        await clickStation(p, 'terminal');
        await p.waitForSelector('[data-testid="runtime-console"][data-phase="live"]');
        await p.click('[data-testid="runtime-new-claude"]');
        await p.waitForSelector('[data-testid="runtime-confirm"]');
        await p.click('[data-testid="runtime-confirm-yes"]');
        await p.waitForFunction(() => document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('OWNED FIXTURE AGENT'));
        await p.click('[data-testid="runtime-task-toggle"]');
        await p.waitForSelector('[data-testid="agent-task-input"]');
        const text = 'Fixture-only prepared task: ' + 'readable detail '.repeat(24);
        await p.type('[data-testid="agent-task-input"]', text);
        await p.click('[data-testid="agent-task-paste"]');
        await p.waitForSelector('[data-testid="task-run-phase"][data-phase="prepared"]');
        await p.evaluate(() => {
            const prefix = 'omo.agent-task-run.v1:';
            const key = Object.keys(sessionStorage).find(k => k.startsWith(prefix));
            if (!key) throw Error('Real composer record missing');
            const foreign = JSON.parse(sessionStorage.getItem(key));
            foreign.text = 'FOREIGN-PRIVATE-STORAGE-FIXTURE';
            foreign.target.projectUri = 'file:///owned/foreign-project';
            foreign.target.tabId = 'foreign-tab';
            window.__foreignTaskKey = prefix + JSON.stringify([foreign.target.projectUri, foreign.target.stationId, foreign.target.workspaceId, foreign.target.tabId]);
            sessionStorage.setItem(window.__foreignTaskKey, JSON.stringify(foreign));
            const original = Storage.prototype.getItem;
            window.__taskStorageReads = [];
            Storage.prototype.getItem = function (key) {
                if (this === sessionStorage) window.__taskStorageReads.push(String(key));
                return original.call(this, key);
            };
        });
        const launches = fs.readFileSync(fixture.agentLog, 'utf8');
        await p.click('[data-testid="task-overview-toggle"]');
        await p.waitForSelector('[data-testid="task-overview-entry"]');
        assert.equal(await p.$$eval('[data-testid="task-overview-entry"]', entries => entries.length), 1);
        assert.ok((await p.$eval('[data-testid="task-overview-detail"]', e => e.textContent)).includes(text));
        const overview = await p.$eval('[data-testid="task-overview-panel"]', e => e.textContent);
        assert.match(overview, /Pasted — not submitted/);
        assert.match(overview, /not live execution, completion, or ownership monitoring/i);
        assert.ok(!overview.includes('FOREIGN-PRIVATE-STORAGE-FIXTURE'));
        assert.equal(await p.evaluate(() => window.__taskStorageReads.includes(window.__foreignTaskKey)), false);
        checks.push('The real prepared task appears with full details and an honest unsubmitted phase');
        checks.push('Foreign-project record is neither displayed nor read from storage');
        await p.click('[data-testid="task-overview-refresh"]');
        assert.equal(fs.readFileSync(fixture.agentLog, 'utf8'), launches);
        assert.equal(fs.readFileSync(received, 'utf8'), '');
        checks.push('Overview refresh starts no agent and sends no terminal input');
        await p.screenshot({ path: path.join(ROOT, 'evidence/task-overview-real.png') });
        await p.click('[data-testid="task-overview-close"]');
        await p.click('[data-testid="task-run-submitted"]');
        await p.waitForSelector('[data-testid="task-run-phase"][data-phase="submitted"]');
        assert.equal(fs.readFileSync(received, 'utf8'), '');
        await p.click('[data-testid="task-overview-toggle"]');
        assert.match(await p.$eval('[data-testid="task-overview-detail"]', e => e.textContent), /user reported a submission|reported by you/i);
        checks.push('Manual submission note updates without implying execution');
        await p.reload({ waitUntil: 'domcontentloaded' });
        await p.waitForSelector('[data-testid="omo-world"][data-configured="true"]');
        await p.waitForFunction(() => {
            const e = document.querySelector('[data-testid="task-overview-toggle"]');
            if (!e || e.disabled) return false;
            const r = e.getBoundingClientRect();
            return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        });
        await p.click('[data-testid="task-overview-toggle"]');
        await p.waitForSelector('[data-testid="task-overview-entry"]');
        assert.match(await p.$eval('[data-testid="task-overview-detail"]', e => e.textContent), /user reported a submission|reported by you/i);
        assert.equal(fs.readFileSync(fixture.agentLog, 'utf8'), launches);
        checks.push('Same browser-tab task note survives reload without another launch');
        fs.writeFileSync(path.join(ROOT, 'evidence/task-overview-real-app.json'), JSON.stringify({ checks, providerCalls: 0, fixtureAgentLaunches: 1 }, null, 2) + '\n');
        console.log(JSON.stringify({ checks, providerCalls: 0 }, null, 2));
    } catch (error) {
        if (world) fs.writeFileSync(path.join(ROOT, 'evidence/task-overview-failure.txt'), await world.page.evaluate(() => document.body.innerText).catch(() => ''));
        throw error;
    } finally {
        try { if (world) await world.dispose(); }
        finally { if (fixture) await fixture.dispose(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
