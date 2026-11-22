#!/usr/bin/env node
/*
 * Omo sky lab — shared capture harness. Serves a strategy folder over HTTP, opens its index.html in headless Chrome
 * (GPU: ANGLE/EGL on the NVIDIA card when available, else SwiftShader), and:
 *   - waits for window.__ready === true (the scene sets it once loaded),
 *   - takes 4 screenshots along window.__tour (array of {x,y,z,yaw,pitch,label}) via window.__setPose(pose),
 *   - records a ~20 s walk-through video by calling window.__tourAt(t in 0..1) each frame (scene moves the camera),
 *   - writes <out>/shot-*.png, <out>/walk.mp4, <out>/result.json (fps measured, errors).
 * Usage: node capture.cjs <strategyDir> <outDir> [port]   (optional env LAB_QUERY='baked=next' adds a page query)
 * The scene contract (index.html must implement): window.__ready, window.__tourAt(t), optional window.__label.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawnSync } = require('node:child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const DIR = path.resolve(process.argv[2]), OUT = path.resolve(process.argv[3]), PORT = Number(process.argv[4] || 3650);
const W = 1600, H = 900, SECONDS = Number(process.env.LAB_SECONDS || 20), FPS = 25;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.spz': 'application/octet-stream', '.ply': 'application/octet-stream', '.splat': 'application/octet-stream', '.css': 'text/css' };
const THREE_DIR = '~/dev/omo-skyscraper/omo/node_modules/three';
const server = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]);
    let file;
    if (u.startsWith('/three/')) file = path.join(THREE_DIR, u.slice(7)); else file = path.join(DIR, u === '/' ? 'index.html' : u);
    if (!file.startsWith(DIR) && !file.startsWith(THREE_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(b); });
});
(async () => {
    fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    const result = { strategy: path.basename(DIR), errors: [], shots: [] };
    const gpu = process.env.LAB_GPU !== '0';
    const args = ['--no-sandbox', `--window-size=${W},${H}`, '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
    if (gpu) args.push('--use-angle=gl-egl', '--use-gl=angle', '--enable-gpu-rasterization'); else args.push('--use-angle=swiftshader');
    const browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', args, defaultViewport: { width: W, height: H } });
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => result.errors.push(String(e.message || e)));
        page.on('console', m => { if (m.type() === 'error') result.errors.push('console: ' + m.text().slice(0, 300)); });
        await page.goto(`http://127.0.0.1:${PORT}/${process.env.LAB_QUERY ? '?' + process.env.LAB_QUERY.replace(/^\?/, '') : ''}`, { waitUntil: 'domcontentloaded' });   // LAB_QUERY=baked=next previews a candidate bake
        await page.waitForFunction(() => window.__ready === true, { timeout: Number(process.env.LAB_READY_MS || 240000) });
        result.renderer = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        // 4 stills along the tour
        for (const [i, t] of [0.0, 0.3, 0.6, 0.9].entries()) {
            await page.evaluate(t => window.__tourAt(t), t);
            await new Promise(r => setTimeout(r, 1500));
            const p = path.join(OUT, `shot-${i + 1}.png`); await page.screenshot({ path: p }); result.shots.push(p);
        }
        // video: deterministic stepping, one screenshot per frame
        const frames = SECONDS * FPS, list = [];
        const t0 = Date.now();
        for (let f = 0; f < frames; f++) {
            await page.evaluate(t => window.__tourAt(t), f / (frames - 1));
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
            const n = String(f).padStart(6, '0');
            await page.screenshot({ path: path.join(OUT, 'frames', `${n}.jpg`), type: 'jpeg', quality: 82 });
            list.push(n);
        }
        result.captureSeconds = (Date.now() - t0) / 1000;
        result.realFps = await page.evaluate(() => new Promise(res => { let n = 0; const s = performance.now(); const tick = () => { n++; if (performance.now() - s < 2000) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now() - s) / 1000))); }; requestAnimationFrame(tick); }));
        const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(OUT, 'frames', '%06d.jpg'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT, 'walk.mp4')], { encoding: 'utf8' });
        if (enc.status !== 0) result.errors.push('ffmpeg: ' + enc.stderr);
        fs.rmSync(path.join(OUT, 'frames'), { recursive: true, force: true });
        result.video = path.join(OUT, 'walk.mp4');
        result.ok = true;
    } catch (e) { result.ok = false; result.errors.push(String(e.stack || e)); try { const p = browser.pages && (await browser.pages())[1]; if (p) await p.screenshot({ path: path.join(OUT, 'failure.png') }); } catch {} }
    finally { await browser.close().catch(() => {}); server.close(); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1)); console.log(JSON.stringify({ ok: result.ok, renderer: result.renderer, fps: result.realFps, errors: result.errors.slice(0, 3) })); process.exit(result.ok ? 0 : 1); }
})();
