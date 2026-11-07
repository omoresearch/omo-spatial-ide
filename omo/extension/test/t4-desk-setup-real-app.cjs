/* t4:polish (1) — adding a desk never opens 'Set up this station?'. Setup is offered only when the user opens a desk for the
 * first time (its monitor, or the desk switcher), and nothing starts without the explicit confirmation. Real app, real Chrome. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { ROOT, CANVAS, pause, openWorld, walkTo, clickStation, command } = require('./world-test-driver.cjs');
const { DESK_ONE } = require('./world-navigation-targets.cjs');
const OUT = path.join(ROOT, 'evidence', 't4-polish');
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const world = await openWorld('t4-desk-setup'); const { page } = world;
    const checks = [];
    const check = (name, value, detail) => { console.log(`${value ? 'PASS' : 'FAIL'}: ${name}${detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300)}`); checks.push({ name, pass: !!value, detail }); assert.ok(value, name); };
    const setupPrompt = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="runtime-confirm"],[data-testid="focus-confirm"]')].map(e => e.textContent).filter(t => /as this station is configured/.test(t)));
    const stations = async () => JSON.parse(await page.$eval(CANVAS, e => e.dataset.worldStations || '[]'));
    const deskOneSays = async token => { await command(page, 'terminal', `echo ${token}`); await page.waitForFunction(t => (JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText || '{}').terminal || []).some(l => l.trim() === t), { timeout: 20000 }, token); await pause(1500); };
    const leave = async () => { for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await pause(300); } };
    try {
        // Desk one in the classic room (no saved world yet): a live shell.
        await walkTo(page, DESK_ONE.x, DESK_ONE.z);
        await deskOneSays('T4_BEFORE');
        check('Using desk one in the classic room asks nothing', (await setupPrompt()).length === 0);
        await leave();
        // Add a desk with the Hermes admin, then Apply.
        const before = (await stations()).length;
        await page.click('[data-testid="admin-toggle"]'); await page.waitForSelector('[data-testid="admin-panel"]');
        await page.click('[data-testid="admin-prompt"]'); await page.keyboard.type('add a desk for Codex'); await page.keyboard.press('Enter');
        await page.waitForSelector('[data-testid="admin-entry"][data-status="proposed"] [data-testid="admin-apply"]', { timeout: 20000 });
        await page.click('[data-testid="admin-apply"]');
        await page.waitForFunction(n => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.worldStations || '[]').length === n + 1, { timeout: 10000 }, before);
        await page.click('[data-testid="admin-close"]').catch(() => undefined);
        await pause(1000);
        // Keep using desk one: its next output must not bring up a setup offer.
        await walkTo(page, DESK_ONE.x, DESK_ONE.z);
        await deskOneSays('T4_AFTER_ADMIN');
        const afterAdmin = await setupPrompt();
        await page.screenshot({ path: path.join(OUT, 'item1-after-admin-apply.png') });
        check('After admin Apply adds a desk, no setup prompt opens (desk one keeps working)', afterAdmin.length === 0, afterAdmin);
        await leave();
        // Add another desk with build mode (overview camera, as the demo does), then Apply.
        await page.click('[data-testid="overview-mode"]'); await pause(800);
        await page.focus(CANVAS); await page.keyboard.press('b'); await page.waitForSelector('[data-testid="build-mode"]');
        await page.click('[data-testid="build-item-agent-desk"]'); await pause(500);
        const wrap = await page.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        let placed = false;
        for (const [fx, fy] of [[0.62, 0.72], [0.55, 0.78], [0.7, 0.66], [0.45, 0.8], [0.4, 0.7], [0.6, 0.6], [0.3, 0.75], [0.75, 0.8], [0.5, 0.5]]) {
            const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
            await page.mouse.move(x, y); await pause(300);
            if (/true$/.test(await page.$eval('[data-testid="build-mode"]', e => e.dataset.ghost || ''))) { await page.mouse.click(x, y); placed = true; break; }
        }
        check('Build mode placed a ghost agent desk', placed);
        await page.waitForSelector('[data-testid="build-apply"]'); await page.click('[data-testid="build-apply"]');
        await page.waitForFunction(n => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.worldStations || '[]').length === n + 2, { timeout: 10000 }, before);
        if (await page.$('[data-testid="build-exit"]')) await page.click('[data-testid="build-exit"]');
        await page.click('[data-testid="walk-mode"]'); await pause(800);
        await walkTo(page, DESK_ONE.x, DESK_ONE.z);
        await deskOneSays('T4_AFTER_BUILD');
        const afterBuild = await setupPrompt();
        await page.screenshot({ path: path.join(OUT, 'item1-after-build-apply.png') });
        check('After build-mode Apply adds a desk, no setup prompt opens (desk one keeps working)', afterBuild.length === 0, afterBuild);
        await leave();
        // Open the new admin desk from the full-screen desk switcher: the first open offers setup; nothing has started.
        const added = (await stations()).find(id => !['terminal', 'terminal-2'].includes(id));
        await page.focus(CANVAS);
        await page.click('[data-testid="focus-full-launch"]');
        await page.waitForFunction(() => document.querySelector('[data-testid="omo-world"]')?.dataset.focusFull === 'true', { timeout: 10000 });
        await page.click(`[data-testid="focus-desk-${added}"]`);
        await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="focus-confirm"]')].some(e => /as this station is configured/.test(e.textContent)), { timeout: 30000 });
        const offered = await setupPrompt();
        await page.screenshot({ path: path.join(OUT, 'item1-first-open-offers-setup.png') });
        check('First open of the new desk (desk switcher) offers its setup and waits for confirmation', offered.length > 0, offered[0]);
        const tabNames = await page.$$eval('[data-testid="focus-tabs"] [role="tab"]', b => b.map(e => e.textContent.trim()));
        check('Nothing started before confirmation: the new desk has only its shell tab', tabNames.length === 1, tabNames);
        await page.click('[data-testid="focus-confirm-no"]'); await pause(800);
        check('Cancel keeps just the shell and the prompt is gone', (await setupPrompt()).length === 0 && (await page.$$eval('[data-testid="focus-tabs"] [role="tab"]', b => b.length)) === 1);
        fs.writeFileSync(path.join(OUT, 'item1-desk-setup.json'), JSON.stringify({ pass: true, checks }, null, 2));
        console.log('FINAL PASS:', checks.length, 'desk setup checks');
    } catch (error) {
        await page.screenshot({ path: path.join(OUT, 'item1-failure.png') }).catch(() => undefined);
        fs.writeFileSync(path.join(OUT, 'item1-desk-setup.json'), JSON.stringify({ pass: false, error: String(error && error.message), checks }, null, 2));
        throw error;
    } finally { await world.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
