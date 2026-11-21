#!/usr/bin/env node
/*
 * sky:render — real-app capture of the skyline (NYC skyscraper) room. Fixture CLIs only, isolated data/tmux/port.
 *   1. Onboarding: pick the "NYC skyscraper" prompt card -> Create room -> walk mode, theme skyline.
 *   2. Screenshots: walking views (desks, skyline, window), overview, immersive mode.
 *   3. Attach a desk monitor, type a real shell command, assert the echoed output on the physical monitor.
 * Usage: node scripts/sky-capture.cjs <outDir> [port]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'sky'));
const PORT = Number(process.argv[3] || 3611);
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, pass, detail) => { if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-sky-'));
    const project = path.join(S, 'penthouse'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# penthouse\n');
    spawnSync('git', ['init', '-q'], { cwd: project });
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-sky-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'w');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = [];
    const W = Number(process.env.SKY_W || 1600), H = Number(process.env.SKY_H || 900);
    try {
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `--window-size=${W},${H}`], defaultViewport: { width: W, height: H } });
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push(String(e.message || e)));
        page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
            new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true });
        });
        const ds = () => page.$eval(CANVAS, c => ({ ...c.dataset }));
        const click = sel => page.$eval(sel, e => e.click());
        const shot = async name => { await pause(2500); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('shot', name); };
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-onboarding"]', { timeout: 180000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        await pause(1500);
        await click('[data-testid="onboarding-template-skyline"]'); await pause(800);
        await click('[data-testid="onboarding-next"]'); await pause(1500);
        await shot('0-onboarding-preview');
        await click('[data-testid="onboarding-next"]'); await pause(1000);
        await page.waitForFunction(() => { const b = document.querySelector('[data-testid="create-room"]'); return b && !b.disabled; }, { timeout: 30000 });
        await click('[data-testid="create-room"]');
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 60000 }); await pause(2000);
        const saved = await page.evaluate(() => Object.keys(localStorage).filter(k => /world/i.test(k)).map(k => localStorage.getItem(k)).find(v => v && v.includes('"skyline"')) || '');
        let d = await ds();
        check('room created in walk mode', d.navigation === 'walk', { nav: d.navigation, world: d.worldName });
        const stations = JSON.parse(d.worldStations || '[]');
        check('three desks in the skyscraper world', stations.length === 3, stations);
        const shell = JSON.parse(d.worldShell || '{}');
        check('skyscraper floor shell is 24 x 18 (theme from the template)', shell.width === 24 && shell.depth === 18, { shell, savedSkyline: !!saved });
        await shot('1-walk-spawn');
        // Look around: turn with arrow keys if supported, else J/L style keys; use the walker's yaw via mouse drag.
        const turn = async (key, ms) => { await page.focus(CANVAS); await page.keyboard.down(key); await pause(ms); await page.keyboard.up(key); await pause(400); };
        const walk = async (key, ms) => { await page.focus(CANVAS); await page.keyboard.down(key); await pause(ms); await page.keyboard.up(key); await pause(400); };
        await turn('ArrowLeft', 900); await shot('2-walk-look-left');
        await turn('ArrowRight', 1800); await shot('3-walk-look-right');
        await turn('ArrowLeft', 900);
        await walk('w', 1200); await shot('4-walk-toward-desks');
        // By the glass on the left side, looking out and down over the city.
        const axis0 = async (key, field, goal, dir) => {
            const reached = () => page.$eval(CANVAS, (c, f, g, dd) => { const n = Number(c.dataset[f]); return dd > 0 ? n >= g : n <= g; }, field, goal, dir);
            const deadline = Date.now() + 40000;
            while (!await reached() && Date.now() < deadline) { await page.focus(CANVAS); await page.keyboard.down(key); try { for (let t = 0; t < 20 && !await reached(); t++) await pause(50); } finally { await page.keyboard.up(key); } }
        };
        await click('[aria-label="Reset room camera"]').catch(() => {}); await pause(600);
        await axis0('a', 'playerX', -10.6, -1);
        const press = async (key, n) => { await page.focus(CANVAS); for (let k = 0; k < n; k++) { await page.keyboard.press(key); await pause(20); } await pause(500); };
        await press('ArrowLeft', 22); // yaw +1.54 rad: facing the left (west) glass
        await press('ArrowDown', 7); await shot('4b-window-look-down');
        await press('ArrowUp', 7); await press('ArrowLeft', 8); await shot('4c-window-horizon');
        console.log('pose at window', (await ds()).playerX, (await ds()).playerZ);
        await click('[aria-label="Reset room camera"]').catch(() => {}); await pause(800);
        // Overview of the whole floor.
        await click('[data-testid="overview-mode"]').catch(() => {}); await pause(1200); await shot('5-overview');
        await click('[data-testid="walk-mode"]').catch(() => {}); await pause(1200);
        // Terminal: attach the middle desk, run a real command, read it back from the physical monitor.
        // Walk up to desk one (like release-smoke): hold a key until the player passes the goal.
        const axis = async (key, field, goal, dir) => {
            const reached = () => page.$eval(CANVAS, (c, f, g, dd) => { const n = Number(c.dataset[f]); return dd > 0 ? n >= g : n <= g; }, field, goal, dir);
            const deadline = Date.now() + 40000;
            while (!await reached()) {
                if (Date.now() > deadline) throw new Error(`walk ${key} did not reach ${field} ${goal}`);
                await page.focus(CANVAS); await page.keyboard.down(key);
                try { for (let t = 0; t < 20 && !await reached(); t++) await pause(50); } finally { await page.keyboard.up(key); }
            }
        };
        await click('[aria-label="Reset room camera"]').catch(() => {}); await pause(800);
        const desks = JSON.parse((await ds()).deskPositions || '{}');
        const me = await ds();
        const goal = desks.terminal; console.log('desk one at', JSON.stringify(goal), 'player', me.playerX, me.playerZ);
        if (Number(me.playerX) > goal.x) await axis('a', 'playerX', goal.x, -1); else await axis('d', 'playerX', goal.x, 1);
        await axis('w', 'playerZ', goal.z + 2.2, -1);
        await pause(1000); await shot('6a-at-desk');
        d = await ds();
        const targets = JSON.parse(d.stationTargets || '{}');
        const id = 'terminal';
        const box = await page.$eval(CANVAS, e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top }; });
        check('a desk monitor is on screen', !!(id && targets[id]), { targets: Object.keys(targets) });
        if (id && targets[id]) {
            await page.mouse.click(box.x + targets[id].x, box.y + targets[id].y);
            const live = await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 90000 }).then(() => true, () => false);
            check('desk terminal is live after clicking its monitor', live);
            await pause(1500);
            await page.keyboard.type('echo skyline-$((60+1)) floor'); await page.keyboard.press('Enter');
            const ok = await page.waitForFunction(() => { const c = document.querySelector('canvas[data-testid="omo-world-canvas"]'); const t = (c.dataset.stationText || c.dataset.terminalText || ''); return t.includes('skyline-61 floor'); }, { timeout: 30000 }).then(() => true, () => false);
            check('real shell output on the in-world monitor (skyline-61 floor)', ok);
            await shot('7-terminal-attached');
            await page.keyboard.press('Escape'); await pause(800); await shot('8-after-detach');
        }
        // Immersive: the world fills the window.
        await page.focus(CANVAS); await page.keyboard.press('g'); await pause(1500); await shot('6-immersive');
        check('no page errors', errors.filter(e => !/favicon|ResizeObserver/.test(e)).length === 0, errors.slice(0, 5));
    } catch (error) {
        failed++; console.error('FAIL', error.stack || error.message);
        try { fs.writeFileSync(path.join(OUT, 'errors.json'), JSON.stringify(errors, null, 1)); } catch {}
    } finally {
        try { await browser?.close(); } catch {}
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        spawnSync('tmux', ['-L', socket, 'kill-server']);
        console.log(failed ? `RESULT FAIL ${failed}` : 'RESULT PASS');
        process.exit(failed ? 1 : 0);
    }
})();
