/* t4:polish (2) — after a request is sent, the World admin box is empty and shows a neutral placeholder (no wrong ordinal). Real app. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { ROOT, openWorld } = require('./world-test-driver.cjs');
const OUT = path.join(ROOT, 'evidence', 't4-polish');
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const world = await openWorld('t4-admin-prompt'); const { page } = world;
    try {
        await page.click('[data-testid="admin-toggle"]'); await page.waitForSelector('[data-testid="admin-panel"]');
        await page.click('[data-testid="admin-prompt"]'); await page.keyboard.type('add a desk for Codex'); await page.keyboard.press('Enter');
        await page.waitForSelector('[data-testid="admin-entry"][data-status="proposed"]', { timeout: 20000 });
        const box = await page.$eval('[data-testid="admin-prompt"]', e => ({ value: e.value, placeholder: e.placeholder }));
        const examples = await page.$$eval('.omo-admin-examples button', b => b.map(e => e.textContent));
        await page.screenshot({ path: path.join(OUT, 'item2-admin-after-send.png') });
        console.log('admin box after send:', JSON.stringify(box));
        assert.equal(box.value, '', 'the box is empty after sending');
        assert.equal(box.placeholder, 'Describe a change, e.g. add a desk for Codex');
        assert.doesNotMatch(box.placeholder + examples.join(' '), /\b(first|second|third|fourth|fifth)\b/i);
        fs.writeFileSync(path.join(OUT, 'item2-admin-prompt.json'), JSON.stringify({ pass: true, box }, null, 2));
        console.log('FINAL PASS: admin prompt is empty after sending, neutral placeholder');
    } finally { await world.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
