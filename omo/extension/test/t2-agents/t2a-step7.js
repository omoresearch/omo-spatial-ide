module.exports = async (ctx) => {
    const { page, pause, fs, trust } = ctx;
    const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
    const S = '/home/harry/.hermes/profiles/omo-dev/cache/scratch/t2a-explore';
    const drv = require('/home/harry/dev/omo-t2-agents/omo/extension/test/world-test-driver.cjs');
    await require('./t2a-step1.js')(ctx);
    const out = {};
    const projectUri = await page.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('omo.room.v1:'))?.slice('omo.room.v1:'.length));
    const st = (id, label, x, z, kind = 'shell') => ({ id, kind: 'station', label, transform: { x, z, rotation: 0 }, station: { name: label, kind, tabs: [{ name: 'Shell', kind: 'shell' }], locked: false } });
    const world = { version: 2, name: 'T2 four desks', revision: 3, shell: { theme: 'station', width: 18, depth: 14 }, entities: [
        st('terminal', 'Desk one', -5.5, -2.2), st('terminal-2', 'Desk two', 0, -2.2), st('research', 'Research', 5.5, -2.2), st('ops', 'Ops', -6.5, 4.6),
        { id: 'web', kind: 'web-wall', label: 'Web wall', transform: { x: 0, z: -6.12, rotation: 0 }, width: 3.9, height: 2.44, elevation: 0.68 }] };
    await page.evaluate((key, w) => localStorage.setItem(key, JSON.stringify(w)), `omo.world.v2:${projectUri}`, world);
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !await page.$(`${CANVAS}[data-navigation="walk"]`); i++) { await trust(); await pause(300); }
    await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 60000 });
    for (let i = 0; i < 8; i++) { await trust(); await pause(300); }
    out.switch = await page.$$eval('.omo-station-switch button', bs => bs.map(b => b.dataset.testid + '=' + b.textContent));
    out.targets = await page.$eval(CANVAS, c => JSON.parse(c.dataset.stationTargets || '{}'));
    out.pose0 = await page.$eval(CANVAS, c => ({ x: c.dataset.playerX, z: c.dataset.playerZ }));
    await drv.walkTo(page, 5.5, -0.4).catch(e => out.walkErr = String(e));
    out.pose1 = await page.$eval(CANVAS, c => ({ x: c.dataset.playerX, z: c.dataset.playerZ }));
    await drv.clickStation(page, 'research').catch(e => out.clickErr = String(e));
    await page.waitForSelector('[data-testid="runtime-console"][data-phase="live"]', { timeout: 20000 }).catch(e => out.liveErr = String(e));
    out.console = await page.$eval('[data-testid="runtime-console"]', e => e.innerText).catch(() => 'none');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: __dirname + '/t2a-desk3.png' });
    return out;
};
