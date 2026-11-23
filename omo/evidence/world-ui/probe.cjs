#!/usr/bin/env node
// world-ui probe (GPU): walking + overview screenshots of a fresh room, plus optional JS. Usage: probe.cjs <out> [port]
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2]); const PORT = Number(process.argv[3] || 3750);
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-probe-'));
    const project = path.join(S, 'penthouse'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# penthouse\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-probe-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'w');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser;
    try {
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage(); page.setDefaultTimeout(60000);
        page.on('pageerror', e => console.log('PAGEERROR', e.message)); page.on('console', m => { if (/omo|error/i.test(m.text())) console.log('CONSOLE', m.text().slice(0, 200)); });
        await page.evaluateOnNewDocument(() => { try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
            new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true }); });
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        for (let i = 0; i < 3; i++) { await page.$eval('[data-testid="create-room"]', e => e.click()).catch(() => {}); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 8000 }); break; } catch {} }
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        await page.waitForFunction(() => document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.styleKit === 'skyline-penthouse', { timeout: 60000 }).catch(() => console.log('kit not loaded'));
        await pause(3000);
        await page.focus(CANVAS); await page.screenshot({ path: path.join(OUT, '1-walking.png') });
        const info = await page.evaluate(() => { const c = document.querySelector('canvas[data-testid="omo-world-canvas"]'); return { kit: c.dataset.styleKit, labels: [...document.querySelectorAll('.omo-scene-label,.omo-wl')].map(e => ({ t: e.textContent, v: getComputedStyle(e).visibility, r: e.getBoundingClientRect().toJSON() })), hud: [...document.querySelectorAll('.omo-hud-layer *, .omo-crosshair-hint')].filter(e => e.children.length === 0 && e.textContent.trim()).map(e => e.textContent.trim()) }; });
        console.log(JSON.stringify(info));
        if (process.env.PROBE_JS) console.log('JS', JSON.stringify(await page.evaluate(process.env.PROBE_JS)));
        await page.$eval('[data-testid="overview-mode"]', e => e.click()).catch(() => {}); await pause(2000);
        await page.focus(CANVAS); await page.screenshot({ path: path.join(OUT, '6-overview.png') });
        if (process.env.PROBE_BUILD) { await page.keyboard.press('b'); await pause(1500); await page.$eval('[data-testid="builder-tab-add"]', e => e.click()).catch(() => {}); await pause(800); await page.screenshot({ path: path.join(OUT, '7-build-add.png') }); }
    } catch (e) { console.log('FAIL', e.message); } finally {
        if (browser) await browser.close().catch(() => {});
        try { process.kill(-server.pid, 'SIGTERM'); } catch {} await pause(1500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); fs.rmSync(S, { recursive: true, force: true });
    }
})();
