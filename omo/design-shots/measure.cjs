#!/usr/bin/env node
// Print bounding boxes of the main chrome regions (design QA helper).
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { launch } = require('puppeteer');
const url = process.env.OMO_URL || 'http://127.0.0.1:3302';
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-measure-'));
    const browser = await launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: profile,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('[data-testid="omo-world"]', { timeout: 60000 }); await delay(5000);
        if (await page.$('[data-testid="omo-onboarding"]')) {
            await page.click('[data-testid="room-name"]', { clickCount: 3 }); await page.keyboard.type('Omo Design Room');
            await page.click('[data-testid="create-room"]'); await delay(2500);
        }
        const out = await page.evaluate(() => {
            const sel = ['.omo-header', '.omo-stage-heading', '.omo-console-dock', '.omo-station-switch', '.omo-presence-bar', '[data-testid="runtime-console"]', 'canvas[data-testid="omo-world-canvas"]', '.omo-footer', '#theia-statusBar', '#theia-top-panel'];
            return sel.map(s => { const e = document.querySelector(s); if (!e) return `${s}: missing`; const r = e.getBoundingClientRect(); return `${s}: x=${r.x|0} y=${r.y|0} w=${r.width|0} h=${r.height|0}`; });
        });
        console.log(out.join('\n'));
        const ok = await page.evaluate(() => document.querySelector('[data-testid="runtime-console"]').getBoundingClientRect().bottom <= document.querySelector('canvas[data-testid="omo-world-canvas"]').getBoundingClientRect().top + 1);
        console.log('console above canvas:', ok);
    } finally { await browser.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
