module.exports = async ({ page, pause, trust, base }) => {
    const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 200 && !await page.$('[data-testid="omo-onboarding"]') && !await page.$(`${CANVAS}[data-navigation="walk"]`); i++) { await trust(); await pause(200); }
    await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 90000 });
    if (await page.$('[data-testid="create-room"]')) {
        await page.waitForFunction(() => { const b = document.querySelector('[data-testid="create-room"]'); return b && !b.disabled; }, { timeout: 60000 });
        await page.evaluate(() => document.querySelector('[data-testid="create-room"]').click());
    }
    await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
    for (let i = 0; i < 10; i++) { await trust(); await pause(300); }
    const drv = require('/home/harry/dev/omo-t2-agents/omo/extension/test/world-test-driver.cjs');
    await drv.walkTo(page, -2.5, 1.9);
    await drv.clickStation(page, 'terminal');
    await page.waitForSelector('[data-testid="runtime-console"][data-phase="live"]', { timeout: 30000 }).catch(() => {});
    await page.keyboard.press('Escape');
    await pause(1500);
    const launchers = await page.$$eval('[data-testid^="runtime-new-"]', bs => bs.map(b => ({ id: b.dataset.testid, disabled: b.disabled, title: b.title, text: b.textContent })));
    const status = await page.$eval('[data-testid="runtime-console"]', e => e.innerText).catch(() => 'none');
    await page.screenshot({ path: __dirname + '/t2a-step1.png' });
    return { launchers, status };
};
