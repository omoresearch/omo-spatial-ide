#!/usr/bin/env node
/*
 * shape — real-app check of Shape mode (real local app on an owned port, real Chrome on the GPU,
 * fixture CLIs only, never real agents). Rules planner only (Hermes is never confirmed here).
 *   1. Space (canvas focused, no screen) opens Shape: one prompt (560-640 px, 44 px, 15 px, 'Describe a change…'),
 *      3 chips, HUD at 30%, the World Builder hidden; the top-bar Shape button exists.
 *   2. "add a reading nook by the window" -> a pending ghost + ONE caption beside the change, never over it (one sentence, Keep / Undo).
 *   3. "make it bigger" -> the ghost changes (bigger things). Enter keeps -> the entities exist in the saved world.
 *   4. Click a sofa -> a pill -> "move this closer to the screen" -> the proposal names that entity; Esc undoes.
 *   5. A second kept change -> the history strip has 2 dots; clicking the first undoes back before it.
 *   6. Nothing covers the centre; Browse shows the old World Builder; Esc closes Shape; no page errors.
 * Screenshots: 1-shape-open, 2-ghost-caption, 3-refined, 4-pill, 5-history, 6-browse.
 * Usage: node scripts/shape-real.cjs <outDir> [port 3750-3759]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'shape', 'real'));
const PORT = Number(process.argv[3] || 3752);
if (!(PORT >= 3750 && PORT <= 3759)) { console.error('Use a port from 3750 to 3759.'); process.exit(2); }
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-shape-'));
    const project = path.join(S, 'shape'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# shape\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-shape-${PORT}`;
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

        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
        for (let i = 0; i < 3; i++) { await click('[data-testid="create-room"]').catch(() => {}); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 8000 }); break; } catch {} }
        await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(2500);
        const gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl'); const x = g?.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        check('Chrome renders on the GPU (not SwiftShader)', !/swiftshader|llvmpipe|software/i.test(gpu), gpu);

        // 1. Enter Shape with Space.
        check('The top bar has a Shape button', await visible('[data-testid="topbar-shape"]'));
        await page.focus(CANVAS); await page.keyboard.press('Space'); await pause(900);
        const diag = await page.evaluate(() => ({ active: document.activeElement?.tagName + '#' + (document.activeElement?.dataset?.testid ?? ''), nav: document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.navigation, body: document.body.className.slice(0, 120), build: !!document.querySelector('[data-testid="build-mode"]'), notice: document.querySelector('.omo-footer')?.textContent?.slice(-120) }));
        check('Space opens Shape', await visible('[data-testid="shape-mode"]'), diag);
        const look = await page.evaluate(() => {
            const p = document.querySelector('[data-testid="shape-prompt"]').getBoundingClientRect(), i = document.querySelector('[data-testid="shape-input"]');
            const c = document.querySelector('canvas[data-testid="omo-world-canvas"]').getBoundingClientRect();
            const views = document.querySelector('.omo-topbar-views');
            return { w: Math.round(p.width), h: Math.round(p.height), centreX: Math.round(p.left + p.width / 2 - (c.left + c.width / 2)), bottomGap: Math.round(c.bottom - p.bottom),
                font: getComputedStyle(i).fontSize, placeholder: i.placeholder, focused: document.activeElement === i, chips: [...document.querySelectorAll('[data-testid="shape-chip"]')].map(b => b.textContent),
                hud: views ? getComputedStyle(views).opacity : 'none', nav: document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.navigation };
        });
        check('One prompt at the bottom centre: 560-640 px wide, 44 px tall, 15 px text, "Describe a change…"', look.w >= 560 && look.w <= 640 && look.h === 44 && look.font === '15px' && look.placeholder === 'Describe a change…' && Math.abs(look.centreX) <= 2 && look.bottomGap < 140, look);
        check('Three suggestion chips under it; the prompt has the keys', look.chips.length === 3 && look.focused, look.chips);
        check('The rest of the HUD fades to 30%; the camera rises to the overview', Math.abs(Number(look.hud) - 0.3) < 0.01 && look.nav === 'overview', { hud: look.hud, nav: look.nav });
        check('The World Builder panel is hidden (behind Browse)', !await visible('[data-testid="world-builder"]') && await visible('[data-testid="shape-browse"]'));
        await pause(800); await shot('1-shape-open');

        // 2. Describe a change.
        const before = await savedWorld();
        const view0 = await page.$eval(CANVAS, c => { const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        await type('add a reading nook by the window'); await page.keyboard.press('Enter');
        await waitCaption();
        // The camera frames the change: it eases (~500 ms) to centre and zoom on the ghost group.
        await page.waitForFunction(() => document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.shapeFramed === 'true', { timeout: 15000 }).catch(() => {});
        await pause(900);
        const frame1 = await page.evaluate(() => { const c = document.querySelector('[data-testid="shape-caption"]'); return { framed: document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.shapeFramed, ghost: c?.dataset.ghostRect }; });
        const fg = frame1.ghost?.split(',').map(Number) ?? [0, 0, 0, 0];
        const fcx = (fg[0] + fg[2]) / 2 - (view0[0] + view0[2] / 2), fcy = (fg[1] + fg[3]) / 2 - (view0[1] + view0[3] / 2);
        check('The camera frames the change: the ghost group is near the view centre and fills a good part of it', frame1.framed === 'true' && Math.abs(fcx) < view0[2] * 0.12 && Math.abs(fcy) < view0[3] * 0.15 && (fg[3] - fg[1]) > view0[3] * 0.3, { frame1, off: [Math.round(fcx), Math.round(fcy)], h: fg[3] - fg[1] });
        const g1 = await ghost(), c1 = await captionText();
        const cap1 = await page.evaluate(() => { const e = document.querySelector('[data-testid="shape-caption"]'); const r = e?.getBoundingClientRect(); return e ? { n: document.querySelectorAll('[data-testid="shape-caption"]').length, anchor: e.dataset.anchor, box: [r.left, r.top, r.right, r.bottom].map(Math.round), keep: !!e.querySelector('[data-testid="shape-keep"]'), undo: !!e.querySelector('[data-testid="shape-undo"]') } : null; });
        check('The plan shows as a pending ghost in the room (3 new things)', g1.ids.split(',').filter(Boolean).length === 3, g1);
        check('ONE caption card: one plain sentence + Keep / Undo', !!cap1 && cap1.n === 1 && cap1.keep && cap1.undo && /^[A-Z][^.]*\.$/.test(c1) && !/\bop\b|diff|proposal/i.test(c1), { c1, cap1 });
        const cap1b = await page.evaluate(() => { const e = document.querySelector('[data-testid="shape-caption"]'); const r = e?.getBoundingClientRect(); return e ? { side: e.dataset.side, anchor: e.dataset.anchor, ghost: e.dataset.ghostRect, box: [r.left, r.top, r.right, r.bottom].map(Math.round) } : null; });
        const beside = !!cap1b?.anchor && (() => { const [ax, ay] = cap1b.anchor.split(',').map(Number), [l, t, r, b] = cap1b.box; const dx = Math.max(l - ax, 0, ax - r), dy = Math.max(t - ay, 0, ay - b); return Math.hypot(dx, dy) < 320; })();
        check('The caption sits beside the change (near its projected anchor, a leader joins them)', beside, cap1b);
        const clear = !!cap1b?.ghost && (() => { const [gl, gt, gr, gb] = cap1b.ghost.split(',').map(Number), [l, t, r, b] = cap1b.box; return gr > gl && gb > gt && (r <= gl || l >= gr || b <= gt || t >= gb); })();
        check('The caption never covers the change (its rect misses the projected ghost bounds)', clear, cap1b);
        check('A leader line joins the caption to the change', await page.$eval('.omo-shape-leader', e => e.dataset.on === 'true').catch(() => false));
        check('Nothing covers the centre of the room (with the caption up)', (await centreFree()).every(t => t === 'CANVAS'), await centreFree());
        const savedMid = await savedWorld();
        check('Nothing is saved before Keep', JSON.stringify(savedMid?.entities ?? []) === JSON.stringify(before?.entities ?? []));
        await page.waitForFunction(() => (document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.ghostReal ?? '').split(',').filter(Boolean).length >= 3, { timeout: 20000 }).catch(() => {});
        await pause(600);
        const real1 = await page.$eval(CANVAS, e => ({ real: e.dataset.ghostReal ?? '', meshes: Number(e.dataset.ghostMeshes ?? 0) }));
        check('The ghost is the real furniture (tinted models, not boxes)', real1.real.split(',').filter(Boolean).length === 3 && real1.meshes > 0, real1);
        const props1 = await page.$eval(CANVAS, e => e.dataset.ghostProps ?? '');
        check('The nook armchair is the kit lounge armchair (mid_century_lounge_chair), named in the caption', /\barmchair:mid_century_lounge_chair\b/.test(props1) && /\barmchair\b/i.test(c1) && !/lounge chair/i.test(c1), { props1, c1 });
        const tags1 = await page.$$eval('[data-testid="shape-ghost-tag"]', ts => ts.map(t => { const r = t.getBoundingClientRect(); return { id: t.dataset.id, text: t.textContent, on: t.dataset.on, font: getComputedStyle(t).fontSize, box: [r.left, r.top, r.right, r.bottom].map(Math.round) }; }));
        const tagsApart = tags1.every((a, i) => tags1.every((b, j) => j <= i || a.box[2] <= b.box[0] || b.box[2] <= a.box[0] || a.box[3] <= b.box[1] || b.box[3] <= a.box[1]));
        const anc = cap1b?.anchor?.split(',').map(Number), gr1 = cap1b?.ghost?.split(',').map(Number);
        const onFloor = !!anc && !!gr1 && anc[1] >= gr1[1] + 0.6 * (gr1[3] - gr1[1]) && tags1.every(t => !(anc[0] >= t.box[0] && anc[0] <= t.box[2] && anc[1] >= t.box[1] && anc[1] <= t.box[3]));
        check('The reticle sits on the floor at the group (low in the ghost bounds, off every tag), not on a thing', onFloor, { anchor: cap1b?.anchor, ghost: cap1b?.ghost });
        check('The ghost tags never overlap each other', tags1.length === 3 && tagsApart, tags1.map(t => t.box));
        check('Every ghosted thing has a 12 px name tag matching the caption (Armchair, Floor lamp, Shelves)', tags1.length === 3 && tags1.every(t => t.on === 'true' && t.font === '12px' && c1.toLowerCase().includes(t.text.toLowerCase()))
            && JSON.stringify(tags1.map(t => t.text).sort()) === JSON.stringify(['Armchair', 'Floor lamp', 'Shelves']), { tags1, c1 });
        await shot('2-ghost-caption');

        // 3. Refine, then keep. Typing while a change is pending: Enter refines, Ctrl+Enter keeps (the card says so).
        const keys0 = await page.evaluate(() => ({ keep: document.querySelector('[data-testid="shape-keep-key"]')?.textContent, hint: document.querySelector('[data-testid="shape-enter-hint"]')?.textContent ?? '' }));
        await type('make it bigger');
        const keys1 = await page.evaluate(() => ({ keep: document.querySelector('[data-testid="shape-keep-key"]')?.textContent, hint: document.querySelector('[data-testid="shape-enter-hint"]')?.textContent ?? '' }));
        check('Enter has one meaning: empty prompt Keep ↵; with text the hint says "Enter = refine" and Keep shows Ctrl ↵', keys0.keep === '↵' && !keys0.hint && keys1.hint === 'Enter = refine' && keys1.keep === 'Ctrl ↵', { keys0, keys1 });
        await page.keyboard.press('Enter');
        await waitCaption(c1);
        const g2 = await ghost(), c2 = await captionText();
        check('Refining replaces the ghost (bigger things)', g2.ids.split(',').filter(Boolean).length === 3 && (g2.diff !== g1.diff || c2 !== c1) && /big/i.test(c2), { c1, c2, d1: g1.diff, d2: g2.diff });
        await shot('3-refined');
        await page.focus('[data-testid="shape-input"]'); await page.keyboard.press('Enter'); await pause(1200);
        const after = await savedWorld();
        const added = (after?.entities ?? []).filter(e => !(before?.entities ?? []).some(b => b.id === e.id));
        check('Enter keeps: the nook exists in the saved world', added.length === 3 && added.every(e => e.kind === 'decor' && (e.scale ?? 1) > 1), added.map(e => `${e.id}:${e.decor}:${e.scale}`));
        await pause(700);
        check('After Keep the camera eases back to the plain overview', await page.$eval(CANVAS, c => c.dataset.shapeFramed) === 'false');
        check('After Keep the caption and the ghost tags are gone and the strip has 1 dot', !await page.$('[data-testid="shape-caption"]') && !await page.$('[data-testid="shape-ghost-tag"]') && (await page.$$('[data-testid="shape-history-dot"]')).length === 1);

        // 4. Point to refer: click a sofa.
        const world = await savedWorld();
        const sofas = (world?.entities ?? []).filter(e => e.kind === 'decor' && (e.decor === 'sofa' || /sofa|couch|armchair/i.test(`${e.label ?? ''} ${e.prop ?? ''}`)));
        let pickedId = '';
        const wrap = await page.$eval(CANVAS, c => { const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        for (let fy = 0.2; fy <= 0.8 && !pickedId; fy += 0.035) for (let fx = 0.1; fx <= 0.9 && !pickedId; fx += 0.03) {
            const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
            if (!await page.evaluate((x, y) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', x, y)) continue;
            await page.mouse.move(x, y); await pause(25);
            const hover = await page.$eval('[data-testid="build-mode"]', e => e.dataset.hover || '');
            if (hover && sofas.some(s => s.id === hover)) { await page.mouse.click(x, y); pickedId = hover; }
        }
        await pause(500);
        const pill = await page.$eval('[data-testid="shape-pill"]', e => ({ id: e.dataset.entity, text: e.textContent.replace('×', '').trim() })).catch(() => null);
        check('Clicking a sofa adds it to the prompt as a pill', !!pickedId && !!pill && pill.id === pickedId, { pickedId, pill, sofas: sofas.map(s => s.id) });
        await page.mouse.move(wrap[0] + 40, wrap[1] + wrap[3] - 40); await pause(900);
        await shot('4-pill');
        if (pill) {
            await type('move this closer to the screen'); await page.keyboard.press('Enter');
            await waitCaption();
            const g3 = await ghost(), c3 = await captionText();
            check('The proposal names the pointed entity', g3.ids.split(',').includes(pill.id), { g3, c3 });
            await page.focus('[data-testid="shape-input"]'); await page.keyboard.press('Escape'); await pause(800);
            const g4 = await ghost(), w4 = await savedWorld();
            check('Esc undoes: no ghost, the world did not change', !g4.ids && !await page.$('[data-testid="shape-caption"]') && JSON.stringify(w4.entities) === JSON.stringify(after.entities), g4);
        }

        // 5. A second kept change, then the strip.
        await type('add a plant'); await page.keyboard.press('Enter'); await waitCaption();
        await type('then'); await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control'); await pause(1000);
        check('Ctrl+Enter keeps even with text in the prompt (the text stays)', !await page.$('[data-testid="shape-caption"]') && await page.$eval('[data-testid="shape-input"]', e => e.value) === 'then');
        await page.$eval('[data-testid="shape-input"]', e => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ''); e.dispatchEvent(new Event('input', { bubbles: true })); });
        const dots = await page.$$('[data-testid="shape-history-dot"]');
        check('The history strip has the kept steps (2 dots)', dots.length === 2, dots.length);
        if (dots.length) { const box = await dots[0].boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await pause(400); }
        const tip = await page.evaluate(() => { const t = document.querySelector('[data-testid="shape-history-dot"] .omo-shape-tip'); return t ? { text: t.textContent, opacity: getComputedStyle(t).opacity } : null; });
        check('Hovering a dot shows its sentence and "Return to this point (you can redo)"', !!tip && Number(tip.opacity) > 0.5 && /nook/i.test(tip.text) && /Return to this point \(you can redo\)/.test(tip.text) && !/takes back/i.test(tip.text), tip);
        await shot('5-history');
        if (dots.length) await dots[0].click(); await pause(1200);
        const rewound = await savedWorld();
        check('Clicking the first dot undoes back to before it', JSON.stringify(rewound.entities) === JSON.stringify(before.entities) && (await page.$$('[data-testid="shape-history-dot"]')).length === 0, rewound.entities.length);
        // ... and you can redo: the Redo button puts the changes back, dot by dot.
        await click('[data-testid="shape-redo"]').catch(() => {}); await pause(700); await click('[data-testid="shape-redo"]').catch(() => {}); await pause(1000);
        const redone = await savedWorld();
        check('Redo puts the taken-back changes back (2 dots, the nook and the plant exist again)', (await page.$$('[data-testid="shape-history-dot"]')).length === 2 && !await page.$('[data-testid="shape-redo"]') && redone.entities.length === before.entities.length + 4, redone.entities.length);
        { const d = await page.$$('[data-testid="shape-history-dot"]'); if (d.length) await d[0].click(); await pause(1200); }

        // 6. Browse, Esc, errors.
        await click('[data-testid="shape-browse"]'); await pause(600);
        check('Browse shows the old World Builder palette', await visible('[data-testid="world-builder"]'));
        await shot('6-browse');
        await click('[data-testid="shape-browse"]'); await pause(300);
        await page.focus('[data-testid="shape-input"]'); await page.keyboard.press('Escape'); await pause(700);
        const closed = await page.evaluate(() => ({ shape: !!document.querySelector('[data-testid="shape-mode"]'), hud: getComputedStyle(document.querySelector('.omo-topbar-views')).opacity, building: !!document.querySelector('[data-testid="build-mode"]') }));
        check('Esc closes Shape: the HUD is back and build mode is off', !closed.shape && closed.hud === '1' && !closed.building, closed);
        await click('[data-testid="topbar-shape"]'); await pause(700);
        check('The top-bar Shape button opens Shape too', await visible('[data-testid="shape-mode"]'));
        await click('[data-testid="topbar-shape"]'); await pause(500);
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
