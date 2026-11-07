module.exports = async (page, h) => {
    const C = h.CANVAS;
    // leave focus, back to the classic dock so the runtime strip shows desk-3
    if (await page.$('[data-testid="focus-exit"]')) { await page.$eval('[data-testid="focus-exit"]', e => e.click()); await h.pause(800); }
    await page.evaluate(() => localStorage.setItem('omo.focus.clickAttach', 'false'));
    await page.$eval('[data-testid="station-controls-desk-3"]', e => e.click()); await h.pause(800);
    console.log('active', await page.$eval('[data-testid="omo-world"]', e => e.dataset.activeStation));
    console.log('launchers', await page.$$eval('[data-testid^="runtime-new-"]', bs => bs.map(b => `${b.dataset.testid}:${b.disabled}`)));
    await page.$eval('[data-testid="runtime-new-hermes"]', e => e.click());
    await page.waitForSelector('[data-testid="runtime-confirm"]', { timeout: 10000 });
    console.log('confirm text', (await h.text('[data-testid="runtime-confirm"]')).slice(0, 200));
    await page.$eval('[data-testid="runtime-confirm-yes"]', e => e.click());
    await page.waitForFunction(() => (JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText || '{}')['desk-3'] || []).some(l => l.includes('FIXTURE-READY-hermes')), { timeout: 20000 });
    console.log('fixture hermes running on desk-3');
    // chat mention
    if (!await page.$('[data-testid="chat-input"]')) await page.$eval('[data-testid="chat-open"]', e => e.click());
    await page.waitForSelector('[data-testid="chat-input"]');
    await page.click('[data-testid="chat-input"]');
    await page.keyboard.type('@desk-3 summarise the literature notes');
    await page.$eval('[data-testid="chat-send"]', e => e.click()); await h.pause(1500);
    console.log('chat log', await page.$$eval('[data-testid="chat-log"] li', ls => ls.map(l => l.innerText.replace(/\s+/g, ' ')).slice(-2)));
    console.log('chat error', (await page.$('[data-testid="chat-error"]')) ? await h.text('[data-testid="chat-error"]') : '');
    const st = JSON.parse((await h.ds()).stationText)['desk-3'];
    console.log('desk-3 screen tail', JSON.stringify(st.filter(l => l.trim()).slice(-3)));
    console.log('received by fixture (must be no Enter => no FIXTURE-RECEIVED):', st.some(l => l.includes('FIXTURE-RECEIVED')));
    await h.shot('s4-04-mention');
};
