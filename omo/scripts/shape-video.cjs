#!/usr/bin/env node
/*
 * shape — a ~25 s GPU video of building a nook by typing (CDP screencast, the approach of omo-world-magic's
 * scripts/world-magic-real.cjs): Space -> "add a reading nook by the window" -> ghost + caption -> "make it bigger"
 * -> Enter keeps -> click the armchair (a pill) -> "move this closer to the screen" -> Enter keeps.
 * Frames keep their real timestamps (an ffmpeg concat list), so the video plays at true speed.
 * Writes <outDir>/shape-nook.mp4 (+ frames/, shape-video.json). Usage: node scripts/shape-video.cjs <outDir> [port 3750-3759]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'shape', 'final'));
const PORT = Number(process.argv[3] || 3752);
if (!(PORT >= 3750 && PORT <= 3759)) { console.error('Use a port from 3750 to 3759.'); process.exit(2); }
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

(async () => {
    fs.mkdirSync(OUT, { recursive: true }); fs.rmSync(path.join(OUT, 'frames'), { recursive: true, force: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-shape-video-'));
    const project = path.join(S, 'shape'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# shape\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-shape-video-${PORT}`;
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

        // The recorder: every painted frame with its timestamp.
        const fr = path.join(OUT, 'frames'); fs.mkdirSync(fr, { recursive: true });
        const cdp = await page.createCDPSession();
        const frames = []; let recording = false, seg = 0;
        cdp.on('Page.screencastFrame', async f => {
            if (recording) { const file = `f${String(frames.length).padStart(5, '0')}.jpg`; fs.writeFileSync(path.join(fr, file), Buffer.from(f.data, 'base64')); frames.push({ file, seg, t: f.metadata.timestamp ?? Date.now() / 1000 }); }
            await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        });
        const record = async on => { if (on === recording) return; if (on) { recording = true; await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1, maxWidth: 1440, maxHeight: 900 }); } else { await cdp.send('Page.stopScreencast'); recording = false; seg++; } };
        const slowType = async (text, delay = 55) => { await page.focus('[data-testid="shape-input"]'); await page.keyboard.type(text, { delay }); };
        // A cursor the viewer can see (headless Chrome draws none).
        await page.evaluate(() => { const d = document.createElement('div'); d.id = 'omo-video-cursor'; d.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.9);box-shadow:0 0 0 2px rgba(0,0,0,.45),0 2px 10px rgba(0,0,0,.5);pointer-events:none;z-index:2147483647;transition:transform .12s;opacity:0'; document.body.appendChild(d); addEventListener('mousemove', e => { d.style.opacity = '1'; d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true); addEventListener('mousedown', () => { d.style.transform = 'scale(.7)'; }, true); addEventListener('mouseup', () => { d.style.transform = ''; }, true); });
        const glide = async (x0, y0, x1, y1, ms = 700) => { const n = Math.max(8, Math.round(ms / 16)); for (let i = 1; i <= n; i++) { const k = i / n, e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; await page.mouse.move(x0 + (x1 - x0) * e, y0 + (y1 - y0) * e); await pause(16); } };

        const t0 = Date.now(); const marks = [];
        const mark = name => { marks.push({ name, s: +((Date.now() - t0) / 1000).toFixed(2) }); console.log(`  ${marks.at(-1).s}s ${name}`); };
        await record(true); await pause(1200); mark('start');
        // 1. Space opens Shape.
        await page.focus(CANVAS); await page.keyboard.press('Space'); await pause(1300); mark('space');
        check('Space opens Shape', await visible('[data-testid="shape-mode"]'));
        // 2. The nook.
        await slowType('add a reading nook by the window'); await pause(350); await page.keyboard.press('Enter'); mark('nook sent');
        await waitCaption();
        await page.waitForFunction(() => (document.querySelector('canvas[data-testid="omo-world-canvas"]')?.dataset.ghostReal ?? '').split(',').filter(Boolean).length >= 3, { timeout: 20000 }).catch(() => {});
        const c1 = await captionText(); mark('ghost + caption');
        check('A ghost of the real furniture with its caption', (await page.$eval(CANVAS, e => e.dataset.ghostReal ?? '')).split(',').filter(Boolean).length === 3 && /nook/i.test(c1), c1);
        await pause(2600);
        // 3. Bigger, then Enter keeps.
        await slowType('make it bigger'); await pause(300); await page.keyboard.press('Enter'); mark('bigger sent');
        await waitCaption(c1); const c2 = await captionText(); mark('bigger ghost');
        check('Refined: bigger', /big/i.test(c2), c2);
        await pause(2000);
        await page.focus('[data-testid="shape-input"]'); await page.keyboard.press('Enter'); await pause(1300); mark('kept');
        check('Enter kept it (1 dot)', (await page.$$('[data-testid="shape-history-dot"]')).length === 1);
        // 4. Click the armchair: find it with the recorder paused (a hover scan), then glide there and click on camera.
        await record(false);
        const wrap = await page.$eval(CANVAS, c => { const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        let at;
        for (let fy = 0.2; fy <= 0.8 && !at; fy += 0.03) for (let fx = 0.1; fx <= 0.9 && !at; fx += 0.025) {
            const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
            if (!await page.evaluate((x, y) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', x, y)) continue;
            await page.mouse.move(x, y); await pause(20);
            if (await page.$eval('[data-testid="build-mode"]', e => e.dataset.hover || '') === 'armchair') at = [x, y];
        }
        const rest = [wrap[0] + wrap[2] * 0.5, wrap[1] + wrap[3] * 0.8];
        await page.mouse.move(...rest); await pause(500);
        await record(true); await pause(500);
        check('Found the armchair on screen', !!at, at);
        if (at) { await glide(...rest, ...at, 900); await pause(250); await page.mouse.click(...at); }
        await pause(700); mark('armchair pill');
        const pill = await page.$eval('[data-testid="shape-pill"]', e => e.dataset.entity).catch(() => '');
        check('The armchair is a pill in the prompt', pill === 'armchair', pill);
        await glide(...(at ?? rest), wrap[0] + 60, wrap[1] + wrap[3] - 60, 500);
        // 5. Move it, then keep.
        await slowType('move this closer to the screen'); await pause(300); await page.keyboard.press('Enter'); mark('move sent');
        await waitCaption(); const c3 = await captionText(); mark('move ghost');
        check('The move names the armchair', /armchair/i.test(c3), c3);
        await pause(2400);
        await page.focus('[data-testid="shape-input"]'); await page.keyboard.press('Enter'); await pause(1800); mark('kept 2');
        check('Enter kept it (2 dots)', (await page.$$('[data-testid="shape-history-dot"]')).length === 2);
        await record(false);

        // Encode at true speed: each frame lasts until the next one (the paused armchair search is cut).
        const list = frames.map((f, i) => `file '${path.join(fr, f.file)}'\nduration ${(frames[i + 1] && frames[i + 1].seg === f.seg ? Math.max(0.001, frames[i + 1].t - f.t) : 0.04).toFixed(4)}`).join('\n') + (frames.length ? `\nfile '${path.join(fr, frames.at(-1).file)}'\n` : '');
        fs.writeFileSync(path.join(fr, 'list.txt'), list);
        const mp4 = path.join(OUT, 'shape-nook.mp4');
        const vid = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(fr, 'list.txt'), '-vf', 'fps=30,scale=1440:-2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).stdout.trim();
        check('The video is encoded (~25 s)', vid.status === 0 && Number(probe) >= 18 && Number(probe) <= 40, { frames: frames.length, seconds: probe, err: vid.stderr?.slice(0, 200) });
        fs.writeFileSync(path.join(OUT, 'shape-video.json'), JSON.stringify({ marks, frames: frames.length, seconds: Number(probe), captions: [c1, c2, c3] }, null, 1));
        check('no page errors', errors.length === 0, errors.slice(0, 3));
    } catch (e) {
        failed++; console.log('FAIL run —', e.message);
        try { const pg = (await browser.pages()).slice(-1)[0]; await pg.screenshot({ path: path.join(OUT, 'fail.png') }); } catch {}
    } finally {
        fs.writeFileSync(path.join(OUT, 'video-results.json'), JSON.stringify({ failed, checks, errors }, null, 1));
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
