#!/usr/bin/env node
/* t3:mp2 — multiplayer across TWO separate Omo apps in real Chrome, through the real UI.
 *
 * Starts: the real room server (plain http on 127.0.0.1 — loopback only; --trace-frames writes every relayed app
 * frame, secrets redacted, so we can prove what crossed), `create-room` for the owner key, two separate Omo apps
 * (own port, THEIA_CONFIG_DIR, OMO_SPATIAL_DATA, tmux socket, project, fixture agent CLIs — no model calls) and two
 * headless Chromes with fake microphones (test browsers only).
 * Then, by clicking the real UI: A hosts with server URL + owner key, A makes an invite link, B joins by pasting it,
 * presence + avatars both ways (B sees A's avatar move when A walks), chat both ways, A adds a desk in build mode +
 * Apply -> B gets the station, B (builder) edit reaches A, owner changes B to member -> B's edit is refused with a
 * readable message, a unique string typed into A's real terminal never reaches the server (stdout/stderr + frame
 * trace), voice on both (RTCPeerConnection connected, inbound bytes grow both ways, mute stops A's outbound bytes),
 * B leaves -> A drops B. Results + screenshots go to omo/evidence/t3-mp2/.
 *
 * Ports: OMO_2APP_PORTS (default 3540,3541,3542 = server, app A, app B).
 * Usage: node extension/test/remote-two-app-real.cjs
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'evidence', 't3-mp2');
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const [SRV_PORT, PORT_A, PORT_B] = (process.env.OMO_2APP_PORTS || '3540,3541,3542').split(',').map(Number);
const TMUX = process.env.OMO_SPATIAL_TMUX || '/home/harry/.local/share/omo/bin/tmux';
const CHROME = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
const pause = ms => new Promise(r => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-2app-'));
const UNIQUE = `omo-term-only-${crypto.randomBytes(6).toString('hex')}`;
const results = { lane: 't3-mp2', test: 'extension/test/remote-two-app-real.cjs', startedAt: new Date().toISOString(),
    setup: { roomServer: `http://127.0.0.1:${SRV_PORT} (plain http, loopback only, --trace-frames test tap)`, appA: `http://127.0.0.1:${PORT_A}`, appB: `http://127.0.0.1:${PORT_B}`, chrome: CHROME, modelCalls: 0 },
    checks: {}, screenshots: [], pass: false };
const check = (name, ok, detail) => { results.checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''}`); return !!ok; };
const children = [];

function fixtureApp(tag, port) {
    const dir = path.join(TMP, tag), project = path.join(dir, 'project'), bin = path.join(dir, 'bin'), hermes = path.join(dir, 'hermes');
    for (const d of [project, bin, path.join(hermes, 'profiles', 'default')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(project, 'README.md'), `# ${tag} project (two-app multiplayer test)\n`);
    fs.writeFileSync(path.join(hermes, 'profiles', 'default', 'config.yaml'), '# fixture profile, never a real agent\n');
    spawnSync('/usr/bin/python3', ['-c', `import sqlite3;c=sqlite3.connect(${JSON.stringify(path.join(hermes, 'state.db'))});c.execute('CREATE TABLE IF NOT EXISTS session_turn_leases(conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL)');c.commit()`]);
    const agentLog = path.join(dir, 'fixture-agents.jsonl'); fs.writeFileSync(agentLog, '');
    const recorder = `#!/usr/bin/python3\n# Fixture only: no model or network calls.\nimport os, sys, json\nwith open(${JSON.stringify(agentLog)}, 'a') as f: f.write(json.dumps({'kind': os.path.basename(sys.argv[0])}) + '\\n')\nprint('FIXTURE AGENT: NO MODEL CALLS', flush=True)\nfor line in sys.stdin: pass\n`;
    for (const k of ['hermes', 'claude', 'codex']) fs.writeFileSync(path.join(bin, k), recorder, { mode: 0o755 });
    const socket = `omo-2app-${tag}-${process.pid}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(dir, 'theia'), OMO_SPATIAL_DATA: path.join(dir, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket, OMO_SPATIAL_TMUX: TMUX,
        OMO_SPATIAL_HERMES_ROOT: hermes, OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(dir, 'app.log'), 'a');
    const proc = spawn(process.execPath, [path.join(ROOT, 'scripts/start.cjs'), '--workspace', project, '--port', String(port)], { cwd: ROOT, env, detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    const app = { tag, port, dir, socket, proc, agentLog, url: `http://127.0.0.1:${port}` };
    children.push({ kill: () => { try { process.kill(-proc.pid, 'SIGTERM'); } catch {} }, hard: () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} spawnSync(TMUX, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 }); } });
    return app;
}
async function ready(url, ms = 90000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {} await pause(300); }
    throw new Error(`${url} not ready`);
}
function toneWav(file, seconds = 120, rate = 48000) {
    const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 330 * i / rate)), 44 + i * 2);
    fs.writeFileSync(file, buf);
}

async function openApp(app, tone) {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(TMP, `chrome-${app.tag}`),
        // Test browsers only: fake mic + no sandbox.
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tone}`, '--autoplay-policy=no-user-gesture-required'],
        defaultViewport: { width: 1440, height: 900 } });
    children.push({ kill: () => browser.close().catch(() => {}), hard: () => { try { browser.process()?.kill('SIGKILL'); } catch {} } });
    const page = await browser.newPage();
    app.errors = [];
    page.on('pageerror', e => app.errors.push(String(e.message || e).slice(0, 300)));
    await page.evaluateOnNewDocument(() => {
        try { localStorage.setItem('omo.focus.clickAttach', 'false'); localStorage.setItem('omo.coach.v1', 'seen'); } catch {}
        // Theia's workspace-trust dialog can open late and steal focus: accept it whenever it appears.
        const trust = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click();
        new MutationObserver(trust).observe(document, { childList: true, subtree: true });
        // Test tap only: remember every RTCPeerConnection so getStats() can be read (the app is not changed).
        const Native = window.RTCPeerConnection;
        if (Native) { window.__pcs = []; window.RTCPeerConnection = class extends Native { constructor(...a) { super(...a); window.__pcs.push(this); } }; }
    });
    await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 90000 });
    for (let i = 0; i < 4; i++) {
        await page.evaluate(() => document.querySelector('[data-testid="create-room"]')?.click());
        try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 6000 }); break; } catch (e) { if (i === 3) throw e; }
    }
    await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 30000 });
    app.page = page; app.browser = browser;
    return page;
}
const click = (p, sel) => p.$eval(sel, e => e.click());
async function typeInto(p, sel, value) {
    await p.$eval(sel, e => e.focus());
    await p.$eval(sel, e => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ''); e.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.type(sel, value);
}
async function panel(p, open = true) {
    const isOpen = !!await p.$('[data-testid="remote-room-panel"]');
    if (isOpen !== open) { await click(p, '[data-testid="remote-room-chip"]'); await pause(300); }
}
const ds = p => p.$eval(CANVAS, c => ({ ...c.dataset }));
const peers = async p => JSON.parse((await ds(p)).peerPositions || '{}');
const shot = async (p, name) => { const f = path.join(OUT, name); await p.screenshot({ path: f }); results.screenshots.push(path.relative(ROOT, f)); console.log('SHOT', f); };
async function axis(p, key, field, goal, dir) {
    const reached = () => p.$eval(CANVAS, (c, f, g, d) => { const n = Number(c.dataset[f]); return d > 0 ? n >= g : n <= g; }, field, goal, dir);
    const end = Date.now() + 30000;
    while (!await reached()) {
        if (Date.now() > end) throw new Error(`walk ${key} did not reach ${field} ${goal}: ${JSON.stringify(await p.$eval(CANVAS, c => [c.dataset.playerX, c.dataset.playerZ]))}`);
        await p.focus(CANVAS); await p.keyboard.down(key);
        try { for (let t = 0; t < 20 && !await reached(); t++) await pause(50); } finally { await p.keyboard.up(key); }
    }
}
async function mode(p, m) { await click(p, `[data-testid="${m}-mode"]`); await pause(1200); }
async function buildPlace(p, item) {
    if (!await p.$('[data-testid="build-mode"]')) { await p.focus(CANVAS); await p.keyboard.press('b'); await p.waitForSelector('[data-testid="build-mode"]', { timeout: 5000 }); }
    await click(p, `[data-testid="build-item-${item}"]`); await pause(250);
    const wrap = await p.$eval('.omo-scene-wrap', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    for (const fy of [0.75, 0.65, 0.55, 0.85, 0.45]) for (const fx of [0.3, 0.7, 0.4, 0.6, 0.5, 0.2, 0.8]) {
        const x = wrap[0] + wrap[2] * fx, y = wrap[1] + wrap[3] * fy;
        await p.mouse.move(x - 3, y - 3); await pause(60); await p.mouse.move(x, y); await pause(200);
        const g = await p.$eval('[data-testid="build-mode"]', e => e.dataset.ghost);
        if (/,true$/.test(g || '')) { await p.mouse.click(x, y); await pause(500); return { x: Math.round(x), y: Math.round(y), ghost: g }; }
    }
    throw new Error(`no valid spot for ${item}`);
}
async function buildApply(p) {
    await p.waitForSelector('[data-testid="build-apply"]', { timeout: 5000 });
    await click(p, '[data-testid="build-apply"]');
}
async function buildExit(p) { if (await p.$('[data-testid="build-exit"]')) await click(p, '[data-testid="build-exit"]'); await pause(400); }
async function voiceStats(p) {
    return p.evaluate(async () => {
        const out = { pcs: 0, states: [], bytesReceived: 0, bytesSent: 0, packetsSent: 0, energyIn: 0 };
        for (const pc of window.__pcs || []) {
            if (pc.connectionState === 'closed') continue;
            out.pcs++; out.states.push(pc.connectionState);
            (await pc.getStats()).forEach(s => {
                if (s.type === 'inbound-rtp' && s.kind === 'audio') { out.bytesReceived += s.bytesReceived || 0; out.energyIn += s.totalAudioEnergy || 0; }
                if (s.type === 'outbound-rtp' && s.kind === 'audio') { out.bytesSent += s.bytesSent || 0; out.packetsSent += s.packetsSent || 0; }
            });
        }
        return out;
    });
}
const until = async (fn, ms, what) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await pause(250); } throw new Error(`timeout: ${what} (last ${JSON.stringify(last)})`); };
async function step(name, fn) {
    try { await fn(); } catch (e) { check(name, false, `error: ${e.message}`); }
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const tone = path.join(TMP, 'tone.wav'); toneWav(tone);
    const DATA = path.join(TMP, 'rooms'), TRACE = path.join(TMP, 'frames.jsonl'), SRV_LOG = path.join(TMP, 'room-server.log');
    const srvCmd = [path.join(ROOT, 'server/omo-room-server.cjs')];
    let A, B;
    try {
        // ---------- room server + owner key ----------
        const created = execFileSync(process.execPath, [...srvCmd, 'create-room', '--data', DATA, '--id', 'two-app-room', '--name', 'Two app room', '--owner', 'Harry'], { encoding: 'utf8' });
        const OWNER = /\b(omo1\.\S+)/.exec(created)[1];
        check('create-room printed an owner key', !!OWNER, created.split('\n')[0]);
        const srvLog = fs.openSync(SRV_LOG, 'a');
        const srv = spawn(process.execPath, [...srvCmd, '--data', DATA, '--host', '127.0.0.1', '--port', String(SRV_PORT), '--trace-frames', TRACE], { detached: true, stdio: ['ignore', srvLog, srvLog] });
        fs.closeSync(srvLog);
        children.push({ kill: () => { try { process.kill(-srv.pid, 'SIGTERM'); } catch {} }, hard: () => { try { process.kill(-srv.pid, 'SIGKILL'); } catch {} } });
        await ready(`http://127.0.0.1:${SRV_PORT}/healthz`, 15000);
        check('room server up on loopback plain http', true, `http://127.0.0.1:${SRV_PORT}/healthz`);

        // ---------- two apps + two Chromes ----------
        A = fixtureApp('app-a', PORT_A); B = fixtureApp('app-b', PORT_B);
        await Promise.all([ready(A.url), ready(B.url)]);
        check('two separate Omo apps serve', true, { A: A.url, B: B.url, socketA: A.socket, socketB: B.socket });
        await openApp(A, tone); await openApp(B, tone);
        check('both apps opened in their own headless Chrome and created a local room', true);

        // ---------- A hosts ----------
        await panel(A.page); await click(A.page, '[data-testid="remote-tab-host"]');
        await typeInto(A.page, '[data-testid="remote-room-name"]', 'Harry');
        await typeInto(A.page, '[data-testid="remote-room-server"]', `http://127.0.0.1:${SRV_PORT}`);
        await typeInto(A.page, '[data-testid="remote-room-owner-token"]', OWNER);
        await click(A.page, '[data-testid="remote-room-host"]');
        await A.page.waitForFunction(() => document.querySelector('[data-testid="remote-room-chip"]')?.getAttribute('data-phase') === 'joined', { timeout: 20000 })
            .catch(async e => { throw new Error(e.message + ' :: ' + await A.page.$eval('[data-testid="remote-room-panel"]', x => x.innerText).catch(() => '')); });
        check('A hosts through "Host a room" (server URL + owner key)', true, await A.page.$eval('[data-testid="remote-room-status"]', e => e.textContent));
        // Invite: pick builder explicitly (the panel's default invite role is member).
        const roleDefault = await A.page.$eval('[data-testid="remote-room-invite-role"]', e => e.value);
        await A.page.select('[data-testid="remote-room-invite-role"]', 'builder');
        await click(A.page, '[data-testid="remote-room-invite"]');
        await A.page.waitForSelector('[data-testid="remote-room-invite-link"]', { timeout: 10000 });
        const link = await A.page.$eval('[data-testid="remote-room-invite-link"]', e => e.value);
        check('A creates an invite link', /\/omo-room\/join\/two-app-room#invite=/.test(link), { link: link.replace(/invite=.*/, 'invite=<redacted>'), uiDefaultInviteRole: roleDefault, chosen: 'builder' });

        // ---------- B joins ----------
        await panel(B.page); await click(B.page, '[data-testid="remote-tab-join"]');
        await typeInto(B.page, '[data-testid="remote-room-name"]', 'Kaviru');
        await typeInto(B.page, '[data-testid="remote-room-link"]', link);
        await click(B.page, '[data-testid="remote-room-join"]');
        await B.page.waitForFunction(() => document.querySelector('[data-testid="remote-room-chip"]')?.getAttribute('data-phase') === 'joined', { timeout: 20000 });
        const bStatus = await B.page.$eval('[data-testid="remote-room-status"]', e => e.textContent);
        check('B joins by pasting the invite link (role builder)', /builder/.test(bStatus), bStatus);

        // ---------- presence + avatars ----------
        await step('presence list both ways', async () => {
            const both = p => p.waitForFunction(() => { const t = document.querySelector('[data-testid="presence-members"]')?.textContent || ''; return t.includes('Harry') && t.includes('Kaviru') ? t : false; }, { timeout: 15000 }).then(h => h.jsonValue());
            const ta = await both(A.page), tb = await both(B.page);
            const panelBoth = p => p.waitForFunction(() => { const t = document.querySelector('[data-testid="remote-room-members"]')?.innerText || ''; return t.includes('Harry') && t.includes('Kaviru') ? t : false; }, { timeout: 15000 }).then(h => h.jsonValue());
            const ra = await panelBoth(A.page), rb = await panelBoth(B.page);
            check('presence list both ways', true, { A_strip: ta, B_strip: tb, A_panel: ra.replace(/\n+/g, ' | '), B_panel: rb.replace(/\n+/g, ' | ') });
        });
        await panel(A.page, false); await panel(B.page, false);
        let aId;
        await step('avatars both ways + peer avatar moves when A walks', async () => {
            const pa = await until(async () => { const m = await peers(A.page); return Object.values(m).some(x => x.name === 'Kaviru') && m; }, 15000, 'A sees B avatar');
            const pb = await until(async () => { const m = await peers(B.page); return Object.values(m).some(x => x.name === 'Harry') && m; }, 15000, 'B sees A avatar');
            aId = Object.entries(pb).find(([, v]) => v.name === 'Harry')[0];
            const before = pb[aId];
            await A.page.focus(CANVAS);
            const startX = Number((await ds(A.page)).playerX);
            await axis(A.page, 'a', 'playerX', startX - 1.2, -1);
            const after = await until(async () => { const v = (await peers(B.page))[aId]; return v && Math.hypot(v.x - before.x, v.z - before.z) > 0.5 && v; }, 10000, 'B sees A move');
            check('avatars both ways + peer avatar moves when A walks', true, { A_sees: Object.values(pa).map(v => v.name), B_sees: Object.values(pb).map(v => v.name), A_on_B_before: { x: before.x, z: before.z }, A_on_B_after: { x: after.x, z: after.z } });
        });

        // ---------- chat both ways ----------
        await step('chat both ways', async () => {
            for (const p of [A.page, B.page]) if (!await p.$('[data-testid="chat-panel"]')) await click(p, '[data-testid="chat-open"]');
            const say = async (p, text) => { await p.focus('[data-testid="chat-input"]'); await p.type('[data-testid="chat-input"]', text); await p.keyboard.press('Enter'); };
            const logHas = (p, text) => p.waitForFunction(t => (document.querySelector('[data-testid="chat-log"]')?.textContent || '').includes(t), { timeout: 10000 }, text);
            await say(A.page, 'hello from Harry'); await logHas(B.page, 'hello from Harry');
            await say(B.page, 'hi Harry, Kaviru here'); await logHas(A.page, 'hi Harry, Kaviru here');
            check('chat both ways', true, { A_to_B: 'hello from Harry', B_to_A: 'hi Harry, Kaviru here' });
            for (const p of [A.page, B.page]) if (await p.$('[data-testid="chat-close"]')) await click(p, '[data-testid="chat-close"]');
        });

        // ---------- unique string in A's real terminal (while connected) ----------
        await step('terminal text stays local', async () => {
            await mode(A.page, 'walk');
            await A.page.focus(CANVAS); await A.page.keyboard.press('Escape');
            let pose = await ds(A.page);
            if (Number(pose.playerZ) < 2.25) await axis(A.page, 's', 'playerZ', 2.25, 1);
            pose = await ds(A.page);
            if (Number(pose.playerX) > -2.5) await axis(A.page, 'a', 'playerX', -2.5, -1); else await axis(A.page, 'd', 'playerX', -2.5, 1);
            await axis(A.page, 'w', 'playerZ', 1.9, -1);
            const pt = await A.page.$eval(CANVAS, e => { const r = e.getBoundingClientRect(), t = JSON.parse(e.dataset.stationTargets || '{}').terminal; return t && { x: r.left + t.x, y: r.top + t.y }; });
            if (!pt) throw new Error('desk monitor has no projected target');
            await A.page.mouse.click(pt.x, pt.y);
            await A.page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]', { timeout: 60000 });
            await A.page.keyboard.type(`echo ${UNIQUE}`); await A.page.keyboard.press('Enter');
            await A.page.waitForFunction(u => (document.querySelector('[data-testid="in-world-terminal-output"]')?.textContent || '').split(u).length > 2, { timeout: 30000 }, UNIQUE);
            check('unique string typed into A\'s real terminal and echoed by the shell', true, UNIQUE);
            await A.page.keyboard.press('Escape'); await pause(500);
            await A.page.evaluate(() => document.querySelector('[data-testid="focus-detach"],[data-testid="focus-exit"]')?.click()); await pause(500);
        });

        // ---------- A adds a desk; B gets it ----------
        await step('A desk -> B within 10 s', async () => {
            await mode(A.page, 'overview'); await mode(B.page, 'overview');
            const before = JSON.parse((await ds(A.page)).worldStations || '[]');
            const at = await buildPlace(A.page, 'agent-desk');
            await buildApply(A.page);
            const t0 = Date.now();
            const aStations = await until(async () => { const s = JSON.parse((await ds(A.page)).worldStations || '[]'); return s.length > before.length && s; }, 10000, 'A applied desk');
            const newId = aStations.find(id => !before.includes(id));
            const bStations = await until(async () => { const s = JSON.parse((await ds(B.page)).worldStations || '[]'); return s.includes(newId) && s; }, 10000, 'B got desk');
            const ms = Date.now() - t0;
            await buildExit(A.page);
            check('A desk -> B within 10 s', ms <= 10000, { placedAt: at, newStation: newId, msToB: ms, A: aStations, B: bStations, notice: await A.page.$eval('[data-testid="build-notice"]', e => e.textContent).catch(() => '') });
        });

        // ---------- B (builder) edit reaches A ----------
        await step('B builder edit -> A', async () => {
            const before = JSON.parse((await ds(B.page)).worldEntities || '[]');
            const at = await buildPlace(B.page, 'decor-plant');
            await buildApply(B.page);
            const bEnts = await until(async () => { const s = JSON.parse((await ds(B.page)).worldEntities || '[]'); return s.length > before.length && s; }, 10000, 'B applied plant');
            const newId = bEnts.find(id => !before.includes(id));
            const t0 = Date.now();
            await until(async () => JSON.parse((await ds(A.page)).worldEntities || '[]').includes(newId), 10000, 'A got plant');
            await buildExit(B.page);
            check('B builder edit -> A', true, { placedAt: at, newEntity: newId, msToA: Date.now() - t0 });
        });

        // ---------- owner makes B a member; B's edit refused readably ----------
        await step('member-role edit refused with readable message', async () => {
            await panel(A.page);
            await A.page.waitForSelector('[data-testid="remote-room-member-role"]', { timeout: 5000 });
            await A.page.select('[data-testid="remote-room-member-role"]', 'member');
            await panel(B.page);
            await B.page.waitForFunction(() => /role: member/.test(document.querySelector('[data-testid="remote-room-status"]')?.textContent || ''), { timeout: 10000 });
            const bRole = await B.page.$eval('[data-testid="remote-room-status"]', e => e.textContent);
            await panel(B.page, false); await panel(A.page, false);
            const rev = (await ds(A.page)).worldRevision;
            await buildPlace(B.page, 'decor-plant');
            await buildApply(B.page);
            const msg = await B.page.waitForFunction(() => { const t = document.querySelector('[data-testid="build-notice"]')?.textContent || ''; return /role|builder|owner/i.test(t) ? t : false; }, { timeout: 10000 }).then(h => h.jsonValue());
            await pause(1500);
            const revAfter = (await ds(A.page)).worldRevision;
            await shot(B.page, 'mp2-B-member-refused.png').catch(() => {});
            if (await B.page.$('[data-testid="build-discard"]')) await click(B.page, '[data-testid="build-discard"]');
            await buildExit(B.page);
            check('member-role edit refused with readable message', /Your role in this room is “member”/.test(msg) && revAfter === rev, { bStatus: bRole, message: msg, roomRevisionUnchanged: `${rev} -> ${revAfter}` });
        });

        // ---------- screenshots of each room showing the other ----------
        await step('screenshots A and B rooms', async () => {
            for (const p of [A.page, B.page]) await mode(p, 'overview');
            await pause(800);
            await shot(A.page, 'mp2-A-room-sees-B.png');
            await shot(B.page, 'mp2-B-room-sees-A.png');
            const va = Object.values(await peers(A.page)).map(v => ({ name: v.name, visible: v.visible })), vb = Object.values(await peers(B.page)).map(v => ({ name: v.name, visible: v.visible }));
            check('screenshots A and B rooms', va.some(v => v.name === 'Kaviru') && vb.some(v => v.name === 'Harry'), { A_peers: va, B_peers: vb });
        });

        // ---------- voice ----------
        await step('voice connected + audio both ways', async () => {
            for (const p of [A.page, B.page]) {
                await p.waitForSelector('[data-testid="voice-enable"]:not([disabled])', { timeout: 10000 });
                await click(p, '[data-testid="voice-enable"]');
                await p.waitForSelector('[data-testid="voice-panel"][data-voice-phase="on"]', { timeout: 15000 });
                await click(p, '[data-testid="voice-mode-open"]');
            }
            for (const p of [A.page, B.page]) await p.waitForFunction(() => document.querySelector('[data-testid="voice-peers"] [data-peer-id]')?.dataset.connection === 'connected', { timeout: 30000 });
            const a1 = await voiceStats(A.page), b1 = await voiceStats(B.page);
            await pause(3000);
            const a2 = await voiceStats(A.page), b2 = await voiceStats(B.page);
            const ok = a2.states.includes('connected') && b2.states.includes('connected') && a2.bytesReceived > a1.bytesReceived && b2.bytesReceived > b1.bytesReceived;
            check('voice connected + audio both ways', ok, { A: { states: a2.states, inboundBytes: [a1.bytesReceived, a2.bytesReceived], outboundBytes: [a1.bytesSent, a2.bytesSent] }, B: { states: b2.states, inboundBytes: [b1.bytesReceived, b2.bytesReceived], outboundBytes: [b1.bytesSent, b2.bytesSent] } });
            await shot(A.page, 'mp2-voice-panel.png');
            const relay = fs.readFileSync(TRACE, 'utf8').split('\n').filter(l => /"t\\":\\"signal\\"/.test(l)).length;
            results.checks['voice connected + audio both ways'].detail.signalFramesThroughRoomServer = relay;
        });
        await step('mute stops A outbound bytes', async () => {
            await click(A.page, '[data-testid="voice-mute"]');
            await A.page.waitForSelector('[data-testid="voice-mute"][aria-pressed="true"]', { timeout: 5000 });
            await pause(1500);
            const m1 = await voiceStats(A.page), bIn1 = await voiceStats(B.page);
            await pause(3000);
            const m2 = await voiceStats(A.page), bIn2 = await voiceStats(B.page);
            check('mute stops A outbound bytes', m2.bytesSent === m1.bytesSent && m2.packetsSent === m1.packetsSent, { A_outboundBytes: [m1.bytesSent, m2.bytesSent], A_packetsSent: [m1.packetsSent, m2.packetsSent], B_inboundBytes: [bIn1.bytesReceived, bIn2.bytesReceived] });
            await click(A.page, '[data-testid="voice-mute"]');
            await pause(2000);
            const u1 = await voiceStats(A.page), ub1 = await voiceStats(B.page); await pause(2500); const u2 = await voiceStats(A.page), ub2 = await voiceStats(B.page);
            check('unmute: A outbound bytes grow again and B receives them', u2.bytesSent > u1.bytesSent && ub2.bytesReceived > ub1.bytesReceived && u2.states.includes('connected'), { A_outboundBytes: [u1.bytesSent, u2.bytesSent], B_inboundBytes: [ub1.bytesReceived, ub2.bytesReceived], A_states: u2.states });
        });

        // ---------- B leaves ----------
        await step('B leaves -> A drops B', async () => {
            await panel(B.page); await click(B.page, '[data-testid="remote-room-leave"]');
            await A.page.waitForFunction(() => !(document.querySelector('[data-testid="presence-members"]')?.textContent || '').includes('Kaviru'), { timeout: 15000 });
            const left = await A.page.$eval('[data-testid="presence-members"]', e => e.textContent);
            await until(async () => !Object.values(await peers(A.page)).some(v => v.name === 'Kaviru'), 10000, 'avatar gone');
            check('B leaves -> A drops B', true, { A_strip: left, B_chip: await B.page.$eval('[data-testid="remote-room-chip"]', e => e.textContent) });
        });

        // ---------- terminal string never crossed the server ----------
        await pause(1000);
        const trace = fs.existsSync(TRACE) ? fs.readFileSync(TRACE, 'utf8') : '';
        const srvText = fs.readFileSync(SRV_LOG, 'utf8');
        const frames = trace.split('\n').filter(Boolean).length;
        check('terminal string never in server log or any relayed frame', frames > 50 && !trace.includes(UNIQUE) && !srvText.includes(UNIQUE), { unique: UNIQUE, framesTraced: frames, inTrace: trace.includes(UNIQUE), inServerLog: srvText.includes(UNIQUE), serverLogBytes: srvText.length });
        check('no owner key in trace or server log', !trace.includes(OWNER) && !srvText.includes(OWNER));
        check('no fixture agent started', fs.readFileSync(A.agentLog, 'utf8') === '' && fs.readFileSync(B.agentLog, 'utf8') === '');
        check('no page errors', !A.errors.length && !B.errors.length, { A: A.errors.slice(0, 5), B: B.errors.slice(0, 5) });
        fs.copyFileSync(SRV_LOG, path.join(OUT, 'mp2-room-server.log'));
        fs.writeFileSync(path.join(OUT, 'mp2-frame-trace-summary.json'), JSON.stringify(trace.split('\n').filter(Boolean).reduce((acc, l) => { try { const t = JSON.parse(JSON.parse(l).text).t; const k = `${JSON.parse(l).dir}:${t}`; acc[k] = (acc[k] || 0) + 1; } catch {} return acc; }, {}), null, 1));
    } catch (e) {
        check('scenario', false, e.stack?.split('\n').slice(0, 3).join(' | ') || String(e));
    } finally {
        results.finishedAt = new Date().toISOString();
        const vals = Object.values(results.checks);
        results.summary = `${vals.filter(c => c.pass).length}/${vals.length} checks passed`;
        results.pass = vals.length > 0 && vals.every(c => c.pass);
        for (const a of [A, B]) if (a) try { fs.copyFileSync(path.join(a.dir, 'app.log'), path.join(OUT, `mp2-${a.tag}.log`)); } catch {}
        fs.writeFileSync(path.join(OUT, 'remote-two-app-results.json'), JSON.stringify(results, null, 2));
        console.log(`\n${results.summary} -> ${path.join(OUT, 'remote-two-app-results.json')}`);
        for (const c of children.reverse()) await c.kill();
        await pause(3000);
        for (const c of children) c.hard();
        fs.rmSync(TMP, { recursive: true, force: true });
        process.exit(results.pass ? 0 : 1);
    }
})();
