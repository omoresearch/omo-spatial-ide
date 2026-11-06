'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { ownedAppFixture } = require('./owned-app-fixture.cjs');
const { ROOT, CANVAS, openWorld, walkTo, command, pause } = require('./world-test-driver.cjs');
const { DESK_ONE } = require('./world-navigation-targets.cjs');
(async () => { let fixture, world; const checks = []; try {
    fixture = await ownedAppFixture('task-workspaces');
    const git = a => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', fixture.project, ...a], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    fs.writeFileSync(path.join(fixture.project, 'README.md'), 'Committed source\n');
    git(['init', '-q']);
    git(['config', 'user.name', 'Owned workspace fixture']);
    git(['config', 'user.email', 'fixture@example.test']);
    git(['add', '--', 'README.md']);
    git(['commit', '-qm', 'Owned initial source']);
    const head = git(['rev-parse', 'HEAD']);
    const index = fs.readFileSync(path.join(fixture.project, '.git/index'));
    fs.writeFileSync(path.join(fixture.project, 'README.md'), 'Dirty source must stay here\n');
    fs.writeFileSync(path.join(fixture.project, 'untracked.txt'), 'Not copied\n');
    process.env.OMO_URL = fixture.env.OMO_URL;
    world = await openWorld('task-workspaces');
    const p = world.page;
    await p.waitForSelector('[data-testid="task-workspace-toggle"]', { timeout: 8000 });
    await p.click('[data-testid="task-workspace-toggle"]');
    await p.waitForSelector('[data-testid="task-workspace-panel"][data-phase="ready"]');
    const warning = await p.$eval('[data-testid="task-workspace-warning"]', e => e.textContent);
    assert.match(warning, /Uncommitted and untracked source changes are not copied/);
    checks.push('Explicit UI warns that only the captured commit is copied');
    await p.type('[data-testid="task-workspace-name"]', 'Isolated feature');
    assert.equal(await p.$eval('[data-testid="task-workspace-create"]', e => e.disabled), true);
    const manifest = path.join(fixture.owned, 'runtime/task-workspaces/manifest.json');
    assert.equal(fs.existsSync(manifest), false);
    await p.click('[data-testid="task-workspace-confirm"]');
    await pause(200);
    assert.equal(fs.existsSync(manifest), false);
    checks.push('Name and confirmation alone create no resource');
    await p.click('[data-testid="task-workspace-create"]');
    await p.waitForSelector('[data-testid="task-workspace-entry"]');
    await p.waitForSelector('[data-testid="task-workspace-panel"][data-phase="ready"]');
    const state = JSON.parse(fs.readFileSync(manifest));
    assert.equal(state.workspaces.length, 1);
    const row = state.workspaces[0], dir = fileURLToPath(row.worktreeUri);
    assert.equal(git(['-C', dir, 'symbolic-ref', '--short', 'HEAD']).trim(), row.branch);
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'Committed source\n');
    assert.equal(fs.existsSync(path.join(dir, 'untracked.txt')), false);
    assert.equal(row.sourceHasChanges, true);
    assert.equal(fs.readFileSync(fixture.agentLog, 'utf8'), '');
    assert.equal(git(['rev-parse', 'HEAD']), head);
    assert.deepEqual(fs.readFileSync(path.join(fixture.project, '.git/index')), index);
    checks.push('Real persisted worktree uses captured HEAD; dirty/untracked source stays separate');
    checks.push('Original HEAD/index unchanged and no agent launches');
    await p.click('[data-testid="task-workspace-refresh"]');
    await p.waitForSelector('[data-testid="task-workspace-panel"][data-phase="ready"]');
    assert.equal(await p.$$eval('[data-testid="task-workspace-entry"]', e => e.length), 1);
    checks.push('Refresh lists the existing worktree without creating another');
    await p.screenshot({ path: path.join(ROOT, 'evidence/task-workspaces-created.png') });
    await p.click('[data-testid="task-workspace-open"]');
    let selected = false;
    for (let n = 0; n < 100; n++) {
        await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).catch(() => { });
        selected = await p.$eval('[data-testid="omo-world"]', (e, uri) => e.dataset.projectUri === uri, row.worktreeUri).catch(() => false);
        if (selected)
            break;
        await pause(200);
    }
    assert.ok(selected, 'Open must select the exact created project');
    if (await p.$('[data-testid="create-room"]')) {
        await p.$eval('[data-testid="create-room"]', e => e.scrollIntoView({ block: 'center' }));
        await p.waitForFunction(() => { const e = document.querySelector('[data-testid="create-room"]'); if (!e || e.disabled)
            return false; const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
        await p.click('[data-testid="create-room"]');
    }
    await p.waitForSelector(`${CANVAS}[data-navigation="walk"]`);
    await walkTo(p, DESK_ONE.x, DESK_ONE.z);
    await command(p, 'terminal', "printf 'Isolated edit\\n' > README.md; pwd");
    for (let n = 0; n < 80 && fs.readFileSync(path.join(dir, 'README.md'), 'utf8') !== 'Isolated edit\n'; n++)
        await pause(100);
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'Isolated edit\n');
    assert.equal(fs.readFileSync(path.join(fixture.project, 'README.md'), 'utf8'), 'Dirty source must stay here\n');
    assert.equal(git(['rev-parse', 'HEAD']), head);
    assert.deepEqual(fs.readFileSync(path.join(fixture.project, '.git/index')), index);
    assert.equal(fs.readFileSync(fixture.agentLog, 'utf8'), '');
    checks.push('Explicit Open selects worktree; physical shell edits only its working folder');
    checks.push('Source files/HEAD/index unchanged after isolated physical terminal edit');
    fs.writeFileSync(path.join(ROOT, 'evidence/task-workspaces-real-app.json'), JSON.stringify({ checks, providerCalls: 0, agentLaunches: 0 }, null, 2) + '\n');
    console.log(JSON.stringify({ checks, providerCalls: 0 }, null, 2));
}
catch (error) {
    if (world) {
        fs.writeFileSync(path.join(ROOT, 'evidence/task-workspaces-ui-failure.txt'), await world.page.evaluate(() => document.body.innerText).catch(() => ''));
        await world.page.screenshot({ path: path.join(ROOT, 'evidence/task-workspaces-ui-failure.png') }).catch(() => { });
    }
    throw error;
}
finally {
    try {
        if (world)
            await world.dispose();
    }
    finally {
        if (fixture)
            await fixture.dispose();
    }
} })().catch(e => { console.error(e); process.exitCode = 1; });
