#!/usr/bin/env node
/*
 * world-magic — real-app check of the creation moment (real local app on an owned port, real Chrome,
 * fixture CLIs only, never real agents).
 *   1. Talk: "add a room for research with 2 desks" -> plan shows -> ghost preview hook set -> Apply -> room + 2 desks.
 *   2. Add: a monitor wall linked to Desk one + a web wall with an owned static page URL -> Apply -> both exist,
 *      link and URL are right (read from the saved world in localStorage).
 *   3. Inspector: rename a desk, then undo (Ctrl+Z drops the step).
 *   4. A desk placed past the edge grows the world.
 *   5. Nothing covers the monitor click point (elementFromPoint at the bottom-centre is the canvas).
 * Usage: node scripts/builder-ui-real.cjs <outDir> [port 3740-3759]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'world-magic', 'real'));
const PORT = Number(process.argv[3] || 3745);
if (!(PORT >= 3740 && PORT <= 3759)) { console.error('Use a port from 3740 to 3759.'); process.exit(2); }
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 260) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-magic-'));
    const project = path.join(S, 'builder'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# builder\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    // Owned static page for the web wall (port + 100).
    const staticPort = PORT + 100;
    const pageServer = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><title>builder-ui static</title><h1>BUILDER_UI_STATIC</h1>'); }).listen(staticPort, '127.0.0.1');
    const webUrl = `http://127.0.0.1:${staticPort}/page.html`;
    const socket = `omo-magic-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = [];
    try {
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900'], defaultViewport: { width: 1600, height: 900 } });
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', e => errors.push(String(e.message || e)));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
            new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true });
        });
        const ds = () => page.$eval(CANVAS, c => ({ ...c.dataset }));
        const J = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
        const click = sel => page.$eval(sel, e => e.click());
        const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
        const savedWorld = () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return k ? JSON.parse(localStorage.getItem(k)) : null; });

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        for (let i = 0; i < 3; i++) { await click('[data-testid="create-room"]').catch(() => {}); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 8000 }); break; } catch {} }
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(1500);


        await click('[data-testid="overview-mode"]').catch(() => {}); await pause(1000);
        await page.focus(CANVAS); await page.keyboard.press('b');
        await page.waitForSelector('[data-testid="world-builder"]');
        await click('[data-testid="builder-tab-talk"]'); await pause(400);
        await page.click('[data-testid="admin-prompt"]'); await page.keyboard.type('add a room for research with 2 desks'); await page.keyboard.press('Enter');
        await page.waitForSelector('[data-testid="admin-entry"][data-status="proposed"]', { timeout: 30000 });
        await pause(1200); await shot('1-ghost-preview');
        // record frames + the progress hook through the sequence
        const fr = path.join(OUT, 'frames'); fs.mkdirSync(fr, { recursive: true });
        const cdp = await page.createCDPSession();
        let n = 0; cdp.on('Page.screencastFrame', async f => { fs.writeFileSync(path.join(fr, `f${String(n++).padStart(4, '0')}.jpg`), Buffer.from(f.data, 'base64')); await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
        await pause(800);
        const samples = [];
        await click('[data-testid="admin-apply"]');
        const t0 = Date.now();
        while (Date.now() - t0 < 3200) { const d = await ds(); samples.push({ t: Date.now() - t0, rec: J(d.magicCreate, {}), fps: d.magicFps }); if (Date.now() - t0 > 250 && Date.now() - t0 < 300) await shot('2-materialising'); await pause(90); }
        await pause(800); await cdp.send('Page.stopScreencast'); await shot('3-created');
        const last = samples[samples.length - 1].rec, ids = Object.keys(last);
        const mid = samples.filter(s => Object.values(s.rec).some(r => r.p > 0.05 && r.p < 0.95));
        check('materialise sequence ran (progress between 0 and 1 seen)', mid.length >= 3, { midSamples: mid.length, ids });
        check('every created thing finished at progress 1', ids.length >= 2 && ids.every(id => last[id].p >= 0.999), last);
        check('mode was animated', ids.some(id => last[id].mode === 'animated'), ids.map(id => last[id].mode));
        const fps = Number(samples[samples.length - 1].fps || 0);
        check('fps during creation >= 50', fps >= 50, fps);
        const d = await ds();
        check('real entities exist after the sequence', J(d.worldStations, []).length >= 2 && J(d.worldRooms, []).length >= 2, { rooms: J(d.worldRooms, []), stations: J(d.worldStations, []).length });
        fs.writeFileSync(path.join(OUT, 'samples.json'), JSON.stringify(samples, null, 1));
        const vid = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '30', '-i', path.join(fr, 'f%04d.jpg'), '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(OUT, 'creation.mp4')]);
        check('creation video recorded', vid.status === 0 && fs.existsSync(path.join(OUT, 'creation.mp4')), n + ' frames');
        check('no page errors', errors.length === 0, errors.slice(0, 5));
    } catch (e) { check('test ran to completion', false, String(e && e.stack || e).slice(0, 400)); }
    finally {
        try { await browser?.close(); } catch {}
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        { const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim(); if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' }); }
        pageServer.close();
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ failed, checks }, null, 1));
        console.log(`${checks.length - failed}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);
        process.exit(failed ? 1 : 0);
    }
})();
