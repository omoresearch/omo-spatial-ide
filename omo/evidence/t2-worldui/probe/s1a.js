module.exports = async (page, h) => {
    await page.evaluateOnNewDocument(() => {
        try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
        const trust = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click();
        new MutationObserver(trust).observe(document, { childList: true, subtree: true });
    });
    await page.goto('http://127.0.0.1:3520/', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 300 && !await page.$('[data-testid="omo-onboarding"]'); i++) { await h.trust(); await h.pause(200); }
    await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
    await h.pause(1500);
    console.log('step', await page.$eval('[data-testid="omo-onboarding"]', e => e.dataset.onboardingStep));
    await page.click('[data-testid="onboarding-prompt"]');
    await page.keyboard.type('research lab: 3 Hermes desks for literature, data and writing, a shared monitor wall, a web wall for papers');
    await h.pause(800);
    console.log('understood:', await h.text('[data-testid="onboarding-understood"]'));
    console.log('name:', await page.$eval('[data-testid="room-name"]', e => e.value));
    await h.shot('s1-01-describe');
    await page.click('[data-testid="onboarding-next"]');
    await h.pause(1500);
    console.log('summary:', await h.text('[data-testid="onboarding-summary"]'));
    console.log('entities:', await page.$$eval('[data-testid="onboarding-entity-list"] li', ls => ls.map(l => `${l.dataset.entity}:${l.dataset.kind}:${l.querySelector('input').value}`)));
    console.log('canvas:', JSON.stringify(await h.ds().then(d => ({ worldName: d.worldName, stations: d.worldStations, entities: d.worldEntities }))));
    await h.shot('s1-02-world');
};
