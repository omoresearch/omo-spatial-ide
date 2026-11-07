module.exports = async (page, h) => {
    const b = () => page.$eval('[data-testid="build-mode"]', e => ({ ...e.dataset }));
    const diff = async () => (await page.$('[data-testid="build-diff"]')) ? page.$$eval('[data-testid="build-diff"] li', ls => ls.map(l => l.textContent)) : [];
    const notice = async () => (await page.$('[data-testid="build-notice"]')) ? h.text('[data-testid="build-notice"]') : '';
    const at = async (x, y) => { await page.mouse.move(x - 3, y - 3); await h.pause(80); await page.mouse.move(x, y); await h.pause(250); };
    const clickAt = async (x, y) => { await at(x, y); await page.mouse.click(x, y); await h.pause(400); };
    if (!await page.$('[data-testid="build-mode"]')) { await page.$eval('[data-testid="overview-mode"]', e => e.click()); await h.pause(1000); await page.focus(h.CANVAS); await page.keyboard.press('b'); await h.pause(400); }
    // 1. Agent desk at (586,580)
    await page.$eval('[data-testid="build-item-agent-desk"]', e => e.click()); await h.pause(200);
    await clickAt(586, 580);
    console.log('after desk', (await b()).ghost, await diff(), await notice());
    // 2. Monitor wall: aim near the back wall
    await page.$eval('[data-testid="build-item-monitor-wall"]', e => e.click()); await h.pause(200);
    await at(854, 492); console.log('wall ghost', (await b()).ghost);
    await clickAt(854, 492);
    console.log('after wall', await diff(), await notice());
    // 3. Decor plant
    await page.$eval('[data-testid="build-item-decor-plant"]', e => e.click()); await h.pause(200);
    await clickAt(451, 757);
    console.log('after plant', await diff(), await notice());
    await page.keyboard.press('Escape'); await h.pause(300);
    console.log('tool', (await b()).tool);
    await h.shot('s2-01-placed');
    const ents = await page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return JSON.parse(localStorage.getItem(k)).entities.map(e => e.id); });
    console.log('saved before apply (must not change):', ents);
    console.log('canvas entities (preview):', (await h.ds()).worldEntities);
};
