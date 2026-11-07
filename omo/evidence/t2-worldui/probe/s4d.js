module.exports = async (page, h) => {
    const C = h.CANVAS;
    if (await page.$('[data-testid="chat-close"]')) { await page.$eval('[data-testid="chat-close"]', e => e.click()); await h.pause(300); }
    const tabs = await page.$$eval('[data-testid="runtime-console"] [role="tab"]', ts => ts.map(t => `${t.dataset.testid}|${t.innerText.trim()}|${t.getAttribute('aria-selected')}`));
    console.log('desk-3 tabs', tabs);
    const shellTab = tabs.find(t => /shell/i.test(t.split('|')[1]));
    await page.$eval(`[data-testid="${shellTab.split('|')[0]}"]`, e => e.click()); await h.pause(800);
    // type into desk-3 shell via its monitor
    const t = JSON.parse((await h.ds()).stationTargets)['desk-3'];
    const r = await page.$eval(C, c => { const b = c.getBoundingClientRect(); return [b.left, b.top]; });
    await page.mouse.click(r[0] + t.x, r[1] + t.y); await h.pause(600);
    await page.keyboard.type("sleep 4; printf '\\a'; echo BELL-DESK-3"); await page.keyboard.press('Enter');
    await h.pause(300);
    // walk away: Esc and switch to desk one
    await page.keyboard.press('Escape'); await h.pause(200);
    await page.$eval('[data-testid="station-one-controls"]', e => e.click()); await h.pause(300);
    console.log('active now', await page.$eval('[data-testid="omo-world"]', e => e.dataset.activeStation));
    await page.waitForFunction(() => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationBells || '{}')['desk-3'] > 0, { timeout: 20000 });
    console.log('bells', (await h.ds()).stationBells, 'lamps', (await h.ds()).stationLamps);
    await h.pause(2500);
    console.log('desk-3 switch bell', (await page.$('[data-testid="station-bell-desk-3"]')) ? await h.text('[data-testid="station-bell-desk-3"]') : 'none');
    console.log('hud unread', (await page.$('[data-testid="hud-notices-unread"]')) ? await h.text('[data-testid="hud-notices-unread"]') : 'none');
    await h.shot('s4-05-bell');
    await page.$eval('[data-testid="hud-notices-toggle"]', e => e.click()); await h.pause(500);
    console.log('notices', await page.$$eval('[data-testid="hud-notices"] li', ls => ls.map(l => l.innerText.replace(/\s+/g, ' '))));
    await h.shot('s4-06-bell-notices');
    const jumps = await page.$$('[data-testid="hud-notice-jump"]');
    if (jumps.length) { await jumps[0].click(); await h.pause(2000); }
    console.log('after jump active', await page.$eval('[data-testid="omo-world"]', e => e.dataset.activeStation), 'bells', (await h.ds()).stationBells, 'footer', await h.text('.omo-footer'));
    await h.shot('s4-07-bell-jump');
};
