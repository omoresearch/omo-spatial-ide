module.exports = async (page, h) => {
    const fs = require('fs');
    const key = await page.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')));
    const mine = await page.evaluate(k => localStorage.getItem(k), key);
    if (!fs.existsSync(h.S + '/research-world.json')) fs.writeFileSync(h.S + '/research-world.json', mine);
    const st = (id, label, x, z, kind = 'hermes', extra = {}) => ({ id, kind: 'station', label, transform: { x, z, rotation: 0 }, station: { name: label, kind, tabs: kind === 'hermes' ? [{ name: 'Hermes', kind: 'hermes' }, { name: 'Shell', kind: 'shell' }] : [{ name: 'Shell', kind: 'shell' }], locked: false, ...extra } });
    const six = { version: 2, name: 'W2 six desks', revision: 3, shell: { theme: 'station', width: 18, depth: 14 }, entities: [
        st('terminal', 'Desk one', -5.5, -2.2), st('terminal-2', 'Desk two', 0, -2.2, 'shell'), st('research', 'Research', 5.5, -2.2, 'hermes', { profile: 'omo-dev' }),
        st('builder', 'Builder', -5.5, 2.0, 'hermes', { locked: true }), st('ops', 'Ops', 0, 2.0, 'shell'), st('writer', 'Writer', 5.5, 2.0),
        { id: 'web', kind: 'web-wall', label: 'Web wall', transform: { x: 0, z: -6.12, rotation: 0 }, width: 3.9, height: 2.44, elevation: 0.68 },
        { id: 'wall-1', kind: 'monitor-wall', label: 'Research wall', transform: { x: 8.6, z: -1, rotation: -Math.PI / 2 }, width: 3.2, height: 1.8, elevation: 0.9, link: 'research' },
        { id: 'mirror', kind: 'mirror', label: 'Mirror · Desk one', link: 'terminal', transform: { x: -8.6, z: -1, rotation: Math.PI / 2 } },
        { id: 'code', kind: 'review-screen', label: 'Code review', transform: { x: -6.8, z: -5.9, rotation: 0 } },
        { id: 'plant-1', kind: 'decor', decor: 'plant', transform: { x: 8, z: 5.5, rotation: 0 } },
        { id: 'sofa-1', kind: 'decor', decor: 'sofa', transform: { x: -3, z: 5.4, rotation: Math.PI }, scale: 1 },
        { id: 'lamp-1', kind: 'decor', decor: 'lamp', transform: { x: 3, z: 5.6, rotation: 0 } },
        { id: 'shelf-1', kind: 'decor', decor: 'bookshelf', transform: { x: 7, z: -6.0, rotation: 0 } }] };
    await page.evaluate((k, w) => localStorage.setItem(k, JSON.stringify(w)), key, six);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`${h.CANVAS}[data-navigation="walk"]`, { timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
    await h.pause(2000);
    await page.$eval('[data-testid="overview-mode"]', e => e.click()); await h.pause(2000);
    console.log(JSON.stringify(await h.labels()));
    await h.shot(process.env.SHOT || 's6-00-six-before');
};
