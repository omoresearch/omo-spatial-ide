module.exports = async (page, h) => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`${h.CANVAS}[data-navigation="walk"]`, { timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
    await h.pause(2500);
    const d = await h.ds();
    console.log('reload stations', d.worldStations, 'entities', d.worldEntities, 'name', d.worldName);
    console.log('onboarding?', !!await page.$('[data-testid="omo-onboarding"]'));
    console.log('switch', await page.$$eval('.omo-station-switch button', bs => bs.map(b => `${b.dataset.testid}=${b.textContent}`)));
    console.log('heading', await h.text('.omo-stage-heading h2'));
    const ls = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('omo.')).map(k => [k, localStorage.getItem(k).slice(0, 200)])));
    console.log(JSON.stringify(ls, null, 1));
    await h.shot('s1-07-reload');
};
