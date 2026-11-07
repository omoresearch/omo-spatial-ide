module.exports = async (page, h) => {
    const b = () => page.$eval('[data-testid="build-mode"]', e => ({ ...e.dataset }));
    const diff = async () => (await page.$('[data-testid="build-diff"]')) ? page.$$eval('[data-testid="build-diff"] li', ls => ls.map(l => l.textContent)) : [];
    const notice = async () => (await page.$('[data-testid="build-notice"]')) ? h.text('[data-testid="build-notice"]') : '';
    const saved = () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return JSON.parse(localStorage.getItem(k)); });
    const at = async (x, y) => { await page.mouse.move(x - 3, y - 3); await h.pause(80); await page.mouse.move(x, y); await h.pause(250); };
    const findEntity = async id => {
        const wrap = await page.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        for (let fy = 0.15; fy < 0.95; fy += 0.035) for (let fx = 0.1; fx < 0.9; fx += 0.025) {
            const x = Math.round(wrap[0] + wrap[2] * fx), y = Math.round(wrap[1] + wrap[3] * fy);
            await page.mouse.move(x, y); await h.pause(20);
            if ((await b()).hover === id) return [x, y];
        }
    };
    const select = async id => { const p = await findEntity(id); if (!p) throw new Error('cannot find ' + id); await at(p[0], p[1]); await page.mouse.click(p[0], p[1]); await h.pause(400); console.log('  clicked', id, '->selected', (await b()).selected, 'tool', (await b()).tool); return p; };
    if (!await page.$('[data-testid="build-mode"]')) { await page.$eval('[data-testid="overview-mode"]', e => e.click()); await h.pause(1000); await page.focus(h.CANVAS); await page.keyboard.press('b'); await h.pause(400); }
    console.log('tool at start', (await b()).tool);
    // move plant-1
    await select('plant-1'); await page.keyboard.press('m'); await h.pause(200);
    await at(586, 668); console.log('move ghost', (await b()).ghost); await page.mouse.click(586, 668); await h.pause(400);
    console.log('after move', (await diff()).slice(-1));
    // rotate monitors-1
    await select('monitors-1'); await page.keyboard.press('r'); await h.pause(300); console.log('after rotate', (await diff()).slice(-1));
    await page.keyboard.press('r'); await h.pause(300); await page.keyboard.press('r'); await h.pause(300); await page.keyboard.press('r'); await h.pause(300);
    // delete window
    await select('window'); await page.keyboard.press('Delete'); await h.pause(300); console.log('after delete', (await diff()).slice(-1));
    // link monitors-1 -> terminal (Literature)
    await page.keyboard.press('Escape'); await page.keyboard.press('k'); await h.pause(300);
    await select('terminal'); console.log('link source', await notice());
    await select('monitors-1'); console.log('after link', (await diff()).slice(-1), '|', await notice());
    await page.keyboard.press('Escape'); await h.pause(200);
    console.log('diff', await diff());
    await h.shot('s2-06-draft');
    await page.$eval('[data-testid="build-apply"]', e => e.click()); await h.pause(800);
    const s = await saved();
    console.log('applied rev', s.revision, await notice());
    console.log('monitors-1', JSON.stringify(s.entities.find(e => e.id === 'monitors-1')), 'plant', JSON.stringify(s.entities.find(e => e.id === 'plant-1')?.transform), 'window?', !!s.entities.find(e => e.id === 'window'));
    await page.$eval('[data-testid="build-exit"]', e => e.click()); await h.pause(500);
    console.log('build off', !await page.$('[data-testid="build-mode"]'));
    await h.shot('s2-07-applied');
};
