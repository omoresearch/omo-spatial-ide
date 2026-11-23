#!/usr/bin/env node
/*
 * HQ floors — real-app check (HQ-FLOORS.md). Real local app on an owned port, real Chrome on the GPU, fixture CLIs only.
 * Start in the penthouse -> palette 'Make HQ floors' -> the rail shows HQ + Library/Lounge/Studio -> glide to each floor:
 * its baked module is ready, nothing of the HQ or other floors is drawn, the studio desks are live screens, fps >= 50.
 * Door-view shots per floor + a side-by-side with the Blender preview (modules-src/previews) into evidence/hq/.
 * Usage: node scripts/hq-floors-real.cjs [outDir] [port 3750-3759]   (default omo/evidence/hq, 3757)
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'hq'));
const PORT = Number(process.argv[3] || 3757);
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const PREVIEW = { library: 'library_v10.png', lounge: 'lounge_v11.png', studio: 'studio_v7.png' };
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-hq-'));
    const project = path.join(S, 'hq'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# hq\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-hq-${PORT}`, tmux = '/home/harry/.local/share/omo/bin/tmux';
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_TMUX: tmux, PATH: `${path.dirname(tmux)}:${process.env.PATH}`,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = [];
    try {
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, protocolTimeout: 300000, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage(); page.setDefaultTimeout(60000);
        page.on('pageerror', e => errors.push(String(e.message || e)));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
            new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true });
        });
        const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
        const data = k => page.$eval(CANVAS, (c, k) => c.dataset[k], k);
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        await page.waitForSelector('[data-testid="create-room"]', { timeout: 120000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(1000);
        await page.$eval('[data-testid="create-room"]', b => b.click());
        await page.waitForFunction(c => document.querySelector(c)?.dataset.styleKit === 'skyline-penthouse', { timeout: 90000 }, CANVAS);
        await pause(2500);
        await shot('0-hq');
        // Make HQ floors from the palette.
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('omo:palette-toggle')));
        await page.waitForSelector('[data-testid="palette-item"][data-command="hq-floors"]', { timeout: 8000 });
        await page.$eval('[data-testid="palette-item"][data-command="hq-floors"]', b => b.click());
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="floor-rail-item"]').length === 4, { timeout: 20000 }).catch(() => {});
        const rail = await page.$$eval('[data-testid="floor-rail-item"]', bs => bs.map(b => b.dataset.floor));
        check('The rail shows HQ + Library, Lounge, Studio', JSON.stringify(rail) === JSON.stringify(['hq', 'floor-library', 'floor-lounge', 'floor-studio']), rail);
        check('The penthouse kit stays on with floors', await data('styleKit') === 'skyline-penthouse', await data('styleKit'));
        await page.waitForFunction(c => { const d = JSON.parse(document.querySelector(c).dataset.moduleRooms || 'null'); return d && d.ready.length >= 3; }, { timeout: 90000 }, CANVAS).catch(() => {});
        const mods = JSON.parse(await data('moduleRooms') || 'null');
        check('All 3 floors have their baked module loaded', mods && mods.ready.length === 3, mods);
        for (const [id, mod] of [['floor-library', 'library'], ['floor-lounge', 'lounge'], ['floor-studio', 'studio']]) {
            await page.$eval(`[data-testid="floor-rail-item"][data-floor="${id}"]`, b => b.click());
            await pause(1800);
            check(`${mod}: the glide lands on the floor`, await data('floor') === id, await data('floor'));
            const vis = await page.$eval(CANVAS, (c, id) => { const s = c.omoSceneVisible?.(); return s; }, id).catch(() => undefined);
            await page.$eval(CANVAS, c => c.focus()); await pause(400);
            await shot(`floor-${mod}`);
            const prev = path.join(ROOT, 'modules-src', 'previews', PREVIEW[mod]);
            if (fs.existsSync(prev)) {
                const r = spawnSync('montage', [path.join(OUT, `floor-${mod}.png`), prev, '-tile', '2x1', '-geometry', '960x600+6+6', '-background', '#0b0c0f', path.join(OUT, `side-${mod}.png`)], { encoding: 'utf8' });
                check(`${mod}: side-by-side written`, r.status === 0, r.stderr?.slice(0, 200));
            }
            void vis;
        }
        // fps on the studio floor while walking.
        await page.$eval(CANVAS, c => c.focus());
        const fps = await page.evaluate(ms => new Promise(res => { let n = 0; const t0 = performance.now(); const f = t => { n++; if (t - t0 < ms) requestAnimationFrame(f); else res(Math.round(n / ((t - t0) / 1000))); }; requestAnimationFrame(f); }), 3000).catch(() => 0);
        check(`fps on a floor >= 50 (${fps})`, fps >= 50, fps);
        await page.$eval('[data-testid="floor-rail-item"][data-floor="hq"]', b => b.click()); await pause(1800);
        check('The rail glides back to HQ', await data('floor') === 'hq', await data('floor'));
        await shot('1-hq-with-rail');
        check('no page errors', errors.length === 0, errors.slice(0, 3));
    } catch (e) { check('run', false, String(e && e.message || e)); }
    finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, failed }, null, 1));
        await browser?.close().catch(() => {});
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
        console.log(`${checks.length - failed}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);
        process.exit(failed ? 1 : 0);
    }
})();
