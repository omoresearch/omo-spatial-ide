module.exports = async (page, h) => {
    const fs = require('fs'), path = require('path');
    const dl = path.join(h.S, 'downloads'); fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl, { recursive: true });
    const cdp = await page.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }).catch(async () => cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }));
    const saved = () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return JSON.parse(localStorage.getItem(k)); });
    const openCustomise = async () => {
        await page.$eval('[data-testid="edit-room"]', e => e.click()); await h.pause(800);
        if (!await page.$('[data-testid="world-preset-panel"]')) {
            const btn = await page.$('[data-testid="onboarding-classic"]') || await page.$('[data-testid="onboarding-classic-footer"]');
            if (btn) { await btn.evaluate(e => e.click()); await h.pause(600); }
        }
        console.log('preset panel', !!await page.$('[data-testid="world-preset-panel"]'));
    };
    await openCustomise();
    console.log('templates', await page.$$eval('[data-testid="world-template"] option', os => os.map(o => `${o.value}=${o.textContent}`)));
    for (const [id, shot] of [['agent-lab', 's5-01-agent-lab'], ['startup-war-room', 's5-02-war-room']]) {
        await page.select('[data-testid="world-template"]', id); await h.pause(200);
        await page.$eval('[data-testid="world-template-preview"]', e => e.click()); await h.pause(2500);
        console.log(id, 'preview:', (await h.text('[data-testid="world-preset-preview"]')).split('\n').slice(0, 3).join(' / '));
        console.log(' status', await h.text('[data-testid="room-preset-status"]'), '| canvas stations', (await h.ds()).worldStations);
        await page.evaluate(() => document.querySelector('[data-testid="world-preset-preview"]')?.scrollIntoView());
        await h.shot(shot);
    }
    // save the war room
    await page.$eval('[data-testid="create-room"]', e => e.click()); await h.pause(2500);
    const s = await saved();
    console.log('saved world', s.name, 'rev', s.revision, 'stations', s.entities.filter(e => e.kind === 'station').map(e => e.label));
    console.log('canvas', (await h.ds()).worldStations, 'switch', await page.$$eval('.omo-station-switch button', bs => bs.map(b => b.textContent)));
    await page.$eval('[data-testid="overview-mode"]', e => e.click()).catch(() => {}); await h.pause(1500);
    await h.shot('s5-03-war-room-saved');
    // export
    await openCustomise();
    await page.$eval('[data-testid="world-preset-export"]', e => e.click()); await h.pause(2000);
    const files = fs.readdirSync(dl); console.log('downloads', files);
    const raw = fs.readFileSync(path.join(dl, files[0]), 'utf8');
    const leaks = [/\/home\//, /file:\/\//, /\.hermes/, /scratch/, /workspaceId/i, /token/i, /sk-[A-Za-z0-9]/, /project/i].filter(r => r.test(raw)).map(String);
    console.log('export bytes', raw.length, 'leaks', leaks, 'head', raw.slice(0, 160).replace(/\n/g, ' '));
    fs.copyFileSync(path.join(dl, files[0]), path.join(h.S, 'exported-world.json'));
    // re-import into a different template preview then save
    await page.select('[data-testid="world-template"]', 'agent-lab'); await page.$eval('[data-testid="world-template-preview"]', e => e.click()); await h.pause(800);
    await page.$eval('[data-testid="world-preset-discard"]', e => e.click()); await h.pause(500);
    const input = await page.$('[data-testid="room-preset-import"]');
    await input.uploadFile(path.join(h.S, 'exported-world.json')); await h.pause(2000);
    console.log('import status', await h.text('[data-testid="room-preset-status"]'), '| error', await h.text('.omo-footer'));
    console.log('import preview', (await page.$('[data-testid="world-preset-preview"]')) ? (await h.text('[data-testid="world-preset-preview"]')).split('\n')[0] : 'none');
    await h.shot('s5-04-import-preview');
    await page.$eval('[data-testid="create-room"]', e => e.click()); await h.pause(2000);
    const s2 = await saved();
    console.log('after import save', s2.name, 'rev', s2.revision, 'stations', s2.entities.filter(e => e.kind === 'station').map(e => e.label), 'same entities as export:', JSON.stringify(s2.entities.map(e => e.id)) === JSON.stringify(JSON.parse(raw).world.entities.map(e => e.id)));
};
