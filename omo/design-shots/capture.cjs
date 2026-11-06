#!/usr/bin/env node
// Capture design screenshots from a running Omo instance.
// Usage: OMO_URL=http://127.0.0.1:3302 node design-shots/capture.cjs <prefix>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { launch } = require('puppeteer');
const prefix = process.argv[2] || 'shot';
const url = process.env.OMO_URL || 'http://127.0.0.1:3302';
const outDir = path.resolve(__dirname);
const delay = ms => new Promise(r => setTimeout(r, ms));
const W = Number(process.env.OMO_W || 1440), H = Number(process.env.OMO_H || 900);

(async () => {
    const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-shots-'));
    const browser = await launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: profile,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'], defaultViewport: { width: W, height: H } });
    const shot = async (page, name) => { const file = path.join(outDir, `${prefix}-${name}.png`); await page.screenshot({ path: file }); console.log('saved', file); };
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('[data-testid="omo-world"]', { timeout: 60000 });
        await delay(4000);
        await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors'); if (b) b.click(); });
        await delay(800);
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 30000 }).catch(() => {});
        await delay(1500);
        if (await page.$('[data-testid="omo-onboarding"]')) {
            await shot(page, '01-setup-station');
            await page.click('[data-testid="theme-jungle"]'); await delay(1500);
            await shot(page, '02-setup-jungle');
            await page.click('[data-testid="theme-station"]'); await delay(800);
            await page.click('[data-testid="room-name"]', { clickCount: 3 });
            await page.keyboard.type('Omo Design Room');
            await page.click('[data-testid="create-room"]'); await delay(2500);
        }
        await shot(page, '03-world');
        const toggle = await page.$('[data-testid="runtime-manage-toggle"]');
        if (toggle) { await toggle.click(); await delay(600); await shot(page, '04-world-manage'); await toggle.click(); await delay(300); }
        const wf = await page.$('[data-testid="agent-workflow-toggle"]');
        if (wf) { await wf.click(); await delay(800); await shot(page, '05-agent-task'); }
        await page.click('[data-testid="task-overview-toggle"]').catch(() => {}); await delay(1000);
        await shot(page, '06-task-overview');
        await page.click('[data-testid="task-workspace-toggle"]').catch(() => {}); await delay(1500);
        await shot(page, '07-task-workspaces');
        await page.click('[data-testid="review-action"]').catch(() => {}); await delay(2500);
        const first = await page.$('[data-review-path]'); if (first) { await first.click(); await delay(1200); }
        await shot(page, '08-code-review');
        await page.click('[data-testid="git-review-close"]').catch(() => {}); await delay(800);
        await page.click('[data-testid="edit-room"]').catch(() => {}); await delay(1500);
        await shot(page, '09-customise');
    } finally {
        await browser.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exit(1); });
