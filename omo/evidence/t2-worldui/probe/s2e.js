module.exports = async (page, h) => {
    const b = () => page.$eval('[data-testid="build-mode"]', e => ({ ...e.dataset }));
    const diff = async () => (await page.$('[data-testid="build-diff"]')) ? page.$$eval('[data-testid="build-diff"] li', ls => ls.map(l => l.textContent)) : [];
    const notice = async () => (await page.$('[data-testid="build-notice"]')) ? h.text('[data-testid="build-notice"]') : '';
    const at = async (x, y) => { await page.mouse.move(x - 3, y - 3); await h.pause(80); await page.mouse.move(x, y); await h.pause(250); };
    // screen position of an entity: project via stationTargets for screens; else search the hover grid
    const findEntity = async id => {
        const t = JSON.parse((await h.ds()).stationTargets || '{}')[id];
        if (t) { const r = await page.$eval(h.CANVAS, c => { const b = c.getBoundingClientRect(); return [b.left, b.top]; }); return [r[0] + t.x, r[1] + t.y]; }
        const wrap = await page.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        for (let fy = 0.2; fy < 0.95; fy += 0.04) for (let fx = 0.15; fx < 0.85; fx += 0.03) {
            const x = Math.round(wrap[0] + wrap[2] * fx), y = Math.round(wrap[1] + wrap[3] * fy);
            await page.mouse.move(x, y); await h.pause(25);
            if ((await b()).hover === id) return [x, y];
        }
    };
    const select = async id => { const p = await findEntity(id); if (!p) throw new Error('cannot find ' + id); await at(p[0], p[1]); await page.mouse.click(p[0], p[1]); await h.pause(400); console.log('selected', (await b()).selected, 'at', p); return p; };
    // select plant-1, move it with M
    await select('plant-1');
    await page.keyboard.press('m'); await h.pause(200);
    await at(586, 668); console.log('move ghost', (await b()).ghost);
    await page.mouse.click(586, 668); await h.pause(400);
    console.log('after move', (await diff()).slice(-1));
    // rotate the new desk with R
    await select('desk-1');
    await page.keyboard.press('r'); await h.pause(400);
    console.log('after rotate', (await diff()).slice(-1));
    // delete the window decor with Delete
    await select('window');
    await page.keyboard.press('Delete'); await h.pause(400);
    console.log('after delete', (await diff()).slice(-1));
    await h.shot('s2-02-edits');
    // Ctrl+Z inside draft drops the last step
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await h.pause(400);
    console.log('after ctrl+z', await diff(), await notice());
    // Link tool: K, click desk-1 (source), then monitors-1
    await page.keyboard.press('k'); await h.pause(300);
    await select('desk-1');
    console.log('link source', (await b()).tool, await notice());
    await select('monitors-1');
    console.log('after link', (await diff()).slice(-1), await notice());
    await page.keyboard.press('Escape'); await h.pause(200);
    await h.shot('s2-03-link');
    console.log('full diff', await diff());
};
