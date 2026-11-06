// Immersive world check on an isolated instance (port 3361). Real app, real tmux, no model calls.
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('puppeteer');
const URL_ = process.env.OMO_URL || 'http://127.0.0.1:3361';
const OUT = process.env.OUT || __dirname;
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
function check(name, ok, details) { results.push({ name, ok: !!ok, details }); console.log(ok ? 'PASS' : 'FAIL', name, details === undefined ? '' : JSON.stringify(details)); }

async function chrome(page) {
    return page.evaluate(sel => {
        const vis = q => { const e = document.querySelector(q); if (!e) return null; const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
        const c = document.querySelector(sel), r = c?.getBoundingClientRect();
        return {
            bodyClass: document.body.classList.contains('omo-immersive-world'),
            immersive: document.querySelector('.omo-root')?.dataset.immersive,
            canvas: c ? { w: c.clientWidth, h: c.clientHeight, x: Math.round(r.left), y: Math.round(r.top), bufW: c.width, bufH: c.height } : null,
            topPanel: vis('#theia-top-panel'), statusBar: vis('#theia-statusBar'), left: vis('#theia-left-content-panel'),
            header: vis('.omo-header'), footer: vis('.omo-footer'), stationRow: vis('.omo-station-switch'), presence: vis('.omo-presence-bar'),
            pill: vis('[data-testid="immersive-pill"]'), launch: vis('[data-testid="immersive-launch"]'), fullLaunch: vis('[data-testid="focus-full-launch"]'),
            crosshair: vis('.omo-crosshair'), hud: !!document.querySelector('[data-testid="hud-layer"]'),
            focus: document.querySelector('.omo-root')?.dataset.focus, navigation: c?.dataset.navigation,
            pose: c ? { x: c.dataset.playerX, z: c.dataset.playerZ } : null,
            stored: localStorage.getItem('omo.immersive'), restore: localStorage.getItem('omo.immersive.restore'),
        };
    }, CANVAS);
}
async function axis(page, key, field, goal, direction) {
    await page.keyboard.down(key);
    try { await page.waitForFunction((f, g, d) => { const n = Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset[f]); return d > 0 ? n >= g : n <= g; }, { timeout: 20000 }, field, goal, direction); }
    finally { await page.keyboard.up(key); }
}
async function walkTo(page, x, z) {
    let p = await page.$eval(CANVAS, e => ({ x: Number(e.dataset.playerX), z: Number(e.dataset.playerZ) }));
    if (p.z < 2.25) await axis(page, 's', 'playerZ', 2.25, 1);
    p = await page.$eval(CANVAS, e => ({ x: Number(e.dataset.playerX), z: Number(e.dataset.playerZ) }));
    if (Math.abs(p.x - x) > .12) await axis(page, p.x < x ? 'd' : 'a', 'playerX', x, p.x < x ? 1 : -1);
    p = await page.$eval(CANVAS, e => ({ x: Number(e.dataset.playerX), z: Number(e.dataset.playerZ) }));
    if (Math.abs(p.z - z) > .12) await axis(page, p.z < z ? 's' : 'w', 'playerZ', z, p.z < z ? 1 : -1);
}

(async () => {
    const profile = path.join(OUT, 'profile');
    fs.rmSync(profile, { recursive: true, force: true });
    const browser = await launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, userDataDir: profile,
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
    const errors = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.evaluateOnNewDocument(() => { try { localStorage.setItem('omo.coach.v1', 'seen'); } catch {} });
        await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        const trust = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click());
        for (let i = 0; i < 100 && !await page.$('[data-testid="omo-onboarding"]') && !await page.$(`${CANVAS}[data-navigation="walk"]`); i++) { await trust(); await pause(150); }
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 30000 });
        if (await page.$('[data-testid="create-room"]')) {
            for (let i = 0; i < 3; i++) {
                await trust(); await page.evaluate(() => document.querySelector('[data-testid="create-room"]').click());
                try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 6000 }); break; } catch (e) { if (i === 2) throw e; }
            }
        }
        await pause(1200);
        // Open the left side panel (Explorer) so we can prove it comes back exactly.
        await page.evaluate(() => { const a = document.querySelector('#theia-left-content-panel'); return a; });
        await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyE'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
        await pause(900);
        const before = await chrome(page);
        await page.screenshot({ path: path.join(OUT, '01-before.png') });
        check('before: Theia chrome visible, not immersive', before.topPanel !== false && before.statusBar && !before.bodyClass && before.immersive === 'false', before);
        check('before: Immersive world button shows next to Full-screen terminal', before.launch && before.fullLaunch);
        const leftBefore = before.left;

        // G on the world canvas.
        await page.focus(CANVAS); await page.keyboard.press('KeyG'); await pause(900);
        const on = await chrome(page);
        await page.screenshot({ path: path.join(OUT, '02-immersive.png') });
        check('G: immersive active (body class + data-immersive)', on.bodyClass && on.immersive === 'true', { bodyClass: on.bodyClass, immersive: on.immersive });
        check('G: canvas fills the window (>= 1400x860)', on.canvas && on.canvas.w >= 1400 && on.canvas.h >= 860, on.canvas);
        check('G: Theia top panel, status bar and side panel hidden', !on.topPanel && !on.statusBar && !on.left, { top: on.topPanel, status: on.statusBar, left: on.left });
        check('G: Omo header, footer, station row and presence hidden', !on.header && !on.footer && !on.stationRow && !on.presence, on);
        check('G: glass pill, crosshair and HUD shown', on.pill && on.crosshair && on.hud, on);
        check('G: choice saved on this device', on.stored === '1', on.stored);

        // Walk to desk one and click its monitor.
        await page.focus(CANVAS);
        const targets = await page.$eval(CANVAS, e => JSON.parse(e.dataset.stationTargets || '{}'));
        console.log('targets', JSON.stringify(Object.keys(targets)));
        await walkTo(page, -1.1, 2.4).catch(e => console.log('walk note', e.message));
        await pause(500);
        const point = await page.$eval(CANVAS, e => { const r = e.getBoundingClientRect(), t = JSON.parse(e.dataset.stationTargets || '{}').terminal; return t ? { x: r.left + t.x, y: r.top + t.y } : undefined; });
        check('desk one monitor is on screen', !!point, point);
        if (point) await page.mouse.click(point.x, point.y);
        await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 30000 });
        await page.waitForFunction(() => document.querySelector('.omo-root')?.dataset.focus === 'attached', { timeout: 15000 }).catch(() => undefined);
        await pause(800);
        const marker = `IMMERSIVE_OK_${Date.now()}`;
        await page.keyboard.type(`echo ${marker}`); await page.keyboard.press('Enter');
        const echoed = await page.waitForFunction(m => (document.querySelector('[data-testid="in-world-terminal-output"]')?.textContent || '').split(m).length > 2, { timeout: 20000 }, marker).then(() => true, () => false);
        const attached = await chrome(page);
        await page.screenshot({ path: path.join(OUT, '03-attached.png') });
        check('attached terminal still works in immersive (echo round trip)', echoed, marker);
        check('attached: still immersive, canvas full window', attached.bodyClass && attached.canvas.w >= 1400 && attached.canvas.h >= 860, { focus: attached.focus, canvas: attached.canvas });

        // Esc twice: leaves the screen, never immersive.
        await page.keyboard.press('Escape'); await pause(400);
        await page.keyboard.press('Escape'); await pause(700);
        const afterEsc = await chrome(page);
        const z0 = Number(afterEsc.pose.z);
        await page.focus(CANVAS); await page.keyboard.down('s'); await pause(700); await page.keyboard.up('s'); await pause(300);
        const walked = await chrome(page);
        await page.screenshot({ path: path.join(OUT, '04-after-esc.png') });
        check('Esc twice: walking again (not attached)', afterEsc.focus !== 'attached' && afterEsc.focus !== 'attaching' && afterEsc.navigation === 'walk', { focus: afterEsc.focus, nav: afterEsc.navigation });
        check('Esc twice: still immersive', afterEsc.bodyClass && afterEsc.immersive === 'true' && afterEsc.pill);
        check('walking works after Esc (S moves the player)', Math.abs(Number(walked.pose.z) - z0) > 0.1, { before: z0, after: walked.pose.z });

        // G again: layout restored.
        await page.focus(CANVAS); await page.keyboard.press('KeyG'); await pause(1200);
        const off = await chrome(page);
        await page.screenshot({ path: path.join(OUT, '05-restored.png') });
        check('G again: immersive off, Theia chrome back', !off.bodyClass && off.immersive === 'false' && off.statusBar && off.topPanel !== false, off);
        check('G again: Omo header, station row back', off.header && off.stationRow, off);
        check('G again: side panel state as before', off.left === leftBefore, { before: leftBefore, after: off.left });
        check('G again: canvas back inside the layout (smaller than window)', off.canvas.w < on.canvas.w || off.canvas.h < on.canvas.h, { on: on.canvas, off: off.canvas });
        check('G again: choice saved off, restore snapshot cleared', off.stored === '0' && off.restore === null, { stored: off.stored, restore: off.restore });

        // Button path + command palette path + Alt+Shift+G.
        await page.evaluate(() => document.querySelector('[data-testid="immersive-launch"]').click()); await pause(1000);
        const btn = await chrome(page);
        await page.screenshot({ path: path.join(OUT, '06-button.png') });
        check('Immersive world button enters immersive', btn.bodyClass && btn.pill && btn.canvas.w >= 1400, btn.canvas);
        await page.evaluate(() => document.querySelector('[data-testid="immersive-exit"]').click()); await pause(1000);
        const ex = await chrome(page);
        check('pill Exit leaves immersive', !ex.bodyClass && ex.statusBar, { body: ex.bodyClass });
        await page.focus(CANVAS);
        await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyG'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); await pause(900);
        const alt = await chrome(page);
        check('Alt+Shift+G enters immersive', alt.bodyClass);
        await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyG'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); await pause(900);
        check('Alt+Shift+G leaves immersive', !(await chrome(page)).bodyClass);

        // Reload with the choice on: comes back immersive.
        await page.keyboard.press('KeyG'); await pause(600);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 30000 });
        await pause(1500);
        const reload = await chrome(page);
        check('reload keeps immersive (saved choice) and fills the window', reload.bodyClass && reload.canvas.w >= 1400 && reload.canvas.h >= 860, reload.canvas);
        await page.focus(CANVAS); await page.keyboard.press('KeyG'); await pause(1000);
        const reloadOff = await chrome(page);
        check('after reload G restores the side panel too', !reloadOff.bodyClass && reloadOff.left === leftBefore, { left: reloadOff.left });
        await page.screenshot({ path: path.join(OUT, '07-after-reload-off.png') });
        check('no page errors', errors.length === 0, errors.slice(0, 5));
    } finally {
        await browser.close();
        fs.rmSync(profile, { recursive: true, force: true });
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
        const failed = results.filter(r => !r.ok).length;
        console.log(`\n${results.length - failed}/${results.length} checks passed`);
        process.exitCode = failed ? 1 : 0;
    }
})().catch(e => { console.error('ERROR', e.stack || e); process.exitCode = 2; });
