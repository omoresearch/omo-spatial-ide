#!/usr/bin/env node
/*
 * w3 expand — real-browser check of the expandable world (no real agents; fixture CLIs only).
 *   1. Onboarding: a big plan (two named wings, 10 desks) creates ROOMS in a bigger/open world, not one crammed room.
 *   2. Hermes admin (built-in rules): "add a room for review with 3 desks" -> proposal -> Apply -> a new room + 3 desks.
 *   3. Build mode: World size + / Open world controls -> Apply -> shell grows / opens.
 *   4. Build mode: a desk placed past the edge grows the world (desk stays where placed).
 *   5. Walking: the player can leave the original 12 x 10 bounds in the grown world.
 *   6. Far monitors park (parkedScreens dataset) when far away; no page errors.
 * Usage: node scripts/w3-expand-real.cjs <outDir> [port]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'w3', 'expand'));
const PORT = Number(process.argv[3] || 3549);
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 240) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-w3-'));
    const project = path.join(S, 'campus'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# campus\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-w3-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = [];
    try {
        for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push(String(e.message || e)));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); } catch {}
            new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true });
        });
        const ds = () => page.$eval(CANVAS, c => ({ ...c.dataset }));
        const J = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
        const click = sel => page.$eval(sel, e => e.click());
        const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-onboarding"]', { timeout: 120000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        await pause(1500);

        // 1. onboarding big plan
        await page.click('[data-testid="onboarding-prompt"]');
        await page.keyboard.type('a research wing with 4 Hermes desks and a web wall for papers, and an agent wing with 6 Codex desks and a monitor wall');
        await pause(800);
        await click('[data-testid="onboarding-next"]'); await pause(1500);
        await shot('1-onboarding-preview');
        await click('[data-testid="onboarding-next"]'); await pause(1000);
        await click('[data-testid="create-room"]');
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 30000 }); await pause(2000);
        let d = await ds();
        const shell1 = J(d.worldShell, {}), rooms1 = J(d.worldRooms, []), desks1 = J(d.worldStations, []);
        check('onboarding: big plan makes rooms', rooms1.length >= 2, { rooms: rooms1 });
        check('onboarding: all 10 desks created', desks1.length === 10, { desks: desks1.length });
        check('onboarding: world is bigger than the classic 12 x 10', shell1.width > 12 || shell1.depth > 10 || shell1.open, shell1);
        await click('[data-testid="overview-mode"]').catch(() => {}); await pause(1500); await shot('1-onboarding-world-overview');
        // w3:look — the straight-ahead first-person view from the spawn spot (Reset view puts the player at home).
        await click('[data-testid="walk-mode"]').catch(() => {}); await pause(800);
        await click('button[aria-label="Reset room camera"]').catch(() => {}); await pause(1500); await shot('1b-spawn-first-person');
        await click('[data-testid="overview-mode"]').catch(() => {}); await pause(1000);

        // 2. admin adds a room
        await page.focus(CANVAS); await page.keyboard.press('h'); await pause(800);
        if (!await page.$('[data-testid="admin-panel"]')) await click('[data-testid="admin-toggle"]').catch(() => {});
        await page.click('[data-testid="admin-prompt"]');
        await page.keyboard.type('add a room for review with 3 desks'); await page.keyboard.press('Enter');
        await page.waitForFunction(() => { const es = [...document.querySelectorAll('[data-testid="admin-entry"]')]; const l = es[es.length - 1]; return l && l.dataset.status !== 'thinking'; }, { timeout: 20000 });
        const status = await page.$$eval('[data-testid="admin-entry"]', es => es[es.length - 1].dataset.status);
        check('admin: room request gives a proposal', status === 'proposed', { status });
        if (status === 'proposed') {
            const applies = await page.$$('[data-testid="admin-apply"]'); await applies[applies.length - 1].click(); await pause(1500);
            d = await ds();
            const rooms2 = J(d.worldRooms, []), desks2 = J(d.worldStations, []);
            check('admin: Apply adds a room', rooms2.length === rooms1.length + 1, { before: rooms1.length, after: rooms2.length });
            check('admin: Apply adds 3 desks', desks2.length === desks1.length + 3, { before: desks1.length, after: desks2.length });
        }
        await shot('2-admin-room');
        if (await page.$('[data-testid="admin-close"]')) await click('[data-testid="admin-close"]'); else { await page.focus(CANVAS); await page.keyboard.press('h'); }
        await pause(600);

        // 3. build mode world size + open world
        await page.focus(CANVAS); await page.keyboard.press('b'); await pause(800);
        check('build: World size controls present', !!await page.$('[data-testid="build-world-size"]'));
        const before3 = J((await ds()).worldShell, {});
        if (await page.$('[data-testid="build-world-width-plus"]')) {
            await click('[data-testid="build-world-width-plus"]'); await pause(400);
            await click('[data-testid="build-world-depth-plus"]'); await pause(400);
            if (await page.$('[data-testid="build-apply"]')) await click('[data-testid="build-apply"]'); await pause(1200);
            const after3 = J((await ds()).worldShell, {});
            const step = n => Math.min(200, Math.floor(n / 4) * 4 + 4); // + goes to the next 4 m step
            check('build: + grows the world to the next 4 m step each way', after3.width === step(before3.width) && after3.depth === step(before3.depth), { before3, after3 });
        }
        if (!J((await ds()).worldShell, {}).open && await page.$('[data-testid="build-world-open"]')) {
            await click('[data-testid="build-world-open"]'); await pause(400);
            if (await page.$('[data-testid="build-apply"]')) await click('[data-testid="build-apply"]'); await pause(1200);
        }
        check('build: Open world switch makes an open world', J((await ds()).worldShell, {}).open === true, J((await ds()).worldShell, {}));
        await shot('3-build-world-size');

        // 4. desk past the edge grows the world
        const before4 = J((await ds()).worldShell, {}); const deskN4 = J((await ds()).worldStations, []).length;
        await click('[data-testid="overview-mode"]').catch(() => {}); await pause(1000);
        await click('[data-testid="build-item-agent-desk"]'); await pause(500);
        const wrap = await page.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        let placed = false, ghostAt;
        for (const [fx, fy] of [[0.97, 0.5], [0.95, 0.6], [0.93, 0.4], [0.98, 0.7], [0.9, 0.5], [0.04, 0.5], [0.06, 0.6]]) {
            const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
            await page.mouse.move(x, y); await pause(300);
            const ghost = await page.$eval('[data-testid="build-mode"]', e => e.dataset.ghost || '');
            if (/true$/.test(ghost)) { ghostAt = [fx, fy]; await page.mouse.click(x, y); placed = true; break; }
        }
        check('build: ghost desk placed near the edge', placed, ghostAt);
        if (placed) {
            const diff = await page.$eval('[data-testid="build-diff"]', e => e.innerText).catch(() => '');
            if (await page.$('[data-testid="build-apply"]')) await click('[data-testid="build-apply"]'); await pause(1500);
            d = await ds(); const after4 = J(d.worldShell, {});
            check('build: desk added', J(d.worldStations, []).length === deskN4 + 1, { before: deskN4, after: J(d.worldStations, []).length });
            check('build: world grew or already fitted (no clamp error)', after4.width >= before4.width && after4.depth >= before4.depth, { before4, after4, diff: diff.slice(0, 160) });
        }
        if (await page.$('[data-testid="build-exit"]')) await click('[data-testid="build-exit"]'); await pause(800);
        await shot('4-desk-at-edge-overview');

        // 5. walking past the classic bounds
        await click('[data-testid="walk-mode"]').catch(() => {}); await pause(1000);
        await page.focus(CANVAS);
        const x0 = Number((await ds()).playerX);
        await page.keyboard.down('d'); await pause(6000); await page.keyboard.up('d'); await pause(500);
        const x1 = Number((await ds()).playerX);
        check('walk: player can go beyond the classic room edge (|x| > 5.5 m)', Math.abs(x1) > 5.5 || Math.abs(x1 - x0) > 5.5, { x0, x1 });
        await shot('5-walked');

        // 6. far monitors park
        const parked = J((await ds()).parkedScreens, null);
        check('render: parked-screen state is published', Array.isArray(parked), parked);
        check('no page errors', errors.length === 0, errors.slice(0, 3));
    } catch (e) {
        failed++; console.log('FAIL run —', e.message);
        try { const pg = (await browser.pages()).slice(-1)[0]; await pg.screenshot({ path: path.join(OUT, 'fail.png') }); } catch {}
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ failed, checks, errors }, null, 1));
        if (browser) await browser.close().catch(() => {});
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        await pause(2500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
        console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);
        process.exitCode = failed ? 1 : 0;
    }
})();
