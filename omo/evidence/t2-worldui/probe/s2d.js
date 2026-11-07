module.exports = async (page, h) => {
    const b = () => page.$eval('[data-testid="build-mode"]', e => ({ ...e.dataset }));
    const at = async (x, y) => { await page.mouse.move(x - 3, y - 3); await h.pause(80); await page.mouse.move(x, y); await h.pause(250); };
    await page.$eval('[data-testid="build-item-agent-desk"]', e => e.click()); await h.pause(200);
    for (const [x, y] of [[586, 580], [720, 668], [451, 668], [586, 757], [989, 757], [720, 757]]) {
        await at(x, y);
        console.log(x, y, (await b()).ghost, '|', await h.text('[data-testid="build-hint"]'));
    }
    await at(720, 757);
    await page.mouse.click(720, 757); await h.pause(500);
    const diff = (await page.$('[data-testid="build-diff"]')) ? await page.$$eval('[data-testid="build-diff"] li', ls => ls.map(l => l.textContent)) : [];
    console.log('diff', diff, (await page.$('[data-testid="build-notice"]')) ? await h.text('[data-testid="build-notice"]') : '');
    await page.keyboard.press('Escape'); await h.pause(200);
};
