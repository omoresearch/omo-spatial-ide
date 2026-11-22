#!/usr/bin/env node
/*
 * onboarding — real-app check of the first minute (real local app on an owned port, real Chrome on the GPU, fixture
 * CLIs only, never real agents). The chat importer reads the FIXTURE folder (OMO_MIND_HOME =
 * extension/test/fixtures/mind), never Harry's real chats. Every request the page makes is logged.
 *   1. A first run shows the welcome: "Your mind, given a place." and Get started.
 *   2. Stage 1: "If your mind had a home, what would it look like?" — one input; type the sentence, Enter.
 *   3. Stage 2: "Bring your mind with you." Hermes + Claude Code sources, Read on this device / Skip for now.
 *      Read -> "Your mind has rooms now", fixture topics as rooms, "0 bytes leave this device"; the page made no request
 *      off this machine and the world behind has the topic rooms with a sign + note boards (no fixture secret shown).
 *   4. Ready: "Your world is ready." -> Enter your world -> the world is shown (walk mode), saved with the rooms.
 *   5. Timer: sentence (Enter) -> world shown < 60 s (wall clock here AND the app's own data-omo-first-minute-ms).
 *   6. A second run (Skip for now) also lands in the world; no page errors.
 * Screenshots: 1-welcome, 2-seed, 3-mind, 4-read, 5-ready, 6-world, 7-world-overview.
 * Usage: node scripts/onboarding-real.cjs [outDir] [port 3750-3759]   (default omo/evidence/onboarding, 3754)
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'onboarding'));
const PORT = Number(process.argv[3] || 3754);
const FIXTURE = path.join(ROOT, 'extension', 'test', 'fixtures', 'mind');
const SENTENCE = 'A lighthouse library at the edge of the sea';
if (!(PORT >= 3750 && PORT <= 3759)) { console.error('Use a port from 3750 to 3759.'); process.exit(2); }
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); };
const SECRETS = ['sk-FAKEfixtureKEY', 'sk-proj-FAKEfixture', 'ghp_FAKEfixture', 'ada.lovelace@example.com', 'grace.hopper@example.org', 'fixture-user'];

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-onboarding-'));
    const project = path.join(S, 'mind'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# mind\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-onboarding-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket, OMO_MIND_HOME: FIXTURE,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    let browser; const errors = []; const requests = [];
    const timings = {};
    try {
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }
        browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, 'chrome'),
            args: ['--no-sandbox', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', e => errors.push(String(e.message || e)));
        page.on('request', r => requests.push({ url: r.url(), at: Date.now() }));
        await page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
            new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true });
        });
        const click = sel => page.$eval(sel, e => e.click());
        const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
        const text = sel => page.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
        const visible = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; }, sel);
        const savedWorld = () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return k ? JSON.parse(localStorage.getItem(k)) : null; });
        const region = async (clip) => { const b64 = await page.screenshot({ clip, encoding: 'base64' }); return page.evaluate(async src => { const img = new Image(); img.src = `data:image/png;base64,${src}`; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let max = 0, sum = 0; for (let i = 0; i < d.length; i += 4) { const v = Math.max(d[i], d[i + 1], d[i + 2]); max = Math.max(max, v); sum += v; } return { max, mean: +(sum / (d.length / 4)).toFixed(2) }; }, b64); };
        const chromeShown = () => page.evaluate(() => ['.omo-header', '.omo-footer', '.omo-stage-heading', '.omo-preview-badge', '.omo-scene-controls', '.omo-navigation-switch', '.omo-tool-dock'].filter(s => [...document.querySelectorAll(s)].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; })));
        const canvasWorld = () => page.$eval(CANVAS, c => ({ entities: JSON.parse(c.dataset.worldEntities || '[]'), rooms: JSON.parse(c.dataset.worldRooms || '[]'), name: c.dataset.worldName, nav: c.dataset.navigation })).catch(() => null);

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        await page.waitForSelector('[data-testid="first-minute"]', { timeout: 120000 });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(1500);
        const gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl'); const x = g?.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        check('Chrome renders on the GPU (not SwiftShader)', !/swiftshader|llvmpipe|software/i.test(gpu), gpu);

        // 1. Welcome.
        const h1 = await text('[data-testid="first-minute"] h1');
        check('First run shows the welcome: "Your mind, given a place."', h1 === 'Your mind, given a place.' && await visible('[data-testid="first-minute-start"]'), h1);
        check('The welcome promises "In about a minute you will have a world of your own"', /In about a minute you will have a world of your own/.test(await text('.omo-fm-lede')));
        const look = await page.evaluate(() => { const e = document.querySelector('[data-testid="first-minute"]'), b = document.querySelector('[data-testid="first-minute-start"]'); return { bg: getComputedStyle(e).backgroundColor, btn: getComputedStyle(b).backgroundColor, h1: getComputedStyle(document.querySelector('.omo-fm h1')).fontFamily }; });
        check('Calm black with one mint primary button and a serif headline (mock-up style)', look.bg === 'rgb(0, 0, 0)' && look.btn === 'rgb(124, 242, 208)' && /serif/i.test(look.h1), look);
        await shot('1-welcome');
        await page.keyboard.press('Enter'); await pause(500);
        if ((await page.$eval('[data-testid="first-minute"]', e => e.dataset.scene)) === 'welcome') await click('[data-testid="first-minute-start"]');

        // 2. Stage 1: one input.
        await page.waitForSelector('[data-testid="first-minute-seed"]');
        const s1 = await page.evaluate(() => ({ h2: document.querySelector('.omo-fm h2')?.innerText.replace(/\s+/g, ' ').trim(), inputs: document.querySelectorAll('[data-testid="first-minute"] textarea, [data-testid="first-minute"] input').length, focused: document.activeElement?.dataset.testid, ph: document.querySelector('[data-testid="first-minute-seed"]').placeholder, step: document.querySelector('.omo-fm-prog')?.textContent }));
        check('Stage 1 asks "If your mind had a home, what would it look like?" with ONE input, focused (1 / 2)', s1.h2 === 'If your mind had a home, what would it look like?' && s1.inputs === 1 && s1.focused === 'first-minute-seed' && /1 \/ 2/.test(s1.step), s1);
        await page.keyboard.type(SENTENCE, { delay: 15 });
        await shot('2-seed');
        timings.sentence = Date.now();
        await page.keyboard.press('Enter');

        // 3. Stage 2: bring your mind.
        await page.waitForSelector('[data-testid="first-minute-read"]');
        await pause(700);
        const s2 = await page.evaluate(() => ({ head: document.querySelector('[data-testid="first-minute-mind-head"]')?.textContent, sub: document.querySelector('.omo-fm-sub')?.textContent, srcs: [...document.querySelectorAll('.omo-fm-src')].map(b => `${b.querySelector('strong').textContent}|${b.getAttribute('aria-pressed')}`), skip: document.querySelector('[data-testid="first-minute-skip"]')?.textContent, read: document.querySelector('[data-testid="first-minute-read"]')?.textContent, echo: document.querySelector('[data-testid="first-minute-echo"]')?.textContent, step: document.querySelector('.omo-fm-prog')?.textContent }));
        check('Stage 2: "Bring your mind with you." Hermes + Claude Code chats (both on), Read on this device / Skip for now (2 / 2)', s2.head === 'Bring your mind with you.' && /Read here, never uploaded/.test(s2.sub) && JSON.stringify(s2.srcs) === JSON.stringify(['Hermes chats|true', 'Claude Code chats|true']) && /^Read on this device/.test(s2.read) && s2.skip === 'Skip for now' && s2.echo === SENTENCE && /2 \/ 2/.test(s2.step), s2);
        await page.waitForFunction(() => (document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.worldName ?? '') === 'Lighthouse library', { timeout: 15000 }).catch(() => {});
        const w1 = await canvasWorld();
        check('The world behind is planned from the sentence (named "Lighthouse library", penthouse + bookshelf and window)', w1?.name === 'Lighthouse library' && w1.entities.some(id => /^bookshelf/.test(id)) && w1.entities.some(id => /^window/.test(id)), w1);
        const bd = await page.$eval(CANVAS, c => ({ backdrop: c.dataset.backdrop, city: Number(c.dataset.backdropCity), kit: c.dataset.styleKit }));
        const right = await region({ x: 1000, y: 120, width: 420, height: 170 }); // the sky above the room, below the progress bars
        check('Before "Form my world" the backdrop is a neutral dim gradient: no city, sky dome or tower behind the sentence', bd.backdrop === 'neutral' && bd.city === 0 && right.max <= 60, { ...bd, right });
        await shot('3-mind');
        const before = requests.length;
        await click('[data-testid="first-minute-read"]');
        await page.waitForSelector('[data-testid="first-minute-result"]', { timeout: 30000 });
        await pause(900);
        const off = requests.slice(before).filter(r => { try { const u = new URL(r.url); return !['127.0.0.1', 'localhost'].includes(u.hostname) && !/^(data|blob|chrome-extension):/.test(r.url); } catch { return false; } });
        check('Reading made no request off this machine (every page request during the read is 127.0.0.1)', off.length === 0, { during: requests.length - before, off: off.map(r => r.url).slice(0, 5) });
        const s3 = await page.evaluate(() => ({ head: document.querySelector('[data-testid="first-minute-mind-head"]')?.textContent, chats: document.querySelector('[data-testid="first-minute-chats"]')?.textContent, rooms: document.querySelector('[data-testid="first-minute-rooms"]')?.textContent, bytes: document.querySelector('[data-testid="first-minute-bytes"]')?.textContent, list: [...document.querySelectorAll('.omo-fm-rooms b')].map(b => b.textContent), page: document.querySelector('[data-testid="first-minute"]').innerText }));
        check('"Your mind has rooms now": the fixture topics are rooms, "0 bytes leave this device"', s3.head === 'Your mind has rooms now.' && Number(s3.chats) >= 9 && Number(s3.rooms) >= 4 && s3.bytes === '0 bytes leave this device' && ['Moonbase', 'Recipe App', 'Garden'].every(t => s3.list.includes(t)), { ...s3, page: undefined });
        check('No fixture secret, email or home path is on screen', SECRETS.every(x => !s3.page.includes(x)));
        const copy = await page.evaluate(() => {
            const btn = document.querySelector('[data-testid="first-minute-form"]'); btn.focus();
            const cs = getComputedStyle(btn), shadows = cs.boxShadow === 'none' ? 0 : cs.boxShadow.split(/,(?![^(]*\))/).length;
            const lines = [...document.querySelectorAll('.omo-fm-rooms span')].map(s => ({ shown: s.textContent, full: s.title, color: getComputedStyle(s).color }));
            return { eyebrow: document.querySelector('.omo-fm-eyebrow')?.textContent, left: /bytes left/.test(document.body.innerText), shadows, ring: cs.boxShadow.includes(' 0px 0px 0px '), outline: cs.outlineStyle, lines };
        });
        const wordCut = l => { if (l.shown === l.full) return true; if (!l.shown.endsWith('…')) return false; const head = l.shown.slice(0, -1); return l.full.startsWith(head) && /[\s·,;:.\-–—]/.test(l.full[head.length] ?? ' '); };
        check('Copy: eyebrow "Stage 2 · Bring your mind with you", no "bytes left", one soft CTA glow (no ring, no outline), chat titles cut at a word and #a8adb8',
            copy.eyebrow === 'Stage 2 · Bring your mind with you' && !copy.left && copy.shadows === 1 && !copy.ring && copy.outline === 'none' && copy.lines.length >= 4 && copy.lines.every(wordCut) && copy.lines.every(l => l.color === 'rgb(168, 173, 184)'), copy);
        await page.evaluate(() => document.activeElement?.blur());
        await page.waitForFunction(() => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.worldRooms || '[]').some(id => id.startsWith('mind-')), { timeout: 15000 }).catch(() => {});
        const w2 = await canvasWorld();
        const mindRooms = (w2?.rooms ?? []).filter(id => id.startsWith('mind-'));
        check('The world behind grows a room per topic, each with a sign and note boards', mindRooms.length === Number(s3.rooms) && w2.entities.filter(id => id.startsWith('sign-')).length === mindRooms.length && w2.entities.filter(id => id.startsWith('note-')).length >= mindRooms.length, { mindRooms, notes: w2?.entities.filter(id => id.startsWith('note-')).length });
        const chrome = await chromeShown(), gap = await page.evaluate(() => { const r = document.querySelector('.omo-fm-side').getBoundingClientRect(); return { x: Math.round(r.right + 8), w: Math.max(8, Math.round(innerWidth / 2 - r.right - 16)) }; });
        const scrim = await region({ x: gap.x, y: 140, width: gap.w, height: 620 });
        check('Onboarding hides the world chrome (header pill, Local workspace, theme title, LIVE badge, camera hints) and the copy column is solid black', chrome.length === 0 && scrim.max <= 6, { chrome, scrim, gap });
        await shot('4-read');

        // 4. Ready -> Enter your world.
        await click('[data-testid="first-minute-form"]');
        await page.waitForSelector('[data-testid="first-minute-enter"]');
        await pause(500);
        const s4 = await page.evaluate(() => ({ h2: document.querySelector('.omo-fm h2')?.textContent, q: document.querySelector('[data-testid="first-minute-quote"]')?.textContent, btn: document.querySelector('[data-testid="first-minute-enter"]')?.textContent, sum: document.querySelector('[data-testid="first-minute-summary"]')?.textContent }));
        check('Ready: "Your world is ready." with the sentence and "Enter your world"', s4.h2 === 'Your world is ready.' && s4.q === `“${SENTENCE}”` && /^Enter your world/.test(s4.btn) && /rooms? from your chats/.test(s4.sum), s4);
        await shot('5-ready');
        await click('[data-testid="first-minute-enter"]');
        await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 60000 });
        timings.world = Date.now();
        await pause(400);
        const gone = !await page.$('[data-testid="first-minute"]');
        const saved = await savedWorld();
        check('Enter your world: the overlay is gone and you walk in the world', gone && (await canvasWorld())?.nav === 'walk');
        const bd2 = await page.$eval(CANVAS, c => ({ backdrop: c.dataset.backdrop, city: Number(c.dataset.backdropCity) }));
        check('After Enter your world the planned backdrop is back (world mode)', bd2.backdrop === 'world', bd2);
        check('The saved world holds the home and the topic rooms with their note boards', !!saved && saved.name === 'Lighthouse library' && saved.entities.filter(e => e.kind === 'room' && e.id.startsWith('mind-')).length === mindRooms.length && saved.entities.some(e => e.id.startsWith('note-') && e.kind === 'decor' && e.decor === 'whiteboard'), { name: saved?.name, n: saved?.entities.length });
        check('The saved world holds no fixture secret, email or home path', SECRETS.every(x => !JSON.stringify(saved).includes(x)));

        // 5. Timer.
        const wall = timings.world - timings.sentence;
        const appMs = Number(await page.evaluate(() => document.documentElement.dataset.omoFirstMinuteMs ?? 'NaN'));
        check('From the sentence to the world shown in under 60 s (wall clock of this run)', wall > 0 && wall < 60000, { ms: wall });
        check('The app measured the same first minute itself (data-omo-first-minute-ms < 60000)', Number.isFinite(appMs) && appMs > 0 && appMs < 60000, { appMs });
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 10000 }).catch(() => {});
        await pause(2500);
        await shot('6-world');
        // An overview from above shows the rooms.
        const pose = await page.evaluate(() => document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.playerPose ?? '');
        await click('[data-testid="overview-mode"]').catch(() => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Overview')?.click()));
        await pause(1800);
        await shot('7-world-overview');

        // 6. A fresh run that skips the import still lands in the world.
        const page2 = await browser.newPage();
        page2.on('pageerror', e => errors.push(String(e.message || e)));
        await page2.evaluate(() => {}).catch(() => {});
        const ctx = page2;
        await ctx.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await ctx.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^omo\.(world|room)/.test(k)) localStorage.removeItem(k); localStorage.setItem('omo.coach.v1', 'seen'); });
        await ctx.reload({ waitUntil: 'domcontentloaded' });
        await ctx.evaluate(() => new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true }));
        const second = await ctx.waitForSelector('[data-testid="first-minute-start"]', { timeout: 120000 }).then(() => true).catch(() => false);
        if (second) {
            await ctx.$eval('[data-testid="first-minute-start"]', e => e.click());
            await ctx.waitForSelector('[data-testid="first-minute-seed"]'); await ctx.focus('[data-testid="first-minute-seed"]');
            await ctx.keyboard.type('an observatory under the stars', { delay: 10 });
            const t0 = Date.now();
            await ctx.keyboard.press('Enter');
            await ctx.waitForSelector('[data-testid="first-minute-skip"]'); await ctx.$eval('[data-testid="first-minute-skip"]', e => e.click());
            await ctx.waitForSelector('[data-testid="first-minute-enter"]'); await ctx.$eval('[data-testid="first-minute-enter"]', e => e.click());
            await ctx.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 60000 });
            const w = await ctx.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return k ? JSON.parse(localStorage.getItem(k)) : null; });
            check('Skip for now: the world is the home only (observatory = station theme, no topic rooms) and it opens in < 60 s', !!w && w.shell.theme === 'station' && !w.entities.some(e => e.kind === 'room') && Date.now() - t0 < 60000, { theme: w?.shell.theme, ms: Date.now() - t0 });
        } else check('A second first run shows the welcome again', false);
        check('no page errors', errors.length === 0, errors.slice(0, 3));
        fs.writeFileSync(path.join(OUT, 'timing.json'), JSON.stringify({ sentenceToWorldMs: wall, appMeasuredMs: appMs, machine: os.hostname(), gpu, at: new Date().toISOString() }, null, 1));
    } catch (e) {
        failed++; console.log('FAIL run —', e.message);
        try { const pg = (await browser.pages()).slice(-1)[0]; await pg.screenshot({ path: path.join(OUT, 'fail.png') }); } catch {}
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ failed, checks, errors, fixture: path.relative(ROOT, FIXTURE) }, null, 1));
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
