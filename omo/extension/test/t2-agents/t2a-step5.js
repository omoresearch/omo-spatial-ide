module.exports = async (ctx) => {
    const { page, pause, fs } = ctx;
    const S = '/home/harry/.hermes/profiles/omo-dev/cache/scratch/t2a-explore';
    fs.writeFileSync(S + '/fake/node-version', 'v24.10.0\n');
    await pause(31000); // host caches the node check for 30 s
    await require('./t2a-step1.js')(ctx);
    const out = {};
    out.dshBtn = await page.$eval('[data-testid="runtime-new-dsh"]', e => ({ disabled: e.disabled, title: e.title }));
    await page.click('[data-testid="runtime-new-dsh"]'); await page.waitForSelector('[data-testid="runtime-confirm"]');
    out.dshConfirm = await page.$eval('[data-testid="runtime-confirm"]', e => e.innerText);
    out.before = fs.readFileSync(S + '/fake/argv.jsonl', 'utf8').includes('"dsh"');
    await page.click('[data-testid="runtime-confirm-yes"]');
    for (let i = 0; i < 60 && !fs.readFileSync(S + '/fake/argv.jsonl', 'utf8').includes('"dsh"'); i++) await pause(200);
    out.dshArgv = fs.readFileSync(S + '/fake/argv.jsonl', 'utf8').trim().split('\n').filter(l => l.includes('"dsh"')).pop();
    await page.waitForSelector('[data-testid="dsh-open-web"]', { timeout: 20000 }).catch(e => out.noBtn = String(e));
    out.row = await page.$eval('[data-testid="dsh-web-row"]', e => e.innerText).catch(() => 'none');
    out.dest = await page.$eval('[data-testid="dsh-open-web"]', e => e.dataset.destination).catch(() => 'none');
    await page.click('[data-testid="dsh-open-web"]').catch(() => {});
    await page.waitForSelector('[data-testid="web-controls"][data-phase="live"]', { timeout: 30000 }).catch(e => out.webErr = String(e));
    await pause(2000);
    out.web = await page.$eval('[data-testid="web-controls"]', e => e.innerText).catch(() => 'none');
    out.webAddr = await page.$eval('[data-testid="web-address"]', e => e.value).catch(() => 'none');
    out.webTabs = await page.$$eval('[data-testid="web-tab-select"]', bs => bs.map(b => b.title));
    await page.screenshot({ path: __dirname + '/t2a-dsh.png' });
    return out;
};
