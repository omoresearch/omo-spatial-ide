// t2:agents exploration helper: node t2a-explore.cjs <port> <step-script.js>
// Keeps one Chrome open per call; prints JSON from the step.
const path = require('path');
const ROOT = '/home/harry/dev/omo-t2-agents/omo';
const { launch } = require(path.join(ROOT, 'node_modules/puppeteer'));
const fs = require('fs');
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    const [port, stepFile] = process.argv.slice(2);
    const base = `http://127.0.0.1:${port}/`;
    const browser = await launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(__dirname, 't2a-chrome'),
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1440, height: 960 } });
    const page = (await browser.pages())[0] || await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('omo.focus.clickAttach', 'false'); localStorage.setItem('omo.coach.v1', 'seen'); } catch {} });
    const trust = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click());
    const ctx = { page, pause, trust, base, errors, fs, path };
    try {
        const step = require(path.resolve(stepFile));
        const out = await step(ctx);
        console.log(JSON.stringify({ out, errors }, null, 1));
    } catch (e) { console.log('STEP ERROR', e); await page.screenshot({ path: path.join(__dirname, 't2a-fail.png') }); }
    finally { await browser.close(); }
})();
