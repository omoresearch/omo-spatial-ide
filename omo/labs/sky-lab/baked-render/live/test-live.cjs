#!/usr/bin/env node
/*
 * Real-browser acceptance test for live terminals + live web walls in the baked-render penthouse.
 *   node live/test-live.cjs            (from ~/dev/omo-sky-lab/baked-render)
 * Starts live/server.cjs, opens the page in Chrome (GPU flags as capture.cjs), clicks a desk monitor, types a command
 * into the real tmux shell, reloads and checks the shell kept its output, sets web-wall URLs through the in-world UI,
 * reloads and checks they persisted + loaded, records live/out/live-demo.mp4 and prints PASS/FAIL per check.
 * Always kills the server and `tmux -L omo-sky-live kill-server` at the end.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const NM = '~/dev/omo-skyscraper/omo/node_modules';
const puppeteer = require(NM + '/puppeteer-core');
const WebSocket = require(NM + '/ws');
const { tmuxBin } = require('./tmuxbin.cjs');

const LANE = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const FRAMES = path.join(OUT, 'frames');
const PORT = Number(process.env.LIVE_PORT || 3671);
const W = 1600, H = 900, FPS = 25;
const TMUX = tmuxBin();
const SOCK = 'omo-sky-live';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const killTmux = () => spawnSync(TMUX, ['-L', SOCK, 'kill-server'], { encoding: 'utf8' });

let server = null, browser = null, frameNo = 0;

async function startServer() {
    server = spawn(process.execPath, [path.join(__dirname, 'server.cjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    server.stderr.on('data', d => process.stderr.write('[server] ' + d));
    return await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('server did not print a token in 10 s: ' + out)), 10000);
        server.stdout.on('data', d => { out += d; const m = /token=([0-9a-f]{32,})/.exec(out); if (m) { clearTimeout(to); res(m[1]); } });
        server.on('exit', c => rej(new Error('server exited ' + c + ': ' + out)));
    });
}

function wsProbe(url, headers = {}) {
    return new Promise((res) => {
        const ws = new WebSocket(url, { headers });
        ws.on('open', () => { ws.close(); res('open'); });
        ws.on('unexpected-response', (_q, r) => res('http ' + r.statusCode));
        ws.on('error', e => res('error ' + e.message));
    });
}

(async () => {
    fs.rmSync(FRAMES, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true });
    killTmux();
    const token = await startServer();
    check('server prints a random token at start', /^[0-9a-f]{48}$/.test(token), `${token.length} hex chars`);

    // ---------------------------------------------------------------- security of the local server
    const ss = spawnSync('ss', ['-Hltn', `sport = :${PORT}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    check('server listens on 127.0.0.1 only', ss.length > 0 && ss.every(l => /\s127\.0\.0\.1:\d+\s/.test(l)), ss.map(l => l.replace(/\s+/g, ' ')).join(' | '));
    const base = `ws://127.0.0.1:${PORT}/live/ws?desk=desk-0`;
    const bad = await wsProbe(base + '&token=' + 'f'.repeat(48)), none = await wsProbe(base);
    check('terminal socket rejects a wrong or missing token', bad === 'http 401' && none === 'http 401', `wrong=${bad} missing=${none}`);
    const foreign = await wsProbe(base + '&token=' + token, { Origin: 'https://evil.example' });
    check('terminal socket rejects a foreign web origin', foreign === 'http 403', foreign);
    // fetch() silently drops a custom Host header, so use http.request to really send a forged one
    const rebind = await new Promise(r => { const q = require('node:http').request({ host: '127.0.0.1', port: PORT, path: '/index.html', headers: { Host: 'evil.example' } }, res => { res.resume(); r(res.statusCode); }); q.on('error', () => r(-1)); q.end(); });
    check('http rejects a foreign Host header (DNS rebinding)', rebind === 403, 'status ' + rebind);

    // ---------------------------------------------------------------- browser
    const args = ['--no-sandbox', `--window-size=${W},${H}`, '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=gl-egl', '--use-gl=angle', '--enable-gpu-rasterization'];
    browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', args, defaultViewport: { width: W, height: H } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    const frame = async () => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await page.screenshot({ path: path.join(FRAMES, String(frameNo++).padStart(6, '0') + '.jpg'), type: 'jpeg', quality: 85 }); };
    const pose = (p) => page.evaluate(p => window.__setPose(p), p);
    const lerp = (a, b, u) => a + (b - a) * u, ease = (u) => u * u * (3 - 2 * u);
    const move = async (A, B, n) => { for (let i = 1; i <= n; i++) { const u = ease(i / n); await pose({ x: lerp(A.x, B.x, u), y: lerp(A.y, B.y, u), z: lerp(A.z, B.z, u), yaw: lerp(A.yaw, B.yaw, u), pitch: lerp(A.pitch, B.pitch, u) }); await frame(); } };
    const hold = async (n) => { for (let i = 0; i < n; i++) await frame(); };
    const waitLive = async () => {
        await page.waitForFunction(() => window.__ready === true, { timeout: 240000 });
        await page.waitForFunction(() => window.__live && window.__live.ready === true, { timeout: 30000 });
    };
    const termText = (id) => page.evaluate(id => (window.__liveText || {})[id] || '', id);
    const waitText = async (id, re, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(await termText(id))) return true; await sleep(100); } return false; };
    const panes = async () => (await fetch(`http://127.0.0.1:${PORT}/live/api/sessions`, { headers: { 'x-live-token': token } }).then(r => r.json())).panes;
    const camPos = () => page.evaluate(() => window.__live.cameraPos());
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

    await page.goto(`http://127.0.0.1:${PORT}/?live=${token}`, { waitUntil: 'domcontentloaded' });
    await waitLive();
    const st = await page.evaluate(() => ({ desks: window.__live.desks(), url: location.href, walls: Object.keys(window.__live.walls()) }));
    check('page finds the 3 desk monitors and connects each to tmux', st.desks.length === 3 && st.desks.every(d => d.status === 'live'), JSON.stringify(st.desks.map(d => d.id + ':' + d.status)));
    check('token is stripped from the address bar', !st.url.includes(token), st.url);
    const p0 = await panes();
    check('server created one persistent tmux session per desk', ['desk-0', 'desk-1', 'desk-2'].every(s => p0.some(p => p.session === s)), p0.map(p => `${p.session}:pid${p.pid}`).join(' '));
    const pidBefore = (p0.find(p => p.session === 'desk-1') || {}).pid;
    check('desk-1 does not show the answer before typing', !/^omo-live-42\s*$/m.test(await termText('desk-1')));

    // ---------------------------------------------------------------- video A: walk from the lifts to desk-1
    const START = { x: 2.6, y: 1.65, z: -1.4, yaw: -38, pitch: -5 };
    const MID = { x: 6.2, y: 1.65, z: -3.0, yaw: -12, pitch: -9 };
    const DESK = { x: 7.6, y: 1.36, z: -4.32, yaw: 0, pitch: -9 };
    await pose(START); await hold(8);
    await move(START, MID, 70);
    await move(MID, DESK, 60);
    await hold(6);

    // click the monitor (real raycast through the page's own mouse handling)
    const sp = await page.evaluate(() => window.__live.screenPoint('desk-1'));
    await page.mouse.click(sp.x, sp.y);
    await sleep(150);
    check('clicking the desk-1 monitor focuses it for typing', (await page.evaluate(() => window.__live.focus())) === 'term:desk-1', `clicked at ${Math.round(sp.x)},${Math.round(sp.y)}`);

    // type into the real shell, one character per video frame
    const cmd = 'echo omo-live-$((40+2)) # wasd';
    const before = await camPos();
    for (const ch of cmd) { await page.keyboard.type(ch); await sleep(25); await frame(); }
    await page.keyboard.down('KeyW'); await sleep(450); await page.keyboard.up('KeyW');
    const afterTyping = await camPos();
    check('typing (incl. holding W) does not move the walker', dist(before, afterTyping) < 1e-6, `moved ${dist(before, afterTyping).toFixed(6)} m`);
    await page.keyboard.press('Enter');
    const got = await waitText('desk-1', /^omo-live-42\s*$/m, 8000);
    check('omo-live-42 appears in window.__liveText["desk-1"]', got, got ? 'line found' : (await termText('desk-1')).slice(-300));
    await hold(35);

    await page.keyboard.press('Escape'); await sleep(100);
    check('Esc releases the monitor', (await page.evaluate(() => window.__live.focus())) === null);
    const relA = await camPos();
    await page.keyboard.down('KeyW'); await sleep(450); await page.keyboard.up('KeyW'); await sleep(200);
    const relB = await camPos();
    check('after Esc, W walks again (control for the frozen-walker check)', dist(relA, relB) > 0.2, `moved ${dist(relA, relB).toFixed(2)} m`);

    // ---------------------------------------------------------------- video B: turn to the web walls
    const BACK = { x: 7.6, y: 1.65, z: -4.0, yaw: 0, pitch: -8 };
    const SOUTH = { x: 8.6, y: 1.65, z: -4.6, yaw: 180, pitch: 3 };
    await pose(BACK); await frame();
    await move(BACK, SOUTH, 55);
    await hold(10);
    // blocked site -> clear message, then another URL
    const setWall = async (id, url) => {
        const wp = await page.evaluate(id => window.__live.wallPoint(id), id);
        await page.mouse.click(wp.x, wp.y); await sleep(150);
        const f = await page.evaluate(() => window.__live.focus());
        await page.$eval('#omo-live-url', e => { e.focus(); e.select(); });
        await page.keyboard.press('Backspace');
        for (const ch of url) { await page.keyboard.type(ch); if (url.length < 40) await frame(); }
        await page.keyboard.press('Enter');
        return f;
    };
    const waitWall = async (id, states, ms) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await page.evaluate(id => window.__live.walls()[id], id); if (states.includes(s.state)) return s; await sleep(150); } return s; };
    const f1 = await setWall('south', 'https://github.com/');
    check('clicking the south wall opens its URL bar', f1 === 'wall:south', f1);
    const blk = await waitWall('south', ['blocked', 'loaded'], 15000);
    check('a site that blocks iframes shows a clear message', blk.state === 'blocked' && /does not allow/i.test(blk.message), `${blk.state}: ${blk.message}`);
    await hold(20);
    const LOCAL = `/live/docs.html?wall=south`;
    await page.$eval('#omo-live-url', e => { e.focus(); e.select(); }); await page.keyboard.press('Backspace');
    await page.keyboard.type(LOCAL); await page.keyboard.press('Enter');
    const loc = await waitWall('south', ['loaded'], 15000);
    check('another URL can be entered after a blocked one and loads', loc.state === 'loaded', loc.state + ' ' + loc.url);
    await page.keyboard.press('Escape'); await sleep(100);
    check('Esc returns from the wall to walking', (await page.evaluate(() => window.__live.focus())) === null);
    await hold(15);
    const WESTV = { x: 5.4, y: 1.65, z: -5.9, yaw: 90, pitch: 1 };
    await move(SOUTH, WESTV, 45);
    await setWall('west', 'https://example.com/');
    const ex = await waitWall('west', ['loaded', 'blocked'], 20000);
    check('west wall loads a public page set through the UI', ex.state === 'loaded', ex.state + ' ' + ex.url);
    await page.keyboard.press('Escape');
    await hold(25);

    // ---------------------------------------------------------------- right-click control from a distance (Harry, 21 Nov)
    const FAR = { x: 13.6, y: 1.65, z: -1.6, yaw: 35, pitch: -6 };   // across the floor, ~8 m from desk-0
    await move(WESTV, FAR, 50); await hold(8);
    const farPos = await camPos();
    const sp0 = await page.evaluate(() => window.__live.screenPoint('desk-0'));
    const dist0 = dist(farPos, [4.2, 1.21, -5.1]);
    await page.mouse.click(sp0.x, sp0.y, { button: 'right' }); await sleep(150);
    check('right-click a desk monitor from far away takes control of it', (await page.evaluate(() => window.__live.focus())) === 'term:desk-0', `distance ${dist0.toFixed(1)} m`);
    const farCmd = 'echo omo-far-$((40+2))';
    for (const ch of farCmd) { await page.keyboard.type(ch); await sleep(25); await frame(); }
    await page.keyboard.press('Enter');
    const farGot = await waitText('desk-0', /^omo-far-42\s*$/m, 8000);
    check('typing from afar runs in desk-0 (omo-far-42)', farGot, farGot ? 'line found' : (await termText('desk-0')).slice(-200));
    await hold(25);
    const farAfter = await camPos();
    check('remote control did not move the player', dist(farPos, farAfter) < 1e-6, `moved ${dist(farPos, farAfter).toFixed(6)} m`);
    await page.keyboard.press('Escape'); await sleep(100);
    // right-click the south web wall from afar and scroll it
    const FARW = { x: 14.8, y: 1.65, z: -6.5, yaw: 128, pitch: -2 };
    await move(FAR, FARW, 40); await hold(5);
    const wpS = await page.evaluate(() => window.__live.wallPoint('south'));
    await page.mouse.click(wpS.x, wpS.y, { button: 'right' }); await sleep(200);
    const fw = await page.evaluate(() => window.__live.focus());
    const docF = page.frames().find(f => f.url().includes('/live/docs.html') && !f.isDetached());
    const y0 = docF ? await docF.evaluate(() => scrollY) : -1;
    await page.mouse.move(wpS.x, wpS.y); for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 120 }); await sleep(60); await frame(); }
    const y1 = docF ? await docF.evaluate(() => scrollY) : -1;
    check('right-click the web wall from afar, then scroll it', fw === 'wall:south' && y1 > y0, `focus=${fw} scrollY ${y0} -> ${y1} distance ${dist(await camPos(), [8.6, 1.62, -0.11]).toFixed(1)} m`);
    await hold(15);
    await page.keyboard.press('Escape'); await sleep(100);
    await move(FARW, FAR, 25);
    const sp0b = await page.evaluate(() => window.__live.screenPoint('desk-0'));
    await page.mouse.click(sp0b.x, sp0b.y, { button: 'right' }); await sleep(100);
    const f2 = await page.evaluate(() => window.__live.focus());
    await page.mouse.click(sp0b.x, sp0b.y, { button: 'right' }); await sleep(100);
    check('right-click the active monitor again releases it', f2 === 'term:desk-0' && (await page.evaluate(() => window.__live.focus())) === null, 'focus was ' + f2);
    await page.screenshot({ path: path.join(OUT, 'far-control.png') });

    // ---------------------------------------------------------------- reload: tmux + localStorage persistence
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitLive();
    const back = await waitText('desk-1', /^omo-live-42\s*$/m, 8000);
    check('after reload the omo-live-42 line is STILL in desk-1 (tmux kept the shell)', back, back ? 'line found' : (await termText('desk-1')).slice(-300));
    const pidAfter = ((await panes()).find(p => p.session === 'desk-1') || {}).pid;
    check('after reload desk-1 is the same shell process', pidBefore && pidBefore === pidAfter, `pane pid ${pidBefore} -> ${pidAfter}`);
    const walls = await page.evaluate(() => ({ ls: { south: localStorage.getItem('omo-live:wall:south'), west: localStorage.getItem('omo-live:wall:west') }, w: window.__live.walls() }));
    check('wall URLs persisted in localStorage', walls.ls.south === `http://127.0.0.1:${PORT}${LOCAL}` && walls.ls.west === 'https://example.com/', JSON.stringify(walls.ls));
    const sw = await waitWall('south', ['loaded'], 15000), ww = await waitWall('west', ['loaded'], 20000);
    const exFrame = page.frames().find(f => f.url().startsWith('https://example.com'));
    const exTitle = exFrame ? await exFrame.evaluate(() => document.title) : '(no frame)';
    const docFrame = page.frames().find(f => f.url().includes('/live/docs.html'));
    const docTitle = docFrame ? await docFrame.evaluate(() => document.title) : '(no frame)';
    check('after reload both wall iframes loaded the persisted pages', sw.state === 'loaded' && ww.state === 'loaded' && exTitle === 'Example Domain' && /Omo Sky Live/.test(docTitle), `south=${sw.state} "${docTitle}" west=${ww.state} "${exTitle}"`);

    // video C: show the terminal still holding the line, then the docs wall
    const DESK2 = { x: 7.6, y: 1.36, z: -4.32, yaw: 0, pitch: -9 };
    await pose(DESK2); await hold(30);
    await move(DESK2, { x: 8.4, y: 1.65, z: -4.2, yaw: 165, pitch: 3 }, 45);
    await hold(20);
    await page.screenshot({ path: path.join(OUT, 'after-reload-wall.png') });
    await pose(DESK2); await sleep(300); await page.screenshot({ path: path.join(OUT, 'after-reload-desk.png') });
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    // ---------------------------------------------------------------- video
    const mp4 = path.join(OUT, 'live-demo.mp4');
    const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(FRAMES, '%06d.jpg'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
    const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).stdout);
    check('video recorded', enc.status === 0 && dur > 17 && dur < 60, `${mp4} ${dur.toFixed(1)} s, ${frameNo} frames`);
})().catch(e => check('test ran to completion', false, String(e.stack || e)))
    .finally(async () => {
        if (browser) await browser.close().catch(() => {});
        if (server) { server.kill('SIGTERM'); await sleep(300); }
        killTmux();
        const gone = spawnSync(TMUX, ['-L', SOCK, 'has-session'], { encoding: 'utf8' }).status !== 0;
        const portFree = spawnSync('ss', ['-Hltn', `sport = :${PORT}`], { encoding: 'utf8' }).stdout.trim() === '';
        check('cleanup: server stopped and tmux -L omo-sky-live killed', gone && portFree, `tmuxGone=${gone} portFree=${portFree}`);
        fs.rmSync(FRAMES, { recursive: true, force: true });
        const failed = results.filter(r => !r.ok);
        fs.writeFileSync(path.join(OUT, 'test-result.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
        console.log(`\n${failed.length ? 'FAIL' : 'PASS'}  ${results.length - failed.length}/${results.length} checks passed`);
        process.exit(failed.length ? 1 : 0);
    });
