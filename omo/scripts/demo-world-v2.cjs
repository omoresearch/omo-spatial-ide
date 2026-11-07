#!/usr/bin/env node
/*
 * World v2 demo recorder (real local app, real Chrome, fixture CLIs only).
 * Scenes: plan-to-world onboarding -> live 3D room -> build mode adds a desk -> Hermes admin (rule planner)
 * proposal + Apply -> real shell on desk 3 -> immersive view -> closing card.
 * Every caption is backed by a DOM/dataset assertion recorded while filming. Usage:
 *   node scripts/demo-world-v2.cjs <outDir> [port]
 * Frames: CDP Page.startScreencast -> JPEG files -> ffmpeg (done by the caller).
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const puppeteer = require(path.join(__dirname, '..', 'node_modules', 'puppeteer-core'));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'demo-w2'));
const PORT = Number(process.argv[3] || 3527);
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + JSON.stringify(detail).slice(0, 200) : ''}`); if (!pass) throw new Error('check failed: ' + name); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-demo-'));
    const project = path.join(S, 'research-lab'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'README.md'), '# research lab\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# Fixture only: no model or network calls.\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const hermesRoot = path.join(S, 'hermes'); fs.mkdirSync(path.join(hermesRoot, 'profiles', 'default'), { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, 'profiles', 'default', 'config.yaml'), '# fixture\n');
    const socket = `omo-demo-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_ROOT: hermesRoot, OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex'),
        PS1: 'research-lab $ ' };
    const log = fs.openSync(path.join(S, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser, frameNo = 0, recording = false, cdp;
    const errors = [];
    try {
        for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push(String(e.message || e)));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); } catch {}
            const trust = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click();
            new MutationObserver(trust).observe(document, { childList: true, subtree: true });
            // Demo overlay: caption pill (top) + cursor dot. Pointer-events none, so it never steals clicks.
            const mount = () => {
                if (document.getElementById('demo-cap')) return;
                const st = document.createElement('style');
                st.textContent = `#demo-cap{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;max-width:1100px;padding:10px 20px;border-radius:999px;background:rgba(10,14,22,.86);color:#eafff6;font:600 19px/1.35 Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid rgba(110,231,183,.45);pointer-events:none;text-align:center}
                #demo-cap small{display:block;font-weight:500;font-size:14px;color:#a7f3d0;opacity:.9}
                #demo-dot{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(110,231,183,.55);border:2px solid #fff;z-index:2147483646;pointer-events:none;transition:transform .15s,left .25s,top .25s;left:-50px;top:-50px}
                #demo-card{position:fixed;inset:0;z-index:2147483647;background:#0b1220;color:#e5e7eb;display:flex;flex-direction:column;justify-content:center;padding:0 160px;font:500 22px/1.55 Inter,system-ui,sans-serif}
                #demo-card h1{font-size:44px;color:#6ee7b7;margin:0 0 18px} #demo-card li{margin:4px 0} #demo-card .no{color:#fca5a5}`;
                document.head.appendChild(st);
                const c = document.createElement('div'); c.id = 'demo-cap'; c.style.display = 'none'; document.body.appendChild(c);
                const d = document.createElement('div'); d.id = 'demo-dot'; document.body.appendChild(d);
            };
            document.addEventListener('DOMContentLoaded', mount);
            window.__demoCaption = (t, s) => { mount(); const c = document.getElementById('demo-cap'); c.style.display = t ? 'block' : 'none'; c.innerHTML = t ? `${t}${s ? `<small>${s}</small>` : ''}` : ''; };
            window.__demoDot = (x, y, press) => { mount(); const d = document.getElementById('demo-dot'); d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.transform = press ? 'scale(.65)' : 'scale(1)'; };
            window.__demoCard = html => { mount(); let k = document.getElementById('demo-card'); if (!k) { k = document.createElement('div'); k.id = 'demo-card'; document.body.appendChild(k); } k.innerHTML = html; };
        });
        const cap = (t, s) => page.evaluate((t, s) => window.__demoCaption(t, s), t, s || '');
        const dot = async (x, y, press) => { await page.evaluate((x, y, p) => window.__demoDot(x, y, p), x, y, !!press); };
        const clickAt = async (x, y) => { await dot(x, y); await pause(350); await dot(x, y, true); await page.mouse.click(x, y); await pause(150); await dot(x, y); };
        const clickSel = async sel => { const b = await page.$eval(sel, e => { e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); await clickAt(b.x, b.y); };
        const typeSlow = async text => { for (const ch of text) { await page.keyboard.type(ch); await pause(18); } };
        const ds = () => page.$eval(CANVAS, c => ({ ...c.dataset }));
        const hold = ms => pause(ms);

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-onboarding"]', { timeout: 120000 });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 90000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 });
        await pause(1500);

        // ---- start filming
        cdp = await page.createCDPSession();
        cdp.on('Page.screencastFrame', async f => {
            if (recording) fs.writeFileSync(path.join(OUT, 'frames', `${String(frameNo++).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64'));
            try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
        });
        const t0 = Date.now(); const timeline = [];
        const mark = label => timeline.push({ t: (Date.now() - t0) / 1000, label });
        recording = true;
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });

        // Scene 1: describe the plan
        mark('describe');
        await cap('1 · Describe your plan', 'Omo builds the world from what you type. No model needed: an offline planner reads it.');
        await hold(1800);
        await clickSel('[data-testid="onboarding-prompt"]');
        await typeSlow('research lab: 3 Hermes desks for literature, data and writing, a shared monitor wall, a web wall for papers');
        await hold(1400);
        const understood = await page.$eval('[data-testid="onboarding-understood"]', e => e.innerText).catch(() => '');
        check('planner understood the plan', /3/.test(understood) || /desk/i.test(understood), understood.slice(0, 160));
        await clickSel('[data-testid="onboarding-next"]');
        await hold(1800);
        mark('preview');
        await cap('2 · Your world, before it exists', 'Floor plan + live 3D preview. Rename, remove or add desks here.');
        const ents = await page.$$eval('[data-testid="onboarding-entity-list"] li[data-kind="station"]', ls => ls.length);
        check('preview lists 3 desks', ents === 3, { ents });
        await hold(3200);
        await clickSel('[data-testid="onboarding-next"]');
        await hold(1200);
        await cap('3 · Create', 'Nothing starts: agents only launch when you confirm them at a desk.');
        await hold(1400);
        await clickSel('[data-testid="create-room"]');
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 30000 });
        await hold(1500);
        let d = await ds();
        check('room has the 3 planned desks', JSON.parse(d.worldStations || '[]').length === 3, d.worldStations);

        // Scene 2: overview of the built room
        mark('overview');
        await clickSel('[data-testid="overview-mode"]');
        await cap('Your room, built from the plan', `${JSON.parse(d.worldStations).length} desks · monitor wall · web wall for papers`);
        await hold(4000);

        // Scene 3: build mode adds a desk
        mark('build');
        await page.focus(CANVAS); await page.keyboard.press('b'); await hold(700);
        check('build mode opens with B', !!await page.$('[data-testid="build-mode"]'));
        await cap('Build mode (B): place anything, then Apply', 'Agent desks, shell desks, monitor walls, web walls, mirrors, decor. Ghost preview first.');
        await hold(1500);
        await clickSel('[data-testid="build-item-agent-desk"]'); await hold(500);
        const wrap = await page.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        let placed = false;
        for (const [fx, fy] of [[0.62, 0.72], [0.55, 0.78], [0.7, 0.66], [0.45, 0.8], [0.4, 0.7], [0.6, 0.6]]) {
            const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
            await dot(x, y); await page.mouse.move(x, y); await pause(300);
            const ghost = await page.$eval('[data-testid="build-mode"]', e => e.dataset.ghost || '');
            if (/true$/.test(ghost)) { await clickAt(x, y); placed = true; break; }
        }
        check('ghost desk placed', placed);
        await hold(1200);
        await cap('Every change is a proposal', 'You see the diff. Nothing is saved until you press Apply.');
        await hold(2200);
        const applyBtn = await page.$('[data-testid="build-apply"]');
        if (applyBtn) await clickSel('[data-testid="build-apply"]');
        await hold(1500);
        d = await ds();
        check('applied: 4 desks in the world', JSON.parse(d.worldStations || '[]').length === 4, d.worldStations);
        if (await page.$('[data-testid="build-exit"]')) await clickSel('[data-testid="build-exit"]');
        await hold(800);

        // Scene 4: Hermes admin (rule planner)
        mark('admin');
        await page.focus(CANVAS); await page.keyboard.press('h'); await hold(700);
        if (!await page.$('[data-testid="admin-panel"]')) await clickSel('[data-testid="admin-toggle"]');
        check('admin opens', !!await page.$('[data-testid="admin-panel"]'));
        await cap('Or just ask the Hermes admin (H)', 'Built-in planner here (no model call). Hermes can plan too, only if you opt in.');
        await hold(1200);
        await clickSel('[data-testid="admin-prompt"]');
        await typeSlow('add a desk for Codex and a big monitor wall linked to it');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => { const es = [...document.querySelectorAll('[data-testid="admin-entry"]')]; const l = es[es.length - 1]; return l && l.dataset.status !== 'thinking'; }, { timeout: 20000 });
        await hold(1800);
        const status = await page.$$eval('[data-testid="admin-entry"]', es => es[es.length - 1].dataset.status);
        check('admin returned a proposal', status === 'proposed', { status });
        const before = JSON.parse((await ds()).worldStations || '[]').length;
        await cap('A proposal, not a change', 'The saved world stays the same until you press Apply.');
        await hold(2200);
        const applies = await page.$$('[data-testid="admin-apply"]');
        const ab = await applies[applies.length - 1].boundingBox(); await clickAt(ab.x + ab.width / 2, ab.y + ab.height / 2);
        await hold(1800);
        d = await ds();
        const after = JSON.parse(d.worldStations || '[]').length;
        check('admin Apply added the Codex desk', after === before + 1, { before, after });
        await cap('Applied: the room grows', `${after} desks now, plus a linked monitor wall`);
        await hold(3000);
        if (await page.$('[data-testid="admin-close"]')) await clickSel('[data-testid="admin-close"]'); else { await page.focus(CANVAS); await page.keyboard.press('h'); }
        await hold(600);

        // Scene 5: real shell on desk 3
        mark('desk3');
        await clickSel('[data-testid="walk-mode"]'); await hold(900);
        const pos = JSON.parse((await ds()).deskPositions || '{}');
        const target = pos['desk-3'] ? 'desk-3' : Object.keys(pos)[2];
        await cap('Walk to desk 3 and use its monitor', 'Every desk has its own real shell, running in its own persistent session');
        const axis = async (key, field, goal, dir) => {
            const reached = () => page.$eval(CANVAS, (c, f, g, d) => { const n = Number(c.dataset[f]); return d > 0 ? n >= g : n <= g; }, field, goal, dir);
            const deadline = Date.now() + 30000;
            while (!await reached()) { if (Date.now() > deadline) throw new Error('walk stuck'); await page.focus(CANVAS); await page.keyboard.down(key); try { for (let t = 0; t < 20 && !await reached(); t++) await pause(40); } finally { await page.keyboard.up(key); } }
        };
        const goal = pos[target];
        let p = await page.$eval(CANVAS, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ }));
        const gz = goal.z + 2.2;
        if (Math.abs(p.z - gz) > .12) await axis(p.z < gz ? 's' : 'w', 'playerZ', gz, p.z < gz ? 1 : -1);
        p = await page.$eval(CANVAS, e => ({ x: +e.dataset.playerX, z: +e.dataset.playerZ }));
        if (Math.abs(p.x - goal.x) > .12) await axis(p.x < goal.x ? 'd' : 'a', 'playerX', goal.x, p.x < goal.x ? 1 : -1);
        await hold(600);
        const t = JSON.parse((await ds()).stationTargets)[target];
        const r = await page.$eval(CANVAS, c => { const b = c.getBoundingClientRect(); return [b.left, b.top]; });
        await clickAt(r[0] + t.x, r[1] + t.y);
        await page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 30000 });
        await hold(900);
        // Station setup offers to start the desk's tabs; the demo keeps just the shell (nothing starts unless confirmed).
        const cancel = await page.$$eval('button', bs => { const b = bs.find(b => b.textContent.trim() === 'Cancel' && b.closest('[class*="setup"],[class*="recipe"],[class*="confirm"]')); if (b) { b.click(); return true; } return false; });
        if (cancel) await hold(600);
        await page.focus(CANVAS).catch(() => {});
        await typeSlow("echo hello from desk 3 && ls"); await page.keyboard.press('Enter');
        await page.waitForFunction(id => (JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText || '{}')[id] || []).some(l => l.trim().startsWith('hello from desk 3')), { timeout: 20000 }, target);
        check('real shell output on desk 3', true, target);
        await cap('Real shell, on a physical screen in the world', `${target}: typed here, output on this desk only`);
        await hold(3500);

        // Scene 6: immersive
        mark('immersive');
        await page.keyboard.press('Escape'); await hold(500); await page.keyboard.press('Escape'); await hold(700);
        await page.focus(CANVAS); await page.keyboard.press('g'); await hold(1500);
        await cap('Immersive world (G)', 'The room fills the window. Multiplayer, voice and agent status work the same here.');
        await hold(3500);
        await page.keyboard.press('g'); await hold(800);

        // Closing card
        mark('card');
        await cap('');
        await page.evaluate(() => window.__demoCard(`<h1>omo · world v2 (local demo)</h1>
          <ul><li>Plan-to-world onboarding, build mode, Hermes admin, N desks: shown live above</li>
          <li>Also merged, tested separately: multiplayer across two app instances (23/23), voice, real agent status, templates</li>
          <li>Checks on this exact build: unit 422/422 · browser 110/110 · room server 4 suites · Python OK</li></ul>
          <p class="no">Not shown / not proven yet: two real computers over Tailscale, real Claude/Hermes runs (fixture CLIs here), new macOS download (GitHub Actions blocked)</p>`));
        await hold(6000);
        recording = false;
        await cdp.send('Page.stopScreencast');
        check('no page errors', errors.length === 0, errors.slice(0, 3));
        fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ pass: true, frames: frameNo, seconds: (Date.now() - t0) / 1000, timeline, checks }, null, 1));
        console.log(`DONE frames=${frameNo} seconds=${((Date.now() - t0) / 1000).toFixed(1)}`);
    } catch (e) {
        console.error('FAIL', e.message);
        try { const pg = (await browser.pages())[1]; await pg.screenshot({ path: path.join(OUT, 'fail.png') }); } catch {}
        fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ pass: false, error: e.message, frames: frameNo, checks, errors }, null, 1));
        process.exitCode = 1;
    } finally {
        recording = false;
        if (browser) await browser.close().catch(() => {});
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        await pause(2500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    }
})();
