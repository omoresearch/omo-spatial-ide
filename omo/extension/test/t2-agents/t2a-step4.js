module.exports = async (ctx) => {
    const { page, pause, fs } = ctx;
    const S = '/home/harry/.hermes/profiles/omo-dev/cache/scratch/t2a-explore';
    await require('./t2a-step1.js')(ctx);
    const out = {};
    out.hint = await page.$eval('[data-testid="runtime-install-hint"]', e => e.innerText).catch(() => 'no hint row');
    out.dshBtn = await page.$eval('[data-testid="runtime-new-dsh"]', e => ({ disabled: e.disabled, title: e.title }));
    // Turn off
    await page.click('[data-testid="agents-toggle"]');
    await page.waitForSelector('[data-testid="claude-status-disable"]', { timeout: 15000 });
    await page.click('[data-testid="claude-status-disable"]');
    await page.waitForSelector('[data-testid="claude-status-confirm"]');
    out.offConfirm = await page.$eval('[data-testid="claude-status-confirm"]', e => e.innerText);
    out.existsBeforeOff = fs.existsSync(S + '/data/claude-status/settings.json');
    await page.click('[data-testid="claude-status-confirm-yes"]');
    await page.waitForSelector('[data-testid="claude-status-enable"]', { timeout: 10000 });
    out.existsAfterOff = fs.existsSync(S + '/data/claude-status/settings.json');
    out.stateAfterOff = await page.$eval('[data-testid="claude-status-state"]', e => e.textContent);
    // Claude after off: no --settings
    await page.click('[data-testid="runtime-new-claude"]'); await page.waitForSelector('[data-testid="runtime-confirm"]');
    await page.click('[data-testid="runtime-confirm-yes"]');
    for (let i = 0; i < 60 && fs.readFileSync(S + '/fake/argv.jsonl', 'utf8').trim().split('\n').filter(l => l.includes('"claude"')).length < 2; i++) await pause(200);
    out.claudeOffArgv = fs.readFileSync(S + '/fake/argv.jsonl', 'utf8').trim().split('\n').filter(l => l.includes('"claude"')).pop();
    // Codex
    await pause(1500);
    await page.click('[data-testid="runtime-new-codex"]'); await page.waitForSelector('[data-testid="runtime-confirm"]');
    out.codexConfirm = await page.$eval('[data-testid="runtime-confirm"]', e => e.innerText);
    out.codexBefore = fs.readFileSync(S + '/fake/argv.jsonl', 'utf8').includes('"codex"');
    await page.click('[data-testid="runtime-confirm-yes"]');
    for (let i = 0; i < 60 && !fs.readFileSync(S + '/fake/argv.jsonl', 'utf8').includes('"codex"'); i++) await pause(200);
    out.codexArgv = fs.readFileSync(S + '/fake/argv.jsonl', 'utf8').trim().split('\n').filter(l => l.includes('"codex"')).pop();
    await pause(3000);
    out.screen = await page.$eval('canvas[data-testid="omo-world-canvas"]', c => JSON.parse(c.dataset.stationText || '{}').terminal);
    await page.screenshot({ path: __dirname + '/t2a-codex.png' });
    return out;
};
