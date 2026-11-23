#!/usr/bin/env node
/*
 * Real-Chrome acceptance test for mobile/touch controls in the baked-render penthouse.
 *   node touch/test-touch.cjs            (from ~/dev/omo-sky-lab/baked-render)
 * Starts live/server.cjs on a free port with an ISOLATED tmux socket dir (never touches the real desk shells), opens the
 * page in headless Chrome (GPU flags as ../capture.cjs) emulating iPhone 14 and Pixel 7 (touch, isMobile, DPR), then:
 * joystick drag -> player moved; right-half drag -> yaw changed; jump/sprint/crouch buttons; tap a desk monitor (near) and
 * one from far away; Keyboard button -> hidden textarea focused; soft-keyboard style input (CDP Input.insertText) of
 * `echo omo-touch-$((40+2))` -> omo-touch-42 in window.__liveText; extra keys (Up, Ctrl, Esc); fps over 3 s; portrait +
 * landscape screenshots; a ~15 s phone-view video; a desktop control run (touch stays off). Prints PASS/FAIL per check.
 * Always stops the server and kills the isolated tmux server at the end.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const NM = '~/dev/omo-skyscraper/omo/node_modules';
const puppeteer = require(NM + '/puppeteer-core');
const { KnownDevices } = puppeteer;
const { tmuxBin } = require('../live/tmuxbin.cjs');

const LANE = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const TMUX = tmuxBin(), SOCK = 'omo-sky-live';
const TMUX_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'omo-touch-tmux-'));
const TENV = { ...process.env, TMUX_TMPDIR: TMUX_DIR };
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCK, ...a], { encoding: 'utf8', env: TENV });
// Pixel 7 is not in this puppeteer's KnownDevices (it stops at Pixel 5): Chrome DevTools' Pixel 7 preset.
const PIXEL7 = { name: 'Pixel 7', userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36', viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, isLandscape: false } };
const PIXEL7_L = { ...PIXEL7, name: 'Pixel 7 landscape', viewport: { ...PIXEL7.viewport, width: 915, height: 412, isLandscape: true } };
const DEVICES = [[KnownDevices['iPhone 14'], KnownDevices['iPhone 14 landscape'], 'iphone14'], [PIXEL7, PIXEL7_L, 'pixel7']];

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let server = null, browser = null, PORT = 0;
const report = { fps: {}, shots: [], video: null };

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

async function openPage(device, token) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    if (device) await page.emulate(device);
    const cdp = await page.createCDPSession();
    await page.goto(`http://127.0.0.1:${PORT}/?live=${token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 240000 });
    await page.waitForFunction(() => window.__live && window.__live.ready === true, { timeout: 30000 });
    // touch helpers (CDP Input.dispatchTouchEvent = what a real touchscreen produces)
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 6, radiusY: 6, force: 1 })) });
    const tap = async (x, y) => { await touch('touchStart', [[x, y, 9]]); await sleep(60); await touch('touchEnd', []); await sleep(120); };
    const tapSel = async (sel) => { const b = await page.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }); await tap(b.x, b.y); return b; };
    const drag = async (x0, y0, x1, y1, steps, holdMs, id = 1, during) => {
        await touch('touchStart', [[x0, y0, id]]);
        for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, id]]); await sleep(30); }
        const mid = during ? await during() : null;
        if (holdMs) await sleep(holdMs);
        await touch('touchEnd', []);
        return mid;
    };
    const cam = () => page.evaluate(() => window.__touch.cam());
    const termText = (id) => page.evaluate(id => (window.__liveText || {})[id] || '', id);
    const count = async (id, re) => ((await termText(id)).match(re) || []).length;
    const waitCount = async (id, re, n, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await count(id, re) >= n) return true; await sleep(100); } return false; };
    const insert = (text) => cdp.send('Input.insertText', { text });
    const key = async (k, code, vk) => { await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    const focus = () => page.evaluate(() => window.__live.focus());
    const vp = () => page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    return { page, cdp, errors, touch, tap, tapSel, drag, cam, termText, count, waitCount, insert, key, focus, vp };
}

const DESK = { x: 7.6, y: 1.36, z: -4.32, yaw: 0, pitch: -9 };
const START = { x: 2.6, y: 1.65, z: -1.4, yaw: -38, pitch: -5 };
const RE42 = /^omo-touch-42\s*$/mg;
const yawTo = (from, to) => Math.atan2(-(to[0] - from.x), -(to[2] - from.z)) * 180 / Math.PI;

async function runDevice(P, dev, devL, tag, token) {
    const { page } = P;
    const L = (s) => `[${dev.name}] ${s}`;
    const st = await page.evaluate(() => ({ active: window.__touch && window.__touch.active, coarse: matchMedia('(pointer: coarse)').matches, url: location.href }));
    check(L('touch mode turns on by itself (pointer: coarse, no ?touch=1 in the URL)'), st.active === true && st.coarse && !/touch=1/.test(st.url), JSON.stringify(st));
    const v = await P.vp();
    check(L('page uses the device width (viewport meta, no 980 px desktop layout)'), v.w === dev.viewport.width, `innerWidth ${v.w} (device ${dev.viewport.width})`);
    const perf = await page.evaluate(() => window.__touch.perf());
    check(L('pixel ratio capped at 1.5 and bloom reduced'), perf.pixelRatio === Math.min(1.5, perf.dpr) && perf.bloom && perf.bloom.strength < perf.bloom.baseStrength && perf.bloom.half === true, JSON.stringify(perf));
    const sizes = await page.evaluate(() => [...document.querySelectorAll('#omo-touch button')].filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(); return { id: b.id, w: Math.round(r.width), h: Math.round(r.height), in: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; }));
    check(L('every visible button is at least 44x44 px and inside the screen'), sizes.length >= 3 && sizes.every(s => s.w >= 44 && s.h >= 44 && s.in), JSON.stringify(sizes));

    // ---- joystick: left half
    await page.evaluate(p => window.__setPose(p), START); await sleep(300);
    const a = await P.cam();
    const jx = v.w * 0.25, jy = v.h * 0.72;
    const inpMid = await P.drag(jx, jy, jx + 4, jy - 60, 8, 1400, 1, () => page.evaluate(() => window.__touch.state()));
    await sleep(400);
    const b = await P.cam();
    const moved = Math.hypot(b.x - a.x, b.z - a.z);
    check(L('joystick drag (left half) sets walker.input.forward and moves the player'), inpMid.input.forward && !inpMid.input.back && moved > 0.8, `input=${JSON.stringify(inpMid.input)} moved ${moved.toFixed(2)} m`);
    const stopped = await page.evaluate(() => window.__touch.state().input);
    check(L('releasing the joystick clears the move input'), !stopped.forward && !stopped.back && !stopped.left && !stopped.right, JSON.stringify(stopped));

    // ---- look: right half
    const c0 = await P.cam();
    await P.drag(v.w * 0.75, v.h * 0.45, v.w * 0.75 - 140, v.h * 0.45 + 20, 10, 0, 2);
    await sleep(350);
    const c1 = await P.cam();
    check(L('drag on the right half turns the view (yaw changed) without moving'), Math.abs(c1.yaw - c0.yaw) > 0.15 && Math.hypot(c1.x - c0.x, c1.z - c0.z) < 0.05, `yaw ${c0.yaw.toFixed(3)} -> ${c1.yaw.toFixed(3)} rad, moved ${Math.hypot(c1.x - c0.x, c1.z - c0.z).toFixed(3)} m`);

    // ---- two thumbs at once: walk + look
    await P.touch('touchStart', [[jx, jy, 1]]);
    await P.touch('touchStart', [[jx, jy, 1], [v.w * 0.75, v.h * 0.4, 2]]);
    for (let i = 1; i <= 8; i++) { await P.touch('touchMove', [[jx, jy - 7 * i, 1], [v.w * 0.75 + 12 * i, v.h * 0.4, 2]]); await sleep(30); }
    const both = await page.evaluate(() => window.__touch.state());
    await P.touch('touchEnd', []);
    check(L('two thumbs: joystick and look work at the same time'), both.input.forward && both.lookTouch === true, JSON.stringify({ input: both.input, lookTouch: both.lookTouch }));

    // ---- buttons
    const j0 = (await page.evaluate(() => window.__touch.state())).jumps;
    await P.tapSel('#omo-touch-jump'); await sleep(700);
    const j1 = (await page.evaluate(() => window.__touch.state())).jumps;
    check(L('Jump button makes the walker jump'), j1 === j0 + 1, `jumps ${j0} -> ${j1}`);
    await P.tapSel('#omo-touch-sprint'); const s1 = (await page.evaluate(() => window.__touch.state())).input.sprint;
    await P.tapSel('#omo-touch-sprint'); const s2 = (await page.evaluate(() => window.__touch.state())).input.sprint;
    check(L('Sprint button toggles sprint on and off'), s1 === true && s2 === false, `${s1} -> ${s2}`);
    await P.tapSel('#omo-touch-crouch'); await sleep(500); const k1 = await page.evaluate(() => window.__touch.state());
    await P.tapSel('#omo-touch-crouch'); await sleep(500); const k2 = await page.evaluate(() => window.__touch.state());
    check(L('Crouch button toggles crouch (body really crouches, then stands)'), k1.input.crouch && k1.crouched && !k2.input.crouch && !k2.crouched, `on: input=${k1.input.crouch} crouched=${k1.crouched}; off: input=${k2.input.crouch} crouched=${k2.crouched}`);

    // ---- fps over 3 s while walking with the joystick
    const fps = await P.drag(jx, jy, jx + 30, jy - 50, 6, 0, 1, () => page.evaluate(() => new Promise(res => { let n = 0; const s = performance.now(); const tick = () => { n++; if (performance.now() - s < 3000) requestAnimationFrame(tick); else res(Math.round(10 * n / ((performance.now() - s) / 1000)) / 10); }; requestAnimationFrame(tick); })));
    report.fps[dev.name] = fps;
    check(L('30+ fps over 3 s while walking'), fps >= 30, `${fps} fps`);

    // ---- portrait screenshot with the stick showing
    await page.evaluate(p => window.__setPose(p), START); await sleep(200);
    const shotP = path.join(OUT, `${tag}-portrait.png`);
    await P.drag(jx, jy, jx + 18, jy - 44, 5, 0, 1, async () => { await sleep(250); await page.screenshot({ path: shotP }); });
    report.shots.push(shotP);

    // ---- tap a desk monitor (near) + soft keyboard
    await page.evaluate(p => window.__setPose(p), DESK); await sleep(400);
    const sp = await page.evaluate(() => window.__live.screenPoint('desk-1'));
    const pk = await page.evaluate((x, y) => window.__live.pickAt(x, y), sp.x, sp.y);
    await P.tap(sp.x, sp.y);
    check(L('tapping the desk-1 monitor (near) focuses it for typing'), (await P.focus()) === 'term:desk-1', `tap ${Math.round(sp.x)},${Math.round(sp.y)} pick=${JSON.stringify(pk)}`);
    const ui = await page.evaluate(() => ({ kb: !!document.querySelector('#omo-touch-kb')?.offsetParent, keys: [...document.querySelectorAll('#omo-touch-keys button')].filter(b => b.offsetParent).map(b => b.textContent), stick: !!document.querySelector('#omo-touch-jump')?.offsetParent }));
    check(L('terminal focus shows Keyboard + Esc Tab Ctrl Up Down keys and hides the move buttons'), ui.kb && ['Esc', 'Tab', 'Ctrl', '↑', '↓'].every(k => ui.keys.includes(k)) && !ui.stick, JSON.stringify(ui));
    await P.tapSel('#omo-touch-kb');
    const act = await page.evaluate(() => ({ id: document.activeElement && document.activeElement.id, tag: document.activeElement && document.activeElement.tagName, fs: getComputedStyle(document.activeElement).fontSize }));
    check(L('Keyboard button focuses the hidden textarea (raises the soft keyboard; 16px font = no iOS zoom)'), act.id === 'omo-touch-ta' && act.tag === 'TEXTAREA' && parseFloat(act.fs) >= 16, JSON.stringify(act));
    const n0 = await P.count('desk-1', RE42);
    const before = await P.cam();
    for (const ch of 'echo omo-touch-$((40+2))x') { await P.insert(ch); await sleep(25); }   // soft keyboard commits text (no key events)
    await P.key('Backspace', 'Backspace', 8);                                                 // fix the typo
    await P.key('Enter', 'Enter', 13);
    const got = await P.waitCount('desk-1', RE42, n0 + 1, 8000);
    check(L('typing `echo omo-touch-$((40+2))` (+typo, Backspace, Enter) prints omo-touch-42 in window.__liveText'), got, got ? `omo-touch-42 lines ${n0} -> ${await P.count('desk-1', RE42)}` : (await P.termText('desk-1')).slice(-300));
    const after = await P.cam();
    check(L('typing does not move the player'), Math.hypot(after.x - before.x, after.z - before.z) < 1e-6, `moved ${Math.hypot(after.x - before.x, after.z - before.z).toFixed(6)} m`);
    // Up arrow key (extra row) + newline from the soft keyboard -> the command runs again
    const n1 = await P.count('desk-1', RE42);
    await P.tapSel('#omo-touch-k-up'); await sleep(150); await P.insert('\n');
    const again = await P.waitCount('desk-1', RE42, n1 + 1, 8000);
    check(L('extra key ↑ recalls the command and a soft-keyboard newline runs it again'), again, `omo-touch-42 lines ${n1} -> ${await P.count('desk-1', RE42)}`);
    const stillFocused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check(L('tapping extra keys keeps the soft keyboard up (textarea stays focused)'), stillFocused === 'omo-touch-ta', stillFocused);
    // Ctrl (sticky) + c interrupts a running command
    for (const ch of 'sleep 30') await P.insert(ch);
    await P.key('Enter', 'Enter', 13); await sleep(400);
    await P.tapSel('#omo-touch-k-ctrl'); await P.insert('c'); await sleep(300);
    const reN = new RegExp(`^ctrl-ok-${tag}-2\\s*$`, 'm');
    for (const ch of `echo ctrl-ok-${tag}-$((1+1))`) await P.insert(ch);
    await P.key('Enter', 'Enter', 13);
    const t0 = Date.now(); let ctrlOk = false; while (Date.now() - t0 < 6000) { if (reN.test(await P.termText('desk-1'))) { ctrlOk = true; break; } await sleep(100); }
    check(L('extra key Ctrl + c interrupts `sleep 30` (next command answers within 6 s)'), ctrlOk, ctrlOk ? `answered in ${Date.now() - t0} ms` : (await P.termText('desk-1')).slice(-200));
    const shotK = path.join(OUT, `${tag}-portrait-keyboard.png`); await page.screenshot({ path: shotK }); report.shots.push(shotK);
    await P.tapSel('#omo-touch-k-esc'); await sleep(200);
    const rel = await page.evaluate(() => ({ focus: window.__live.focus(), active: document.activeElement && document.activeElement.id, keys: !!document.querySelector('#omo-touch-keys')?.offsetParent, stick: !!document.querySelector('#omo-touch-jump')?.offsetParent }));
    check(L('extra key Esc releases the terminal, drops the keyboard, brings the move buttons back'), rel.focus === null && rel.active !== 'omo-touch-ta' && !rel.keys && rel.stick, JSON.stringify(rel));

    // ---- tap a monitor from far away (> 6 m): the desktop right-click path
    const FARP = { x: 13.6, y: 1.65, z: -1.6, pitch: -6 }; FARP.yaw = yawTo(FARP, [4.2, 1.21, -5.1]);
    await page.evaluate(p => window.__setPose(p), FARP); await sleep(400);
    const sp0 = await page.evaluate(() => window.__live.screenPoint('desk-0'));
    const pk0 = await page.evaluate((x, y) => window.__live.pickAt(x, y), sp0.x, sp0.y);
    await P.tap(sp0.x, sp0.y);
    const ff = await P.focus();
    check(L('tapping a monitor from far away (> 6 m) takes control of it'), ff === 'term:desk-0' && pk0 && pk0.dist > 6, `focus=${ff} pick=${JSON.stringify(pk0)}`);
    await P.tapSel('#omo-touch-done'); await sleep(150);
    check(L('Done button releases a screen'), (await P.focus()) === null);

    // ---- landscape
    await page.emulate(devL); await sleep(900);
    const lv = await P.vp();
    const lperf = await page.evaluate(() => window.__touch.perf());
    const lsizes = await page.evaluate(() => [...document.querySelectorAll('#omo-touch button')].filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(); return { id: b.id, w: Math.round(r.width), h: Math.round(r.height), in: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; }));
    check(L('landscape: page resizes, buttons stay >= 44 px and on screen, pixel ratio still capped'), lv.w > lv.h && lv.w === devL.viewport.width && lsizes.length >= 3 && lsizes.every(s => s.w >= 44 && s.h >= 44 && s.in) && lperf.pixelRatio <= 1.5, `${lv.w}x${lv.h} pr=${lperf.pixelRatio} ${JSON.stringify(lsizes)}`);
    await page.evaluate(p => window.__setPose(p), { x: 9.3, y: 1.65, z: -4.0, yaw: -8, pitch: -8 }); await sleep(300);
    const shotL = path.join(OUT, `${tag}-landscape.png`);
    await P.drag(lv.w * 0.2, lv.h * 0.7, lv.w * 0.2 + 20, lv.h * 0.7 - 40, 5, 0, 1, async () => { await sleep(250); await page.screenshot({ path: shotL }); });
    report.shots.push(shotL);
    await page.emulate(dev); await sleep(600);
}

async function recordDemo(P) {
    const { page } = P;
    const v = await P.vp();
    const mp4 = path.join(OUT, 'touch-demo-iphone14.mp4');
    fs.rmSync(mp4, { force: true });
    await page.evaluate(p => window.__setPose(p), START); await sleep(300);
    // CDP screencast frames carry timestamps -> concat list with real durations -> H.264 at a constant 25 fps
    const FR = path.join(OUT, 'frames'); fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
    const frames = [];
    const onFrame = async (f) => { const n = path.join(FR, String(frames.length).padStart(6, '0') + '.jpg'); frames.push({ n, t: f.metadata.timestamp }); fs.writeFileSync(n, Buffer.from(f.data, 'base64')); P.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); };
    P.cdp.on('Page.screencastFrame', onFrame);
    await P.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: v.w * 2, maxHeight: v.h * 2, everyNthFrame: 1 });
    const rec = { stop: async () => {
        await P.cdp.send('Page.stopScreencast'); P.cdp.off('Page.screencastFrame', onFrame); await sleep(200);
        const list = frames.map((f, i) => `file '${f.n}'\nduration ${Math.max(0.001, ((frames[i + 1] || { t: f.t + 0.04 }).t - f.t)).toFixed(4)}`).join('\n') + `\nfile '${frames[frames.length - 1].n}'\n`;
        fs.writeFileSync(path.join(FR, 'list.txt'), list);
        const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(FR, 'list.txt'), '-vf', 'fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
        if (enc.status !== 0) console.log('ffmpeg:', enc.stderr);
        report.videoFrames = frames.length;
        fs.rmSync(FR, { recursive: true, force: true });
    } };
    const t0 = Date.now();
    const jx = v.w * 0.25, jy = v.h * 0.72;
    await P.drag(jx, jy, jx + 6, jy - 55, 8, 2600, 1);                             // walk forward
    await P.drag(v.w * 0.75, v.h * 0.45, v.w * 0.75 - 90, v.h * 0.45, 14, 300, 2);  // look left
    await P.drag(jx, jy, jx + 40, jy - 40, 8, 1500, 1);                            // walk diagonally
    await P.drag(v.w * 0.7, v.h * 0.45, v.w * 0.7 + 120, v.h * 0.42, 14, 200, 2);  // look right
    await page.evaluate(p => window.__setPose(p), DESK); await sleep(700);
    const sp = await page.evaluate(() => window.__live.screenPoint('desk-1'));
    await P.tap(sp.x, sp.y); await sleep(500);
    await P.tapSel('#omo-touch-kb'); await sleep(300);
    for (const ch of 'echo omo-touch-$((40+2))') { await P.insert(ch); await sleep(70); }
    await P.key('Enter', 'Enter', 13); await sleep(1500);
    await P.tapSel('#omo-touch-k-up'); await sleep(500); await P.key('Enter', 'Enter', 13); await sleep(1300);
    await P.tapSel('#omo-touch-k-esc'); await sleep(500);
    await P.drag(v.w * 0.75, v.h * 0.45, v.w * 0.75 + 110, v.h * 0.5, 14, 300, 2);
    while (Date.now() - t0 < 15000) await sleep(100);
    await rec.stop();
    await sleep(500);
    const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).stdout);
    const dims = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).stdout.trim();
    report.video = mp4;
    check('[iPhone 14] ~15 s phone-view video recorded', dur > 12 && dur < 30, `${mp4} ${dur.toFixed(1)} s ${dims} from ${report.videoFrames} screencast frames`);
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    PORT = await freePort();
    const token = await startServer();
    check('live server started on a free port with an isolated tmux socket', /^[0-9a-f]{48}$/.test(token), `port ${PORT}, TMUX_TMPDIR=${TMUX_DIR}`);
    const args = ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=gl-egl', '--use-gl=angle', '--enable-gpu-rasterization'];
    browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', args, defaultViewport: null });
    const allErrors = [];
    for (const [dev, devL, tag] of DEVICES) {
        const P = await openPage(dev, token);
        await runDevice(P, dev, devL, tag, token);
        if (tag === 'iphone14') await recordDemo(P);
        allErrors.push(...P.errors.map(e => `[${dev.name}] ${e}`));
        await P.page.close();
    }
    // desktop control: no touch emulation -> touch layer stays off, desktop path unchanged
    const D = await openPage(null, token);
    await D.page.setViewport({ width: 1280, height: 720 });
    await sleep(500);
    const ds = await D.page.evaluate(() => ({ active: window.__touch && window.__touch.active, ui: !!document.querySelector('#omo-touch'), pr: window.__touch && window.__touch.perf().pixelRatio, coarse: matchMedia('(pointer: coarse)').matches }));
    check('[desktop] touch layer stays off without a touch screen (no overlay, pixel ratio 1)', ds.active === false && !ds.ui && ds.pr === 1 && !ds.coarse, JSON.stringify(ds));
    await D.page.evaluate(p => window.__setPose(p), DESK); await sleep(300);
    const dsp = await D.page.evaluate(() => window.__live.screenPoint('desk-1'));
    await D.page.mouse.click(dsp.x, dsp.y); await sleep(150);
    check('[desktop] left-click on a monitor still focuses it (desktop path unchanged)', (await D.focus()) === 'term:desk-1');
    await D.page.keyboard.press('Escape');
    allErrors.push(...D.errors.map(e => `[desktop] ${e}`));
    check('no page errors on any device', allErrors.length === 0, allErrors.slice(0, 4).join(' | '));
})().catch(e => check('test ran to completion', false, String(e.stack || e)))
    .finally(async () => {
        if (browser) await browser.close().catch(() => {});
        if (server) { server.kill('SIGTERM'); await sleep(400); }
        tmux('kill-server');
        const gone = tmux('has-session').status !== 0;
        try { fs.rmSync(TMUX_DIR, { recursive: true, force: true }); } catch {}
        const portFree = !PORT || spawnSync('ss', ['-Hltn', `sport = :${PORT}`], { encoding: 'utf8' }).stdout.trim() === '';
        const srvAlive = server && server.exitCode === null && server.signalCode === null;
        check('cleanup: server stopped, port free, isolated tmux server killed and its dir removed', gone && portFree && !srvAlive && !fs.existsSync(TMUX_DIR), `tmuxGone=${gone} portFree=${portFree} serverAlive=${!!srvAlive}`);
        const failed = results.filter(r => !r.ok);
        fs.writeFileSync(path.join(OUT, 'test-result.json'), JSON.stringify({ when: new Date().toISOString(), port: PORT, ...report, results }, null, 1));
        console.log(`\nfps: ${JSON.stringify(report.fps)}\nshots: ${report.shots.join(' ')}\nvideo: ${report.video}`);
        console.log(`\n${failed.length ? 'FAIL' : 'PASS'}  ${results.length - failed.length}/${results.length} checks passed`);
        process.exit(failed.length ? 1 : 0);
    });
