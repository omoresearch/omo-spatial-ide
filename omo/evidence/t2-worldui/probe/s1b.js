module.exports = async (page, h) => {
    const list = () => page.$$eval('[data-testid="onboarding-entity-list"] li', ls => ls.map(l => `${l.dataset.entity}:${l.querySelector('input').value}`));
    // rename Data -> Datasets
    const sel = '[data-testid="onboarding-rename-terminal-2"]';
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.type('Datasets'); await page.keyboard.press('Enter');
    await h.pause(400);
    console.log('after rename', await list());
    // remove Writing (desk-3)
    await page.$eval('[data-testid="onboarding-remove-desk-3"]', e => e.click());
    await h.pause(400);
    console.log('after remove', await list());
    // add a desk
    await page.$eval('[data-testid="onboarding-add-desk"]', e => e.click());
    await h.pause(400);
    console.log('after add', await list());
    // rename the new desk to "Writing desk"
    const ids = await page.$$eval('[data-testid="onboarding-entity-list"] li[data-kind="station"]', ls => ls.map(l => l.dataset.entity));
    const newId = ids[ids.length - 1];
    await page.click(`[data-testid="onboarding-rename-${newId}"]`, { clickCount: 3 });
    await page.keyboard.type('Writing desk'); await page.keyboard.press('Enter');
    await h.pause(800);
    console.log('final', await list(), 'summary', await h.text('[data-testid="onboarding-summary"]'));
    console.log('plan labels', await page.$$eval('[data-testid="onboarding-floor-plan"] text', ts => ts.map(t => t.textContent)));
    await h.pause(800);
    console.log('canvas', (await h.ds()).worldStations, (await h.labels()).map(l => l.t).join(' | '));
    await h.shot('s1-03-edited');
    await page.$eval('[data-testid="onboarding-next"]', e => e.click()); await h.pause(800);
    console.log('step3', await h.text('[data-testid="onboarding-create-summary"]'));
    await h.shot('s1-04-create');
    await page.$eval('[data-testid="onboarding-step-3"] ~ *, [data-testid="create-room"]', e => e.click());
    await page.waitForSelector(`${h.CANVAS}[data-navigation="walk"]`, { timeout: 30000 });
    await h.pause(2500);
    const d = await h.ds();
    console.log('room stations', d.worldStations, 'entities', d.worldEntities, 'name', d.worldName);
    console.log('switch', await page.$$eval('.omo-station-switch button', bs => bs.map(b => b.textContent)));
    console.log('footer', await h.text('.omo-footer'));
    await h.shot('s1-05-room-walk');
    await page.$eval('[data-testid="overview-mode"]', e => e.click()); await h.pause(2000);
    console.log('labels', JSON.stringify(await h.labels()));
    await h.shot('s1-06-room-overview');
};
