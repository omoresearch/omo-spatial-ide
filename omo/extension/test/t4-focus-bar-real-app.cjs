/* t4:polish (4) — the full-screen terminal top bar keeps every control fully visible with 5 desks and the agent
 * buttons, at 1440x900 and 1280x800 (desk view and full window). Real app, real Chrome, fixture agent CLIs only
 * (nothing is started: showing a "+ Claude" button does not run Claude).
 * Usage: node extension/test/t4-focus-bar-real-app.cjs [port 3540-3559] */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'evidence', 't4-polish');
const PORT = Number(process.argv[2] || process.env.OMO_T4_PORT || 3543);
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
if (PORT < 3540 || PORT > 3559) throw new Error('Use a port from 3540 to 3559.');

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-t4-bar-'));
    const project = path.join(S, 'research-lab'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# fixture\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# Fixture only: no model or network calls.\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const hermesRoot = path.join(S, 'hermes'); fs.mkdirSync(path.join(hermesRoot, 'profiles', 'default'), { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, 'profiles', 'default', 'config.yaml'), '# fixture\n');
    const socket = `omo-t4-bar-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_ROOT: hermesRoot, OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, `focus-bar-server-${PORT}.log`), 'w');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser;
    const results = [];
    try {
        let ready = false;
        for (let i = 0; i < 300 && !ready; i++) { try { ready = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { /* bounded */ } if (!ready) await pause(300); }
        assert.ok(ready, 'the app started');
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => { try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {} });
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        const trust = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click());
        for (let i = 0; i < 200 && !await page.$('[data-testid="omo-onboarding"]'); i++) { await trust(); await pause(300); }
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 90000 });
        for (let i = 0; i < 3; i++) { await trust(); await page.$eval('[data-testid="create-room"]', b => b.click()); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 8000 }); break; } catch (e) { if (i === 2) throw e; } }
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        // Five desks with real-length names, through the admin (Apply only, nothing starts).
        await page.click('[data-testid="admin-toggle"]'); await page.waitForSelector('[data-testid="admin-panel"]');
        for (const ask of ['add a shell desk named Literature', 'add a shell desk named Writing', 'add a desk for Codex']) {
            const n = await page.$$eval('[data-testid="admin-entry"]', e => e.length);
            await page.click('[data-testid="admin-prompt"]'); await page.keyboard.type(ask); await page.keyboard.press('Enter');
            await page.waitForFunction(n => { const es = document.querySelectorAll('[data-testid="admin-entry"]'); return es.length > n && es[es.length - 1].dataset.status === 'proposed'; }, { timeout: 20000 }, n);
            const applies = await page.$$('[data-testid="admin-apply"]'); await applies[applies.length - 1].click(); await pause(700);
        }
        await page.$eval('[data-testid="admin-close"]', b => b.click());
        const desks = await page.$eval(CANVAS, e => JSON.parse(e.dataset.worldStations || '[]'));
        assert.equal(desks.length, 5, `five desks (${desks})`);
        // Open desk one (dock Terminal button = same path as its monitor), then the full-window terminal.
        await page.$eval('[data-testid="terminal-action"]', b => b.click());
        await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 30000 });
        await pause(1500); await page.$eval('[data-testid="runtime-confirm-no"]', b => b.click()).catch(() => undefined); // first open may offer desk setup: keep just the shell
        await page.focus(CANVAS); await page.keyboard.press('Escape'); await pause(300);
        await page.waitForSelector('[data-testid="focus-full-launch"]', { timeout: 10000 });
        await page.$eval('[data-testid="focus-full-launch"]', b => b.click());
        await page.waitForFunction(() => document.querySelector('[data-testid="omo-world"]')?.dataset.focusFull === 'true', { timeout: 15000 });
        await page.waitForSelector('[data-testid="focus-new-claude"]', { timeout: 15000 });
        for (const [w, h] of [[1440, 900], [1280, 800]]) {
            for (const full of [true, false]) {
                await page.setViewport({ width: w, height: h }); await pause(900);
                const isFull = await page.$eval('[data-testid="focus-layer"]', e => e.dataset.full === 'true');
                if (isFull !== full) { await page.$eval('[data-testid="focus-full-toggle"]', b => b.click()); await pause(900); }
                const m = await page.evaluate(() => {
                    const bar = document.querySelector('.omo-focus-bar'), b = bar.getBoundingClientRect();
                    const vw = window.innerWidth, vh = window.innerHeight, cs = getComputedStyle(bar);
                    const inner = { left: b.left + parseFloat(cs.paddingLeft), right: b.right - parseFloat(cs.paddingRight) }; // desk view keeps its right end free for the HUD chat and bell
                    const controls = [...bar.querySelectorAll('button, [data-testid="focus-keys"], [data-testid="focus-project"]')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
                    // A control is fully visible when its box is inside the window, inside the bar, and not clipped by a scrolling/hidden ancestor.
                    const clipped = e => { const r = e.getBoundingClientRect(); for (let a = e.parentElement; a && a !== bar.parentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible') { const c = a.getBoundingClientRect(); if (r.left < c.left - 0.5 || r.right > c.right + 0.5) return true; } } return false; };
                    const bad = controls.map(e => { const r = e.getBoundingClientRect(); return { id: e.dataset.testid || e.className || e.tagName, text: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 24), l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), btm: Math.round(r.bottom),
                        out: r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5 || r.right > inner.right + 0.5 || r.left < inner.left - 0.5, clip: clipped(e) }; }).filter(x => x.out || x.clip);
                    const hud = [...document.querySelectorAll('.omo-chat-toggle, .omo-hud-bell')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect());
                    const overlap = [...bar.querySelectorAll('button')].filter(e => e.getClientRects().length).some(e => { const r = e.getBoundingClientRect(); return hud.some(h => r.left < h.right && r.right > h.left && r.top < h.bottom && r.bottom > h.top); });
                    return { vw, vh, inner: [Math.round(inner.left), Math.round(inner.right)], hud: hud.map(h => [Math.round(h.left), Math.round(h.top), Math.round(h.right), Math.round(h.bottom)]), bar: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)], scrollW: bar.scrollWidth, clientW: bar.clientWidth, count: controls.length, bad, overlap,
                        truncated: [...bar.querySelectorAll('.omo-focus-desk-name')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent), walk: (() => { const r = document.querySelector('[data-testid="focus-exit"]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })() };
                });
                const name = `item4-${w}x${h}-${full ? 'full' : 'desk'}`;
                await page.screenshot({ path: path.join(OUT, `${name}.png`) });
                const pass = m.bad.length === 0 && !m.overlap && m.scrollW <= m.clientW + 1;
                results.push({ name, pass, ...m });
                console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${m.count} controls, bar ${JSON.stringify(m.bar)} content ${JSON.stringify(m.inner)} hud ${JSON.stringify(m.hud)} scrollWidth ${m.scrollW}/${m.clientW}, Walk at ${JSON.stringify(m.walk)}, desk names cut: ${JSON.stringify(m.truncated)}${m.bad.length ? ' — outside: ' + JSON.stringify(m.bad).slice(0, 600) : ''}${m.overlap ? ' — overlaps the HUD chat/bell' : ''}`);
            }
        }
        fs.writeFileSync(path.join(OUT, 'item4-focus-bar.json'), JSON.stringify({ pass: results.every(r => r.pass), results }, null, 2));
        assert.ok(results.every(r => r.pass), 'every control of the full-screen top bar is fully visible');
        console.log(`FINAL PASS: ${results.length} viewport/mode checks, every bar control inside the window`);
    } finally {
        await browser?.close().catch(() => undefined);
        try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
        for (let i = 0; i < 40 && server.exitCode === null && server.signalCode === null; i++) await pause(100);
        try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
        const tmux = spawnSync('bash', ['-lc', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
        fs.rmSync(S, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
