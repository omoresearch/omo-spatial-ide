const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { ROOT, CANVAS, pause, openWorld, walkTo, command, fileContents } = require('./world-test-driver.cjs');
const { DESK_ONE, DESK_TWO } = require('./world-navigation-targets.cjs');
(async () => {
    const world = await openWorld('multi-station-browser'); const { page } = world;
    const run = crypto.randomUUID().slice(0, 8), files = [1, 2, 3].map(n => path.join(ROOT, 'demo-project', `.omo-desk-${run}-${n}`));
    const checks = [];
    const check = (name, value) => { assert.ok(value, name); checks.push({ name, pass: true }); console.log('PASS:', name); };
    try {
        const targets = await page.$eval(CANVAS, e => JSON.parse(e.dataset.stationTargets || '{}'));
        check('Both physical computers have their own real projected screen targets', !!targets.terminal && !!targets['terminal-2']);
        await walkTo(page, DESK_ONE.x, DESK_ONE.z);
        await command(page, 'terminal', `export DESK_MARK=LEFT_${run}; printf '%s:%s\\n' "$$" "$DESK_MARK" > ${path.basename(files[0])}; printf '\\n%s\\n' "$DESK_MARK"`);
        const left = await fileContents(files[0]); check('First physical desk executes a real shell', /^\d+:LEFT_/.test(left));
        await walkTo(page, DESK_TWO.x, DESK_TWO.z);
        await command(page, 'terminal-2', `export DESK_MARK=RIGHT_${run}; printf '%s:%s\\n' "$$" "$DESK_MARK" > ${path.basename(files[1])}; printf '\\n%s\\n' "$DESK_MARK"`);
        const right = await fileContents(files[1]);
        check('Second physical desk runs a different actual shell process', /^\d+:RIGHT_/.test(right) && right.split(':')[0] !== left.split(':')[0]);
        await page.waitForFunction(token => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText).terminal.some(line => line.trim() === token), {}, `LEFT_${run}`);
        await page.waitForFunction(token => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText)['terminal-2'].some(line => line.trim() === token), {}, `RIGHT_${run}`);
        check('Both physical monitor textures keep their independent live output', true);
        const bindings = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('omo.runtime.v1:')).map(k => ({ key: k, ...JSON.parse(localStorage.getItem(k)) })));
        check('Each physical desk has its own durable workspace, not just another view of one tab', bindings.length === 2 && bindings[0].workspaceId !== bindings[1].workspaceId);
        await walkTo(page, DESK_ONE.x, DESK_ONE.z);
        await command(page, 'terminal', `printf '%s:%s\\n' "$$" "$DESK_MARK" > ${path.basename(files[2])}`);
        check('Walking back to the first desk preserves its PID and exported state', await fileContents(files[2]) === left);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => { const data = JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.stationText || '{}'); return Object.keys(data).length === 2 && data.terminal.length && data['terminal-2'].length; }, { timeout: 30000 });
        const again = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('omo.runtime.v1:')).map(k => ({ key: k, ...JSON.parse(localStorage.getItem(k)) })));
        check('Refresh restores both physical desks and their exact workspace bindings', JSON.stringify(bindings.sort((a,b)=>a.key.localeCompare(b.key))) === JSON.stringify(again.sort((a,b)=>a.key.localeCompare(b.key))));
        fs.writeFileSync(path.join(ROOT, 'evidence/multi-station-verdict.json'), JSON.stringify({ verdict: 'PASS', checks }, null, 2));
        console.log('FINAL PASS:', checks.length, 'real multi-station checks');
    } catch (error) { await page.screenshot({ path: path.join(ROOT, 'evidence/multi-station-failure.png') }); throw error; }
    finally { await world.dispose(); files.forEach(file => fs.rmSync(file, { force: true })); }
})().catch(error => { console.error(error); process.exitCode = 1; });
