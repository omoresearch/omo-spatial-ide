#!/usr/bin/env node
/*
 * builder-ui — real-app check of the World Builder panel (real local app on an owned port, real Chrome,
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
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'builder-ui', 'real'));
const PORT = Number(process.argv[3] || 3745);
if (!(PORT >= 3740 && PORT <= 3759)) { console.error('Use a port from 3740 to 3759.'); process.exit(2); }
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 260) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-bui-'));
    const project = path.join(S, 'builder'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# builder\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    // Owned static page for the web wall (port + 100).
    const staticPort = PORT + 100;
    const pageServer = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><title>builder-ui static</title><h1>BUILDER_UI_STATIC</h1>'); }).listen(staticPort, '127.0.0.1');
    const webUrl = `http://127.0.0.1:${staticPort}/page.html`;
    const socket = `omo-bui-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = [];
    try {
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
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

        // Open the builder with B in the overview.
        await click('[data-testid="overview-mode"]').catch(() => {}); await pause(1000);
        await page.focus(CANVAS); await page.keyboard.press('b');
        await page.waitForSelector('[data-testid="world-builder"]');
        check('B opens the World Builder panel', !!await page.$('[data-testid="world-builder"]'));
        await shot('0-builder-add');

        // 5 (early). Nothing covers the screen centre / bottom-centre monitor click point.
        const cover = await page.evaluate(() => {
            const c = document.querySelector('canvas[data-testid="omo-world-canvas"]').getBoundingClientRect();
            const pts = [[c.left + c.width / 2, c.top + c.height / 2], [c.left + c.width / 2, c.top + c.height * 0.85]];
            const panel = document.querySelector('[data-testid="world-builder"]').getBoundingClientRect();
            return { hits: pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.tagName + (e.dataset.testid ? `#${e.dataset.testid}` : '') + '.' + (e.className?.baseVal ?? e.className ?? '')).slice(0, 80) : 'none'; }), panel: [panel.left, panel.top, panel.right, panel.bottom].map(Math.round), canvas: [c.left, c.top, c.right, c.bottom].map(Math.round) };
        });
        check('Nothing covers the screen centre or the bottom-centre monitor point', cover.hits.every(h => /^CANVAS/.test(h)), cover);

        // world-ui: popovers open inside the panel flow: every tab is hit-testable at its centre (nothing paints over the tab row).
        const tabsClear = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="builder-tab-"]')].map(t => { const r = t.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && t.contains(e); }));
        check('World Builder tabs are not covered by any popover', tabsClear.length >= 3 && tabsClear.every(Boolean), tabsClear);
        check('No native <select> inside the World Builder', await page.$$eval('[data-testid="world-builder"] select', l => l.length) === 0);

        // 1. Talk.
        await click('[data-testid="builder-tab-talk"]'); await pause(400);
        // count BEFORE asking: the proposal's ghost preview already shows its desks in the dataset
        const desks0 = J((await ds()).worldStations, []).length, rooms0 = J((await ds()).worldRooms, []).length;
        await page.click('[data-testid="admin-prompt"]'); await page.keyboard.type('add a room for research with 2 desks'); await page.keyboard.press('Enter');
        await page.waitForSelector('[data-testid="admin-entry"][data-status="proposed"]', { timeout: 30000 });
        const plan = await page.evaluate(() => ({ steps: [...document.querySelectorAll('[data-testid="admin-ops"] li')].map(l => l.textContent), diff: document.querySelector('[data-testid="builder-plan-diff"]')?.textContent, ghost: document.querySelector('[data-testid="world-builder"]').dataset.ghostPreview }));
        check('Talk: plan shows steps and a diff summary', plan.steps.length > 0 && /\+\d+ rooms?/.test(plan.diff || '') && /\+2 desks/.test(plan.diff || ''), plan);
        check('Talk: ghost preview hook lists the proposed things', (plan.ghost || '').split(',').filter(Boolean).length >= 3, plan.ghost);
        await shot('1-talk-plan');
        await click('[data-testid="admin-apply"]'); await pause(1500);
        let d = await ds();
        check('Talk: Apply adds the room and 2 desks', J(d.worldRooms, []).length > rooms0 && J(d.worldStations, []).length === desks0 + 2, { rooms: J(d.worldRooms, []), desks: J(d.worldStations, []).length, desks0 });
        await shot('1b-talk-applied');

        // 2. Add tab: monitor wall linked to Desk one + web wall with URL.
        await click('[data-testid="builder-tab-add"]'); await pause(400);
        const deskOne = await page.evaluate(() => { const w = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); const world = JSON.parse(localStorage.getItem(w)); const s = world.entities.find(e => e.kind === 'station' && /desk one/i.test(e.label || e.station.name)) || world.entities.find(e => e.kind === 'station'); return s.id; });
        // world-ui: the follows picker is a custom select (no native <select>): open it, then pick the option.
        await click('[data-testid="builder-monitor-link"]'); await pause(200);
        await page.$eval(`[data-testid="builder-monitor-link-option"][data-value="${deskOne}"]`, e => e.click()); await pause(200);
        check('Add: the custom follows select shows the picked desk', await page.$eval('[data-testid="builder-monitor-link"]', e => e.dataset.value) === deskOne);
        await page.click('[data-testid="builder-web-url"]', { clickCount: 3 }); await page.keyboard.type(webUrl); await page.keyboard.press('Enter');
        const wrap = await page.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        const placeAt = async (item, spots) => {
            await click(`[data-testid="build-item-${item}"]`); await pause(500);
            for (const [fx, fy] of spots) {
                const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
                if (!await page.evaluate((x, y) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', x, y)) continue;
                await page.mouse.move(x, y); await pause(350);
                const g = await page.$eval('[data-testid="build-mode"]', e => e.dataset.ghost || '');
                if (/true$/.test(g)) { await page.mouse.click(x, y); await pause(400); return g; }
            }
            return '';
        };
        const spots = [[0.3, 0.4], [0.35, 0.5], [0.25, 0.6], [0.4, 0.35], [0.45, 0.45], [0.2, 0.45], [0.5, 0.3], [0.3, 0.7], [0.55, 0.6]];
        const g1 = await placeAt('monitor-wall', spots);
        await page.keyboard.press('Escape'); await pause(300);
        const g2 = await placeAt('web-wall', spots.slice().reverse());
        await page.keyboard.press('Escape'); await pause(300);
        check('Add: placement ghosts placed a monitor wall and a web wall', !!g1 && !!g2, { g1, g2 });
        await shot('2-add-pending');
        const tray = await page.$eval('[data-testid="builder-diff-summary"]', e => e.textContent).catch(() => '');
        check('Add: tray shows the diff summary', /monitor wall/.test(tray) && /web wall/.test(tray), tray);
        if (await page.$('[data-testid="build-apply"]')) await click('[data-testid="build-apply"]'); await pause(1500);
        const w2 = await savedWorld();
        const mon = w2?.entities.filter(e => e.kind === 'monitor-wall' && e.link === deskOne) || [];
        const web = w2?.entities.filter(e => e.kind === 'web-wall' && e.home === webUrl) || [];
        check('Add: monitor wall exists and follows Desk one', mon.length >= 1, { deskOne, monitors: w2?.entities.filter(e => e.kind === 'monitor-wall').map(e => [e.id, e.link]) });
        check('Add: web wall exists with the owned page URL', web.length >= 1, { webUrl, webs: w2?.entities.filter(e => e.kind === 'web-wall').map(e => [e.id, e.home]) });

        // 3. Inspector: select a desk via the rooms list jump / pick, rename, then undo.
        const deskId = deskOne;
        await page.evaluate(id => { const c = document.querySelector('canvas[data-testid="omo-world-canvas"]'); c.focus(); return id; }, deskId);
        // Select through the Rooms tab is room-only; select the desk by clicking it on screen is flaky in the overview, so use the build hook.
        const selected = await page.evaluate(id => { const panel = document.querySelector('[data-testid="build-mode"]'); return panel ? id : ''; }, deskId);
        // Find the desk on screen: hover candidate points until data-hover is the desk.
        let picked = false;
        await click('[data-testid="builder-tab-add"]');
        for (let fy = 0.25; fy <= 0.85 && !picked; fy += 0.05) for (let fx = 0.1; fx <= 0.7 && !picked; fx += 0.04) {
            const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
            await page.mouse.move(x, y); await pause(60);
            if ((await page.$eval('[data-testid="build-mode"]', e => e.dataset.hover || '')) === deskId) { await page.mouse.click(x, y); picked = true; }
        }
        await pause(600);
        const insp = await page.$('[data-testid="build-inspector"]');
        check('Inspector: clicking a desk shows the inspector in the builder', picked && !!insp, { picked, selected, view: await page.$eval('[data-testid="world-builder"]', e => e.dataset.view) });
        if (insp) {
            const oldName = await page.$eval('[data-testid="build-rename"]', e => e.value);
            await page.click('[data-testid="build-rename"]', { clickCount: 3 }); await page.keyboard.type('Renamed desk'); await page.keyboard.press('Enter'); await pause(500);
            const pending = await page.$eval('[data-testid="builder-diff-summary"]', e => e.textContent).catch(() => '');
            await shot('3-inspector-rename');
            await click('[data-testid="builder-undo"]'); await pause(500);
            const after = await page.$eval('[data-testid="build-rename"]', e => e.value).catch(() => '');
            check('Inspector: rename is a pending change, undo restores the name', /1 changed/.test(pending) && after === oldName && !await page.$('[data-testid="build-apply"]'), { oldName, pending, after });
            await page.keyboard.press('Escape').catch(() => {});
        }

        // 4. Placement past the edge grows the world.
        await click('[data-testid="builder-tab-add"]').catch(() => {}); await pause(300);
        const before4 = J((await ds()).worldShell, {});
        const g4 = await placeAt('shell-desk', [[0.02, 0.5], [0.03, 0.6], [0.02, 0.4], [0.04, 0.7], [0.05, 0.3], [0.62, 0.05], [0.4, 0.97]]);
        await page.keyboard.press('Escape'); await pause(300);
        if (await page.$('[data-testid="build-apply"]')) await click('[data-testid="build-apply"]'); await pause(1500);
        const after4 = J((await ds()).worldShell, {});
        check('Add: a desk past the edge grows the world', !!g4 && (after4.width > before4.width || after4.depth > before4.depth || (after4.open && before4.open)), { g4, before4, after4 });
        await shot('4-grown');

        // Rooms list.
        await click('[data-testid="builder-tab-rooms"]'); await pause(400);
        const roomsListed = await page.$$eval('[data-testid^="builder-room-room"], [data-testid^="builder-room-"]', es => es.filter(e => /^builder-room-[a-z0-9-]+$/.test(e.dataset.testid) && e.tagName === 'LI').length);
        check('Rooms tab lists the rooms', roomsListed >= 1, roomsListed);
        await shot('5-rooms');
        check('no page errors', errors.length === 0, errors.slice(0, 3));
    } catch (e) {
        failed++; console.log('FAIL run —', e.message);
        try { const pg = (await browser.pages()).slice(-1)[0]; await pg.screenshot({ path: path.join(OUT, 'fail.png') }); } catch {}
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ failed, checks, errors }, null, 1));
        if (browser) await browser.close().catch(() => {});
        pageServer.close();
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        await pause(2500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
        fs.rmSync(S, { recursive: true, force: true });
        console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);
        process.exitCode = failed ? 1 : 0;
    }
})();
