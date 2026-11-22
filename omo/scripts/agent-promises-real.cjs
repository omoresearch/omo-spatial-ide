#!/usr/bin/env node
/*
 * agent-promises-real — the room-aware Omo in a real app on an owned port, real Chrome on the GPU,
 * fixture CLIs only, never real agents (desks run plain shells). Rules planner only.
 *   1. "where is the Claude desk" -> the answer card + the soft beam on that desk.
 *   2. "make a dashboard of my desks" -> a ghost -> Keep -> the page is live on the web wall
 *      (its URL is under /omo-pages/, the page and its state.json list the desk names).
 *   3. Reload -> the page is still on the wall.
 *   4. A desk state change while away (the Claude desk was working when you left) -> reload -> "Since you left: …".
 *   5. Use a desk, go elsewhere, "where was I" -> the camera walks back (the pose changes, to that desk).
 *   Polish checks: the answer is plain words with a landmark; the beam is bright, pulsing, never hidden; the page's
 *   wall is a solid wall (not the penthouse glass); after Keep the camera frames it and the dashboard text is taller
 *   than 24 px on screen.
 * Screenshots: 1-answer-beam, 2-dashboard-ghost, 3-dashboard-live (the framed wall), 4-after-reload, 5-since-you-left, 6-where-was-i.
 * Usage: node scripts/agent-promises-real.cjs <outDir> [port 3750-3759]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'promises-agent'));
const PORT = Number(process.argv[3] || 3755);
if (!(PORT >= 3750 && PORT <= 3759)) { console.error('Use a port from 3750 to 3759.'); process.exit(2); }
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-promises-'));
    const project = path.join(S, 'promises'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# shape\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-promises-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
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
        const click = sel => page.$eval(sel, e => e.click());
        const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
        const visible = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; }, sel);
        const savedWorld = () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return k ? JSON.parse(localStorage.getItem(k)) : null; });
        const ghost = () => page.evaluate(() => { const wb = document.querySelector('[data-testid="world-builder"]'); return { ids: wb?.dataset.ghostPreview ?? '', diff: wb?.dataset.diffSummary ?? '' }; });
        const captionText = () => page.$eval('[data-testid="shape-caption-text"]', e => e.textContent).catch(() => '');
        const type = async text => { await page.focus('[data-testid="shape-input"]'); await page.keyboard.type(text, { delay: 12 }); };
        const waitCaption = async (prev = '') => { await page.waitForFunction(p => { const t = document.querySelector('[data-testid="shape-caption-text"]')?.textContent; return t && t !== p && document.querySelector('[data-testid="shape-mode"]')?.dataset.busy === 'false'; }, { timeout: 20000 }, prev).catch(() => {}); await pause(700); };
        const centreFree = () => page.evaluate(() => {
            const c = document.querySelector('canvas[data-testid="omo-world-canvas"]').getBoundingClientRect();
            const pts = [[0.5, 0.5], [0.45, 0.45], [0.55, 0.55], [0.45, 0.55], [0.55, 0.45]].map(([fx, fy]) => [c.left + c.width * fx, c.top + c.height * fy]);
            return pts.map(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'none');
        });

        const omo = () => page.evaluate(() => ({ answer: document.querySelector('[data-testid="omo-answer-text"]')?.textContent ?? '', target: document.querySelector('[data-testid="omo-answer"]')?.dataset.target ?? '',
            beam: document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.answerBeam ?? '', since: document.querySelector('[data-testid="omo-since"]')?.textContent ?? '',
            web: document.querySelector('[data-testid="omo-world"]')?.dataset.webUrl ?? '', footer: document.querySelector('.omo-footer [role]')?.textContent ?? '',
            pose: document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.playerPose ?? '', walk: document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.walkTarget ?? '',
            nav: document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.navigation ?? '' }));
        const openShape = async () => { if (!await visible('[data-testid="shape-mode"]')) { await click('[data-testid="topbar-shape"]'); await pause(900); } };
        const ready = async () => {
            await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
            await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(2500);
        };
        const ask = async text => { await openShape(); await type(text); await page.keyboard.press('Enter'); };

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        for (let i = 0; i < 3; i++) { await click('[data-testid="create-room"]').catch(() => {}); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 8000 }); break; } catch {} }
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(2500);
        const gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl'); const x = g?.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        check('Chrome renders on the GPU (not SwiftShader)', !/swiftshader|llvmpipe|software/i.test(gpu), gpu);
        const world0 = await savedWorld();
        const desks = (world0?.entities ?? []).filter(e => e.kind === 'station');
        const claude = desks.find(d => /claude/i.test(d.station?.name ?? d.label ?? ''));
        check('The room has desks, one of them the Claude desk', desks.length >= 2 && !!claude, desks.map(d => `${d.id}:${d.station?.name}`));

        // 1. A question -> the answer card + the beam. (Fix 4: the region round the desk is measured before the ask.)
        const lum = (b64, box) => page.evaluate(async (b64, box) => {
            const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
            const x0 = Math.max(0, Math.round(box.x - box.w / 2)), y0 = Math.max(0, Math.round(box.y - box.h)), w = Math.min(img.width - x0, box.w), h = Math.min(img.height - y0, box.h + 40);
            const d = g.getImageData(x0, y0, w, h).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            return +(sum / (d.length / 4)).toFixed(1); }, b64, box);
        await openShape(); await pause(1500);
        const deskAt = await page.evaluate(() => { const r = document.querySelector('canvas[data-testid="omo-world-canvas"]').getBoundingClientRect(); return { canvas: [r.left, r.top, r.width, r.height] }; });
        const beforeShot = await page.screenshot({ encoding: 'base64' });
        await ask('where is the Claude desk');
        await page.waitForSelector('[data-testid="omo-answer"]', { timeout: 10000 }).catch(() => {});
        await pause(900);
        const a1 = await omo();
        check('"where is the Claude desk" -> an answer card that names the desk and its place', /claude/i.test(a1.answer) && /\b(wall|corner|middle|north|south|east|west)\b/i.test(a1.answer) && a1.target === claude?.id, a1);
        check('The soft beam stands on the Claude desk', a1.beam === claude?.id, { beam: a1.beam });
        check('The answer did not change the world (no ghost, nothing saved)', !(await ghost()).ids && JSON.stringify((await savedWorld()).entities) === JSON.stringify(world0.entities));
        // Fix 4: the desk's centre is not hidden (raycast from the camera: the first large hit is the desk), and the beam is bright there.
        await page.waitForFunction(() => { const s = document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.answerSight; return s && JSON.parse(s).id; }, { timeout: 8000 }).catch(() => {});
        await pause(1200);
        const sight = await page.evaluate(() => { const c = document.querySelector('canvas[data-testid="omo-world-canvas"]'); return { sight: JSON.parse(c?.dataset.answerSight || '{}'), view: c?.dataset.beamView ?? '' }; });
        const [cx, cy] = sight.sight.screen ?? [0, 0], box = { x: deskAt.canvas[0] + cx, y: deskAt.canvas[1] + cy, w: 70, h: 170 };
        const after = await lum(await page.screenshot({ encoding: 'base64' }), box), before = await lum(beforeShot, box);
        check('Fix 4: the Claude desk is not hidden — the raycast from the camera to its centre meets the desk first (no wall > 0.6 m in front)', sight.sight.id === claude?.id && sight.sight.occluded === false && cx > 0 && cy > 0 && cx < deskAt.canvas[2] && cy < deskAt.canvas[3], sight);
        check('Fix 4: the beam is visible — the pixels round the desk are brighter than before the ask (2 s pulse, ring at the base)', after > before + 10 && sight.sight.pulse === 2 && sight.sight.ring > 0.5, { before, after, box, pulse: sight.sight.pulse, ring: sight.sight.ring });
        await shot('1-answer-beam');

        // 2. A page on demand -> ghost -> Keep -> live on the wall.
        await page.$eval('[data-testid="shape-input"]', e => e.blur()).catch(() => {});
        await ask('make a dashboard of my desks');
        await page.waitForFunction(() => !document.querySelector('[data-testid="omo-making"]') && !!document.querySelector('[data-testid="shape-caption"]'), { timeout: 30000 }).catch(() => {});
        await pause(1200);
        const g2 = await ghost(), c2 = await captionText();
        const answerNote = (await omo()).answer;
        check('"make a dashboard of my desks" -> a pending ghost (a new web wall) + a caption with Keep', g2.ids.split(',').filter(Boolean).length >= 1 && !!c2 && !!await page.$('[data-testid="shape-keep"]'), { g2, c2, answerNote });
        await shot('2-dashboard-ghost');
        await click('[data-testid="shape-keep"]').catch(() => {}); await pause(1500);
        const world2 = await savedWorld();
        const wall = (world2?.entities ?? []).find(e => e.kind === 'web-wall' && /\/omo-pages\//.test(e.home ?? ''));
        check('Keep: the new web wall is in the saved world with its home under /omo-pages/', !!wall, (world2?.entities ?? []).filter(e => e.kind === 'web-wall').map(e => `${e.id}:${e.label}:${e.home ?? ''}`));
        // Polish check: the chosen wall is a solid wall, not glazing (the penthouse is glazed north and east).
        const { wallSide, isGlassSide } = require(path.join(ROOT, 'extension', 'lib', 'common', 'omo-agent.js'));
        const { activeKit } = require(path.join(ROOT, 'extension', 'lib', 'common', 'world-style-kits.js'));
        const kit2 = world2 && activeKit(world2), side2 = wall && wallSide(world2, wall.transform);
        const W2 = (world2?.shell.width ?? 0) / 2, D2 = (world2?.shell.depth ?? 0) / 2;
        const onEdge = wall && (side2 === 'south' ? D2 - wall.transform.z : side2 === 'north' ? wall.transform.z + D2 : side2 === 'west' ? wall.transform.x + W2 : W2 - wall.transform.x) < 0.6;
        check('The chosen wall is not glazing: a solid wall of the penthouse (south or west), against it, centre at eye height', !!wall && !!kit2 && kit2.glass.includes('north') && kit2.glass.includes('east') && !isGlassSide(world2, side2) && (side2 === 'south' || side2 === 'west') && onEdge && Math.abs(wall.elevation + wall.height / 2 - 1.55) < 0.05,
            { side: side2, glass: kit2?.glass, at: wall && [wall.transform.x, wall.transform.z, wall.transform.rotation.toFixed(2)], elevation: wall?.elevation, height: wall?.height });
        await page.waitForFunction(() => /\/omo-pages\//.test(document.querySelector('[data-testid="omo-world"]')?.dataset.webUrl ?? ''), { timeout: 30000 }).catch(() => {});
        await page.waitForFunction(() => Number(document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.webFrameSequence ?? 0) > 0, { timeout: 30000 }).catch(() => {});
        await pause(1500);
        const live = await omo();
        const frameSeq = await page.$eval(CANVAS, c => Number(c.dataset.webFrameSequence ?? 0));
        check('The page is live on the wall: the web surface shows a URL under /omo-pages/ and frames arrive', /^http:\/\/127\.0\.0\.1:\d+\/omo-pages\/[a-z0-9-]+\.html$/.test(live.web) && frameSeq > 0, { web: live.web, frameSeq });
        const html = live.web ? await (await fetch(live.web)).text() : '';
        await pause(5500); // one publish tick (5 s)
        const st = await (await fetch(`http://127.0.0.1:${PORT}/omo-pages/state.json`)).json().catch(() => ({}));
        const names = desks.map(d => d.station?.name).filter(Boolean);
        // Polish check: after Keep the camera frames the wall; the dashboard text is taller than 24 px on screen.
        await page.waitForFunction(id => document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.framedWall === id, { timeout: 8000 }, wall?.id).catch(() => {});
        await pause(1400);
        const framedView = await page.evaluate(id => { const c = document.querySelector('canvas[data-testid="omo-world-canvas"]'); const q = JSON.parse(c?.dataset.webQuads || '{}')[id]; const r = c.getBoundingClientRect(); return { framed: c?.dataset.framedWall, solid: c?.dataset.solidView, quad: q, canvas: [r.width, r.height] }; }, wall?.id);
        const tab = await browser.newPage(); await tab.setViewport({ width: 960, height: 600 });
        await tab.goto(live.web || 'about:blank', { waitUntil: 'load' }).catch(() => {}); await pause(400);
        const pageType = await tab.evaluate(() => { const px = sel => { const e = document.querySelector(sel); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; }; return { status: px('.status'), name: px('.desk h2'), page: [innerWidth, innerHeight] }; }).catch(() => ({}));
        await tab.close();
        const q = framedView.quad, qh = q ? (Math.hypot(q[0].x - q[3].x, q[0].y - q[3].y) + Math.hypot(q[1].x - q[2].x, q[1].y - q[2].y)) / 2 : 0;
        const k = qh / 600, statusPx = (pageType.status ?? 0) * k, namePx = (pageType.name ?? 0) * k;
        const inView = q && q.every(p => p.x >= 0 && p.y >= 0 && p.x <= framedView.canvas[0] && p.y <= framedView.canvas[1]);
        check('After Keep the camera frames the new wall: the whole page is in view and its dashboard text is taller than 24 px on screen (status and desk name)', framedView.framed === wall?.id && inView && statusPx > 24 && namePx > 24,
            { framed: framedView.framed, solid: framedView.solid, quadHeightPx: Math.round(qh), statusPx: Math.round(statusPx), deskNamePx: Math.round(namePx), pageType, quad: q });
        await shot('3-dashboard-live');
        check('The page content shows the desk names (page HTML and its live state.json)', names.length > 0 && names.every(n => html.includes(n) || html.includes(n.replace(/·/g, '&middot;'))) && names.every(n => (st.desks ?? []).some(d => d.name === n)), { names, inHtml: names.map(n => html.includes(n)), state: (st.desks ?? []).map(d => `${d.name}:${d.status}`) });
        await click('[data-testid="topbar-shape"]').catch(() => {}); await pause(600);

        // 3. Reload -> still there.
        await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
        await page.waitForFunction(() => /\/omo-pages\//.test(document.querySelector('[data-testid="omo-world"]')?.dataset.webUrl ?? ''), { timeout: 40000 }).catch(() => {});
        await page.waitForFunction(() => Number(document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.webFrameSequence ?? 0) > 0, { timeout: 30000 }).catch(() => {});
        await pause(1500);
        const r1 = await omo(), world3 = await savedWorld();
        check('After reload the dashboard wall is still in the world and its page is live on it again', r1.web === live.web && !!live.web && (world3?.entities ?? []).some(e => e.id === wall?.id), { web: r1.web, before: live.web });
        await shot('4-after-reload');

        // 4. Since you left: when you left, the Claude desk was working; now it is not -> one quiet line after reload.
        const project = await page.$eval('[data-testid="omo-world"]', e => e.dataset.projectUri);
        await page.evaluate((key, deskId) => { sessionStorage.setItem('omo.test.return', JSON.stringify({ key, deskId })); }, `omo.return.v1:${project}`, claude?.id);
        await page.evaluateOnNewDocument(() => {
            try {
                const t = JSON.parse(sessionStorage.getItem('omo.test.return') || 'null'); if (!t) return; sessionStorage.removeItem('omo.test.return');
                const rec = JSON.parse(localStorage.getItem(t.key) || 'null'); if (!rec) return;
                rec.at = Date.now() - 12 * 60000; rec.desks = rec.desks.map(d => d.id === t.deskId ? { ...d, status: 'working' } : d);
                localStorage.setItem(t.key, JSON.stringify(rec));
            } catch {}
        });
        const recBefore = await page.evaluate(k => localStorage.getItem(k), `omo.return.v1:${project}`);
        await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
        await page.waitForSelector('[data-testid="omo-since"]', { timeout: 20000 }).catch(() => {});
        const s1 = await omo();
        check('After reload with a desk state change: the "Since you left" line names what changed', /^Since you left: .*(finished|waiting|started|stopped).*\(away \d+ min\)\.?/.test(s1.since.replace('×', '').trim()), { since: s1.since, recBefore: (recBefore ?? '').slice(0, 300) });
        await shot('5-since-you-left');

        // 5. Where was I: use the Claude desk, walk to another desk, ask "where was I" -> the camera walks back.
        const other = desks.find(d => d.id !== claude?.id);
        // Use the Claude desk's screen the normal way: the command palette's "go to desk" (walks to it and attaches), then Esc back to walking.
        await page.focus(CANVAS); await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control'); await pause(500);
        await click(`[data-testid="palette-item"][data-command="desk-${claude?.id}"]`).catch(e => console.log('palette', e.message)); await pause(1800);
        const used = await page.evaluate(k => localStorage.getItem(k), `omo.visits.v1:${project}`);
        check('Using the Claude desk is remembered as a place you were', /"id":"/.test(used ?? '') && (used ?? '').includes(`"id":"${claude?.id}"`), used);
        await page.keyboard.press('Escape'); await pause(1500);
        await ask(`take me to ${other?.station?.name}`); await pause(2200);
        const p1 = await omo();
        check(`"take me to ${other?.station?.name}" walks the camera there`, p1.walk === other?.id && !!p1.pose, { walk: p1.walk, pose: p1.pose, footer: p1.footer });
        await ask('where was I'); await pause(2400);
        const p2 = await omo();
        check('"where was I" -> the camera moves back to the Claude desk (the pose changes) and says so', p2.walk === claude?.id && !!p2.pose && p2.pose !== p1.pose && /claude/i.test(p2.footer), { walk: p2.walk, before: p1.pose, after: p2.pose, footer: p2.footer });
        await shot('6-where-was-i');
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
        fs.rmSync(S, { recursive: true, force: true });
        console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);
        process.exitCode = failed ? 1 : 0;
    }
})();
