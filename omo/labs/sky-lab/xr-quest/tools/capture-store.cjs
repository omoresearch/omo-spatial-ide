#!/usr/bin/env node
// Store captures from the REAL app: live server + real tmux terminals, the page in headless Chrome (GPU), the headset
// emulated by Meta's IWER (Quest 3 profile, stereo off = one eye, full frame). The ?quest=1 profile is used because that
// is what the headset build runs. Nothing is painted on top: every pixel is the app's own WebGL frame.
//   node tools/capture-store.cjs [shots|covers|trailer|all]
// Writes: listing/assets/raw/shot-*.png (2560x1440), listing/assets/raw/cover-*.png (each Store aspect, rendered natively),
//         <scratch>/trailer-frames/<seg>/f-00001.jpg (1920x1080) + listing/assets/raw/trailer-segments.json
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const { tmuxBin } = require('../live/tmuxbin.cjs');
const LANE = path.resolve(__dirname, '..'), RAW = path.join(LANE, 'listing/assets/raw'), SOCK = 'omo-xr-store-' + process.pid;
const SCR = '~/.hermes/cache/scratch/xr-store', FR = path.join(SCR, 'trailer-frames');
const MODE = process.argv[2] || 'all';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TMUX = tmuxBin();
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCK, ...a], { encoding: 'utf8' });
const keys = (desk, s) => tmux('send-keys', '-t', desk, s, 'Enter');
fs.mkdirSync(RAW, { recursive: true }); fs.mkdirSync(FR, { recursive: true });

// in-page helpers (string, injected once per page)
const HELPERS = `
window.__cap = {
  q(yaw, pitch) { const a = yaw * Math.PI / 360, b = pitch * Math.PI / 360, cy = Math.cos(a), sy = Math.sin(a), cx = Math.cos(b), sx = Math.sin(b); return [cy * sx, sy * cx, -sy * sx, cy * cx]; },
  pose(x, z, yaw, pitch, eye = 1.62) { window.__xr.setRigYaw(0); window.__xr.setFeet(x, z, 0); const d = window.__xrDevice; d.position.set(0, eye, 0); d.quaternion.set(...this.q(yaw, pitch)); this.head = { yaw, eye }; },
  ctl(on) { const d = window.__xrDevice; d.controllers.left.connected = on; d.controllers.right.connected = on; },
  // aim a controller (or the right hand) from a hand-ish spot next to the head at a WORLD point
  aim(side, world, off = [0.16, -0.28, -0.22]) {
    const d = window.__xrDevice, h = side === 'hand' ? d.hands.right : d.controllers[side];
    const y = this.head.yaw * Math.PI / 180, c = Math.cos(y), s = Math.sin(y);
    const ox = side === 'left' ? -Math.abs(off[0]) : Math.abs(off[0]);
    const o = [d.position.x + ox * c + off[2] * s, d.position.y + off[1], d.position.z - ox * s + off[2] * c];
    const t = window.__xr.toRig(world), v = [t[0] - o[0], t[1] - o[1], t[2] - o[2]], m = Math.hypot(...v), u = v.map(k => k / m);
    // quaternion that turns -Z onto u: axis (-Z x u) = [u1, -u0, 0], w = 1 + dot(-Z, u)
    let ax = [u[1], -u[0], 0], w = 1 - u[2]; if (w < 1e-6) { ax = [0, 1, 0]; w = 0; } const n = Math.hypot(...ax, w);
    h.position.set(...o); h.quaternion.set(ax[0] / n, ax[1] / n, ax[2] / n, w / n); return m;
  },
  rest(side) { const d = window.__xrDevice, h = d.controllers[side]; const y = this.head.yaw * Math.PI / 180, c = Math.cos(y), s = Math.sin(y), ox = side === 'left' ? -0.2 : 0.2, oz = -0.3;
    h.position.set(d.position.x + ox * c + oz * s, d.position.y - 0.45, d.position.z - ox * s + oz * c); h.quaternion.set(...this.q(this.head.yaw, -35)); },
  async frames(n = 2) { const f0 = window.__xr.frames; const t0 = performance.now(); while (window.__xr.frames < f0 + n && performance.now() - t0 < 3000) await new Promise(r => setTimeout(r, 8)); },
};`;

(async () => {
  const PORT = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const home = path.join(fs.mkdtempSync(path.join('~/.hermes/cache/scratch/', 'xrstore-')), 'agent-desk'); fs.mkdirSync(home);
  const server = spawn(process.execPath, [path.join(LANE, 'live/server.cjs'), '--port', String(PORT)], { env: { ...process.env, LIVE_SOCK: SOCK, LIVE_CWD: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const token = await new Promise((res, rej) => { let o = ''; const to = setTimeout(() => rej(new Error('no token')), 15000); server.stdout.on('data', d => { o += d; const m = /token=([0-9a-f]{48})/.exec(o); if (m) { clearTimeout(to); res(m[1]); } }); });
  const browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', defaultViewport: { width: 2560, height: 1440 },
    args: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=gl-egl', '--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const log = [];
  let ensureDesks = async () => {};
  const open = async (w, h) => {
    const page = await browser.newPage(); await page.setViewport({ width: w, height: h });
    const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
    await page.goto(`http://127.0.0.1:${PORT}/?xremu=1&quest=1&live=${token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true && window.__live && window.__live.ready, { timeout: 240000 });
    await page.evaluate(HELPERS);
    await page.click('#omo-enter-vr');
    await page.waitForFunction(() => window.__xr.presenting && window.__xr.loading === false, { timeout: 30000 });
    // the Exit VR button is page UI, not headset UI: it is not drawn in the headset, so it is not in the captures
    await page.evaluate(() => { document.querySelector('#omo-enter-vr').style.display = 'none'; });
    // capture poses jump the body, which (correctly) fades in the comfort vignette; off for captures, as with Y in the headset
    await page.evaluate(() => { window.__xr.comfort.vignette = false; });
    page.errs = errs; await ensureDesks(); return page;
  };
  // real shell content on the three desks (real commands, real output)
  const PS1 = "export PS1='\\[\\e[1;32m\\]omo\\[\\e[0m\\]:\\[\\e[1;34m\\]\\W\\[\\e[0m\\]\\$ '; cd " + LANE + "; clear";
  const setupDesks = async () => {
    for (const d of ['desk-0', 'desk-1', 'desk-2']) keys(d, PS1);
    await sleep(800);
    keys('desk-0', 'git log --oneline --no-decorate | cut -c1-74');
    keys('desk-1', 'grep -E "^(PASS|FAIL|VERDICT)" out/test-step4-run2.log | cut -c1-78 | tail -n 21');
    keys('desk-2', 'top -d 2 -o %CPU');
    await sleep(2500);
  };
  const tryRm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
  try {
    let deskReady = false;
    ensureDesks = async () => { if (!deskReady) { await setupDesks(); deskReady = true; } };
    const desk = (id) => (page) => page.evaluate((id) => window.__live.deskCenter(id), id);

    if (MODE === 'shots' || MODE === 'all') {
      const page = await open(2560, 1440);
      const c1 = await desk('desk-1')(page), c0 = await desk('desk-0')(page), c2 = await desk('desk-2')(page);
      const shoot = async (name, note) => { await page.waitForFunction(() => !window.__xr.vignetteShown(), { timeout: 5000 }).catch(() => {}); await page.evaluate(() => window.__cap.frames(4)); await sleep(300); const f = path.join(RAW, `shot-${name}.png`); await page.screenshot({ path: f }); log.push({ file: path.relative(LANE, f), note }); };
      // 1 arrival: the three desks from the window side, controllers in hand, the wrist hint
      await page.evaluate(() => { window.__cap.ctl(true); window.__cap.pose(5.9, -1.0, -6, -14); });
      await sleep(300); await page.evaluate((c) => { window.__cap.aim('right', c); window.__cap.aim('left', [c[0] - 1.4, 0.1, c[2] + 1.6], [0.2, -0.3, -0.25]); }, c1);
      await shoot('1-arrive', 'arrival: three live desks, right controller pointing at Desk 2, left wrist hint');
      // 2 typing panel: point at Desk 2, trigger, the close panel shows the real test log from step 4
      await page.evaluate(() => window.__cap.pose(7.6, -2.55, 0, -6)); await sleep(300);
      await page.evaluate((c) => window.__cap.aim('right', c), c1); await sleep(300);
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 1)); await sleep(250);
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 0)); await sleep(800);
      const pv = await page.evaluate(() => window.__xr.panelView());
      await page.evaluate((at) => { window.__cap.aim('right', [at[0] + 0.25, at[1] - 0.1, at[2]]); window.__cap.rest('left'); }, pv.at);
      await shoot('2-panel', 'Desk 2 brought close as a readable panel; the real test-suite results (out/test-step4-run2.log)');
      // 3 move the panel: grip it and carry it to the left
      await page.evaluate((at) => window.__cap.aim('right', at), pv.at); await sleep(300);
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 1)); await sleep(300);
      const grabbed = await page.evaluate(() => window.__xr.grabbing);
      await page.evaluate(() => { const r = window.__xrDevice.controllers.right; r.position.set(r.position.x - 0.45, r.position.y + 0.06, r.position.z - 0.25); }); await sleep(500);
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 0)); await sleep(300);
      // look straight at where the panel now sits (it turned to face you when you let go)
      const pa = await page.evaluate(() => window.__xr.panelView().at);
      await page.evaluate((a) => { const yaw = Math.atan2(-(a[0] - 7.6), -(a[2] + 2.55)) * 180 / Math.PI; const pitch = Math.atan2(a[1] - 1.62, Math.hypot(a[0] - 7.6, a[2] + 2.55)) * 180 / Math.PI; window.__cap.pose(7.6, -2.55, yaw, pitch); }, pa); await sleep(300);
      const pv2 = await page.evaluate(() => window.__xr.panelView());
      await page.evaluate((at, c2) => { window.__cap.aim('right', c2); window.__cap.aim('left', [at[0] + 0.3, at[1] - 0.15, at[2]], [0.2, -0.3, -0.25]); }, pv2.at, c2);
      await shoot('3-place', `panel gripped and moved aside (grabbed=${grabbed}); Desk 3 still live (top) behind it`);
      // release, then 4: all three desks running, seen from the side
      await page.evaluate(() => { window.__xrDevice.controllers.right.updateButtonValue('a-button', 1); }); await sleep(250);
      await page.evaluate(() => { window.__xrDevice.controllers.right.updateButtonValue('a-button', 0); }); await sleep(400);
      await page.evaluate(() => window.__cap.pose(2.9, -2.6, -62, -8)); await sleep(300);
      await page.evaluate((c) => { window.__cap.aim('right', c); window.__cap.rest('left'); }, c0);
      await shoot('4-desks', 'three desks, three real shells (git log, test results, top), seen from the west end');
      // 5 the city: at the north glass, looking out and down
      // (four views were tried; the lounge view showed the room and the city with the fewest glass reflections)
      await page.evaluate(() => { window.__cap.ctl(false); window.__cap.pose(8.0, -6.6, -70, -4); }); await sleep(300);
      await shoot('5-lounge', 'the lounge and the city through two glass walls, controllers down');
      await page.evaluate(() => window.__cap.ctl(true));
      // 6 teleport: aim at the floor, the marker shows where you land
      await page.evaluate(() => window.__cap.pose(12.2, -8.6, 120, -18)); await sleep(300);
      const tgt = await page.evaluate(() => { const y = 120 * Math.PI / 180; return [12.2 - Math.sin(y) * 3.0, 0, -8.6 - Math.cos(y) * 3.0]; });
      await page.evaluate((t) => { window.__cap.aim('right', t); window.__cap.rest('left'); window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, -1); }, tgt); await sleep(600);
      const aimT = await page.evaluate(() => window.__xr.teleportAim);
      await shoot('6-teleport', `teleport aim on the floor (valid=${aimT && aimT.valid}), looking back over the lounge to the desks`);
      await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0)); await sleep(400);
      log.push({ errors: page.errs });
      await page.close();
    }

    if (MODE === 'covers' || MODE === 'all') {
      // clean frames for the branded covers: no controllers, rendered at each Store aspect (not cropped)
      for (const [name, w, h, pose] of [['landscape', 2560, 1440, [5.2, -0.6, -8, -9]], ['hero', 3000, 900, [5.2, -0.6, -8, -6]], ['square', 1440, 1440, [6.4, -0.9, -4, -10]],
        ['portrait', 1008, 1440, [7.3, -1.3, 0, -10]], ['mini', 1080, 360, [5.2, -0.6, -8, -6]]]) {
        const page = await open(w, h);
        await page.evaluate((p) => { window.__cap.ctl(false); window.__cap.pose(...p); }, pose);
        await page.evaluate(() => window.__cap.frames(6)); await sleep(400);
        const f = path.join(RAW, `cover-${name}.png`); await page.screenshot({ path: f }); log.push({ file: path.relative(LANE, f), note: `clean ${w}x${h} render for the ${name} cover` });
        await page.close();
      }
    }

    if (MODE === 'trailer' || MODE === 'all') {
      tryRm(FR); fs.mkdirSync(FR, { recursive: true });
      const page = await open(1920, 1080);
      const c0 = await desk('desk-0')(page), c1 = await desk('desk-1')(page), c2 = await desk('desk-2')(page);
      const segs = [];
      let seg = null, n = 0;
      const begin = (id, caption) => { seg = { id, caption, frames: 0 }; segs.push(seg); n = 0; fs.mkdirSync(path.join(FR, id), { recursive: true }); };
      const grab = async () => { await page.evaluate(() => window.__cap.frames(2)); n++; seg.frames = n; await page.screenshot({ path: path.join(FR, seg.id, `f-${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 }); };
      const ease = (t) => t * t * (3 - 2 * t), lerp = (a, b, t) => a + (b - a) * t;
      const glide = async (from, to, frames, each) => { for (let i = 0; i < frames; i++) { const t = ease(i / (frames - 1)); const p = from.map((v, k) => lerp(v, to[k], t)); await page.evaluate((p) => window.__cap.pose(...p), p); if (each) await each(t, i); await grab(); } };
      const hold = async (frames, each) => { for (let i = 0; i < frames; i++) { if (each) await each(i); await grab(); } };
      // A: arrive and walk toward the desks (camera path through the real room; controllers in hand)
      // the comfort vignette fades in whenever the body moves; a camera glide would show it the whole time, so it is
      // switched off for the trailer (the Y button does the same in the headset)
      await page.evaluate(() => { window.__xr.comfort.vignette = false; });
      begin('a-walk', 'A calm office in the sky');
      await page.evaluate(() => window.__cap.ctl(true));
      await glide([3.0, -0.7, -30, -6], [6.6, -2.4, -4, -10], 210, async () => page.evaluate(() => { window.__cap.rest('left'); window.__cap.rest('right'); }));
      // B: point at Desk 2, pull the trigger, the panel comes up, type a real command
      begin('b-type', 'Point at a desk. Type into a real shell.');
      await page.evaluate(() => window.__cap.pose(7.6, -2.55, 0, -6));
      await hold(30, async (i) => page.evaluate((c, i) => { window.__cap.aim('right', [c[0] + 0.9 - i * 0.03, c[1], c[2]]); window.__cap.rest('left'); }, c1, i));
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 1)); await grab(); await grab();
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 0));
      await hold(24);
      keys('desk-1', 'clear'); await sleep(300);
      const pv = await page.evaluate(() => window.__xr.panelView());
      await page.evaluate((at) => window.__cap.aim('right', [at[0] + 0.3, at[1] - 0.2, at[2]]), pv.at);
      for (const ch of 'grep -c ^PASS out/test-step4-run*.log; tail -n 3 out/test-step4-run2.log') { await page.keyboard.type(ch); await grab(); }
      await page.keyboard.press('Enter'); await hold(75);
      // C: grip the panel and move it aside
      begin('c-move', 'Grab a screen. Put it anywhere.');
      await page.evaluate((at) => window.__cap.aim('right', at), pv.at); await hold(8);
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 1)); await hold(6);
      const r0 = await page.evaluate(() => { const p = window.__xrDevice.controllers.right.position; return [p.x, p.y, p.z]; });
      for (let i = 0; i < 60; i++) { const t = ease(i / 59); await page.evaluate((r, t) => window.__xrDevice.controllers.right.position.set(r[0] - 0.4 * t, r[1] + 0.08 * t, r[2] + 0.05 * t), r0, t); await grab(); }
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 0));
      await glide([7.6, -2.55, 0, -6], [7.6, -2.55, 12, -8], 45, async () => page.evaluate((c) => window.__cap.aim('right', c), c2));
      await hold(30);
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('a-button', 1)); await grab();
      await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('a-button', 0)); await grab();
      // D: all three desks keep running
      begin('d-desks', 'Every terminal keeps running. Even when you leave.');
      await glide([2.8, -2.2, -70, -12], [3.2, -3.4, -52, -18], 150, async () => page.evaluate((c) => { window.__cap.rest('left'); window.__cap.rest('right'); }, c0));
      // E: walk to the glass and look at the city
      begin('e-city', 'Step to the window whenever you need a break.');
      await glide([8.8, -8.8, -20, -4], [9.4, -10.9, -8, -22], 150, async () => page.evaluate(() => { window.__cap.rest('left'); window.__cap.rest('right'); }));
      // F: comfort: teleport aim + jump
      begin('f-comfort', 'Teleport, snap turn, comfort vignette, seated mode.');
      await page.evaluate(() => window.__cap.pose(12.2, -8.6, 120, -18));
      const y = 120 * Math.PI / 180, tgt = [12.2 - Math.sin(y) * 3.0, 0, -8.6 - Math.cos(y) * 3.0];
      await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, -1));
      await hold(75, async (i) => page.evaluate((t, i) => { window.__cap.pose(12.2, -8.6, 120, -18); window.__cap.aim('right', [t[0] + Math.sin(i / 12) * 0.5, 0, t[2] + Math.cos(i / 12) * 0.4]); window.__cap.rest('left'); }, tgt, i));
      const ok = await page.evaluate(() => window.__xr.teleportAim);
      await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0)); await hold(4);
      const land = await page.evaluate(() => window.__xr.feet());
      await hold(56, async () => page.evaluate((f) => { const d = window.__xrDevice; window.__cap.head = { yaw: 120, eye: 1.62 }; d.quaternion.set(...window.__cap.q(120, -10)); window.__cap.rest('left'); window.__cap.rest('right'); }, land));
      seg.note = `teleport aim valid=${ok && ok.valid}, landed at ${land.map(v => v.toFixed(2))}`;
      fs.writeFileSync(path.join(RAW, 'trailer-segments.json'), JSON.stringify({ fps: 30, size: [1920, 1080], profile: 'quest', segs }, null, 2));
      log.push({ trailer: segs.map(s => `${s.id} ${s.frames}f`), errors: page.errs });
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {}); server.kill('SIGTERM'); tmux('kill-server');
  }
  const L = path.join(RAW, `capture-${MODE}.json`); fs.writeFileSync(L, JSON.stringify(log, null, 2)); console.log(JSON.stringify(log, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
