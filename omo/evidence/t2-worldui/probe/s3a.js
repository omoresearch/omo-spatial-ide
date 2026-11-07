module.exports = async (page, h) => {
    const saved = () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return JSON.parse(localStorage.getItem(k)); });
    const summary = w => w.entities.map(e => `${e.id}${e.kind === 'station' ? `[${e.label}${e.station.locked ? ',L' : ''}]` : e.link ? `->${e.link}` : ''}@${e.transform.x},${e.transform.z},${Math.round(e.transform.rotation * 100) / 100}`).join(' ');
    // open admin with H on the canvas
    await page.$eval('[data-testid="overview-mode"]', e => e.click()); await h.pause(800);
    await page.focus(h.CANVAS); await page.keyboard.press('h'); await h.pause(600);
    if (!await page.$('[data-testid="admin-panel"]')) { console.log('H did not open admin; using button'); await page.$eval('[data-testid="admin-toggle"]', e => e.click()); await h.pause(500); }
    console.log('admin open', !!await page.$('[data-testid="admin-panel"]'), 'planner', await h.text('.omo-admin-planner'));
    const ask = async (text, shot) => {
        const before = await saved();
        await page.click('[data-testid="admin-prompt"]'); await page.keyboard.type(text); await page.keyboard.press('Enter');
        await page.waitForFunction(() => { const es = [...document.querySelectorAll('[data-testid="admin-entry"]')]; const l = es[es.length - 1]; return l && l.dataset.status !== 'thinking'; }, { timeout: 20000 });
        await h.pause(800);
        const entry = await page.$$eval('[data-testid="admin-entry"]', es => { const l = es[es.length - 1]; return { status: l.dataset.status, expl: l.querySelector('[data-testid="admin-explanation"]')?.innerText, ops: [...l.querySelectorAll('[data-testid="admin-ops"] li')].map(x => x.innerText.replace(/\s+/g, ' ')) }; });
        const mid = await saved();
        console.log(`\nASK "${text}"\n status=${entry.status}\n expl=${entry.expl}\n ops=${JSON.stringify(entry.ops)}\n saved unchanged before Apply: ${mid.revision === before.revision}`);
        console.log(' canvas preview entities', (await h.ds()).worldEntities);
        await h.shot(shot + '-proposal');
        if (entry.status === 'proposed') {
            const applies = await page.$$('[data-testid="admin-apply"]');
            await applies[applies.length - 1].click(); await h.pause(1500);
            const after = await saved();
            console.log(' applied rev', before.revision, '->', after.revision);
            console.log(' world', summary(after));
            console.log(' canvas', (await h.ds()).worldStations, (await h.labels()).map(l => l.t).join(' | '));
            await h.shot(shot + '-applied');
        }
    };
    await ask('add a third desk for Codex and a big monitor wall linked to it', 's3-01');
    await ask('rename Desk two to Review', 's3-02');
    await ask('arrange desks in a U', 's3-03');
};
