// t2:worldui exploration helper: connect to the lane's test Chrome (CDP 3521) and run a step file.
// Usage: node step.cjs <step.js>   (step file body: async (page, h) => {...})
const path = require('node:path');
const puppeteer = require('/home/harry/dev/omo-t2-worldui/omo/node_modules/puppeteer-core');
const S = __dirname;
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:3521', defaultViewport: { width: 1440, height: 900 } });
    const pages = await browser.pages();
    let page = pages.find(p => p.url().startsWith('http://127.0.0.1:3520')) || pages[0];
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
    const h = {
        CANVAS, pause, S,
        shot: async name => { const p = path.join(S, 'shots', name + '.png'); require('fs').mkdirSync(path.dirname(p), { recursive: true }); await page.screenshot({ path: p }); console.log('SHOT', p); return p; },
        trust: () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()),
        ds: () => page.$eval(CANVAS, c => ({ ...c.dataset })),
        text: sel => page.$eval(sel, e => e.innerText),
        click: sel => page.$eval(sel, e => e.click()),
        labels: () => page.$$eval('.omo-scene-label', ls => ls.map(l => ({ id: l.dataset.workstation, t: l.textContent, vis: l.style.visibility, r: (b => [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)])(l.getBoundingClientRect()) }))),
    };
    const step = require(path.resolve(process.argv[2]));
    try { await step(page, h); }
    catch (e) { console.log('STEP ERROR', e && e.stack || e); }
    if (errors.length) console.log('PAGE ERRORS', JSON.stringify(errors.slice(0, 10), null, 1));
    browser.disconnect();
})();
