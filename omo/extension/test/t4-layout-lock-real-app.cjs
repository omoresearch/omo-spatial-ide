/* t4:polish (3) — the room layout lock note names the locked desk. Real app: lock desk one in Station recipes, open Edit room. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { ROOT, pause, openWorld } = require('./world-test-driver.cjs');
const OUT = path.join(ROOT, 'evidence', 't4-polish');
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const world = await openWorld('t4-layout-lock'); const { page } = world;
    try {
        await page.click('[data-testid="station-one-controls"]');
        await page.click('[data-testid="station-recipe-toggle"]'); await page.waitForSelector('[data-testid="station-lock-toggle"]');
        await page.click('[data-testid="station-lock-toggle"]'); await page.waitForSelector('[data-testid="station-lock-note"]');
        await page.click('[data-testid="edit-room"]'); await page.waitForSelector('[data-testid="room-layout-locked"]', { timeout: 10000 });
        const note = await page.$eval('[data-testid="room-layout-locked"]', e => e.textContent);
        const disabled = await page.$eval('[data-testid="room-layout"]', e => e.disabled);
        await page.$eval('[data-testid="room-layout-locked"]', e => e.scrollIntoView({ block: 'center' })); await pause(300);
        await page.screenshot({ path: path.join(OUT, 'item3-layout-lock-note.png') });
        console.log('layout lock note:', note);
        assert.equal(disabled, true, 'the layout dropdown stays locked');
        assert.match(note, /Desk “Desk one” is locked, so the room layout cannot change\. Unlock it in Station recipes/);
        // Leave the room as it was.
        await page.click('[data-testid="station-lock-toggle"]').catch(() => undefined);
        fs.writeFileSync(path.join(OUT, 'item3-layout-lock.json'), JSON.stringify({ pass: true, note, disabled }, null, 2));
        console.log('FINAL PASS: the layout lock note names the locked desk');
    } finally { await world.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
