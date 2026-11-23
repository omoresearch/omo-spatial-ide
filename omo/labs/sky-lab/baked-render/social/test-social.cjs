#!/usr/bin/env node
/*
 * Real-Chrome acceptance test for the social lane (third-person camera, emote wheel, slap/knockdown, seats, speaking ring).
 *   node social/test-social.cjs            (from ~/dev/omo-sky-lab/baked-render)
 * Starts live/server.cjs on port 3702 (social lane port) with an ISOLATED tmux socket dir (never touches the real desk
 * shells), opens the page in headless Chrome with the GPU flags of ../capture.cjs and real CDP keyboard/mouse input:
 *   V toggles third-person, own avatar visible / hidden; mouse-drag orbit + scroll zoom; the camera never passes through a
 *   wall (walker-grid cast AND an independent three.js Raycaster on the room meshes); emote by key 1-5 and by the G wheel;
 *   slap a second local avatar < 1.5 m in front -> 'knocked' 2 s + SLAP! burst, out of range -> nothing; click a seat ring
 *   -> sit (player on the seat), E stands, E sits, W stands; an occupied seat hides its ring; speaking ring radius 2.5 m;
 *   right-click a desk screen in third-person -> forced back to first-person. Screenshots + a ~20 s video in social/out/.
 * Prints PASS/FAIL per check, writes social/out/result.json. Always stops the server and the isolated tmux server.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const NM = '~/dev/omo-skyscraper/omo/node_modules';
const puppeteer = require(NM + '/puppeteer-core');
const { tmuxBin } = require('../live/tmuxbin.cjs');

const LANE = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.env.SOCIAL_PORT || 3702);
const W = 1280, H = 720;
const TMUX = tmuxBin(), SOCK = 'omo-sky-live';
const TMUX_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'omo-social-tmux-'));
const TENV = { ...process.env, TMUX_TMPDIR: TMUX_DIR };
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let server = null, browser = null;
const report = { shots: [], video: null, errors: [] };

function startServer() {
  server = spawn(process.execPath, [path.join(LANE, 'live', 'server.cjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], env: TENV });
  let out = '';
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not print a token in 10 s: ' + out)), 10000);
    server.stdout.on('data', d => { out += d; const m = /token=([0-9a-f]{48})/.exec(out); if (m) { clearTimeout(to); res(m[1]); } });
    server.on('exit', c => { clearTimeout(to); rej(new Error('server exited ' + c + ': ' + out)); });
  });
}

(async () => {
  let page;
  try {
    const token = await startServer();
    browser = await puppeteer.launch({
      executablePath: '/opt/google/chrome/chrome', headless: 'new', defaultViewport: { width: W, height: H },
      args: ['--no-sandbox', `--window-size=${W},${H}`, '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=gl-egl', '--use-gl=angle', '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    page = await browser.newPage();
    page.on('pageerror', e => report.errors.push(String(e.message || e)));
    page.on('console', m => { if (m.type() === 'error') report.errors.push('console: ' + m.text().slice(0, 240)); });
    const cdp = await page.createCDPSession();
    await page.goto(`http://127.0.0.1:${PORT}/?live=${token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 240000 });
    await page.waitForFunction(() => window.__social && window.__social.ready === true, { timeout: 30000 });
    await page.waitForFunction(() => window.__live && window.__live.ready === true, { timeout: 30000 }).catch(() => {});
    await sleep(800);
    const ev = (fn, ...a) => page.evaluate(fn, ...a);
    const S = (expr) => page.evaluate(`window.__social.${expr}`);
    const shot = async (name) => { const p = path.join(OUT, name + '.png'); await page.screenshot({ path: p }); report.shots.push(p); return p; };
    const key = async (code, ms = 60) => { await page.keyboard.down(code); await sleep(ms); await page.keyboard.up(code); };
    const place = (p) => ev((p) => window.__social.placePlayer(p), p);
    const unlock = () => ev(() => document.pointerLockElement && document.exitPointerLock());
    const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

    // ------------------------------------------------------------------ boot facts
    const seats = await S('seats()');
    check('seats found (seat_* anchors, else derived from sofa/chair/stool/lounge props)', seats.length >= 6, `${seats.length} seats, source=${await S('seatSource')}: ${[...new Set(seats.map(s => s.kind))].join(',')}`);
    const sofa = seats.filter(s => s.kind === 'sofa');
    check('sofa gives 2+ seat places, sit height 0.35–0.75 m', sofa.length >= 2 && sofa.every(s => s.y > 0.35 && s.y < 0.75), sofa.map(s => `${s.id}@(${s.x},${s.y},${s.z}) yaw ${s.yaw}`).join(' | '));

    // ------------------------------------------------------------------ (1) third-person toggle
    await place({ x: 13.7, z: -10.55, yaw: yawTo({ x: 13.7, z: -10.55 }, { x: 15.0, z: -7.7 }), pitch: -0.12 });
    await sleep(500);
    let L = await S('local()');
    check('first-person is the default; own avatar hidden', (await S('mode()')) === '1p' && L.visible === false, JSON.stringify(L));
    await shot('01-first-person');
    await key('KeyV'); await sleep(900);
    L = await S('local()'); let V = await S('view()'); let E = await S('eye()');
    const camDist = Math.hypot(V.x - E.x, V.y - E.y, V.z - E.z);
    check('V -> third-person; own avatar visible; camera behind and above', (await S('mode()')) === '3p' && L.visible && camDist > 1.5 && V.y > L.y + 1.4, `mode 3p, visible ${L.visible}, cam ${camDist.toFixed(2)} m from eye, cam y ${V.y} vs feet ${L.y}`);
    const camNow = await S('cameraNow()');
    check('between frames the shared camera stays on the eye (mp/voice/touch read the player, not the orbit cam)', Math.hypot(camNow[0] - E.x, camNow[2] - E.z) < 0.05, `camera ${camNow} eye ${E.x},${E.y},${E.z}`);
    await shot('02-third-person');
    // orbit: mouse drag on the canvas (or pointer-lock movement) + scroll zoom
    await unlock();
    const yaw0 = V.yaw;
    await page.mouse.move(W * 0.5, H * 0.5); await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(W * 0.5 - i * 18, H * 0.5); await sleep(16); }
    await page.mouse.up(); await sleep(500);
    V = await S('view()');
    check('mouse drag orbits the camera around the player', Math.abs(V.yaw - yaw0) > 0.15, `yaw ${yaw0} -> ${V.yaw}`);
    await unlock();
    const d0 = (await S('view()')).want;
    await page.mouse.move(W * 0.5, H * 0.5); await page.mouse.wheel({ deltaY: 400 }); await sleep(700);
    const d1 = (await S('view()')).want;
    await page.mouse.wheel({ deltaY: -700 }); await sleep(500);
    check('scroll zooms the third-person camera', d1 > d0 + 0.5 && (await S('view()')).want < d1, `zoom ${d0} -> ${d1} -> ${(await S('view()')).want}`);
    await ev(() => window.__social.setZoom(3.0));

    // ------------------------------------------------------------------ camera vs walls
    // south wall: player 0.75 m from it, facing north -> the 3 m orbit wants to be 2.25 m inside the wall
    await place({ x: 12.4, z: -0.75, yaw: 0, pitch: -0.05 }); await sleep(1100);
    V = await S('view()'); let los = await S('losHits()');
    const southFace = await ev(() => window.__social.rayRoom([12.4, 1.5, -0.75], [0, 0, 1]));
    check('camera does not pass through the south wall (wants 3 m, wall ~0.75 m behind)', V.z < -0.75 + southFace - 0.05 && los.hits === 0 && V.dist < 1.0, `cam z ${V.z}, wall face at z ${(-0.75 + southFace).toFixed(3)}, dist ${V.dist} (want ${V.want}), room-mesh hits pivot->cam ${los.hits}`);
    await shot('03-wall-south');
    // west wall, facing east
    await place({ x: 0.85, z: -3.2, yaw: -Math.PI / 2, pitch: -0.05 }); await sleep(1100);
    V = await S('view()'); los = await S('losHits()');
    const westFace = await ev(() => window.__social.rayRoom([0.85, 1.5, -3.2], [-1, 0, 0]));
    check('camera does not pass through the west wall', V.x > 0.85 - westFace + 0.05 && los.hits === 0, `cam x ${V.x}, wall face at x ${(0.85 - westFace).toFixed(3)}, room-mesh hits ${los.hits}`);
    // sweep: walk along the north glass and the desk row while orbiting; sample every frame for wall penetration
    let worst = 0, samples = 0, bad = [];
    for (const [x, z, yaw] of [[3.0, -11.3, Math.PI], [9.0, -11.3, Math.PI], [17.3, -6.0, Math.PI / 2], [6.0, -5.9, Math.PI], [1.0, -0.8, -Math.PI * 0.75]]) {
      await place({ x, z, yaw, pitch: -0.1 });
      for (let k = 0; k < 10; k++) {
        await ev((k) => { const w = window.__social; w.setZoom(2 + (k % 4)); }, k);
        await page.mouse.move(W / 2, H / 2); await page.mouse.down(); await page.mouse.move(W / 2 + 30, H / 2 + (k % 2 ? 8 : -8)); await page.mouse.up(); await unlock();
        await sleep(120);
        const v = await S('view()'), l = await S('losHits()'); samples++;
        const inRoom = v.x > 0.02 && v.x < 17.98 && v.z < -0.02 && v.z > -11.98 && v.y > 0.05 && v.y < 3.38;
        if (l.hits || !inRoom) bad.push(`(${v.x},${v.y},${v.z}) hits ${l.hits}`);
      }
    }
    check('orbit sweep along glass, walls and desks: camera always inside the room, no mesh between player and camera', bad.length === 0, `${samples} samples, ${bad.length} bad ${bad.slice(0, 3).join(' ; ')}`);

    // ------------------------------------------------------------------ (2) emotes
    await ev(() => window.__social.setZoom(3.0));
    const P0 = { x: 9.3, z: -7.4 };
    await place({ x: P0.x, z: P0.z, yaw: 0.35, pitch: -0.1 }); await sleep(900);
    const nEv0 = (await S('events()')).length;
    await key('Digit1'); await sleep(350);
    L = await S('local()'); let evs = await S('events()');
    check('key 1 plays the wave emote and emits omo:social {type:"emote"}', L.state === 'emote:wave' && evs.slice(nEv0).some(e => e.type === 'emote' && e.emote === 'wave'), `state ${L.state}, events ${JSON.stringify(evs.slice(nEv0))}`);
    await sleep(2600);
    // hold G -> wheel; move the mouse toward the 'dance' wedge (upper right); release G -> dance
    await unlock();
    await page.mouse.move(W / 2, H / 2);
    await page.keyboard.down('KeyG'); await sleep(250);
    const wOpen = await S('wheel()');
    await page.mouse.move(W / 2 + 110, H / 2 - 40, { steps: 6 }); await sleep(250);
    const wSel = await S('wheel()');
    await shot('04-emote-wheel');
    await page.keyboard.up('KeyG'); await sleep(500);
    L = await S('local()');
    check('hold G opens the emote wheel, pointing picks a wedge, release plays it', wOpen.open && wSel.sel === 'dance' && L.state === 'emote:dance' && !(await S('wheel()')).open, `open ${wOpen.open}, picked ${wSel.sel}, state ${L.state}`);
    await sleep(900);
    await shot('05-dance-third-person');
    await sleep(3500);

    // ------------------------------------------------------------------ slap on a second local avatar
    L = await S('local()');
    const fwd = { x: -Math.sin(L.yaw), z: -Math.cos(L.yaw) };
    await ev((p) => window.__social.spawn(p), { id: 'mia', name: 'Mia', colour: '#ff7aa8', hat: 'beanie', x: L.x + fwd.x * 1.1, z: L.z + fwd.z * 1.1, yaw: L.yaw + Math.PI });
    await ev((p) => window.__social.spawn(p), { id: 'far', name: 'Kai', colour: '#7ad6ff', hat: 'cap', x: L.x - fwd.x * 3.2 + 1, z: L.z - fwd.z * 3.2, yaw: 0 });
    await sleep(400);
    const nEv1 = (await S('events()')).length;
    await key('Digit5'); await sleep(320);
    let av = await S('avatars()'); const mia = av.find(a => a.id === 'mia'), kai = av.find(a => a.id === 'far');
    const fxNow = await S('fx()');
    evs = (await S('events()')).slice(nEv1);
    check('slap: target 1.1 m in front is knocked down, SLAP! burst shown, event carries targetId', mia.state === 'knocked' && fxNow.some(f => f.kind === 'burst') && evs.some(e => e.type === 'emote' && e.emote === 'slap' && e.targetId === 'mia'), `mia ${mia.state}, fx ${JSON.stringify(fxNow)}, events ${JSON.stringify(evs)}`);
    check('slap does not reach an avatar 3.2 m behind', kai.state === 'idle', `kai ${kai.state}`);
    await sleep(120); await shot('06-slap-knockdown');
    await sleep(1200);
    av = await S('avatars()');
    const stillDown = av.find(a => a.id === 'mia').state === 'knocked';
    await sleep(900);
    av = await S('avatars()');
    check('knocked lasts ~2 s, then the target gets up', stillDown && av.find(a => a.id === 'mia').state === 'idle', `at 1.6 s knocked=${stillDown}, at 2.5 s ${av.find(a => a.id === 'mia').state}`);
    // out of range slap: no target
    await ev(() => { window.__social.remove('mia'); });
    await key('Digit5'); await sleep(400);
    av = await S('avatars()');
    check('slap with nobody within 1.5 m in front knocks nobody', av.every(a => a.state !== 'knocked'), JSON.stringify(av.map(a => [a.id, a.state])));
    await ev(() => window.__social.remove('far'));
    await sleep(800);

    // ------------------------------------------------------------------ (3) seats: click a ring to sit
    const target = sofa[sofa.length - 1];
    const stand = { x: target.x - 1.25, z: target.z - 1.0 };
    await ev(() => window.__social.setMode('1p')); await sleep(600);
    await place({ x: stand.x, z: stand.z, yaw: yawTo(stand, target), pitch: -0.55 }); await sleep(700);
    let ring = (await S('seats()')).find(s => s.id === target.id);
    const pt = await ev((s) => window.__social.project(s.x, s.y + 0.05, s.z), target);
    check('free seats within 6 m show a ring hotspot', ring.ring && pt.inFront, `ring ${ring.ring}, screen (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)})`);
    await shot('07-seat-rings');
    await unlock();
    const nEv2 = (await S('events()')).length;
    await page.mouse.click(pt.x, pt.y); await sleep(900);
    L = await S('local()'); E = await S('eye()');
    check('click the ring -> sit: player moved onto the seat, state sit, omo:social sit', L.seatId === target.id && L.state === 'sit' && Math.hypot(L.x - target.x, L.z - target.z) < 0.05 && Math.hypot(E.x - target.x, E.z - target.z) < 0.05 && (await S('events()')).slice(nEv2).some(e => e.type === 'sit' && e.seatId === target.id), `seat ${L.seatId}, avatar (${L.x},${L.y},${L.z}), eye (${E.x},${E.y},${E.z}), seat (${target.x},${target.y},${target.z})`);
    ring = (await S('seats()')).find(s => s.id === target.id);
    check('occupied seat hides its ring', ring.occupant === 'local' && !ring.ring, JSON.stringify(ring));
    await sleep(400); await shot('08-seated-first-person');
    await key('KeyV'); await sleep(900); await shot('09-seated-third-person');
    await key('KeyE'); await sleep(700);
    L = await S('local()'); const Pw = await ev(() => window.__social.local());
    check('E stands up (off the seat, walking again)', L.seatId === null && L.state === 'idle' && L.present && Math.hypot(L.x - target.x, L.z - target.z) > 0.4, `seat ${L.seatId}, state ${L.state}, at (${L.x},${L.z})`);
    const nearId = await S('near()');
    await key('KeyE'); await sleep(800);
    L = await S('local()');
    check('E next to a free seat sits on the closest one', L.seatId !== null && L.seatId === nearId && L.state === 'sit', `near ${nearId}, seat ${L.seatId}`);
    await page.keyboard.down('KeyW'); await sleep(450); await page.keyboard.up('KeyW'); await sleep(500);
    L = await S('local()');
    check('W (WASD) stands you up', L.seatId === null && L.state !== 'sit', `seat ${L.seatId}, state ${L.state}`);
    // remote sit (mp/ path) occupies a seat and hides its ring
    await ev((s) => { window.__social.spawn({ id: 'zoe', name: 'Zoe', colour: '#b48cff', hat: 'party', x: s.x, z: s.z - 1 }); window.__social.applyRemote('zoe', { type: 'sit', seatId: s.id }); }, sofa[0]);
    await sleep(300);
    const s0 = (await S('seats()')).find(s => s.id === sofa[0].id);
    check('remote avatar sitting (applyRemote) occupies the seat and hides its ring', s0.occupant === 'zoe' && !s0.ring, JSON.stringify(s0));
    await ev(() => window.__social.remove('zoe'));

    // ------------------------------------------------------------------ (4) speaking range ring
    await place({ x: 9.3, z: -7.4, yaw: 0.6, pitch: -0.2 }); await sleep(400);
    await ev(() => window.__social.setSpeaking(0.8)); await sleep(700);
    const sr = await S('speakRing()'); L = await S('local()');
    check('speaking shows a floor ring around the player at the proximity-voice radius (2.5 m)', sr.visible && Math.abs(sr.radius - 2.5) < 0.01 && Math.hypot(sr.x - L.x, sr.z - L.z) < 0.05, JSON.stringify(sr));
    await shot('10-speaking-ring');
    await ev(() => window.__social.setSpeaking(0)); await sleep(800);
    check('ring disappears when not speaking', !(await S('speakRing()')).visible, JSON.stringify(await S('speakRing()')));
    await ev(() => window.__social.setSpeaking(null));

    // ------------------------------------------------------------------ screen focus forces first-person
    const liveOk = await ev(() => !!(window.__live && window.__live.ready && window.__live.desks().length));
    if (liveOk) {
      await place({ x: 7.6, z: -3.55, yaw: 0, pitch: -0.15 }); await sleep(400);
      if ((await S('mode()')) !== '3p') { await key('KeyV'); }
      await sleep(900);
      const sc = (await S('screens()')).sort((a, b) => Math.abs(a[0] - 7.6) - Math.abs(b[0] - 7.6))[0];
      const sp = await ev((c) => window.__social.project(c[0], c[1], c[2]), sc);
      await unlock();
      await page.mouse.click(sp.x, sp.y, { button: 'right' }); await sleep(800);
      const focus = await ev(() => window.__live.focus());
      L = await S('local()');
      check('right-click a desk screen in third-person -> screen focus forces first-person, avatar hidden', !!focus && (await S('mode()')) === '1p' && !L.visible, `focus ${focus}, mode ${await S('mode()')}, visible ${L.visible}`);
      await page.keyboard.press('Escape'); await sleep(300);
    } else check('screen focus forces first-person (live desks not attached)', false, 'live desks not ready');
    // V back to first-person hides the own avatar
    await place({ x: 9.3, z: -7.4, yaw: 0.6, pitch: -0.1 }); await sleep(300);
    if ((await S('mode()')) !== '3p') await key('KeyV');
    await sleep(700); const vis3 = (await S('local()')).visible;
    await key('KeyV'); await sleep(700);
    check('V again -> first-person, own avatar hidden', vis3 && (await S('mode()')) === '1p' && !(await S('local()')).visible, `3p visible ${vis3}, 1p visible ${(await S('local()')).visible}`);

    // ------------------------------------------------------------------ ~20 s video (CDP screencast with real timestamps)
    report.video = await recordDemo(page, cdp, { place, key, S, ev, unlock, sofa, seats, yawTo });
    const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', report.video], { encoding: 'utf8' }).stdout);
    check('~20 s demo video recorded', dur > 17 && dur < 30, `${report.video} ${dur.toFixed(1)} s`);
    report.fps = await ev(() => new Promise(res => { let n = 0; const s = performance.now(); const t = () => { n++; if (performance.now() - s < 2000) requestAnimationFrame(t); else res(Math.round(n / ((performance.now() - s) / 1000))); }; requestAnimationFrame(t); }));

    const socialErrors = report.errors.filter(e => /social/i.test(e));
    check('no page errors from social/', socialErrors.length === 0, socialErrors.slice(0, 3).join(' | ') || `(${report.errors.length} errors from other lanes: ${report.errors.slice(0, 2).join(' | ').slice(0, 200)})`);
  } catch (e) {
    check('test run completed', false, String(e && e.stack || e));
    try { if (page) await page.screenshot({ path: path.join(OUT, 'failure.png') }); } catch {}
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    spawnSync(TMUX, ['-L', SOCK, 'kill-server'], { env: TENV });
    fs.rmSync(TMUX_DIR, { recursive: true, force: true });
    const pass = results.filter(r => r.ok).length;
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ pass, total: results.length, results, ...report }, null, 1));
    console.log(`\n${pass}/${results.length} PASS\nfps: ${report.fps}\nshots: ${report.shots.join(' ')}\nvideo: ${report.video}`);
    process.exit(pass === results.length ? 0 : 1);
  }
})();

async function recordDemo(page, cdp, h) {
  const mp4 = path.join(OUT, 'social-demo.mp4');
  fs.rmSync(mp4, { force: true });
  const FR = path.join(OUT, 'frames'); fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
  // set the scene first: friends on the sofa and the lounge chair, one standing
  const lounge = h.seats.find(s => s.kind === 'lounge');
  const sofaA = h.sofa[0], sofaB = h.sofa[h.sofa.length - 1];
  await h.ev((a) => {
    const S = window.__social;
    S.spawn({ id: 'mia', name: 'Mia', colour: '#ff7aa8', hat: 'beanie', x: a.sofaA.x, z: a.sofaA.z - 1 }); S.applyRemote('mia', { type: 'sit', seatId: a.sofaA.id });
    S.spawn({ id: 'kai', name: 'Kai', colour: '#7ad6ff', hat: 'cap', x: a.lounge.x, z: a.lounge.z }); S.applyRemote('kai', { type: 'sit', seatId: a.lounge.id });
    S.spawn({ id: 'noa', name: 'Noa', colour: '#ffc857', hat: 'party', x: 14.3, z: -9.0, yaw: -2.2 });
    S.setAvatarSpeaking('mia', 0);
  }, { sofaA, lounge });
  const start = { x: 12.2, z: -10.4 };
  await h.place({ x: start.x, z: start.z, yaw: h.yawTo(start, { x: 15.0, z: -8.2 }), pitch: -0.12 });
  await h.ev(() => { window.__social.setMode('1p'); window.__social.setZoom(3.2); });
  await sleep(600);
  const frames = [];
  const onFrame = (f) => { const n = path.join(FR, String(frames.length).padStart(6, '0') + '.jpg'); frames.push({ n, t: f.metadata.timestamp }); fs.writeFileSync(n, Buffer.from(f.data, 'base64')); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const t0 = Date.now();
  const at = async (s) => { const d = s * 1000 - (Date.now() - t0); if (d > 0) await sleep(d); };
  const drag = async (dx, steps = 14) => { await h.unlock(); await page.mouse.move(W / 2, H / 2); await page.mouse.down(); for (let i = 1; i <= steps; i++) { await page.mouse.move(W / 2 + dx * i / steps, H / 2); await sleep(30); } await page.mouse.up(); await h.unlock(); };
  await at(1.2); await h.key('KeyV');                                                         // 1st -> 3rd person
  await at(2.2); await h.ev(() => window.__social.applyRemote('noa', { type: 'emote', emote: 'wave' }));
  await at(2.6); await drag(-160);                                                            // orbit
  await at(4.0); await h.ev(() => { window.__social.applyRemote('mia', { type: 'emote', emote: 'dance' }); window.__social.setAvatarSpeaking('kai', 0.7); });
  await at(4.4); await page.keyboard.down('KeyW'); await sleep(700); await page.keyboard.up('KeyW');
  await at(5.6); await h.key('Digit3');                                                       // cheer
  await at(6.2); await h.ev(() => window.__social.setSpeaking(0.75));                          // speaking ring
  await at(8.4); await h.ev(() => { window.__social.setSpeaking(0); window.__social.setAvatarSpeaking('kai', 0); });
  // face Noa and step in
  await h.ev(() => { const S = window.__social, me = S.local(), n = S.avatars().find(a => a.id === 'noa'); const dx = n.x - me.x, dz = n.z - me.z, d = Math.hypot(dx, dz); S.placePlayer({ x: n.x - dx / d * 1.05, z: n.z - dz / d * 1.05, yaw: Math.atan2(-dx, -dz), pitch: -0.12 }); });
  await at(9.4); await h.key('Digit5');                                                       // SLAP!
  await at(11.0); await h.ev(() => window.__social.applyRemote('kai', { type: 'emote', emote: 'clap' }));
  await at(12.0); await h.ev(() => window.__social.setMode('1p'));
  await h.ev((s) => { const S = window.__social; S.placePlayer({ x: s.x - 0.2, z: s.z - 1.3, yaw: Math.atan2(-0.2, -1.3) + Math.PI, pitch: -0.5 }); }, sofaB);
  await at(13.4); await h.key('KeyE');                                                        // sit on the sofa
  await at(14.6); await h.key('KeyV');                                                        // seated, third person
  await at(15.4); await drag(220, 20);
  await at(16.6); await h.key('Digit4');                                                      // clap from the sofa
  await h.ev(() => window.__social.applyRemote('mia', { type: 'emote', emote: 'cheer' }));
  await at(19.0); await page.keyboard.down('KeyS'); await sleep(400); await page.keyboard.up('KeyS');   // stand up
  await at(21.0);
  await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', onFrame); await sleep(200);
  const list = frames.map((f, i) => `file '${f.n}'\nduration ${Math.max(0.001, ((frames[i + 1] || { t: f.t + 0.04 }).t - f.t)).toFixed(4)}`).join('\n') + `\nfile '${frames[frames.length - 1].n}'\n`;
  fs.writeFileSync(path.join(FR, 'list.txt'), list);
  const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(FR, 'list.txt'), '-vf', 'fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
  if (enc.status !== 0) console.log('ffmpeg:', enc.stderr);
  fs.rmSync(FR, { recursive: true, force: true });
  await h.ev(() => { for (const id of ['mia', 'kai', 'noa']) window.__social.remove(id); });
  return mp4;
}
