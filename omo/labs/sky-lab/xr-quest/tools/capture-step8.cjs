#!/usr/bin/env node
// step 8 evidence: real captures of free screens (desktop view + emulated headset view), from the real app + live server.
//   node tools/capture-step8.cjs  -> out/step8-desktop.png, out/step8-headset.png, out/step8-layout.json
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const { tmuxBin } = require('../live/tmuxbin.cjs');
const LANE = path.resolve(__dirname, '..'), OUT = path.join(LANE, 'out'), SOCK = 'omo-xr-cap8-' + process.pid, TMUX = tmuxBin();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const PORT = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const LAYOUT = path.join(fs.mkdtempSync('~/.hermes/cache/scratch/cap8-'), 'layout.json');
  const server = spawn(process.execPath, [path.join(LANE, 'live/server.cjs'), '--port', String(PORT)], { env: { ...process.env, LIVE_SOCK: SOCK, LIVE_LAYOUT: LAYOUT, LIVE_CWD: fs.mkdtempSync('~/.hermes/cache/scratch/cap8ws-') }, stdio: ['ignore', 'pipe', 'inherit'] });
  const token = await new Promise((res) => { let o = ''; server.stdout.on('data', d => { o += d; const m = /token=([0-9a-f]{48})/.exec(o); if (m) res(m[1]); }); });
  const browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', defaultViewport: { width: 1600, height: 900 }, args: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=gl-egl', '--use-gl=angle'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/?xremu=1&live=${token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true && window.__live && window.__live.ready, { timeout: 240000 });
    // a free layout: three terminals in a gentle arc in the open room, one big terminal on the west wall, the docs page floating
    const ids = await page.evaluate(() => {
      const L = window.__live, out = {};
      for (const id of ['desk-0', 'desk-1', 'desk-2']) L.closeScreen(id);
      out.a = L.createScreen('term', { pos: [4.2, 1.55, -4.6], rotY: 0.45, w: 1.25 });
      out.b = L.createScreen('term', { pos: [5.6, 1.55, -5.0], rotY: 0, w: 1.25 });
      out.c = L.createScreen('term', { pos: [7.0, 1.55, -4.6], rotY: -0.45, w: 1.25 });
      out.w = L.createScreen('term', { pos: [0.5, 1.8, -4.4], rotY: Math.PI / 2 - 0.2, w: 2.6 });
      L.snapScreen(out.w);
      L.moveScreen('west', [2.2, 1.65, -7.6], 0.5); L.resizeScreen('west', 2.2, 1.25);
      L.closeScreen('south');
      return out;
    });
    for (let i = 0; i < 80; i++) { await sleep(100); if (await page.evaluate(() => window.__live.desks().every(d => d.status === 'live'))) break; }
    const say = (id, cmd) => spawnSync(TMUX, ['-L', SOCK, 'send-keys', '-t', '=' + id + ':', cmd, 'Enter']);
    say(ids.a, "clear; echo 'agent: build'; for i in 1 2 3 4 5; do echo \"step $i ok\"; done");
    say(ids.b, 'clear; uname -sr; uptime; echo; ls -la | head -12');
    say(ids.c, "clear; echo 'tests'; printf 'PASS %s\\n' layout snap resize close persist");
    say(ids.w, "clear; echo 'Omo Space: free screens'; echo 'This terminal is snapped flat on the west wall.'; echo; seq 1 8 | sed 's/^/line /'");
    await page.evaluate((id) => window.__live.setFocus('term:' + id, 'far'), ids.b);
    await sleep(1500);
    await page.evaluate(() => window.__setPose({ x: 5.6, z: -0.9, yaw: 18, pitch: -6 }));
    await sleep(1200);
    await page.screenshot({ path: path.join(OUT, 'step8-desktop.png') });
    await page.evaluate(() => window.__live.setFocus(null));
    fs.writeFileSync(path.join(OUT, 'step8-layout.json'), fs.readFileSync(LAYOUT));
    // headset view (emulator, mono): standing in front of the arc
    await page.click('#omo-enter-vr');
    await page.waitForFunction(() => window.__xr.presenting && window.__xr.loading === false && window.__xr.frames > 30, { timeout: 30000 });
    await page.evaluate(() => { window.__xr.setRigYaw(0); window.__xr.setFeet(5.6, -2.6, 0); const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(-0.06, 0, 0, 0.998); d.controllers.left.connected = true; d.controllers.right.connected = true;
      d.controllers.right.position.set(0.18, 1.3, -0.3); d.controllers.left.position.set(-0.2, 1.3, -0.35); });
    await sleep(1500);
    await page.screenshot({ path: path.join(OUT, 'step8-headset.png') });
    await page.evaluate(() => window.__xr.exit());
    console.log('ok', JSON.stringify(ids));
  } finally { await browser.close(); server.kill('SIGTERM'); spawnSync(TMUX, ['-L', SOCK, 'kill-server']); }
})().catch(e => { console.error(e); process.exit(1); });
