#!/usr/bin/env node
// Runs physics/test.html in headless Chrome (same server/launch as capture.cjs) and prints window.__results.
// Usage: node run-test.cjs [port] [page]
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const DIR = __dirname, THREE_DIR = '~/dev/omo-skyscraper/omo/node_modules/three';
const PORT = Number(process.argv[2] || 3672), PAGE = process.argv[3] || 'test.html';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const file = u.startsWith('/three/') ? path.join(THREE_DIR, u.slice(7)) : path.join(DIR, u === '/' ? 'index.html' : u);
    if (!file.startsWith(DIR) && !file.startsWith(THREE_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(b); });
});
(async () => {
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    const browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new',
        args: ['--no-sandbox', '--window-size=1600,900', '--ignore-gpu-blocklist', '--use-angle=gl-egl', '--use-gl=angle'], defaultViewport: { width: 1600, height: 900 } });
    let code = 1;
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e.message || e)));
        page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); else if (m.text().startsWith('[walk-test]')) console.log(m.text()); });
        await page.goto(`http://127.0.0.1:${PORT}/${PAGE}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
        const res = await page.evaluate(() => window.__results);
        if (process.env.SHOT) { await page.evaluate(t => window.__tourAt(t), Number(process.env.SHOT_T || 0.5)); await page.screenshot({ path: process.env.SHOT }); }
        const fails = res.filter(r => !r.pass).length;
        console.log(`RESULT ${res.length - fails}/${res.length} PASS, errors=${errors.length}`);
        errors.forEach(e => console.log('ERROR', e));
        code = fails || errors.length ? 1 : 0;
    } catch (e) { console.log('RUN ERROR', e.stack || e); }
    finally { await browser.close().catch(() => {}); server.close(); process.exit(code); }
})();
