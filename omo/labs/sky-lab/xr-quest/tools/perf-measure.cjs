#!/usr/bin/env node
// Measures the render budget of the desktop profile and the ?quest=1 profile on THIS host (headless Chrome, GPU via
// ANGLE/EGL, IWER Quest 3 emulator). Writes out/perf-step4.json and prints a table.
//   node tools/perf-measure.cjs
// Numbers: draw calls + triangles for one desktop frame, texture memory estimate, load time, and XR frame CPU time
// (stereo on, so both eyes are drawn). None of this is a Quest fps number: that needs the headset.
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const { tmuxBin } = require('../live/tmuxbin.cjs');
const LANE = path.resolve(__dirname, '..'), OUT = path.join(LANE, 'out'), SOCK = 'omo-xr-perf-' + process.pid;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const PORT = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const server = spawn(process.execPath, [path.join(LANE, 'live/server.cjs'), '--port', String(PORT)], { env: { ...process.env, LIVE_SOCK: SOCK, LIVE_CWD: fs.mkdtempSync('~/.hermes/cache/scratch/xrperf-') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const token = await new Promise((res, rej) => { let o = ''; const to = setTimeout(() => rej(new Error('no token')), 15000); server.stdout.on('data', d => { o += d; const m = /token=([0-9a-f]{48})/.exec(o); if (m) { clearTimeout(to); res(m[1]); } }); });
  const browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', defaultViewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=gl-egl', '--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const res = { host: { load: require('node:os').loadavg().map(v => +v.toFixed(1)), cpus: require('node:os').cpus().length, when: new Date().toISOString() } };
  try {
    for (const [name, qs] of [['desktop', ''], ['quest', '&quest=1']]) {
      const page = await browser.newPage();
      const t0 = Date.now();
      await page.goto(`http://127.0.0.1:${PORT}/?xremu=1&stereo=1${qs}&live=${token}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__ready === true && window.__live && window.__live.ready, { timeout: 240000 });
      const wall = Date.now() - t0;
      await page.evaluate(() => window.__tourAt(0));
      const perf = await page.evaluate(() => window.__perf());
      const st = await page.evaluate(() => ({ loadMs: window.__status.loadMs, readyMs: window.__status.readyMs }));
      // desktop frame time: 120 frames of the normal loop
      const dFrame = await page.evaluate(async () => { const a = []; let l = performance.now(); for (let i = 0; i < 120; i++) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); a.push(n - l); l = n; } a.sort((x, y) => x - y); return { p50: a[60], p95: a[114] }; });
      await page.screenshot({ path: path.join(OUT, `perf-${name}.png`) });
      // XR: enter through the button, stereo on, let it run 6 s, read frame CPU time
      await page.click('#omo-enter-vr');
      await page.waitForFunction(() => window.__xr.presenting && window.__xr.loading === false, { timeout: 30000 });
      await sleep(6000);
      const xr = await page.evaluate(() => { const a = window.__xr.frameMs.slice().sort((x, y) => x - y); const s = window.__xrDevice; return { n: a.length, p50: a[a.length >> 1], p95: a[Math.floor(a.length * 0.95)], stereo: s.stereoEnabled }; });
      const xrPerf = await page.evaluate(() => window.__perf());
      await page.evaluate(() => window.__xr.exit()); await sleep(500);
      res[name] = { wallLoadMs: wall, ...st, perf, desktopFrameMs: dFrame, xr, xrCalls: xrPerf.calls, xrTriangles: xrPerf.triangles };
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {}); server.kill('SIGTERM'); spawnSync(tmuxBin(), ['-L', SOCK, 'kill-server']);
  }
  fs.writeFileSync(path.join(OUT, 'perf-step4.json'), JSON.stringify(res, null, 2));
  const D = res.desktop, Q = res.quest, row = (k, a, b) => console.log(`${k.padEnd(34)} ${String(a).padStart(14)} ${String(b).padStart(14)}`);
  console.log(`host load ${res.host.load.join(' ')} on ${res.host.cpus} cpus`);
  row('', 'desktop', '?quest=1');
  row('draw calls (one view)', D.perf.calls, Q.perf.calls);
  row('triangles (one view)', D.perf.triangles, Q.perf.triangles);
  row('realtime lights', D.perf.lights, Q.perf.lights);
  row('bloom pass', D.perf.bloom, Q.perf.bloom);
  row('antialias (MSAA)', D.perf.antialias, Q.perf.antialias);
  row('lightmaps', D.perf.lightmaps.join(' '), Q.perf.lightmaps.join(' '));
  row('textures', D.perf.textures, Q.perf.textures);
  row('texture memory estimate (MB)', D.perf.texMB, Q.perf.texMB);
  row('page load to ready (ms)', D.readyMs, Q.readyMs);
  row('desktop frame p50/p95 (ms)', `${D.desktopFrameMs.p50.toFixed(1)}/${D.desktopFrameMs.p95.toFixed(1)}`, `${Q.desktopFrameMs.p50.toFixed(1)}/${Q.desktopFrameMs.p95.toFixed(1)}`);
  row('XR frame cpu p50/p95 (ms, stereo)', `${D.xr.p50.toFixed(1)}/${D.xr.p95.toFixed(1)}`, `${Q.xr.p50.toFixed(1)}/${Q.xr.p95.toFixed(1)}`);
  console.log('top desktop textures: ' + D.perf.top.join(', '));
  console.log('top quest textures:   ' + Q.perf.top.join(', '));
})().catch(e => { console.error(e); process.exit(1); });
