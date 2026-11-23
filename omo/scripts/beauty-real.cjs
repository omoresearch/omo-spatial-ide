#!/usr/bin/env node
/*
 * beauty:foundation — real-app beauty check (real local app on an owned port, real Chrome on the GPU, fixture CLIs and
 * the fixture chat folder only, never real agents). Builds a STRESS world and proves the design system holds:
 *   1. Onboarding: 'A lighthouse library at the edge of the sea' + the fixture importer (OMO_MIND_HOME) -> topic rooms.
 *   2. The planner: Shape 'add 3 rooms' -> Keep.
 *   3. A CSV world from extension/test/fixtures/customers.csv (grouped by region) -> Apply.
 * At every stage: no visible world mesh uses a material that is not from world-look.ts (canvas.omoLookAudit()), and every
 * decor is a real CC0 kit prop or an approved fallback kind (no procedural stand-in left once props load).
 * Four fixed shots matching omo-sky-lab/out/beauty/before/: 1-onboarding-overview, 2-topic-room, 3-csv-world,
 * 4-boards-close, into omo/evidence/beauty/after/, plus a before|after sheet (sheet.png). Walking fps is measured.
 * Usage: node scripts/beauty-real.cjs [outDir] [port 3750-3759]   (default omo/evidence/beauty/after, 3758)
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'beauty', 'after'));
const PORT = Number(process.argv[3] || 3758);
if (!(PORT >= 3750 && PORT <= 3759)) { console.error('Use a port from 3750 to 3759.'); process.exit(2); }
const BEFORE = process.env.OMO_BEAUTY_BEFORE || path.join(os.homedir(), 'dev', 'omo-sky-lab', 'out', 'beauty', 'before');
const FIXTURE = path.join(ROOT, 'extension', 'test', 'fixtures', 'mind');
const CSV = path.join(ROOT, 'extension', 'test', 'fixtures', 'customers.csv');
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const SENTENCE = 'A lighthouse library at the edge of the sea';
const SHOTS = ['1-onboarding-overview', '2-topic-room', '3-csv-world', '4-boards-close'];
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-beauty-'));
    const project = path.join(S, 'beauty'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# beauty\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-beauty-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket, OMO_MIND_HOME: FIXTURE,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = []; const audits = {}; const perf = {};
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
        const savedWorld = () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return k ? JSON.parse(localStorage.getItem(k)) : null; });
        const audit = () => page.$eval(CANVAS, c => c.omoLookAudit());
        /** Wait until every decor that has a kit plan shows its kit props (they load async), then audit. */
        const settledAudit = async (stage) => {
            let a; for (let i = 0; i < 60; i++) { a = await audit(); if (!a.decor.some(d => d.state === 'standin')) break; await pause(500); }
            audits[stage] = a;
            fs.writeFileSync(path.join(OUT, `audit-${stage}.json`), JSON.stringify(a, null, 1));
            check(`${stage}: no visible world mesh uses a non-look material (${a.meshes} meshes)`, a.meshes > 50 && a.offLook.length === 0, { off: a.offLook.slice(0, 6), n: a.offLook.length });
            const kit = a.decor.filter(d => d.state === 'kit'), fb = a.decor.filter(d => d.state === 'fallback'), stand = a.decor.filter(d => d.state === 'standin');
            const approved = new Set(['crystal', 'whiteboard', 'rug', 'window']);
            check(`${stage}: every decor is a kit prop or an approved fallback (${kit.length} kit, ${fb.length} fallback)`, stand.length === 0 && fb.every(d => approved.has(d.kind) || /^(note|sign)-/.test(d.id)) && kit.every(d => d.props.length > 0),
                { standin: stand.map(d => d.id), oddFallback: fb.filter(d => !approved.has(d.kind) && !/^(note|sign)-/.test(d.id)).map(d => `${d.id}:${d.kind}`), kit: kit.map(d => `${d.kind}:${d.props.join('+')}`).slice(0, 8) });
            return a;
        };
        /** beauty r2 — the shot's subject (room signs / boards) is on screen and not hidden behind a big opaque mesh. */
        const subject = async (shotName, kind, min, filter = () => true, minPx = 0) => {
            const all = (await page.$eval(CANVAS, (c, k) => c.omoSubjectView(k), kind)).filter(filter);
            const good = all.filter(s => s.onScreen && !s.occluded && s.rect && (s.rect.right - s.rect.left) >= minPx);
            check(`${shotName}: its subject is framed (${good.length}/${all.length} ${kind} on screen, unoccluded${minPx ? `, >= ${minPx} px wide` : ''}; need ${min})`, good.length >= min,
                all.slice(0, 8).map(s => ({ id: s.id, on: s.onScreen, occ: s.occluded, hit: s.hit, w: s.rect ? Math.round(s.rect.right - s.rect.left) : 0, d: s.distance })));
            return good;
        };
        const overview = async () => { await click('[data-testid="overview-mode"]').catch(() => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Overview')?.click())); await pause(1800); };
        const walk = async () => { await click('[data-testid="walk-mode"]').catch(() => page.evaluate(() => [...document.querySelectorAll('button')].find(b => /^(Walk|Explore)$/.test(b.textContent.trim()))?.click())); await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 15000 }); };
        /** rAF frame rate while walking forward and turning (the world draws on demand: it draws every frame while moving). */
        const walkFps = async (ms = 3500) => {
            await page.focus(CANVAS);
            const done = page.evaluate(ms => new Promise(res => { const d = []; let last = performance.now(); const t0 = last; const f = t => { d.push(t - last); last = t; if (t - t0 < ms) requestAnimationFrame(f); else { d.sort((a, b) => a - b); const mean = d.reduce((a, b) => a + b, 0) / d.length; res({ frames: d.length, fps: +(d.length / (ms / 1000)).toFixed(1), p90: +d[Math.floor(d.length * 0.9)].toFixed(1), meanMs: +mean.toFixed(1) }); } }; requestAnimationFrame(f); }), ms);
            await page.keyboard.down('w'); await page.keyboard.down('ArrowLeft'); await pause(ms * 0.5); await page.keyboard.up('ArrowLeft'); await page.keyboard.down('ArrowRight'); await pause(ms * 0.5 + 200);
            await page.keyboard.up('ArrowRight'); await page.keyboard.up('w');
            return done;
        };

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        await page.waitForSelector('[data-testid="first-minute"]', { timeout: 120000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(1500);
        const gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl'); const x = g?.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        check('Chrome renders on the GPU (not SwiftShader)', !/swiftshader|llvmpipe|software/i.test(gpu), gpu);

        // ---------------------------------------------------------------- 1. onboarding: the lighthouse library + imported topics
        await page.keyboard.press('Enter'); await pause(500);
        if ((await page.$eval('[data-testid="first-minute"]', e => e.dataset.scene)) === 'welcome') await click('[data-testid="first-minute-start"]');
        await page.waitForSelector('[data-testid="first-minute-seed"]'); await page.focus('[data-testid="first-minute-seed"]');
        await page.keyboard.type(SENTENCE, { delay: 10 }); await page.keyboard.press('Enter');
        await page.waitForSelector('[data-testid="first-minute-read"]'); await pause(700);
        await click('[data-testid="first-minute-read"]');
        await page.waitForSelector('[data-testid="first-minute-result"]', { timeout: 30000 }); await pause(900);
        await click('[data-testid="first-minute-form"]');
        await page.waitForSelector('[data-testid="first-minute-enter"]'); await pause(500);
        await click('[data-testid="first-minute-enter"]');
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 60000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 10000 }).catch(() => {});
        await pause(2500);
        const w1 = await savedWorld();
        const mindRooms = (w1?.entities ?? []).filter(e => e.kind === 'room' && e.id.startsWith('mind-'));
        check('Onboarding built the lighthouse library with imported topic rooms', w1?.name === 'Lighthouse library' && mindRooms.length >= 4, { name: w1?.name, rooms: mindRooms.length });
        perf.onboarding = await walkFps();
        check(`Walking view keeps 50+ fps in the onboarding world (${perf.onboarding.fps} fps, p90 ${perf.onboarding.p90} ms)`, perf.onboarding.fps >= 50, perf.onboarding);
        await settledAudit('onboarding');
        await overview(); await settledAudit('onboarding-overview');
        await subject(SHOTS[0], 'signs', 4);
        await shot(SHOTS[0]);
        // The topic room from the path (the same pose as onboarding-real's 9-topic-room).
        const bRoom = mindRooms.find(r => r.id === 'mind-moonbase') ?? mindRooms[0];
        await walk();
        await page.$eval(CANVAS, (c, pose) => c.omoStandAt(pose), { x: bRoom.transform.x + Math.sin(bRoom.transform.rotation) * 9.5, z: bRoom.transform.z + Math.cos(bRoom.transform.rotation) * 9.5, yaw: bRoom.transform.rotation + 0.12, pitch: -0.08 });
        await pause(1500);
        await subject(SHOTS[1], 'signs', 1, x => x.id === bRoom.id, 300);
        await shot(SHOTS[1]);
        // Inside the topic room, looking at its decor (evidence, not one of the 4 scored shots).
        await page.$eval(CANVAS, (c, pose) => c.omoStandAt(pose), { x: bRoom.transform.x + Math.sin(bRoom.transform.rotation) * 1.5, z: bRoom.transform.z + Math.cos(bRoom.transform.rotation) * 1.5, yaw: bRoom.transform.rotation + 0.5, pitch: -0.12 });
        await pause(1200); await shot('5-topic-room-inside');

        // ---------------------------------------------------------------- 2. the planner: 'add 3 rooms'
        await page.focus(CANVAS); await page.keyboard.press('Space'); await pause(900);
        const shapeOpen = !!await page.$('[data-testid="shape-input"]');
        if (shapeOpen) {
            await page.focus('[data-testid="shape-input"]'); await page.keyboard.type('add 3 rooms', { delay: 12 }); await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelector('[data-testid="shape-caption-text"]')?.textContent && document.querySelector('[data-testid="shape-mode"]')?.dataset.busy === 'false', { timeout: 20000 }).catch(() => {});
            await pause(900);
            await page.focus('[data-testid="shape-input"]'); await page.keyboard.press('Enter'); await pause(1500);
            await page.focus('[data-testid="shape-input"]').catch(() => {}); await page.keyboard.press('Escape'); await pause(800);
        }
        const w2 = await savedWorld();
        const added = (w2?.entities ?? []).filter(e => e.kind === 'room' && !(w1?.entities ?? []).some(b => b.id === e.id));
        check('The planner kept "add 3 rooms" (3 new rooms in the saved world)', shapeOpen && added.length === 3, { shapeOpen, added: added.map(r => r.label) });
        await overview(); await settledAudit('planner-rooms');
        await shot('6-planner-rooms');

        // ---------------------------------------------------------------- 3. a CSV world
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('omo:palette-toggle')));
        await page.waitForSelector('[data-testid="command-palette"]', { timeout: 5000 });
        await page.waitForSelector('[data-testid="palette-item"][data-command="world-from-data"]', { timeout: 5000 });
        await click('[data-testid="palette-item"][data-command="world-from-data"]');
        await page.waitForSelector('[data-testid="data-world-dialog"]', { timeout: 8000 });
        await (await page.$('[data-testid="data-csv-input"]')).uploadFile(CSV);
        await page.waitForSelector('[data-testid="data-group-by"]', { timeout: 8000 });
        const headers = await page.$$eval('[data-testid="data-group-by"] option', os => os.map(o => o.textContent));
        await page.select('[data-testid="data-group-by"]', String(headers.indexOf('region'))); await pause(400);
        await click('[data-testid="data-build"]');
        await page.waitForSelector('[data-testid="build-apply"]', { timeout: 15000 }); await click('[data-testid="build-apply"]'); await pause(800);
        if (await page.$('[data-testid="build-exit"]')) { await click('[data-testid="build-exit"]').catch(() => {}); await pause(600); }
        await page.waitForFunction(() => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.worldRooms || '[]').length >= 4, { timeout: 20000 }).catch(() => {});
        const w3 = await savedWorld();
        check('The CSV world has the 4 region rooms', (w3?.entities ?? []).filter(e => e.kind === 'room').length >= 4, (w3?.entities ?? []).filter(e => e.kind === 'room').map(e => e.label));
        await walk().catch(() => {});
        await pause(1500);
        perf.csv = await walkFps();
        check(`Walking view keeps 50+ fps in the CSV world (${perf.csv.fps} fps, p90 ${perf.csv.p90} ms)`, perf.csv.fps >= 50, perf.csv);
        await settledAudit('csv');
        // beauty r2 — the data world at eye level from the plaza, framed on its region rooms (not from the desk spawn, where
        // the desk monitor filled the frame): a three-quarter view of the room row from ~12 m in front of it.
        const dataRooms = (w3?.entities ?? []).filter(e => e.kind === 'room');
        const front = Math.max(...dataRooms.map(r => r.transform.z + r.depth / 2));
        const minX = Math.min(...dataRooms.map(r => r.transform.x)), maxX = Math.max(...dataRooms.map(r => r.transform.x));
        await page.$eval(CANVAS, (c, pose) => c.omoStandAt(pose), { x: minX + (maxX - minX) * 0.3, z: front + 12, yaw: -0.35, pitch: -0.04 });
        await pause(1500);
        await subject(SHOTS[2], 'signs', 2, x => dataRooms.some(r => r.id === x.id));
        await shot(SHOTS[2]);
        // Inside the first region room, facing its boards on the back wall (share-promises 4-boards-close).
        const near = dataRooms.slice().sort((a, b) => Math.abs(a.transform.x) - Math.abs(b.transform.x))[0];
        await page.$eval(CANVAS, (c, pose) => c.omoStandAt(pose), { x: near.transform.x, z: near.transform.z + near.depth / 2 - 1.1, yaw: 0, pitch: -0.06 });
        await pause(1500);
        await subject(SHOTS[3], 'boards', 2, x => x.id.startsWith(`${near.id}-board-`), 200);
        await shot(SHOTS[3]);
        check('no page errors', errors.length === 0, errors.slice(0, 3));

        // ---------------------------------------------------------------- the before | after sheet
        const py = `
import sys
from PIL import Image, ImageDraw, ImageFont
before, after, out, names = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(',')
W = 720; rows = []
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
except Exception: font = ImageFont.load_default()
for n in names:
    pair = []
    for d, tag in ((before, 'BEFORE'), (after, 'AFTER')):
        try: im = Image.open(f'{d}/{n}.png').convert('RGB')
        except Exception: im = Image.new('RGB', (1440, 900), (40, 40, 40))
        im = im.resize((W, int(im.height * W / im.width)))
        dr = ImageDraw.Draw(im); dr.rectangle([0, 0, 330, 34], fill=(0, 0, 0)); dr.text((10, 5), f'{tag} · {n}', fill=(255, 255, 255), font=font)
        pair.append(im)
    row = Image.new('RGB', (W * 2 + 8, max(p.height for p in pair)), (255, 255, 255)); row.paste(pair[0], (0, 0)); row.paste(pair[1], (W + 8, 0)); rows.append(row)
sheet = Image.new('RGB', (rows[0].width, sum(r.height for r in rows) + 8 * (len(rows) - 1)), (255, 255, 255)); y = 0
for r in rows: sheet.paste(r, (0, y)); y += r.height + 8
sheet.save(out)
`;
        const r = spawnSync('python3', ['-c', py, BEFORE, OUT, path.join(OUT, 'sheet.png'), SHOTS.join(',')], { encoding: 'utf8' });
        check('The before | after sheet is written', r.status === 0 && fs.existsSync(path.join(OUT, 'sheet.png')), r.stderr?.slice(0, 300));
        check('All 4 fixed after shots exist', SHOTS.every(n => fs.existsSync(path.join(OUT, `${n}.png`))));
    } catch (e) {
        failed++; console.log('FAIL run —', e.message);
        try { const pg = (await browser.pages()).slice(-1)[0]; await pg.screenshot({ path: path.join(OUT, 'fail.png') }); } catch {}
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ failed, checks, errors, perf, looks: Object.fromEntries(Object.entries(audits).map(([k, a]) => [k, { meshes: a.meshes, offLook: a.offLook.length, looks: a.looks, decor: a.decor.reduce((m, d) => { m[d.state] = (m[d.state] ?? 0) + 1; return m; }, {}) }])) }, null, 1));
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
