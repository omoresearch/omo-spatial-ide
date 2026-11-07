module.exports = async (page, h) => {
    await page.$eval('[data-testid="overview-mode"]', e => e.click()); await h.pause(1500);
    const wrap = await page.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    console.log('wrap', wrap);
    await page.focus(h.CANVAS); await page.keyboard.press('b'); await h.pause(500);
    console.log('build active', !!await page.$('[data-testid="build-mode"]'));
    await page.$eval('[data-testid="build-item-agent-desk"]', e => e.click()); await h.pause(300);
    const grid = [];
    for (const fx of [0.3, 0.4, 0.5, 0.6, 0.7]) for (const fy of [0.35, 0.5, 0.65, 0.8]) {
        const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
        await page.mouse.move(x, y); await h.pause(120);
        grid.push([Math.round(x), Math.round(y), await page.$eval('[data-testid="build-mode"]', e => e.dataset.ghost)]);
    }
    console.log(grid.map(g => g.join(' ')).join('\n'));
    await h.shot('s2-00-ghost');
};
