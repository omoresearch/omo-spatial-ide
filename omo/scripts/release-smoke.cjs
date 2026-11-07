#!/usr/bin/env node
/*
 * Release smoke test for an UNPACKED package (no repo, no node_modules):
 * start ./omo on a free port with isolated data, open it in headless Chrome, create a room,
 * walk to desk one, type a real shell command on the physical monitor and see its output,
 * then stop only our process group. Usage:
 *   node release-smoke.cjs <unpackedDir> <puppeteerModuleDir> [chromePath]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const [dir, pptrDir, chromeArg] = process.argv.slice(2);
const { launch } = require(pptrDir);
const pause = ms => new Promise(r => setTimeout(r, ms));
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const chrome = chromeArg || process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/google/chrome/chrome');
(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-smoke-'));
    const project = path.join(scratch, 'project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'README.md'), '# smoke\n');
    const port = await freePort(), socket = `omo-smoke-${process.pid}`;
    const log = fs.openSync(path.join(scratch, 'server.log'), 'a');
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(scratch, 'theia'), OMO_SPATIAL_DATA: path.join(scratch, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket };
    const server = spawn(path.join(dir, 'omo'), ['--workspace', project, '--port', String(port)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser, ok = false;
    try {
        let ready = false;
        for (let i = 0; i < 300 && server.exitCode === null; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) })).ok) { ready = true; break; } } catch {} await pause(300); }
        if (!ready) throw new Error(`packaged app not ready (exit ${server.exitCode})`);
        console.log('PASS packaged app serves HTTP on 127.0.0.1');
        browser = await launch({ executablePath: chrome, headless: true, userDataDir: path.join(scratch, 'chrome'), args: ['--no-sandbox', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage();
        const errors = []; page.on('pageerror', e => errors.push(String(e)));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
            // Theia's workspace-trust dialog can open late (after the room renders) and take keyboard focus,
            // so the walk keys never reach the canvas. Accept it whenever it appears.
            const trust = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click();
            new MutationObserver(trust).observe(document, { childList: true, subtree: true });
        });
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 300 && !await page.$('[data-testid="omo-onboarding"]'); i++) { await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()); await pause(200); }
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 60000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        await page.waitForFunction(() => { const b = document.querySelector('[data-testid="create-room"]'); return b && !b.disabled; }, { timeout: 30000 });
        await page.evaluate(() => document.querySelector('[data-testid="create-room"]').click());
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 30000 });
        console.log('PASS first-person room renders in a real browser');
        // Walk to desk one (left desk): A then W, like the repo's world driver.
        // Hold <key> until dataset[field] passes goal. Re-focus the canvas when a dialog took focus (keys only reach a focused canvas).
        const axis = async (key, field, goal, dir) => {
            const reached = () => page.$eval(CANVAS, (c, f, g, d) => { const n = Number(c.dataset[f]); return d > 0 ? n >= g : n <= g; }, field, goal, dir);
            const deadline = Date.now() + 30000;
            while (!await reached()) {
                if (Date.now() > deadline) { const d = await page.$eval(CANVAS, c => ({ x: c.dataset.playerX, z: c.dataset.playerZ, focus: document.activeElement === c ? 'canvas' : (document.activeElement?.textContent || '').trim().slice(0, 60) })); throw new Error(`walk ${key} did not reach ${field} ${goal}: ${JSON.stringify(d)}`); }
                await page.focus(CANVAS); await page.keyboard.down(key);
                try { for (let t = 0; t < 20 && !await reached() && await page.$eval(CANVAS, c => document.activeElement === c); t++) await pause(50); } finally { await page.keyboard.up(key); }
            }
        };
        await axis('a', 'playerX', -2.5, -1); await axis('w', 'playerZ', 1.9, -1);
        const pt = await page.$eval(CANVAS, (e) => { const r = e.getBoundingClientRect(), t = JSON.parse(e.dataset.stationTargets || '{}').terminal; return t && { x: r.left + t.x, y: r.top + t.y }; });
        if (!pt) throw new Error('desk monitor has no projected target');
        await page.mouse.click(pt.x, pt.y);
        await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 60000 });
        await page.keyboard.type('echo omo-release-$((40+2))'); await page.keyboard.press('Enter');
        await page.waitForFunction(() => (document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText || '').includes('omo-release-42'), { timeout: 30000 });
        console.log('PASS real shell runs on the physical in-world monitor (omo-release-42)');
        if (errors.length) throw new Error('page errors: ' + errors.join(' | ').slice(0, 400));
        console.log('PASS no page errors');
        ok = true;
    } catch (error) {
        console.error('FAIL', error.message);
        try { console.error('--- server.log (tail) ---\n' + fs.readFileSync(path.join(scratch, 'server.log'), 'utf8').split('\n').slice(-40).join('\n')); } catch {}
    } finally {
        if (browser) await browser.close().catch(() => {});
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        await pause(2500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        // The package may have used its bundled tmux (no tmux on PATH): try every candidate, then kill
        // any server still bound to our private socket (AppImage extract dirs vanish on exit).
        const pathTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        for (const tmux of new Set([process.env.OMO_SMOKE_TMUX, process.env.OMO_SPATIAL_TMUX, path.join(dir, 'vendor', 'tmux', 'tmux'), pathTmux].filter(Boolean))) {
            if (fs.existsSync(tmux)) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
        }
        spawnSync('pkill', ['-f', `tmux.* -L ${socket}( |$)`], { stdio: 'ignore' });
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    process.exitCode = ok ? 0 : 1;
})();
