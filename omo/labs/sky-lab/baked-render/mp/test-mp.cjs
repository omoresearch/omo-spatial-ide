#!/usr/bin/env node
/*
 * Two-browser acceptance test for multiplayer + proximity voice in the baked-render penthouse.
 *   node mp/test-mp.cjs        (from ~/dev/omo-sky-lab/baked-render)
 * Starts live/server.cjs (host terminals) + mp/server.cjs (room), launches TWO headless Chromes with fake mic/camera
 * (GPU flags as capture.cjs). A = host (live token + host key), B = guest who joins ONLY through A's copied share link.
 * Checks avatars, pose sync, WebRTC voice (inbound-rtp bytes grow), proximity gain, guest isolation from the desks and
 * that no terminal text / token ever appears in an mp frame or the mp server log. Records mp/out/mp-demo.mp4 from A's view.
 * Cleans up servers, browsers and (only if this test started it) the tmux socket.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const NM = '~/dev/omo-skyscraper/omo/node_modules';
const puppeteer = require(NM + '/puppeteer-core');
const { tmuxBin } = require('../live/tmuxbin.cjs');

const LANE = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out'), FRAMES = path.join(OUT, 'frames');
const LIVE_PORT = 3681, MP_PORT = 3682, W = 1280, H = 720;
const TMUX = tmuxBin(), SOCK = 'omo-sky-live';
const MARK = 'OMO-TERM-SECRET-' + Math.random().toString(36).slice(2, 8);   // typed into the host's real shell
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Isolated tmux socket dir: the test never touches Harry's real desk shells on the default omo-sky-live socket.
const TMUX_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'omo-mp-tmux-'));
const TENV = { ...process.env, TMUX_TMPDIR: TMUX_DIR };
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCK, ...a], { encoding: 'utf8', env: TENV });
const procs = [], browsers = [];
const mpLog = [];

function start(file, args, re, logTo) {
    const p = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: TENV }); procs.push(p);
    let out = '';
    p.stdout.on('data', d => { out += d; if (logTo) logTo.push(String(d)); }); p.stderr.on('data', d => { out += d; if (logTo) logTo.push(String(d)); process.stderr.write('[' + path.basename(file) + '] ' + d); });
    return new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error(file + ' did not start: ' + out)), 10000);
        const iv = setInterval(() => { const m = re.exec(out); if (m) { clearTimeout(to); clearInterval(iv); res({ m, out: () => out }); } }, 30);
        p.on('exit', c => { clearTimeout(to); clearInterval(iv); rej(new Error(file + ' exited ' + c + ': ' + out)); });
    });
}

async function launch(label) {
    const args = ['--no-sandbox', `--window-size=${W},${H}`, '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=gl-egl', '--use-gl=angle', '--enable-gpu-rasterization',
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];
    const b = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: 'new', args, defaultViewport: { width: W, height: H } });
    browsers.push(b);
    const page = await b.newPage();
    const errors = [], frames = [];
    page.on('pageerror', e => errors.push(String(e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    const cdp = await page.createCDPSession(); await cdp.send('Network.enable');
    const wsUrl = new Map();
    cdp.on('Network.webSocketCreated', e => wsUrl.set(e.requestId, e.url));
    const grab = (dir) => (e) => frames.push({ dir, url: wsUrl.get(e.requestId) || '', data: e.response.payloadData || '' });
    cdp.on('Network.webSocketFrameSent', grab('sent')); cdp.on('Network.webSocketFrameReceived', grab('recv'));
    return { label, b, page, errors, frames };
}
const mpFrames = (who) => who.frames.filter(f => f.url.includes('/mp/ws'));

(async () => {
    fs.rmSync(FRAMES, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true });
    const live = await start(path.join(LANE, 'live', 'server.cjs'), ['--port', String(LIVE_PORT)], /token=([0-9a-f]{48})/);
    const token = live.m[1];
    const mp = await start(path.join(__dirname, 'server.cjs'), ['--port', String(MP_PORT), '--live-port', String(LIVE_PORT)], /host-key=([0-9a-f]{48})/, mpLog);
    const hostKey = mp.m[1], room = /room=([0-9a-f]{8})/.exec(mp.out())[1];
    const ss = spawnSync('ss', ['-Hltn', `sport = :${MP_PORT}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    check('mp server listens on 127.0.0.1 only', ss.length && ss.every(l => /\s127\.0\.0\.1:\d+\s/.test(l)), ss.map(l => l.replace(/\s+/g, ' ')).join(' | '));

    // ------------------------------------------------------------------------------ A = host
    const A = await launch('A'), B = await launch('B');
    try { await A.b.defaultBrowserContext().overridePermissions(`http://127.0.0.1:${LIVE_PORT}`, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']); } catch (e) { console.log('clipboard permission:', e.message); }
    await A.page.goto(`http://127.0.0.1:${LIVE_PORT}/?live=${token}&mp=127.0.0.1:${MP_PORT}#mphost=${hostKey}`, { waitUntil: 'domcontentloaded' });
    await A.page.waitForSelector('#omo-mp-name', { timeout: 240000 });
    await A.page.type('#omo-mp-name', 'Harry'); await A.page.click('#omo-mp-go');
    await A.page.waitForFunction(() => window.__mp && window.__mp.status() === 'joined', { timeout: 15000 });
    const aUrl = await A.page.evaluate(() => location.href);
    check('host page strips the host key and live token from the address bar', !aUrl.includes(hostKey) && !aUrl.includes(token), aUrl);
    const deskLive = await A.page.evaluate(() => window.__live && window.__live.desks().map(d => d.status).join(','));
    check('host still has the live desk terminals', deskLive === 'live,live,live', deskLive);

    // host types a marker into a REAL desk shell (this text must never reach the mp channel)
    await A.page.evaluate(() => window.__setPose({ x: 7.6, y: 1.36, z: -4.32, yaw: 0, pitch: -9 }));
    await sleep(300);
    const sp = await A.page.evaluate(() => window.__live.screenPoint('desk-1'));
    await A.page.mouse.click(sp.x, sp.y); await sleep(150);
    await A.page.keyboard.type(`echo ${MARK}-$((40+2))`); await A.page.keyboard.press('Enter');
    let termOk = false; for (let i = 0; i < 80 && !termOk; i++) { termOk = new RegExp(`^${MARK}-42\\s*$`, 'm').test(await A.page.evaluate(() => window.__liveText['desk-1'])); if (!termOk) await sleep(100); }
    check('host typed into a real desk shell (marker on screen)', termOk, MARK + '-42');
    await A.page.keyboard.press('Escape'); await sleep(100);

    // share link: real button, real clipboard
    await A.page.bringToFront();
    await A.page.click('#omo-mp-share');
    await A.page.waitForFunction(() => window.__mp.link(), { timeout: 5000 });
    await sleep(200);
    const clip = await A.page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.message));
    const shown = await A.page.evaluate(() => document.querySelector('#omo-mp-link').value);
    const linkRe = new RegExp(`^http://127\\.0\\.0\\.1:${MP_PORT}/\\?room=${room}#invite=v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`);
    check("'Share link' copies http://<host>:<port>/?room=<id>#invite=<signed>", linkRe.test(clip) && clip === shown, clip.slice(0, 70) + '…');
    const link = linkRe.test(clip) ? clip : shown;
    check('share link carries neither the terminal token nor the host key', !link.includes(token) && !link.includes(hostKey));

    // ------------------------------------------------------------------------------ B = guest, joins via the link only
    await B.page.goto(link, { waitUntil: 'domcontentloaded' });
    await B.page.waitForSelector('#omo-mp-name', { timeout: 240000 });
    await B.page.evaluate(() => { document.querySelector('#omo-mp-name').value = ''; });
    await B.page.type('#omo-mp-name', 'Kaviru'); await B.page.click('#omo-mp-go');
    await B.page.waitForFunction(() => window.__mp && window.__mp.status() === 'joined', { timeout: 15000 });
    const bSelf = await B.page.evaluate(() => window.__mp.self());
    const aSelf = await A.page.evaluate(() => window.__mp.self());
    check('B joins via the share link and a display name prompt', bSelf && bSelf.role === 'guest' && bSelf.name === 'Kaviru', JSON.stringify(bSelf));
    const bUrl = await B.page.evaluate(() => location.href);
    check('the invite is stripped from the guest address bar after join', !bUrl.includes('invite='), bUrl);

    // poses
    const P_A = { x: 12.0, y: 1.65, z: -7.0, yaw: 90, pitch: -4 };
    await A.page.evaluate(p => window.__setPose(p), P_A);
    await B.page.evaluate(() => window.__setPose({ x: 9.5, y: 1.65, z: -7.2, yaw: -90, pitch: 0 }));
    await sleep(900);
    const aSeesB = await A.page.evaluate(id => ({ m: window.__mp.members().find(x => x.id === id), av: window.__mp.avatar(id) }), bSelf.id);
    const bSeesA = await B.page.evaluate(id => ({ m: window.__mp.members().find(x => x.id === id), av: window.__mp.avatar(id) }), aSelf.id);
    check("A sees B's avatar and name", aSeesB.m && aSeesB.m.name === 'Kaviru' && aSeesB.av && aSeesB.av.visible && Math.abs(aSeesB.av.x - 9.5) < 0.05, aSeesB.av && `at ${aSeesB.av.x.toFixed(2)},${aSeesB.av.z.toFixed(2)} name=${aSeesB.m && aSeesB.m.name}`);
    check("B sees A's avatar and name", bSeesA.m && bSeesA.m.name === 'Harry' && bSeesA.av && bSeesA.av.visible && Math.abs(bSeesA.av.x - 12) < 0.05, bSeesA.av && `at ${bSeesA.av.x.toFixed(2)},${bSeesA.av.z.toFixed(2)} name=${bSeesA.m && bSeesA.m.name}`);
    const ovA = await A.page.evaluate(() => [...document.querySelectorAll('#omo-mp-people .nm')].map(e => e.firstChild.textContent));
    check('overlay lists both people', ovA.includes('Harry') && ovA.includes('Kaviru'), ovA.join(', '));
    await B.page.evaluate(() => window.__setPose({ x: 6.0, y: 1.65, z: -9.0, yaw: 0, pitch: 0 }));
    await sleep(700);
    const moved = await A.page.evaluate(id => window.__mp.avatar(id), bSelf.id);
    check("moving B moves B's avatar in A's scene", Math.abs(moved.x - 6.0) < 0.05 && Math.abs(moved.z + 9.0) < 0.05, `now ${moved.x.toFixed(2)},${moved.z.toFixed(2)}`);
    // rate + smoothness: B walks for 2 s; A counts pose frames and checks the shown position moves in small steps
    const r0 = await A.page.evaluate(() => window.__mp.frames().poseRecv), tw0 = Date.now();
    const walk = B.page.evaluate(() => new Promise(res => { const t0 = performance.now(); const f = () => { const u = Math.min(1, (performance.now() - t0) / 3000); window.__setPose({ x: 6 + 6 * u, y: 1.65, z: -9, yaw: -90, pitch: 0 }); if (u < 1) requestAnimationFrame(f); else res(); }; f(); }));
    await sleep(700);
    const steps = await A.page.evaluate(id => new Promise(res => { const xs = []; const t0 = performance.now(); const f = () => { xs.push(window.__mp.avatar(id).x); if (performance.now() - t0 < 800) requestAnimationFrame(f); else res(xs); }; f(); }), bSelf.id);
    await walk;
    const r1 = await A.page.evaluate(() => window.__mp.frames().poseRecv);
    const hz = (r1 - r0) / ((Date.now() - tw0) / 1000);
    check('pose updates arrive at 15-20 Hz', hz >= 12 && hz <= 21, `${hz.toFixed(1)} Hz`);
    const bigJump = steps.slice(1).reduce((m, x, i) => Math.max(m, Math.abs(x - steps[i])), 0);
    check('others are interpolated smoothly (no per-frame jumps > 0.2 m)', bigJump < 0.2 && steps.length > 5, `max step ${bigJump.toFixed(3)} m over ${steps.length} frames`);

    // ------------------------------------------------------------------------------ guest isolation from the desks
    const bIso = await B.page.evaluate(async (t) => {
        const ws = await new Promise(res => { const w = new WebSocket(`ws://127.0.0.1:${t.port}/live/ws?desk=desk-0`); w.onopen = () => { w.close(); res('open'); }; w.onerror = () => res('refused'); });
        const api = await fetch('/live/api/sessions').then(r => r.status).catch(() => -1);
        const store = JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + document.documentElement.outerHTML;
        return { hasLive: typeof window.__live !== 'undefined', liveText: typeof window.__liveText !== 'undefined', ws, api, tokenInPage: /omo-live-token/.test(store), desks: window.__mp.desks() };
    }, { port: LIVE_PORT });
    check('guest has no terminal token (no live client, no token in storage/page)', !bIso.hasLive && !bIso.liveText && !bIso.tokenInPage, JSON.stringify({ live: bIso.hasLive, text: bIso.liveText, stored: bIso.tokenInPage }));
    check('guest cannot reach the terminal socket or API', bIso.ws === 'refused' && bIso.api === 403, `ws=${bIso.ws} api=${bIso.api}`);
    check("guest desk screens show the 'Host's desk' placeholder", bIso.desks.placeholder === 3, `${bIso.desks.placeholder} screens`);
    await B.page.evaluate(() => window.__setPose({ x: 7.6, y: 1.36, z: -4.32, yaw: 0, pitch: -9 }));
    await sleep(300);
    const dps = await B.page.evaluate(() => [0, 1, 2].map(i => window.__mp.deskPoint(i)));
    const dp = dps.filter(p => p && p.inFront).sort((a, b) => Math.hypot(a.x - W / 2, a.y - H / 2) - Math.hypot(b.x - W / 2, b.y - H / 2))[0];
    await B.page.mouse.click(dp.x, dp.y); await sleep(150);
    await B.page.screenshot({ path: path.join(OUT, 'guest-desk.png') });
    await B.page.keyboard.type('echo GUEST-TYPED-$((1+1))'); await B.page.keyboard.press('Enter'); await sleep(800);
    await B.page.keyboard.press('Escape'); await sleep(100);   // Enter opened the room chat on the guest (desks never take keys)
    const afterClick = await B.page.evaluate(() => ({ desks: window.__mp.desks(), toast: document.querySelector('#omo-mp-toast').textContent, focus: document.activeElement && document.activeElement.tagName }));
    const hostDesks = await A.page.evaluate(() => ['desk-0', 'desk-1', 'desk-2'].map(d => window.__liveText[d]).join('\n'));
    check('guest clicking a desk monitor gets the placeholder message, no focus', afterClick.desks.clicks >= 1 && /host's desk/i.test(afterClick.toast), `clicks=${afterClick.desks.clicks} toast="${afterClick.toast}"`);
    check("guest typing never reaches any of the host's shells", !/GUEST-TYPED/.test(hostDesks));

    // ------------------------------------------------------------------------------ voice
    await A.page.click('#omo-mp-voice'); await B.page.click('#omo-mp-voice');
    await A.page.waitForFunction(() => window.__mp.voice().phase === 'on', { timeout: 10000 });
    await B.page.waitForFunction(() => window.__mp.voice().phase === 'on', { timeout: 10000 });
    check('both join voice from a click (mic only after the click)', true, 'phase on/on');
    const connected = async (pg) => { const t0 = Date.now(); while (Date.now() - t0 < 20000) { const s = await pg.evaluate(() => window.__mp.voiceStats()); if (s.length && s.every(p => p.connection === 'connected')) return s; await sleep(250); } return pg.evaluate(() => window.__mp.voiceStats()); };
    const sA = await connected(A.page), sB = await connected(B.page);
    if (!(sA[0] && sA[0].connection === 'connected' && sB[0] && sB[0].connection === 'connected')) for (const [n, pg] of [['A', A.page], ['B', B.page]]) console.log('voiceDebug', n, JSON.stringify(await pg.evaluate(() => ({ dbg: window.__mp.voiceDebug(), members: window.__mp.members(), self: window.__mp.self() }))));
    check('RTCPeerConnection connected on both sides', sA[0] && sA[0].connection === 'connected' && sB[0] && sB[0].connection === 'connected', `A:${sA.map(s => s.connection)} B:${sB.map(s => s.connection)}`);
    await sleep(2000);
    const a1 = (await A.page.evaluate(() => window.__mp.voiceStats()))[0], b1 = (await B.page.evaluate(() => window.__mp.voiceStats()))[0];
    await sleep(2000);
    const a2 = (await A.page.evaluate(() => window.__mp.voiceStats()))[0], b2 = (await B.page.evaluate(() => window.__mp.voiceStats()))[0];
    check('A receives B audio: inbound-rtp bytes increasing', a2.bytesReceived > a1.bytesReceived && a1.bytesReceived > 0 && a2.hasAudio, `${a1.bytesReceived} -> ${a2.bytesReceived} B, energy ${a2.audioEnergy}`);
    check('B receives A audio: inbound-rtp bytes increasing', b2.bytesReceived > b1.bytesReceived && b1.bytesReceived > 0 && b2.hasAudio, `${b1.bytesReceived} -> ${b2.bytesReceived} B, energy ${b2.audioEnergy}`);

    // mute (M) sends nothing; unmute resumes
    await B.page.keyboard.press('KeyM'); await sleep(1500);
    const m1 = (await A.page.evaluate(() => window.__mp.voiceStats()))[0]; await sleep(1500);
    const m2 = (await A.page.evaluate(() => window.__mp.voiceStats()))[0];
    const bMuted = await B.page.evaluate(() => window.__mp.voice().muted), aSeesMuted = await A.page.evaluate(id => (window.__mp.members().find(m => m.id === id).voice || {}).muted, bSelf.id);
    await B.page.keyboard.press('KeyM'); await sleep(1500);
    const m3 = (await A.page.evaluate(() => window.__mp.voiceStats()))[0];
    check('M mutes B (no audio bytes flow, A sees the mute) and M again unmutes', bMuted && aSeesMuted && m2.bytesReceived - m1.bytesReceived < 200 && m3.bytesReceived > m2.bytesReceived + 1000, `muted delta ${m2.bytesReceived - m1.bytesReceived} B, after unmute +${m3.bytesReceived - m2.bytesReceived} B`);
    // deafen on A silences A's output and mutes A
    await A.page.click('#omo-mp-deafen'); await sleep(300);
    const deaf = await A.page.evaluate(() => window.__mp.voice());
    await A.page.click('#omo-mp-deafen'); await sleep(300);
    check('deafen button deafens (and mutes) A, click again restores', deaf.deaf && deaf.muted === false && !deaf.transmitting && (await A.page.evaluate(() => !window.__mp.voice().deaf)), JSON.stringify({ deaf: deaf.deaf, transmitting: deaf.transmitting }));

    // proximity gain on A for B
    const gainAt = async (d) => {
        await B.page.evaluate(p => window.__setPose(p), { x: P_A.x - d, y: 1.65, z: P_A.z, yaw: -90, pitch: 0 });
        await sleep(1000);
        return A.page.evaluate(id => window.__mp.gainFor(id), bSelf.id);
    };
    await A.page.evaluate(p => window.__setPose(p), { ...P_A, x: 16.5 });
    P_A.x = 16.5;
    const g15 = await gainAt(1.5), g9 = await gainAt(9), g16 = await gainAt(16);
    check("A's gain for B is ~1 at 1.5 m", Math.abs(g15.computed - 1) < 0.01 && Math.abs(g15.node - 1) < 0.05, `computed ${g15.computed} node ${g15.node} at ${g15.distance} m`);
    check("A's gain for B is < 0.3 at 9 m", g9.computed < 0.3 && g9.node < 0.3 && g9.computed > 0, `computed ${g9.computed} node ${g9.node} at ${g9.distance} m`);
    check("A's gain for B is 0 at 16 m", g16.computed === 0 && g16.node < 0.005, `computed ${g16.computed} node ${g16.node} at ${g16.distance} m`);

    // chat (bonus)
    await B.page.keyboard.press('Enter'); await sleep(150);
    await B.page.keyboard.type('hi from the guest'); await B.page.keyboard.press('Enter'); await sleep(500);
    const chatA = await A.page.evaluate(() => window.__mp.chat());
    check('text chat: Enter opens, Enter sends, A receives it', chatA.some(c => c.name === 'Kaviru' && c.text === 'hi from the guest'), JSON.stringify(chatA.slice(-1)));

    // ------------------------------------------------------------------------------ video: B walks up to A, speaking (fake mic beeps)
    const VIEW = { x: 15.6, y: 1.65, z: -9.4, yaw: 82, pitch: -3 };
    await A.page.evaluate(p => window.__setPose(p), VIEW);
    const START = { x: 4.2, z: -10.2 }, END = { x: 13.9, z: -9.1 };
    await B.page.evaluate(p => window.__setPose(p), { x: START.x, y: 1.65, z: START.z, yaw: -84, pitch: 0 });
    await sleep(800);
    await A.page.screenshot({ path: path.join(OUT, 'view-start.png') });
    const WALK_MS = 18000;
    B.page.evaluate((s, e, ms) => new Promise(res => { const t0 = performance.now(); const f = () => { const u = Math.min(1, (performance.now() - t0) / ms), k = u * u * (3 - 2 * u); window.__setPose({ x: s.x + (e.x - s.x) * k, y: 1.65 + Math.sin(u * 60) * 0.015, z: s.z + (e.z - s.z) * k + Math.sin(u * 9) * 0.25, yaw: -84 - Math.cos(u * 9) * 8, pitch: 0 }); if (u < 1) requestAnimationFrame(f); else res(); }; f(); }), START, END, WALK_MS);
    const t0 = Date.now(); let n = 0, ringSeen = 0, speakSeen = 0;
    while (Date.now() - t0 < WALK_MS + 3000) {
        await A.page.screenshot({ path: path.join(FRAMES, String(n++).padStart(6, '0') + '.jpg'), type: 'jpeg', quality: 82 });
        if (n % 5 === 0) { const s = await A.page.evaluate(id => ({ ring: window.__mp.avatar(id).ring, sp: window.__mp.speaking().includes(id) }), bSelf.id); if (s.ring > 0.1) ringSeen++; if (s.sp) speakSeen++; }
    }
    const secs = (Date.now() - t0) / 1000;
    await A.page.screenshot({ path: path.join(OUT, 'view-end.png') });
    check("B's speaking ring pulses with B's mic level in A's view (+ overlay shows speaking)", ringSeen > 0 && speakSeen > 0, `ring visible in ${ringSeen} samples, overlay speaking in ${speakSeen}`);
    const endAv = await A.page.evaluate(id => window.__mp.avatar(id), bSelf.id);
    check("B's avatar walked up to A and is on A's screen", Math.hypot(endAv.x - VIEW.x, endAv.z - VIEW.z) < 2.2 && endAv.screen.inFront && endAv.screen.x > 0 && endAv.screen.x < W, `${Math.hypot(endAv.x - VIEW.x, endAv.z - VIEW.z).toFixed(2)} m from A, screen ${Math.round(endAv.screen.x)},${Math.round(endAv.screen.y)}`);
    const mp4 = path.join(OUT, 'mp-demo.mp4'), fps = Math.max(1, n / secs);
    const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', fps.toFixed(3), '-i', path.join(FRAMES, '%06d.jpg'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
    const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).stdout);
    check('video recorded from A\'s view (~20 s)', enc.status === 0 && dur > 17 && dur < 30, `${mp4} ${dur.toFixed(1)} s, ${n} frames at ${fps.toFixed(1)} fps real time ${enc.stderr || ''}`);

    // ------------------------------------------------------------------------------ nothing secret on the mp channel
    await sleep(300);
    const all = [...mpFrames(A), ...mpFrames(B)];
    const types = {}; for (const f of all) { try { const t = JSON.parse(f.data).type; types[t] = (types[t] || 0) + 1; } catch { types['?'] = (types['?'] || 0) + 1; } }
    const leak = all.filter(f => f.data.includes(MARK) || f.data.includes(token) || /GUEST-TYPED|omo-live-42/.test(f.data));
    check('no terminal text or terminal token in any captured mp ws frame', all.length > 200 && leak.length === 0, `${all.length} frames scanned (${Object.entries(types).map(([k, v]) => k + ':' + v).join(' ')}), leaks ${leak.length}`);
    const bHostKey = mpFrames(B).filter(f => f.data.includes(hostKey)).length;
    check('the guest never receives the host key', bHostKey === 0, `${mpFrames(B).length} guest frames`);
    const logText = mpLog.join('');
    fs.writeFileSync(path.join(OUT, 'mp-server.log'), logText.replace(hostKey, '<host-key>'));
    check('no terminal text or terminal token in the mp server log', logText.length > 0 && !logText.includes(MARK) && !logText.includes(token), `${logText.split('\n').length} log lines`);
    // the guest isolation probe above deliberately hits the live socket (401) and API (403): those two console lines are expected
    const probe = (e) => /\/live\/ws\?desk=desk-0' failed|status of 403/.test(e);
    const errs = [...A.errors, ...B.errors.filter(e => !probe(e))];
    check('no page errors in A or B (except the 2 expected lines from the guest probe)', errs.length === 0 && B.errors.filter(probe).length <= 2, errs.slice(0, 3).join(' | '));
})().catch(e => check('test ran to completion', false, String(e.stack || e)))
    .finally(async () => {
        for (const b of browsers) await b.close().catch(() => {});
        for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
        await sleep(500);
        tmux('kill-server');
        const tmuxGone = tmux('has-session').status !== 0;
        try { fs.rmSync(TMUX_DIR, { recursive: true, force: true }); } catch {}
        const free = [LIVE_PORT, MP_PORT].every(p => spawnSync('ss', ['-Hltn', `sport = :${p}`], { encoding: 'utf8' }).stdout.trim() === '');
        const alive = browsers.filter(b => { const pr = b.process(); if (!pr || pr.exitCode !== null || pr.signalCode) return false; try { process.kill(pr.pid, 0); return true; } catch { return false; } }).length;
        const srvAlive = procs.filter(p => p.exitCode === null && p.signalCode === null).length;
        check('cleanup: servers stopped, ports free, browsers closed, isolated tmux killed', tmuxGone && free && !alive && !srvAlive, `tmuxGone=${tmuxGone} portsFree=${free} browsersAlive=${alive} serversAlive=${srvAlive}`);
        fs.rmSync(FRAMES, { recursive: true, force: true });
        const failed = results.filter(r => !r.ok);
        fs.writeFileSync(path.join(OUT, 'test-result.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
        console.log(`\n${failed.length ? 'FAIL' : 'PASS'}  ${results.length - failed.length}/${results.length} checks passed`);
        process.exit(failed.length ? 1 : 0);
    });
