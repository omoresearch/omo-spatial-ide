// Driver for actual application tests. No component harnesses, fake API routes or agent/model calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { launch } = require('puppeteer');
const ROOT = path.resolve(__dirname, '../..');
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function openWorld(tag, viewport = { width: 1440, height: 960 }) {
    const base = process.env.OMO_URL || 'http://127.0.0.1:3192';
    let ready = false;
    for (let i = 0; i < 200; i++) { try { if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* bounded application startup */ } await pause(100); }
    if (!ready) throw new Error('The actual local application is not HTTP-ready');
    const profile = path.join(ROOT, 'evidence', `${tag}-${crypto.randomUUID()}`);
    const browser = await launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, userDataDir: profile,
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'], defaultViewport: viewport });
    const page = await browser.newPage();
    const trust = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click());
    try {
        await page.goto(process.env.OMO_URL || 'http://127.0.0.1:3192', { waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 100 && !await page.$('[data-testid="omo-onboarding"]'); i++) { await trust(); await pause(150); }
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]');
        for (let i = 0; i < 3; i++) {
            await trust(); await page.click('[data-testid="create-room"]');
            try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 5000 }); break; } catch (error) { if (i === 2) throw error; }
        }
        return { browser, page, async dispose() { await browser.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
    } catch (error) { fs.writeFileSync(path.join(ROOT, 'evidence', `${tag}-failed.txt`), await page.evaluate(() => document.body.innerText).catch(() => 'Page unavailable')); await browser.close(); fs.rmSync(profile, { recursive: true, force: true }); throw error; }
}
async function axis(page, key, field, goal, direction) {
    await page.focus(CANVAS); await page.keyboard.down(key);
    try { await page.waitForFunction((field, goal, direction) => { const n = Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset[field]); return direction > 0 ? n >= goal : n <= goal; }, { timeout: 20000 }, field, goal, direction); }
    finally { await page.keyboard.up(key); }
}
async function walkTo(page, x, z) {
    await page.focus(CANVAS); await page.keyboard.press('Escape');
    let pose = await page.$eval(CANVAS, e => ({ x: Number(e.dataset.playerX), z: Number(e.dataset.playerZ) }));
    if (pose.z < 2.25) await axis(page, 's', 'playerZ', 2.25, 1); // route in front of desks, never through them
    pose = await page.$eval(CANVAS, e => ({ x: Number(e.dataset.playerX), z: Number(e.dataset.playerZ) }));
    if (Math.abs(pose.x - x) > .12) await axis(page, pose.x < x ? 'd' : 'a', 'playerX', x, pose.x < x ? 1 : -1);
    pose = await page.$eval(CANVAS, e => ({ x: Number(e.dataset.playerX), z: Number(e.dataset.playerZ) }));
    if (Math.abs(pose.z - z) > .12) await axis(page, pose.z < z ? 's' : 'w', 'playerZ', z, pose.z < z ? 1 : -1);
}
async function clickStation(page, station) {
    const point = await page.$eval(CANVAS, (e, station) => { const r = e.getBoundingClientRect(), t = JSON.parse(e.dataset.stationTargets || '{}')[station]; if (!t) return undefined; return { x: r.left + t.x, y: r.top + t.y }; }, station);
    if (!point) throw new Error(`Physical ${station} screen has no projected target`);
    await page.mouse.click(point.x, point.y);
}
async function command(page, station, text) {
    await clickStation(page, station);
    await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 30000 });
    await page.keyboard.type(text); await page.keyboard.press('Enter');
}
async function fileContents(file) { for (let i = 0; i < 200 && !fs.existsSync(file); i++) await pause(100); if (!fs.existsSync(file)) throw new Error(`The real process did not create ${path.basename(file)}`); return fs.readFileSync(file, 'utf8').trim(); }
module.exports = { ROOT, CANVAS, pause, openWorld, walkTo, clickStation, command, fileContents };
