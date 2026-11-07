module.exports = async (page, h) => {
    const C = h.CANVAS;
    await page.evaluate(() => localStorage.setItem('omo.focus.clickAttach', 'true'));
    await page.focus(C); await page.keyboard.press('Escape'); await h.pause(400);
    const t = JSON.parse((await h.ds()).stationTargets)['desk-3'];
    const r = await page.$eval(C, c => { const b = c.getBoundingClientRect(); return [b.left, b.top]; });
    await page.mouse.click(r[0] + t.x, r[1] + t.y);
    await page.waitForSelector('[data-testid="focus-layer"]', { timeout: 10000 }).catch(() => {});
    await h.pause(1500);
    const fl = async () => (await page.$('[data-testid="focus-layer"]')) ? page.$eval('[data-testid="focus-layer"]', e => `${e.dataset.station}/${e.dataset.phase}`) : 'none';
    console.log('attached', await fl(), 'desk buttons', await page.$$eval('[data-testid^="focus-desk-"]', bs => bs.map(b => `${b.dataset.testid}:${b.getAttribute('aria-pressed')}`)));
    await h.shot('s4-02-focus-desk3');
    for (const n of ['1', '2', '3', '4']) {
        await page.keyboard.down('Control'); await page.keyboard.press(n); await page.keyboard.up('Control');
        await h.pause(1600);
        console.log(`Ctrl+${n} ->`, await fl(), 'active', await page.$eval('[data-testid="omo-world"]', e => e.dataset.activeStation));
    }
    await page.keyboard.down('Control'); await page.keyboard.press('3'); await page.keyboard.up('Control'); await h.pause(1600);
    console.log('back to 3', await fl());
    await h.shot('s4-03-focus-ctrl3');
};
