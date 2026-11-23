#!/usr/bin/env node
/*
 * live-desks-real — demo-ready (1)(2)(4): real local app on an owned port, real Chrome on the GPU, the bundled tmux,
 * fixture agent CLIs only (each one writes a marker if it is ever run). Onboarding is skipped with "Start in the
 * penthouse". Nothing is clicked on a desk.
 *   1. Within 20 s of the world loading, every desk monitor mirrors a live shell prompt (the mirrored text per desk,
 *      canvas data-station-text, ends in a "$ " prompt line), and no desk keeps its idle card.
 *   2. No agent started: tmux list-panes -F '#{pane_current_command}' on the app's socket lists only shells, there is
 *      one shell pane per desk, and no fixture agent CLI wrote its marker.
 *   3. Bigger monitor text: at the spawn view, the glyph height (ascent + descent of the monitor font, scaled by the
 *      monitor's on-screen height) is >= 12 px on the nearest visible desk monitor.
 *   4. From the overview every monitor is live (none parked), still showing its prompt; no page errors.
 * Screenshots: 1-spawn-view, 2-nearest-desk, 3-overview (+ results.json, panes.txt).
 * Usage: node scripts/live-desks-real.cjs <outDir> [port 3750-3759]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'live-desks'));
const PORT = Number(process.argv[3] || 3759);
if (!(PORT >= 3750 && PORT <= 3759)) { console.error('Use a port from 3750 to 3759.'); process.exit(2); }
const TMUX = process.env.OMO_SPATIAL_TMUX || path.join(os.homedir(), '.local', 'share', 'omo', 'bin', 'tmux');
if (!fs.existsSync(TMUX)) { console.error(`No tmux at ${TMUX} (set OMO_SPATIAL_TMUX).`); process.exit(2); }
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const SHELLS = /^(-?bash|-?sh|-?zsh|-?dash|-?fish)$/;
const PROMPT = /\$\s*$/;
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-live-desks-'));
    const project = path.join(S, 'live-desks'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# live desks fixture\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    const marker = path.join(S, 'agent-ran.log');
    for (const k of ['hermes', 'claude', 'codex']) {
        fs.writeFileSync(path.join(bin, k), `#!/usr/bin/python3\n# Fixture only: no model or network calls. Leaves a marker if it is ever run.\nimport sys\nopen(${JSON.stringify(marker)}, 'a').write(${JSON.stringify(k)} + '\\n')\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n`);
        fs.chmodSync(path.join(bin, k), 0o755);
    }
    const hermesRoot = path.join(S, 'hermes'); fs.mkdirSync(path.join(hermesRoot, 'profiles', 'default'), { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, 'profiles', 'default', 'config.yaml'), '# fixture\n');
    const socket = `omo-live-desks-${PORT}`;
    const env = { ...process.env, PATH: `${path.dirname(TMUX)}:${process.env.PATH ?? ''}`, OMO_SPATIAL_TMUX: TMUX,
        THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket, OMO_SPATIAL_HERMES_ROOT: hermesRoot,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const tmux = (...args) => spawnSync(TMUX, ['-L', socket, ...args], { encoding: 'utf8', timeout: 5000 });
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = [];
    try {
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', e => errors.push(String(e.message || e)));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
            new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true });
        });
        const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
        const data = () => page.$eval(CANVAS, c => ({
            stations: JSON.parse(c.dataset.worldStations || '[]'), text: JSON.parse(c.dataset.stationText || '{}'),
            parked: JSON.parse(c.dataset.parkedScreens || '[]'), quads: JSON.parse(c.dataset.terminalQuads || '{}'),
            targets: JSON.parse(c.dataset.stationTargets || '{}'), nav: c.dataset.navigation, size: [c.clientWidth, c.clientHeight] }));
        const lastLine = lines => [...(lines ?? [])].reverse().find(l => l.trim()) ?? '';

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        // Skip onboarding: "Start in the penthouse".
        for (let i = 0; i < 3; i++) { await page.$eval('[data-testid="create-room"]', b => b.click()).catch(() => {}); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 8000 }); break; } catch {} }
        const loadedAt = Date.now();
        const label = await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.dataset.testid === 'create-room')?.textContent ?? '(gone)');
        const gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl'); const x = g?.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        check('Chrome renders on the GPU (not SwiftShader)', !/swiftshader|llvmpipe|software/i.test(gpu), gpu);
        check('Onboarding skipped with "Start in the penthouse"; the world is in walk mode', (await data()).nav === 'walk', { button: label });

        // 1. Every desk monitor mirrors a live shell prompt within 20 s.
        let d = await data(), allLive = false;
        while (Date.now() - loadedAt < 20000) {
            d = await data();
            allLive = d.stations.length > 0 && d.stations.every(id => PROMPT.test(lastLine(d.text[id])));
            if (allLive) break;
            await pause(250);
        }
        const liveMs = Date.now() - loadedAt;
        const perDesk = Object.fromEntries(d.stations.map(id => [id, lastLine(d.text[id])]));
        check(`Every desk monitor (${d.stations.length}) shows a shell prompt within 20 s of load`, allLive && d.stations.length >= 2, { ms: liveMs, perDesk });
        fs.writeFileSync(path.join(OUT, 'mirrored-text.json'), JSON.stringify({ ms: liveMs, text: d.text }, null, 1));
        const cards = await page.evaluate(() => [...document.querySelectorAll('[data-testid="runtime-status"]')].map(e => e.textContent));
        check('No desk is left on "Click to use this desk." with an empty screen (each mirrored text is non-empty)', d.stations.every(id => (d.text[id] ?? []).some(l => l.trim())), { cards: cards.slice(0, 6) });

        // 2. No agent started.
        await pause(1500);
        const panes = tmux('list-panes', '-a', '-F', '#{session_name}:#{window_name} #{pane_current_command}');
        const commands = panes.stdout.trim().split('\n').filter(Boolean).map(l => l.split(' ').slice(-1)[0]);
        fs.writeFileSync(path.join(OUT, 'panes.txt'), `$ tmux -L ${socket} list-panes -a -F '#{session_name}:#{window_name} #{pane_current_command}'\n${panes.stdout}${panes.stderr}`);
        check("tmux list-panes -F '#{pane_current_command}' shows only shells (no agent process)", commands.length > 0 && commands.every(c => SHELLS.test(c)), { commands });
        check('At least one live shell pane per desk (each desk session + its monitor view sessions; all shells)', commands.length >= d.stations.length, { panes: commands.length, desks: d.stations.length });
        check('No fixture agent CLI (hermes / claude / codex) was ever run', !fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : 'no marker');
        await shot('1-spawn-view');

        // 3. Glyph height at the spawn view (nearest visible desk monitor).
        d = await data();
        const font = await page.evaluate(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '30px monospace'; const m = c.measureText('Mg$|'); return { ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent, cap: c.measureText('M').actualBoundingBoxAscent }; });
        const glyph = d.stations.map(id => {
            const q = d.quads[id]; if (!q) return { id, px: 0 };
            const h = (Math.hypot(q[0].x - q[3].x, q[0].y - q[3].y) + Math.hypot(q[1].x - q[2].x, q[1].y - q[2].y)) / 2; // on-screen monitor height, CSS px
            const k = h / 576, inView = q.every(p => p.x >= 0 && p.y >= 0 && p.x <= d.size[0] && p.y <= d.size[1]);
            return { id, monitorPx: Math.round(h), px: +((font.ascent + font.descent) * k).toFixed(1), capPx: +(font.cap * k).toFixed(1), inView, visible: !!d.targets[id]?.visible };
        }).sort((a, b) => b.px - a.px);
        const nearest = glyph.find(g => g.inView) ?? glyph[0];
        check('Spawn view: monitor glyph height >= 12 px on the nearest visible desk monitor', !!nearest && nearest.inView && nearest.px >= 12, { nearest, font, all: glyph });
        fs.writeFileSync(path.join(OUT, 'glyph-height.json'), JSON.stringify({ font, glyph }, null, 1));
        // A closer look at that desk for the eye (walk only, no click on the screen: nothing attaches).
        if (nearest?.id) {
            await page.focus(CANVAS);
            await page.keyboard.down('w'); await pause(900); await page.keyboard.up('w'); await pause(1200);
            await shot('2-nearest-desk');
        }

        // 4. Overview: every monitor live (none parked), still a prompt.
        await page.$eval('[data-testid="overview-mode"]', b => b.click()).catch(() => {});
        await page.waitForSelector(`${CANVAS}[data-navigation="overview"]`, { timeout: 5000 }).catch(async () => { await page.focus(CANVAS); await page.keyboard.press('Tab'); await pause(400); });
        await pause(2500);
        d = await data();
        check('Overview: every desk monitor is live (none parked) and still shows its prompt', d.nav !== 'walk' ? d.parked.length === 0 && d.stations.every(id => PROMPT.test(lastLine(d.text[id]))) : d.stations.every(id => PROMPT.test(lastLine(d.text[id]))),
            { nav: d.nav, parked: d.parked, desks: d.stations.length });
        await shot('3-overview');
        const panes2 = tmux('list-panes', '-a', '-F', '#{pane_current_command}').stdout.trim().split('\n').filter(Boolean);
        check('Still no agent process at the end of the run', panes2.length > 0 && panes2.every(c => SHELLS.test(c)) && !fs.existsSync(marker), { commands: panes2 });
        check('No page errors', errors.length === 0, errors.slice(0, 3));
    } catch (e) {
        failed++; console.log('FAIL run —', e.message);
        try { const pg = (await browser.pages()).slice(-1)[0]; await pg.screenshot({ path: path.join(OUT, 'fail.png') }); } catch {}
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ failed, checks, errors, port: PORT, tmux: TMUX, at: new Date().toISOString() }, null, 1));
        if (browser) await browser.close().catch(() => {});
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        await pause(2500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        spawnSync(TMUX, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 });
        fs.rmSync(S, { recursive: true, force: true });
        console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);
        process.exitCode = failed ? 1 : 0;
    }
})();
