module.exports = async (page, h) => {
    const b = () => page.$eval('[data-testid="build-mode"]', e => ({ ...e.dataset }));
    const diff = async () => (await page.$('[data-testid="build-diff"]')) ? page.$$eval('[data-testid="build-diff"] li', ls => ls.map(l => l.textContent)) : [];
    const notice = async () => (await page.$('[data-testid="build-notice"]')) ? h.text('[data-testid="build-notice"]') : '';
    const saved = () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return JSON.parse(localStorage.getItem(k)); });
    const at = async (x, y) => { await page.mouse.move(x - 3, y - 3); await h.pause(80); await page.mouse.move(x, y); await h.pause(250); };
    const findEntity = async id => {
        const wrap = await page.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        for (let fy = 0.2; fy < 0.95; fy += 0.04) for (let fx = 0.15; fx < 0.85; fx += 0.03) {
            const x = Math.round(wrap[0] + wrap[2] * fx), y = Math.round(wrap[1] + wrap[3] * fy);
            await page.mouse.move(x, y); await h.pause(25);
            if ((await b()).hover === id) return [x, y];
        }
    };
    const select = async id => { const p = await findEntity(id); if (!p) throw new Error('cannot find ' + id); await at(p[0], p[1]); await page.mouse.click(p[0], p[1]); await h.pause(400); return p; };
    const p = await select('desk-1');
    console.log('selected', (await b()).selected);
    await page.$eval('[data-testid="build-open-setup"]', e => e.click()); await h.pause(500);
    console.log('setup open', !!await page.$('[data-testid="station-setup"]'));
    await page.click('[data-testid="setup-name"]', { clickCount: 3 }); await page.keyboard.type('Codex bench');
    console.log('profiles', await page.$$eval('[data-testid="setup-profile"] option', os => os.map(o => o.value)));
    const profs = await page.$$eval('[data-testid="setup-profile"] option', os => os.map(o => o.value).filter(Boolean));
    if (profs.length) await page.select('[data-testid="setup-profile"]', profs[0]);
    await page.$eval('[data-testid="setup-add-tab"]', e => e.click()); await h.pause(200);
    const n = await page.$$eval('[data-testid="setup-tabs"] li', ls => ls.length);
    await page.select(`[aria-label="Tab ${n} kind"]`, 'codex');
    await page.click(`[aria-label="Tab ${n} name"]`, { clickCount: 3 }); await page.keyboard.type('Codex');
    await page.$eval('[data-testid="setup-lock"]', e => e.click()); await h.pause(200);
    await h.shot('s2-04-station-setup');
    await page.$eval('[data-testid="setup-save"]', e => e.click()); await h.pause(500);
    console.log('diff after setup', await diff());
    // Apply
    const before = (await saved()).revision;
    await page.$eval('[data-testid="build-apply"]', e => e.click()); await h.pause(800);
    const s1 = await saved();
    console.log('applied: rev', before, '->', s1.revision, 'notice', await notice());
    const d1 = s1.entities.find(e => e.id === 'desk-1'), m1 = s1.entities.find(e => e.id === 'monitors-1'), pl = s1.entities.find(e => e.id === 'plant-1');
    console.log('desk-1', JSON.stringify(d1));
    console.log('monitors-1 link', m1 && m1.link, 'plant', pl && JSON.stringify(pl.transform), 'window present', !!s1.entities.find(e => e.id === 'window'));
    // locked desk refuses edits
    await select('desk-1');
    await page.keyboard.press('Delete'); await h.pause(300); console.log('locked delete ->', await notice(), '| diff', await diff());
    await page.keyboard.press('m'); await h.pause(300); console.log('locked move ->', await notice(), (await b()).tool);
    await page.keyboard.press('r'); await h.pause(300); console.log('locked rotate ->', await notice(), '| diff', await diff());
    console.log('rename disabled', await page.$eval('[data-testid="build-rename"]', e => e.disabled), 'locked badge', !!await page.$('[data-testid="build-locked"]'));
    await h.shot('s2-05-locked');
    // Undo / redo of the applied change
    await page.keyboard.press('Escape'); await h.pause(200);
    await page.focus(h.CANVAS);
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await h.pause(600);
    const s2 = await saved();
    console.log('after undo rev', s2.revision, 'desk-1?', !!s2.entities.find(e => e.id === 'desk-1'), await notice());
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await h.pause(600);
    const s3 = await saved();
    console.log('after redo rev', s3.revision, 'desk-1?', !!s3.entities.find(e => e.id === 'desk-1'), await notice());
    // Discard: place a plant, then discard
    await page.$eval('[data-testid="build-item-decor-lamp"]', e => e.click()); await h.pause(200);
    await at(451, 668); await page.mouse.click(451, 668); await h.pause(400);
    console.log('lamp pending', await diff());
    await page.keyboard.press('Escape'); await h.pause(200);
    await page.$eval('[data-testid="build-discard"]', e => e.click()); await h.pause(400);
    const s4 = await saved();
    console.log('after discard', !!await page.$('[data-testid="build-proposal"]'), 'lamp saved?', s4.entities.some(e => e.kind === 'decor' && e.decor === 'lamp'), 'canvas', (await h.ds()).worldEntities);
};
