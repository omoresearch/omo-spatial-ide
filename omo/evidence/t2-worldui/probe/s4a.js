module.exports = async (page, h) => {
    const C = h.CANVAS;
    if (await page.$('[data-testid="build-mode"]')) { await page.$eval('[data-testid="build-exit"]', e => e.click()); await h.pause(300); }
    await page.$eval('[data-testid="walk-mode"]', e => e.click()); await h.pause(1200);
    const pos = JSON.parse((await h.ds()).deskPositions);
    console.log('desks', JSON.stringify(pos));
    const axis = async (key, field, goal, dir) => {
        const reached = () => page.$eval(C, (c, f, g, d) => { const n = Number(c.dataset[f]); return d > 0 ? n >= g : n <= g; }, field, goal, dir);
        const deadline = Date.now() + 30000;
        while (!await reached()) {
            if (Date.now() > deadline) throw new Error(`walk ${key} stuck: ${JSON.stringify(await page.$eval(C, c => ({ x: c.dataset.playerX, z: c.dataset.playerZ })))}`);
            await page.focus(C); await page.keyboard.down(key);
            try { for (let t = 0; t < 20 && !await reached(); t++) await h.pause(40); } finally { await page.keyboard.up(key); }
        }
    };
    const walkTo = async (x, z) => {
        await page.focus(C); await page.keyboard.press('Escape');
        let p = await page.$eval(C, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ, yaw: e.dataset.playerYaw }));
        console.log('  from', JSON.stringify(p));
        if (Math.abs(p.z - (z)) > .12) await axis(p.z < z ? 's' : 'w', 'playerZ', z, p.z < z ? 1 : -1);
        p = await page.$eval(C, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ }));
        if (Math.abs(p.x - x) > .12) await axis(p.x < x ? 'd' : 'a', 'playerX', x, p.x < x ? 1 : -1);
        console.log('  at', await page.$eval(C, e => `${e.dataset.playerX},${e.dataset.playerZ}`));
    };
    const d3 = pos['desk-3'];
    await walkTo(d3.x, d3.z + 2.2);
    await h.pause(600);
    const t = JSON.parse((await h.ds()).stationTargets)['desk-3'];
    const r = await page.$eval(C, c => { const b = c.getBoundingClientRect(); return [b.left, b.top]; });
    console.log('target desk-3', JSON.stringify(t));
    await page.mouse.click(r[0] + t.x, r[1] + t.y);
    await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 30000 });
    console.log('active', await page.$eval('[data-testid="omo-world"]', e => e.dataset.activeStation));
    await h.pause(800);
    await page.keyboard.type('echo omo-desk-3'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => (JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText || '{}')['desk-3'] || []).some(l => l.trim() === 'omo-desk-3'), { timeout: 20000 });
    const st = JSON.parse((await h.ds()).stationText);
    console.log('desk-3 text', JSON.stringify(st['desk-3'].filter(l => l.trim()).slice(-4)));
    console.log('other desks have it?', Object.entries(st).filter(([k, v]) => k !== 'desk-3' && v.some(l => l.includes('omo-desk-3'))).map(([k]) => k));
    await h.shot('s4-01-desk3-shell');
};
