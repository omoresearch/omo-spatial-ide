#!/usr/bin/env node
// xr-quest end-to-end test: real live server + real tmux terminals, the page in headless Chrome (GPU), the headset
// emulated by Meta's IWER (Quest 3 profile). Drives the controllers exactly as a person would and asserts real effects.
//   node xr/test-xr.cjs            -> prints PASS/FAIL lines and a final VERDICT line; exit 1 on any FAIL
// Env: XR_PORT (default 3681), XR_SEED_FAULT=<name> only in a scratch copy for the red run.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const puppeteer = require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const { tmuxBin } = require('../live/tmuxbin.cjs');
const LANE = path.resolve(__dirname, '..'), OUT = path.join(LANE, 'out'); fs.mkdirSync(OUT, { recursive: true });
const net = require('node:net');
let PORT = Number(process.env.XR_PORT || 0); const SOCK = 'omo-xr-test-' + process.pid, TMUX = tmuxBin();
const LAYOUT = path.join(fs.mkdtempSync('~/.hermes/cache/scratch/xrlayout-'), 'layout.json');   // a fresh layout per run: first start = the default screens
let pass = 0, fail = 0; const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!PORT) PORT = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });   // free port: never collide with another lane's server
  const server = spawn(process.execPath, [path.join(LANE, 'live/server.cjs'), '--port', String(PORT)], { env: { ...process.env, LIVE_SOCK: SOCK, LIVE_CWD: fs.mkdtempSync('~/.hermes/cache/scratch/xrws-'), LIVE_LAYOUT: LAYOUT }, stdio: ['ignore', 'pipe', 'pipe'] });
  const token = await new Promise((res, rej) => { let o = ''; const to = setTimeout(() => rej(new Error('no token: ' + o)), 15000); server.stdout.on('data', d => { o += d; const m = /token=([0-9a-f]{48})/.exec(o); if (m) { clearTimeout(to); res(m[1]); } }); });
  const browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', defaultViewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=gl-egl', '--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(String(e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    await page.goto(`http://127.0.0.1:${PORT}/?xremu=1&live=${token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true && window.__live && window.__live.ready, { timeout: 240000 });
    const st = await page.evaluate(() => ({ supported: window.__xr.supported, btn: !!document.querySelector('#omo-enter-vr'), desks: window.__live.desks(), pwa: window.__xr.pwa, presenting: window.__xr.presenting }));
    check('emulated Quest 3 reports immersive-vr support', st.supported === true);
    check('Enter VR button is shown', st.btn);
    check('three desk terminals are live before entering VR', st.desks.length === 3 && st.desks.every(d => d.status === 'live'), JSON.stringify(st.desks));
    // ---- PWA install criteria (step 6): Chrome's own installability report, plus the fields Meta's Bubblewrap reads
    const cdp = await page.createCDPSession();
    const inst = await cdp.send('Page.getInstallabilityErrors');
    const am = await cdp.send('Page.getAppManifest');
    const mres = await fetch(`http://127.0.0.1:${PORT}/manifest.webmanifest`); const mtype = mres.headers.get('content-type'); const man = await mres.json();
    const icon512 = (man.icons || []).filter(i => i.sizes === '512x512'), base = `http://127.0.0.1:${PORT}/`;
    const iconsOk = (await Promise.all((man.icons || []).map(async i => (await fetch(new URL(i.src, base))).status === 200))).every(Boolean);
    const inScope = new URL(man.start_url, base).href.startsWith(new URL(man.scope, base).href);
    check('PWA: Chrome finds no install errors and the manifest has what Meta packaging needs (name, start page in scope, standalone, landscape, 512 px + maskable icons)',
      inst.installabilityErrors.length === 0 && am.errors.length === 0 && /manifest\+json/.test(mtype || '') && man.name && man.short_name && inScope && man.display === 'standalone' && man.orientation === 'landscape' && icon512.some(i => i.purpose === 'any') && icon512.some(i => i.purpose === 'maskable') && iconsOk,
      `install errors ${JSON.stringify(inst.installabilityErrors)}; manifest ${am.url ? am.url.replace(base, '/') : 'none'} (${mtype}); start ${man.start_url} in scope ${inScope}; icons ok ${iconsOk}`);

    // desktop budget + brightness at the first tour pose (compared with ?quest=1 at the end)
    const deskPerf = await page.evaluate(() => { window.__tourAt(0); return { ...window.__perf(), lum: window.__lum() }; });
    console.log('INFO desktop profile ' + JSON.stringify({ calls: deskPerf.calls, triangles: deskPerf.triangles, texMB: deskPerf.texMB, lights: deskPerf.lights, lightmaps: deskPerf.lightmaps, lum: +deskPerf.lum.toFixed(3) }));
    // screens: an idle terminal is not re-uploaded every frame; output on one makes exactly that one dirty again
    await sleep(1500); const p0 = await page.evaluate(() => window.__live.paints()); await sleep(2000); const p1 = await page.evaluate(() => window.__live.paints());
    spawnSync(TMUX, ['-L', SOCK, 'send-keys', '-t', 'desk-0', 'echo omo-dirty-' + process.pid, 'Enter']); await sleep(1500);
    const p2 = await page.evaluate(() => window.__live.paints());
    check('desk screens upload a new texture only when a terminal changes (idle 2 s: none; new output: some)', p1 === p0 && p2 > p1, `uploads idle ${p1 - p0}, after output ${p2 - p1}`);

    // ================================================================ step 8: FREE SCREENS (desktop view)
    const has = (id) => spawnSync(TMUX, ['-L', SOCK, 'has-session', '-t', '=' + id]).status === 0;
    const capOf = (id) => (spawnSync(TMUX, ['-L', SOCK, 'capture-pane', '-p', '-t', '=' + id + ':'], { encoding: 'utf8' }).stdout || '').split('\n').map(l => l.trim());
    const scr = (pg, id) => pg.evaluate((id) => window.__live.screens().find(s => s.id === id) || null, id);
    const fileLayout = () => { try { return JSON.parse(fs.readFileSync(LAYOUT, 'utf8')); } catch { return null; } };
    const sc0 = await page.evaluate(() => window.__live.screens());
    const fl0 = fileLayout();
    check('free screens: first start makes 3 terminal screens + 2 web screens as free objects (not part of the room) and saves the layout on the server',
      sc0.filter(s => s.kind === 'term').length === 3 && sc0.filter(s => s.kind === 'web').length === 2 && sc0.every(s => s.inScene && !s.inRoom) && fl0 && fl0.screens.length === 5,
      `${sc0.map(s => `${s.id}:${s.kind}`).join(' ')}; on server ${fl0 ? fl0.screens.length : 'none'}`);
    // + Terminal: a new screen in front of the camera, its own tmux session made on demand, and it takes the keyboard
    await page.evaluate(() => window.__setPose({ x: 4.0, z: -2.5, yaw: 0, pitch: 0 }));
    await page.click('#omo-add-term');
    let newT = null; for (let i = 0; i < 60 && !newT; i++) { await sleep(100); newT = await page.evaluate(() => { const s = window.__live.screens().find(s => s.kind === 'term' && s.id.startsWith('s-') && s.status === 'live'); return s || null; }); }
    const mk = 'omo-free-' + process.pid;
    if (newT) { await page.keyboard.type(`echo ${mk}`); await page.keyboard.press('Enter'); for (let i = 0; i < 40 && !capOf(newT.id).includes(mk); i++) await sleep(100); }
    const leak = ['desk-0', 'desk-1', 'desk-2'].some(d => capOf(d).includes(mk));
    check('free screens: "+ Terminal" makes a new screen in front of you with its own new terminal session; typing goes only there',
      !!newT && has(newT.id) && capOf(newT.id).includes(mk) && !leak && (await page.evaluate(() => window.__live.focus())) === 'term:' + (newT && newT.id),
      newT ? `${newT.id} at ${newT.pos.map(v => v.toFixed(2))}, session ${has(newT.id)}, echoed ${capOf(newT.id).includes(mk)}, leak ${leak}` : 'no new terminal screen');
    await page.keyboard.press('Escape');
    // drag the bar with the mouse: the screen follows the pointer and turns to face you
    const T1 = newT ? newT.id : 'desk-0';
    const b0 = await page.evaluate((id) => window.__live.partPoint(id, 'bar'), T1), s0 = await scr(page, T1);
    await page.mouse.move(b0.x, b0.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(b0.x + 20 * i, b0.y + 4 * i); await sleep(30); }
    await page.mouse.up(); await sleep(300);
    const s1 = await scr(page, T1), b1 = await page.evaluate((id) => window.__live.partPoint(id, 'bar'), T1);
    const camP = await page.evaluate(() => window.__live.cameraPos());
    const faceErr = Math.abs(Math.atan2(Math.sin(s1.rotY - Math.atan2(camP[0] - s1.pos[0], camP[2] - s1.pos[2])), Math.cos(s1.rotY - Math.atan2(camP[0] - s1.pos[0], camP[2] - s1.pos[2]))));
    const follow = Math.hypot(b1.x - (b0.x + 160), b1.y - (b0.y + 32));
    check('free screens: dragging a screen\'s bar with the mouse moves it with the pointer, and it turns to face you',
      Math.hypot(s1.pos[0] - s0.pos[0], s1.pos[2] - s0.pos[2]) > 0.2 && follow < 12 && faceErr < 0.02,
      `moved ${Math.hypot(s1.pos[0] - s0.pos[0], s1.pos[2] - s0.pos[2]).toFixed(2)} m; bar ${follow.toFixed(1)} px from the pointer; facing error ${faceErr.toFixed(3)} rad`);
    // snap: let go 0.35 m from the west wall -> it lies flat on the wall; let go in the open -> it floats
    await page.evaluate((id) => { window.__live.moveScreen(id, [0.45, 1.6, -3.4], Math.PI / 2 - 0.35); window.__setPose({ x: 3.2, z: -3.4, yaw: 90, pitch: 0 }); }, T1); await sleep(300);
    const b2 = await page.evaluate((id) => window.__live.partPoint(id, 'bar'), T1);
    await page.mouse.move(b2.x, b2.y); await page.mouse.down(); await page.mouse.move(b2.x + 3, b2.y, { steps: 2 }); await page.mouse.up(); await sleep(300);
    const snapW = await page.evaluate(() => window.__live.lastDrag()), sW = await scr(page, T1);
    await page.evaluate((id) => { window.__live.moveScreen(id, [5.0, 1.5, -2.6], 0); window.__setPose({ x: 5.0, z: -0.9, yaw: 0, pitch: 0 }); }, T1); await sleep(300);
    const b3 = await page.evaluate((id) => window.__live.partPoint(id, 'bar'), T1);
    await page.mouse.move(b3.x, b3.y); await page.mouse.down(); await page.mouse.move(b3.x + 3, b3.y, { steps: 2 }); await page.mouse.up(); await sleep(300);
    const snapF = await page.evaluate(() => window.__live.lastDrag()), sF = await scr(page, T1);
    const sw0 = snapW && snapW.snap;
    check('free screens: let go near a wall and the screen snaps flat on it (3 cm off, square to the wall); let go in the open and it floats',
      sw0 && sw0.anchor === 'wall' && Math.abs(sw0.gap - 0.03) < 0.01 && Math.abs(Math.cos(sW.rotY) * sw0.normal[2] + Math.sin(sW.rotY) * sw0.normal[0] - 1) < 1e-3 && sW.anchor === 'wall' && snapF.snap.anchor === 'float' && sF.anchor === 'float',
      `wall: ${JSON.stringify(sw0)}; open room: ${JSON.stringify(snapF && snapF.snap)}`);
    // corner handle: drag outward -> bigger; a terminal keeps its 80x24 shape
    const k0 = await scr(page, T1), c0 = await page.evaluate((id) => window.__live.partPoint(id, 'corner'), T1);
    await page.mouse.move(c0.x, c0.y); await page.mouse.down(); for (let i = 1; i <= 6; i++) { await page.mouse.move(c0.x + 12 * i, c0.y + 8 * i); await sleep(30); } await page.mouse.up(); await sleep(300);
    const k1 = await scr(page, T1);
    check('free screens: dragging the corner handle resizes the screen, and a terminal keeps its shape',
      k1.w > k0.w * 1.15 && Math.abs(k1.h / k1.w - k0.h / k0.w) < 1e-3, `w ${k0.w.toFixed(2)} -> ${k1.w.toFixed(2)} m, h/w ${(k0.h / k0.w).toFixed(4)} -> ${(k1.h / k1.w).toFixed(4)}`);
    // + Web page: a web screen that really loads a page
    await page.evaluate(() => window.__setPose({ x: 4.0, z: -2.5, yaw: 0, pitch: 0 }));
    await page.click('#omo-add-web');
    let newW = null; for (let i = 0; i < 80; i++) { await sleep(100); newW = await page.evaluate(() => { const s = window.__live.screens().find(s => s.kind === 'web' && s.id.startsWith('w-')); return s ? { ...s, st: window.__live.walls()[s.id] } : null; }); if (newW && newW.st.state === 'loaded') break; }
    await page.keyboard.press('Escape');
    check('free screens: "+ Web page" makes a web screen that loads a page', !!newW && newW.st.state === 'loaded', JSON.stringify(newW && { id: newW.id, st: newW.st }));
    // close (x): the screen goes and its terminal session ends; the web screen goes too
    await page.evaluate((id) => { window.__live.moveScreen(id, [4.0, 1.5, -3.6], 0); }, T1); await sleep(300);
    const x1 = await page.evaluate((id) => window.__live.partPoint(id, 'close'), T1);
    await page.mouse.click(x1.x, x1.y); await sleep(800);
    const xw = newW ? await page.evaluate((id) => window.__live.partPoint(id, 'close'), newW.id) : null;
    if (xw) { await page.mouse.click(xw.x, xw.y); await sleep(600); }
    const afterClose = await page.evaluate(() => window.__live.screens().map(s => s.id));
    check('free screens: the x on the bar closes a screen; a closed terminal\'s session is ended on the server',
      !afterClose.includes(T1) && !has(T1) && newW && !afterClose.includes(newW.id), `left: ${afterClose.join(' ')}; session ${T1} alive ${has(T1)}`);
    // persistence: move + resize one screen, make one more, then a fresh page restores exactly that layout from the server
    const keepT = await page.evaluate(() => window.__live.createScreen('term', { pos: [6.0, 1.7, -3.2], rotY: 0.4, w: 1.4 }));
    await page.evaluate(() => { window.__live.moveScreen('west', [0.12, 1.7, -7.0], Math.PI / 2); window.__live.resizeScreen('west', 2.4, 1.4); return window.__live.save(); });
    for (let i = 0; i < 40 && !has(keepT); i++) await sleep(100);
    const before = (await page.evaluate(() => window.__live.screens())).map(s => ({ id: s.id, kind: s.kind, pos: s.pos.map(v => +v.toFixed(3)), w: +s.w.toFixed(3), h: +s.h.toFixed(3), anchor: s.anchor })).sort((a, b) => a.id < b.id ? -1 : 1);
    const rp = await browser.newPage();
    rp.on('pageerror', e => errors.push('reload: ' + String(e.message || e)));
    await rp.goto(`http://127.0.0.1:${PORT}/?live=${token}`, { waitUntil: 'domcontentloaded' });
    await rp.waitForFunction(() => window.__ready === true && window.__live && window.__live.ready, { timeout: 240000 });
    const after = (await rp.evaluate(() => window.__live.screens())).map(s => ({ id: s.id, kind: s.kind, pos: s.pos.map(v => +v.toFixed(3)), w: +s.w.toFixed(3), h: +s.h.toFixed(3), anchor: s.anchor })).sort((a, b) => a.id < b.id ? -1 : 1);
    const restored = await rp.evaluate(() => [window.__live.restored(), window.__live.desks().every(d => d.status === 'live')]);
    await rp.close();
    check('free screens: the layout (every screen, place, size, wall or float) is kept on the server and comes back exactly on reload',
      JSON.stringify(before) === JSON.stringify(after) && restored[0] === before.length && restored[1] && before.some(s => s.id === keepT),
      `${before.length} screens before, ${after.length} after, restored ${restored[0]}, terminals live ${restored[1]}${JSON.stringify(before) === JSON.stringify(after) ? '' : ' DIFF ' + JSON.stringify(after).slice(0, 300)}`);
    // the layout + session endpoints keep their guard: token needed, bad layouts refused, odd session names refused
    const gA = (await fetch(`http://127.0.0.1:${PORT}/live/api/layout`)).status;
    const gB = (await fetch(`http://127.0.0.1:${PORT}/live/api/layout`, { method: 'PUT', headers: { 'x-live-token': token }, body: JSON.stringify({ screens: [{ id: '../x', kind: 'term', pos: [0, 0, 0], rotY: 0, w: 1, h: 1 }] }) })).status;
    const gC = (await fetch(`http://127.0.0.1:${PORT}/live/api/close?id=${encodeURIComponent('desk-0;x')}`, { method: 'POST', headers: { 'x-live-token': token } })).status;
    const gD = await new Promise(r => { const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live/ws?desk=evil&token=${token}`); ws.onopen = () => { ws.close(); r('open'); }; ws.onerror = () => r('refused'); });   // from node: no page console noise
    const fl1 = fileLayout();
    check('free screens: the layout and session endpoints need the token, refuse bad layouts and odd session names',
      gA === 401 && gB === 400 && gC === 400 && gD === 'refused' && fl1 && fl1.screens.length === before.length, `no token ${gA}; bad layout ${gB}; bad close ${gC}; bad session ${gD}; file still ${fl1 && fl1.screens.length}`);
    await page.evaluate(() => window.__tourAt(0));

    // enter through the real button (a user gesture, as on the headset)
    await page.click('#omo-enter-vr');
    await page.waitForFunction(() => window.__xr.presenting && window.__xr.frames > 30, { timeout: 30000 });
    check('a real immersive-vr session starts from the button', true);
    await page.waitForFunction(() => window.__xr.loading === false, { timeout: 15000 }).catch(() => {});
    const ld = await page.evaluate(() => ({ loading: window.__xr.loading, frames: window.__xr.loadingFrames, ms: window.__xr.loadMs, text: window.__xr.loadText }));
    check('a loading card is drawn inside the headset first, then the room (at most 8 s)', ld.loading === false && ld.frames > 0 && ld.ms <= 8500, JSON.stringify(ld));
    const cssHidden = await page.evaluate(() => getComputedStyle(window.__live.cssRoot).display === 'none');
    check('DOM web-wall layer is hidden inside the headset', cssHidden);

    // controllers connect as input sources
    await page.evaluate(() => { const d = window.__xrDevice; d.controllers.left.connected = true; d.controllers.right.connected = true; });
    await sleep(500);
    // ---- walk: left stick forward for 1.5 s. The head looks down -Z at the start yaw, so the feet must move.
    // speed is measured on the page clock between two samples taken WHILE the stick is held (host load cannot skew it)
    await page.evaluate(() => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1));
    await sleep(400);
    const a = await page.evaluate(() => ({ p: window.__xr.feet(), t: performance.now() }));
    let vmax = 0, vigMax = 0; for (let i = 0; i < 8; i++) { await sleep(100); const s = await page.evaluate(() => [window.__xr.vel(), window.__xr.vignetteShown()]); vmax = Math.max(vmax, s[0]); vigMax = Math.max(vigMax, s[1] || 0); }
    const b = await page.evaluate(() => ({ p: window.__xr.feet(), t: performance.now() })); b.v = vmax;
    await page.evaluate(() => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0));
    await sleep(300);
    const speed = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]) / ((b.t - a.t) / 1000);
    await sleep(500); const vigStill = await page.evaluate(() => window.__xr.vignetteShown());
    check('comfort vignette dims the edges while walking and clears when you stop', vigMax > 0.5 && !vigStill, `while walking ${vigMax.toFixed(2)}, standing ${vigStill}`);
    console.log('INFO walker speeds in session: ' + JSON.stringify(await page.evaluate(() => window.__xr.speeds())));
    check('left stick walks at a comfortable VR pace (2 m/s body speed)', Math.abs(b.v - 2.0) < 0.1 && speed > 1.0, `peak body ${b.v.toFixed(2)} m/s; ${speed.toFixed(2)} m/s over the page clock (the emulator frame clock is not wall time)`);
    await page.evaluate(() => { const c = window.__xrDevice.controllers.left; c.updateButtonValue('thumbstick', 1); c.updateAxes('thumbstick', 0, -1); });
    await sleep(300);
    const c1 = await page.evaluate(() => ({ p: window.__xr.feet(), t: performance.now() }));
    // sample up to 1.5 s: the emulator frame clock lags wall time under host load, so top speed can take longer to reach
    let rmax = 0; for (let i = 0; i < 15 && rmax < 3.5; i++) { await sleep(100); rmax = Math.max(rmax, await page.evaluate(() => window.__xr.vel())); }
    const c2 = await page.evaluate(() => ({ p: window.__xr.feet(), t: performance.now() })); c2.v = rmax;
    await page.evaluate(() => { const c = window.__xrDevice.controllers.left; c.updateButtonValue('thumbstick', 0); c.updateAxes('thumbstick', 0, 0); });
    await sleep(300);
    const run = Math.hypot(c2.p[0] - c1.p[0], c2.p[2] - c1.p[2]) / ((c2.t - c1.t) / 1000);
    check('clicking the left stick in runs faster (3.6 m/s body speed)', Math.abs(c2.v - 3.6) < 0.3, `peak body ${c2.v.toFixed(2)} m/s`);

    // ---- collision: walk 8 s straight at the north glass (yaw 0 at spawn was -0.5 rad; aim the head north first)
    await page.evaluate(() => { const d = window.__xrDevice; d.quaternion.set(0, 0, 0, 1); });
    await page.evaluate(() => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1));
    await sleep(7000);
    await page.evaluate(() => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0));
    await sleep(300);
    const feet2 = await page.evaluate(() => window.__xr.feet());
    check('the glass wall stops the player (no walking through it)', feet2[2] > -11.96, `z=${feet2[2].toFixed(2)} (glass at -11.96)`);

    // ---- snap turn
    const turns0 = await page.evaluate(() => window.__xr.turns), feetT0 = await page.evaluate(() => window.__xr.feet());
    await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0));
    await sleep(300);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0));
    await sleep(300);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0));
    await sleep(300);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0));
    await sleep(300);
    const turns1 = await page.evaluate(() => window.__xr.turns);
    check('right stick snap-turns once per flick (no smooth turning)', turns1 - turns0 === 2, `${turns1 - turns0} turns for 2 flicks`);
    const feetT1 = await page.evaluate(() => window.__xr.feet()), turnShift = Math.hypot(feetT1[0] - feetT0[0], feetT1[2] - feetT0[2]);
    check('a snap turn turns you on the spot (the body does not jump)', turnShift < 0.15, `feet moved ${turnShift.toFixed(3)} m over 2 turns`);
    // known spot for the pointing checks: the spawn by the window, looking north, rig yaw 0
    const standAt = async (x, z) => { await page.evaluate((x, z) => { window.__xr.setRigYaw(0); window.__xr.setFeet(x, z, 0); const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); }, x, z); await sleep(400); };
    const press = async (side, btn) => { await page.evaluate((s, b) => window.__xrDevice.controllers[s].updateButtonValue(b, 1), side, btn); await sleep(250); await page.evaluate((s, b) => window.__xrDevice.controllers[s].updateButtonValue(b, 0), side, btn); await sleep(250); };
    const walkFor = async (ms) => { const p0 = await page.evaluate(() => window.__xr.feet()); let vig = 0;   // walks back, then returns the player to p0
      await page.evaluate(() => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 1));
      for (let t = 0; t < ms; t += 100) { await sleep(100); vig = Math.max(vig, await page.evaluate(() => window.__xr.vignetteShown()) || 0); }
      await page.evaluate(() => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0)); await sleep(400);
      const p1 = await page.evaluate(() => window.__xr.feet()); await page.evaluate((p) => window.__xr.setFeet(p[0], p[2], p[1]), p0); await sleep(200);
      return { moved: Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), vig }; };

    // ---- Y turns the vignette off (and it stays off while walking), Y again turns it back on; the choice is saved
    await press('left', 'y-button');
    const vOff = await walkFor(900);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('omo-xr-comfort') || '{}'));
    await press('left', 'y-button');
    check('Y switches the comfort vignette off and on, and the choice is saved', vOff.moved > 0.3 && vOff.vig === 0 && saved.vignette === false && await page.evaluate(() => window.__xr.comfort.vignette === true),
      `walked ${vOff.moved.toFixed(2)} m with vignette ${vOff.vig}; saved ${JSON.stringify(saved)}`);

    // ---- teleport-only mode: right stick click; the left stick no longer walks
    await press('right', 'thumbstick');
    const tOnly = await walkFor(900);
    await press('right', 'thumbstick');
    check('teleport-only mode (right stick click) stops stick walking', tOnly.moved < 0.02 && await page.evaluate(() => window.__xr.comfort.teleportOnly === false), `moved ${tOnly.moved.toFixed(3)} m while teleport-only`);

    // ---- point at desk-1 from where we stand and pull the trigger: place the right controller so it aims at the screen
    async function aimAt(id) {
      return page.evaluate((id) => {
        const d = window.__xrDevice, c = window.__live.deskCenter(id);
        const tgt = window.__xr.toRig(c);              // screen centre in headset reference space
        const o = [d.position.x + 0.15, d.position.y - 0.25, d.position.z - 0.2];
        const v = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]], n = Math.hypot(...v), f = v.map(x => x / n);
        // quaternion rotating -Z onto f
        const a = [0, 0, -1], dot = a[0] * f[0] + a[1] * f[1] + a[2] * f[2];
        let ax = [a[1] * f[2] - a[2] * f[1], a[2] * f[0] - a[0] * f[2], a[0] * f[1] - a[1] * f[0]], w = 1 + dot;
        if (w < 1e-6) { ax = [0, 1, 0]; w = 0; }
        const qn = Math.hypot(...ax, w);
        d.controllers.right.position.set(...o); d.controllers.right.quaternion.set(ax[0] / qn, ax[1] / qn, ax[2] / qn, w / qn);
        return { dist: n };
      }, id);
    }
    async function trigger(side = 'right') {
      await page.evaluate((s) => window.__xrDevice.controllers[s].updateButtonValue('trigger', 1), side); await sleep(250);
      await page.evaluate((s) => window.__xrDevice.controllers[s].updateButtonValue('trigger', 0), side); await sleep(250);
    }
    await standAt(3.0, -1.6);
    const aim = await aimAt('desk-1'); await sleep(300);
    console.log('INFO pointer hit before trigger: ' + JSON.stringify(await page.evaluate(() => ({ hit: window.__xr.lastHit, feet: window.__xr.feet(), desk: window.__live.deskCenter('desk-1') }))));
    const rays = await page.evaluate(() => window.__xr.rays());
    check('pointer beam is a solid 3-6 mm tube that reaches the screen (not a 1-pixel line)', rays.some(r => r.mesh && r.visible && r.widthMm >= 5 && Math.abs(r.len - aim.dist) < 0.6), JSON.stringify(rays) + ` aim ${aim.dist.toFixed(2)} m`);
    await trigger();
    const f1 = await page.evaluate(() => ({ xr: window.__xr.focus, live: window.__live.focus(), panel: window.__xr.panel }));
    check('pointing at Desk 2 and pulling the trigger makes it the typing target', f1.xr === 'term:desk-1' && f1.live === 'term:desk-1', `${JSON.stringify(f1)} from ${aim.dist.toFixed(1)} m`);
    check('the active terminal comes up as a close readable panel', f1.panel === true);
    const wt = await page.evaluate(() => window.__xr.wristText());
    check('the wrist hint shows the whole text (nothing cut off)', wt.fits === true && /A: release$/.test(wt.text), JSON.stringify(wt));
    await sleep(1200); await page.screenshot({ path: path.join(OUT, 'xr-panel.png') });
    const pv = await page.evaluate(() => window.__xr.panelView());
    console.log('INFO panel view ' + JSON.stringify(pv));
    check('the panel is really in front of the eyes (centre of view, 0.8-1.6 m, facing the viewer, showing the terminal)',
      pv.visible && pv.map && Math.abs(pv.ndc[0]) < 0.5 && Math.abs(pv.ndc[1]) < 0.6 && pv.ndc[2] < 1 && pv.dist > 0.8 && pv.dist < 1.6 && pv.facing > 0.8,
      `ndc ${pv.ndc.map(v => v.toFixed(2))} dist ${pv.dist.toFixed(2)} facing ${pv.facing.toFixed(2)}`);
    const ps = await page.evaluate(() => window.__xr.panelSize());
    const rowDeg = 2 * Math.atan((ps[1] / 24) / 2 / pv.dist) * 180 / Math.PI;
    check('panel text is large: one terminal row is at least 2 degrees tall', rowDeg >= 2.0, `panel ${ps.map(v => v.toFixed(2))} m at ${pv.dist.toFixed(2)} m -> ${rowDeg.toFixed(2)} deg per row`);

    // ---- grip on the panel grabs it; moving the hand 0.3 m right carries it; letting go leaves it there
    const g0 = await page.evaluate(() => {
      const d = window.__xrDevice, c = window.__xr.panelView().at, tgt = window.__xr.toRig(c);
      const o = [d.position.x + 0.15, d.position.y - 0.25, d.position.z - 0.2];
      const v = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]], m = Math.hypot(...v), u = v.map(x => x / m);
      const a = [0, 0, -1], dot = -u[2]; let ax = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]], w = 1 + dot; const qn = Math.hypot(...ax, w);
      d.controllers.right.position.set(...o); d.controllers.right.quaternion.set(ax[0] / qn, ax[1] / qn, ax[2] / qn, w / qn);
      return { at: c, o };
    });
    await sleep(300);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 1)); await sleep(300);
    const grabbing = await page.evaluate(() => window.__xr.grabbing);
    await page.evaluate((o) => window.__xrDevice.controllers.right.position.set(o[0] + 0.3, o[1], o[2]), g0.o); await sleep(400);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 0)); await sleep(300);
    await page.evaluate((o) => window.__xrDevice.controllers.right.position.set(o[0] - 0.3, o[1], o[2]), g0.o); await sleep(400);
    const g1 = await page.evaluate(() => { const v = window.__xr.panelView(); return { at: v.at, upright: v.upright, facing: v.facing, grabbing: window.__xr.grabbing, focus: window.__xr.focus }; });
    const moved = Math.hypot(g1.at[0] - g0.at[0], g1.at[1] - g0.at[1], g1.at[2] - g0.at[2]);
    check('grip grabs the panel, carries it with the hand, and leaves it where you let go', grabbing && !g1.grabbing && Math.abs(moved - 0.3) < 0.08 && g1.focus === 'term:desk-1',
      `grabbed ${grabbing}; panel moved ${moved.toFixed(3)} m for a 0.3 m hand move, then stayed`);
    check('a moved panel stays upright and turns to face you', g1.upright > 0.999 && g1.facing > 0.98, `up.y ${g1.upright.toFixed(4)}, facing ${g1.facing.toFixed(3)}`);

    // ---- typing: Bluetooth keyboard (real key events) and system keyboard (input events) both reach tmux
    const m1 = 'omo-xr-bt-' + process.pid, m2 = 'omo-xr-sys-' + process.pid;
    await page.keyboard.type(`echo ${m1}`); await page.keyboard.press('Enter');
    const paneLines = (d) => spawnSync(TMUX, ['-L', SOCK, 'capture-pane', '-p', '-t', d], { encoding: 'utf8' }).stdout.split('\n').map(l => l.trim());
    for (let i = 0; i < 40 && !paneLines('desk-1').includes(m1); i++) await sleep(100);
    await page.evaluate((m) => { const ta = document.querySelector('#omo-xr-ta'); for (const ch of `echo ${m}`) { ta.value = ch; ta.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText' })); } ta.dispatchEvent(new InputEvent('input', { inputType: 'insertLineBreak' })); }, m2);
    await sleep(1500);
    const cap = spawnSync(TMUX, ['-L', SOCK, 'capture-pane', '-p', '-t', 'desk-1'], { encoding: 'utf8' }).stdout.split('\n').map(l => l.trim());
    check('Bluetooth-keyboard typing runs in the Desk 2 tmux session', cap.includes(m1), `capture has echoed line: ${cap.includes(m1)}`);
    check('Quest system-keyboard text runs in the Desk 2 tmux session', cap.includes(m2), `capture has echoed line: ${cap.includes(m2)}`);
    const other = spawnSync(TMUX, ['-L', SOCK, 'capture-pane', '-p', '-t', 'desk-0'], { encoding: 'utf8' }).stdout;
    check('nothing typed leaks into Desk 1', !other.includes(m1) && !other.includes(m2));

    // ---- B sends the panel back, A releases; walking is blocked while typing? (stick still walks; keys go to the terminal)
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('b-button', 1)); await sleep(250);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('b-button', 0)); await sleep(250);
    check('B sends the panel back to the desk', await page.evaluate(() => window.__xr.panel === false && window.__xr.focus === 'term:desk-1'));
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('a-button', 1)); await sleep(250);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('a-button', 0)); await sleep(250);
    const rel = await page.evaluate(() => ({ xr: window.__xr.focus, live: window.__live.focus() }));
    check('A releases the terminal', rel.xr === null && rel.live === null, JSON.stringify(rel));
    const m3 = 'omo-xr-after-' + process.pid;
    await page.keyboard.type(`echo ${m3}`); await page.keyboard.press('Enter'); await sleep(800);
    const all = ['desk-0', 'desk-1', 'desk-2'].map(d => spawnSync(TMUX, ['-L', SOCK, 'capture-pane', '-p', '-t', d], { encoding: 'utf8' }).stdout).join('\n');
    check('after release, keys no longer reach any terminal', !all.includes(m3));

    // ---- hand tracking: put the controllers down, point the right hand at Desk 3 and pinch
    await standAt(3.0, -1.6);
    await page.evaluate(() => { window.__xrDevice.primaryInputMode = 'hand'; }); await sleep(600);
    const hp = await page.evaluate(() => {
      const d = window.__xrDevice, h = d.hands.right, c = window.__live.deskCenter('desk-2'), tgt = window.__xr.toRig(c);
      const o = [d.position.x + 0.15, d.position.y - 0.25, d.position.z - 0.2];
      const v = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]], m = Math.hypot(...v), u = v.map(x => x / m);
      const a = [0, 0, -1], dot = -u[2]; let ax = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]], w = 1 + dot; const qn = Math.hypot(...ax, w);
      h.position.set(...o); h.quaternion.set(ax[0] / qn, ax[1] / qn, ax[2] / qn, w / qn);
      return { dist: m };
    });
    await sleep(400);
    console.log('INFO hand pointer hit: ' + JSON.stringify(await page.evaluate(() => ({ hit: window.__xr.lastHit, src: window.__xr.inputs(), dolly: window.__xr.dollyPos() }))));
    await page.evaluate(() => window.__xrDevice.hands.right.updatePinchValue(1)); await sleep(400);
    await page.evaluate(() => window.__xrDevice.hands.right.updatePinchValue(0)); await sleep(400);
    const hf = await page.evaluate(() => ({ xr: window.__xr.focus, live: window.__live.focus(), hand: !!(navigator.xr && window.__xrDevice.primaryInputMode === 'hand') }));
    check('hand tracking: pointing at Desk 3 and pinching makes it the typing target', hf.xr === 'term:desk-2' && hf.live === 'term:desk-2', `${JSON.stringify(hf)} from ${hp.dist.toFixed(1)} m`);
    await page.evaluate(() => window.__xrDevice.hands.right.updatePinchValue(1)); await sleep(400);
    await page.evaluate(() => window.__xrDevice.hands.right.updatePinchValue(0)); await sleep(400);
    await page.evaluate(() => { window.__xrDevice.primaryInputMode = 'controller'; }); await sleep(400);

    // ================================================================ step 8: FREE SCREENS in the headset
    await standAt(3.0, -1.6);
    await page.evaluate(() => { const d = window.__xrDevice; d.controllers.left.position.set(-0.2, 1.3, -0.35); d.controllers.left.quaternion.set(0, 0, 0, 1); });
    const aimWorld = async (w, dy = 0) => page.evaluate((w, dy) => {
      const d = window.__xrDevice, tgt = window.__xr.toRig(w), o = [d.position.x + 0.15, d.position.y - 0.25 + dy, d.position.z - 0.2];
      const v = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]], m = Math.hypot(...v), u = v.map(x => x / m);
      const a = [0, 0, -1], dot = -u[2]; let ax = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]], ww = 1 + dot; const qn = Math.hypot(...ax, ww);
      d.controllers.right.position.set(...o); d.controllers.right.quaternion.set(ax[0] / qn, ax[1] / qn, ax[2] / qn, ww / qn);
      return { o, dist: m };
    }, w, dy);
    // wrist "+ Terminal": point at it with the right hand and pull -> a new terminal screen in front of you, typing target
    await sleep(300);
    const addW = await page.evaluate(() => window.__xr.addButtonWorld());
    if (addW) await aimWorld(addW); await sleep(300);
    const addHit = await page.evaluate(() => window.__xr.lastHit);
    await trigger(); await sleep(600);
    const xNew = await page.evaluate(() => ({ focus: window.__xr.focus, created: window.__xr.created, screens: window.__live.screens() }));
    const xT = xNew.focus && xNew.focus.slice(5), xS = xNew.screens.find(s => s.id === xT);
    for (let i = 0; i < 40 && xT && !has(xT); i++) await sleep(100);
    const eyeX = await page.evaluate(() => window.__xr.eye());
    check('headset: pointing at "+ Terminal" on the left wrist and pulling makes a new terminal screen in front of you, ready to type',
      !!addW && xNew.created === 1 && xS && xS.kind === 'term' && has(xT) && Math.hypot(xS.pos[0] - eyeX[0], xS.pos[2] - eyeX[2]) < 1.6,
      `button at ${addW && addW.map(v => v.toFixed(2))}, hit ${JSON.stringify(addHit)}; new ${xT} at ${xS && xS.pos.map(v => v.toFixed(2))}, session ${xT && has(xT)}`);
    // a new screen opens without the big panel: you work with the screen itself
    // trigger on the bar: hold, move the hand 0.4 m right, let go -> the screen went with the hand and faces you
    const xb0 = await page.evaluate((id) => window.__live.partWorld(id, 'bar'), xT);
    const xa = await aimWorld(xb0); await sleep(300);
    const xs0 = await scr(page, xT);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 1)); await sleep(300);
    const xg = await page.evaluate(() => window.__xr.screenGrabbing);
    await page.evaluate((o) => window.__xrDevice.controllers.right.position.set(o[0] + 0.4, o[1], o[2]), xa.o); await sleep(400);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 0)); await sleep(400);
    const xs1 = await scr(page, xT), eyeM = await page.evaluate(() => window.__xr.eye());
    const xMoved = Math.hypot(xs1.pos[0] - xs0.pos[0], xs1.pos[2] - xs0.pos[2]);
    const xFace = Math.abs(Math.atan2(Math.sin(xs1.rotY - Math.atan2(eyeM[0] - xs1.pos[0], eyeM[2] - xs1.pos[2])), Math.cos(xs1.rotY - Math.atan2(eyeM[0] - xs1.pos[0], eyeM[2] - xs1.pos[2]))));
    check('headset: trigger on a screen\'s bar picks it up; it moves with the hand, faces you, and stays where you let go',
      xg === 'move' && xMoved > 0.3 && xFace < 0.05 && (await page.evaluate(() => window.__xr.screenGrabbing)) === null, `grab ${xg}; moved ${xMoved.toFixed(2)} m for a 0.4 m hand move; facing error ${xFace.toFixed(3)} rad`);
    // grip anywhere on a screen also carries it (pinch-and-hold with hands uses the trigger path above)
    const xf0 = await page.evaluate((id) => window.__live.deskCenter(id), xT);
    const xa2 = await aimWorld(xf0); await sleep(300);
    const xs2 = await scr(page, xT);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 1)); await sleep(300);
    const xg2 = await page.evaluate(() => window.__xr.screenGrabbing);
    await page.evaluate((o) => window.__xrDevice.controllers.right.position.set(o[0], o[1] + 0.25, o[2]), xa2.o); await sleep(400);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 0)); await sleep(400);
    const xs3 = await scr(page, xT);
    check('headset: grip on a screen grabs it and carries it (up 0.25 m here)', xg2 === 'move' && xs3.pos[1] - xs2.pos[1] > 0.15, `grab ${xg2}; height ${xs2.pos[1].toFixed(2)} -> ${xs3.pos[1].toFixed(2)} m`);
    // trigger on the corner: hold and move the hand out -> bigger, same shape
    const xc0 = await page.evaluate((id) => window.__live.partWorld(id, 'corner'), xT);
    const xa3 = await aimWorld(xc0); await sleep(300);
    const xk0 = await scr(page, xT); const cornerHit = await page.evaluate(() => window.__xr.lastHit);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 1)); await sleep(300);
    const xg3 = await page.evaluate(() => window.__xr.screenGrabbing);
    await page.evaluate((o) => window.__xrDevice.controllers.right.position.set(o[0] + 0.2, o[1] - 0.1, o[2]), xa3.o); await sleep(400);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 0)); await sleep(400);
    const xk1 = await scr(page, xT);
    check('headset: trigger on the corner handle resizes the screen; a terminal keeps its shape',
      xg3 === 'size' && xk1.w > xk0.w * 1.15 && Math.abs(xk1.h / xk1.w - xk0.h / xk0.w) < 1e-3, `grab ${xg3} (hit ${cornerHit && cornerHit.part}); w ${xk0.w.toFixed(2)} -> ${xk1.w.toFixed(2)} m`);
    // trigger on the x: the screen and its terminal session are gone
    const xx = await page.evaluate((id) => window.__live.partWorld(id, 'close'), xT);
    await aimWorld(xx); await sleep(300);
    const closeHit = await page.evaluate(() => window.__xr.lastHit);
    await trigger(); await sleep(800);
    const xLeft = await page.evaluate(() => window.__live.screens().map(s => s.id));
    check('headset: trigger on the x closes the screen and ends its terminal session', !xLeft.includes(xT) && !has(xT) && (await page.evaluate(() => window.__xr.focus)) !== 'term:' + xT,
      `hit ${closeHit && closeHit.part}; left ${xLeft.join(' ')}; session alive ${has(xT)}`);

    // ---- teleport (done last: it moves the player behind the desks): aim the right controller at the floor 2.5 m back toward the spawn, push the stick forward, let go
    await standAt(6.0, -2.5);
    const tp = await page.evaluate(() => {
      const f = window.__xr.feet(), sx = 3.0, sz = -1.6, dx = sx - f[0], dz = sz - f[2], n = Math.hypot(dx, dz);
      const tgtW = [f[0] + dx / n * 2.5, f[1], f[2] + dz / n * 2.5], tgt = window.__xr.toRig(tgtW);
      const d = window.__xrDevice, o = [d.position.x + 0.15, d.position.y - 0.3, d.position.z - 0.1];
      const v = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]], m = Math.hypot(...v), u = v.map(x => x / m);
      const a = [0, 0, -1], dot = -u[2]; let ax = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]], w = 1 + dot; const qn = Math.hypot(...ax, w);
      d.controllers.right.position.set(...o); d.controllers.right.quaternion.set(ax[0] / qn, ax[1] / qn, ax[2] / qn, w / qn);
      return { from: f, to: tgtW };
    });
    const tp0 = await page.evaluate(() => window.__xr.teleports);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, -1)); await sleep(500);
    const aimT = await page.evaluate(() => window.__xr.teleportAim);
    await page.evaluate(() => window.__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0)); await sleep(500);
    const tpF = await page.evaluate(() => ({ feet: window.__xr.feet(), n: window.__xr.teleports }));
    const tpErr = Math.hypot(tpF.feet[0] - tp.to[0], tpF.feet[2] - tp.to[2]);
    check('teleport: aim at the floor with the right stick, let go, and you are there', aimT && aimT.valid && tpF.n === tp0 + 1 && tpErr < 0.6,
      `aim ${JSON.stringify(aimT)}; landed ${tpF.feet.map(v => Number(v).toFixed(2))} target ${tp.to.map(v => v.toFixed(2))} (off by ${tpErr.toFixed(2)} m)`);

    // ---- seated mode: a seated head (1.10 m) is lifted to a standing eye height (1.65 m) by X; X again removes the lift
    await page.evaluate(() => window.__xrDevice.position.set(0, 1.10, 0)); await sleep(300);
    await press('left', 'x-button'); await sleep(200);
    const seatOn = await page.evaluate(() => ({ eye: window.__xr.eye(), feet: window.__xr.feet(), lift: window.__xr.seatedLift }));
    await press('left', 'x-button'); await sleep(200);
    const seatOff = await page.evaluate(() => ({ eye: window.__xr.eye(), feet: window.__xr.feet() }));
    await page.evaluate(() => window.__xrDevice.position.set(0, 1.6, 0)); await sleep(300);
    const hOn = seatOn.eye[1] - seatOn.feet[1], hOff = seatOff.eye[1] - seatOff.feet[1];
    check('seated mode (X) lifts a seated head to standing eye height, and X turns it off', Math.abs(hOn - 1.65) < 0.05 && Math.abs(hOff - 1.10) < 0.05,
      `eye above floor: seated mode ${hOn.toFixed(2)} m, off ${hOff.toFixed(2)} m`);

    // ---- frame time (this host renders the scene twice per frame at emulator resolution; Quest numbers must come from the headset)
    const fm = await page.evaluate(() => { const a = window.__xr.frameMs.slice().sort((x, y) => x - y); return { n: a.length, p50: a[a.length >> 1], p95: a[Math.floor(a.length * 0.95)] }; });
    console.log(`INFO xr frame cpu time on this host: p50 ${fm.p50?.toFixed(1)} ms, p95 ${fm.p95?.toFixed(1)} ms over ${fm.n} frames (not a Quest number)`);
    await page.screenshot({ path: path.join(OUT, 'xr-emulator.png') });

    // ---- exit VR restores desktop walking and the web walls
    const hitEl = await page.evaluate(() => { const r = document.querySelector('#omo-enter-vr').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e ? (e.id || e.tagName) : null; });
    console.log('INFO element on top of the Exit button while presenting: ' + hitEl);
    await page.evaluate(() => window.__xr.exit()); await sleep(800);
    const ex = await page.evaluate(() => ({ presenting: window.__xr.presenting, css: getComputedStyle(window.__live.cssRoot).display }));
    check('Exit VR ends the session and brings the web walls back', ex.presenting === false && ex.css !== 'none', JSON.stringify(ex));

    // ---- ?quest=1 budget profile: same room, cheaper to draw; it must still run in the headset
    const qp = await browser.newPage();
    qp.on('pageerror', e => errors.push('quest: ' + String(e.message || e)));
    qp.on('console', m => { if (m.type() === 'error') errors.push('quest console: ' + m.text().slice(0, 200)); });
    await qp.goto(`http://127.0.0.1:${PORT}/?xremu=1&quest=1&live=${token}`, { waitUntil: 'domcontentloaded' });
    await qp.waitForFunction(() => window.__ready === true && window.__live && window.__live.ready, { timeout: 240000 });
    const qPerf = await qp.evaluate(() => { window.__tourAt(0); return { ...window.__perf(), lum: window.__lum() }; });
    console.log('INFO quest profile ' + JSON.stringify({ calls: qPerf.calls, triangles: qPerf.triangles, texMB: qPerf.texMB, lights: qPerf.lights, lightmaps: qPerf.lightmaps, lum: +qPerf.lum.toFixed(3) }));
    const lmMax = Math.max(...qPerf.lightmaps.map(s => Math.max(...s.split('x').map(Number))));
    check('?quest=1 uses half-size lightmaps (max 2048 px), no bloom, no realtime lamps, no MSAA', qPerf.profile === 'quest' && lmMax <= 2048 && qPerf.bloom === false && qPerf.lights === 0 && qPerf.antialias === false,
      `lightmaps ${qPerf.lightmaps.join(' ')}, bloom ${qPerf.bloom}, lights ${qPerf.lights}, msaa ${qPerf.antialias}`);
    check('?quest=1 draws at most 60% of the triangles and holds at most 60% of the texture memory', qPerf.triangles <= 0.6 * deskPerf.triangles && qPerf.texMB <= 0.6 * deskPerf.texMB,
      `triangles ${qPerf.triangles} vs ${deskPerf.triangles}; textures ${qPerf.texMB} MB vs ${deskPerf.texMB} MB`);
    const lumRatio = qPerf.lum / deskPerf.lum;
    check('?quest=1 room looks as bright as the full one (mean brightness within 12%)', Math.abs(lumRatio - 1) <= 0.12, `quest ${qPerf.lum.toFixed(3)} vs desktop ${deskPerf.lum.toFixed(3)} (x${lumRatio.toFixed(2)})`);
    await qp.click('#omo-enter-vr');
    const qxr = await qp.waitForFunction(() => window.__xr.presenting && window.__xr.loading === false && window.__xr.frames > 60, { timeout: 30000 }).then(() => true, () => false);
    const qx = await qp.evaluate(() => ({ presenting: window.__xr.presenting, loadMs: window.__xr.loadMs, frames: window.__xr.frames }));
    await qp.evaluate(() => window.__xr.exit()); await sleep(500); await qp.close();
    check('?quest=1 runs in the headset (session starts, loading card clears, frames keep coming)', qxr, JSON.stringify(qx));
    // ---- service worker (step 6): the second page load is controlled by it; it keeps only the offline page, manifest
    // and an icon. Nothing from /live/ and no URL with the desk token may ever be stored on the headset.
    const swp = await browser.newPage();
    await swp.goto(`http://127.0.0.1:${PORT}/?quest=1&live=${token}`, { waitUntil: 'domcontentloaded' });
    await swp.waitForFunction(() => window.__ready === true && window.__live && window.__live.ready, { timeout: 240000 });
    await sleep(1500);
    const sw = await swp.evaluate(async () => { const urls = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(r.url); return { ctrl: !!navigator.serviceWorker.controller, urls }; });
    await swp.close();
    const privateHit = sw.urls.filter(u => /\/live\/|live=|token/.test(u));
    check('PWA: a service worker runs the app and stores nothing private (no terminal stream, no desk token, offline page only)',
      sw.ctrl && sw.urls.some(u => u.endsWith('/offline.html')) && privateHit.length === 0 && sw.urls.length <= 5,
      `controlled ${sw.ctrl}; cached ${sw.urls.map(u => u.replace(`http://127.0.0.1:${PORT}`, '')).join(' ')}`);
    // ---- installed Quest app: opens straight into VR (no 2D landing page); a normal browser tab waited for the button
    const ap = await browser.newPage();
    ap.on('pageerror', e => errors.push('pwa: ' + String(e.message || e)));
    await ap.evaluateOnNewDocument(() => { window.getDigitalGoodsService = async () => { throw new Error('no billing in the test'); }; });
    await ap.goto(`http://127.0.0.1:${PORT}/?xremu=1&quest=1&source=pwa&live=${token}`, { waitUntil: 'domcontentloaded' });
    await ap.waitForFunction(() => window.__ready === true, { timeout: 240000 });
    const auto = await ap.waitForFunction(() => window.__xr.presenting && window.__xr.loading === false && window.__xr.frames > 30, { timeout: 30000 }).then(() => true, () => false);
    const ax = await ap.evaluate(() => ({ pwa: window.__xr.pwa, auto: window.__xr.autoEnter, presenting: window.__xr.presenting }));
    await ap.evaluate(() => window.__xr.exit && window.__xr.exit()); await sleep(400); await ap.close();
    check('PWA: the installed app opens straight into VR without a click; a normal browser tab waits for Enter VR',
      auto && ax.auto === 'ok' && st.pwa === false && st.presenting === false, `installed ${JSON.stringify(ax)}; browser tab pwa ${st.pwa}, presenting before the click ${st.presenting}`);
    check('no page errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));
    // ---- offline (step 6, last: it stops the desk server): opening the app shows a clear 'needs a connection' page
    const op = await browser.newPage();
    await op.goto(`http://127.0.0.1:${PORT}/offline.html`, { waitUntil: 'load' }); await sleep(800);
    server.kill('SIGTERM'); await sleep(1000);
    await op.goto(`http://127.0.0.1:${PORT}/?quest=1&source=pwa`, { waitUntil: 'load' }).catch(() => {});
    const off = await op.evaluate(() => ({ title: document.title, page: !!document.querySelector('#omo-offline'), text: (document.querySelector('h1') || {}).textContent })).catch(e => ({ err: String(e) }));
    check('PWA: with no connection to the desk server, the app shows a clear "needs a connection" page with Try again', off.page === true && /connection/i.test(off.text || ''), JSON.stringify(off));
  } catch (e) {
    check('test ran to the end', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    await browser.close().catch(() => {}); server.kill('SIGTERM');
    spawnSync(TMUX, ['-L', SOCK, 'kill-server']);
  }
  console.log(`VERDICT ${fail === 0 ? 'GREEN' : 'RED'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
