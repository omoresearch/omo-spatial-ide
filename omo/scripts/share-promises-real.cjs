#!/usr/bin/env node
/*
 * promise:share — real-app check of sharing (real local app on an owned port, a real room server on
 * 127.0.0.1, two real Chrome browsers on the GPU with fake media devices; fixture CLIs only, never real agents).
 *   L7  CSV -> world: A opens "Build a world from data" from the ⌘K palette, picks fixtures/customers.csv,
 *       groups by "region", builds; the planner proposal is applied; the rooms exist and their boards print
 *       readable notes (the CSV rows), seen up close.
 *   L7  World file round trip: A presses "Share this world" in the room panel (a real download); the file has
 *       no paths, tokens or codes. B opens that file with "Open a world file" (real file chooser); after Apply
 *       B's world has the same rooms, boards and labels.
 *   L6  Room codes: A hosts a room on the room server (seeded with the data world) and makes an invite; the
 *       panel shows a MARS-4827 style code. B joins with only that code + the server address.
 *   L10 Shared pointer: A holds Q (walking); B's canvas draws A's beam (data-pointers has A's spot); release clears it.
 *   L5  Proximity voice: both turn voice on; B stands ~1 m from A then walks to 13 m; the volume A's app applies
 *       for B (canvas data-voice-gains: volume + the real gain node value) goes from ~1.0 to 0.
 *   Security: B's page never holds the owner key, the invite token or A's terminal text.
 * Screenshots: omo/evidence/promises-share/ (1-palette, 2-data-dialog, 3-data-world, 4-boards-close, 5-room-panel,
 *   6-opened-on-b, 7-room-code, 8-joined-b, 9-pointer-b, 10-voice-near, 11-voice-far).
 * Usage: node scripts/share-promises-real.cjs [outDir] [port 3750-3759]
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'evidence', 'promises-share'));
const PORT = Number(process.argv[3] || 3756);
if (!(PORT >= 3750 && PORT <= 3759)) { console.error('Use a port from 3750 to 3759.'); process.exit(2); }
const CSV = path.join(ROOT, 'extension', 'test', 'fixtures', 'customers.csv');
const ROOM_BIN = path.join(ROOT, 'server', 'omo-room-server.cjs');
const CANVAS = 'canvas[data-testid="omo-world-canvas"]';
const pause = ms => new Promise(r => setTimeout(r, ms));
const checks = []; let failed = 0;
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`); };

(async () => {
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const S = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-share-'));
    const project = path.join(S, 'share'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# share\n');
    const bin = path.join(S, 'bin'); fs.mkdirSync(bin);
    for (const k of ['hermes', 'claude', 'codex']) { fs.writeFileSync(path.join(bin, k), '#!/usr/bin/python3\n# fixture only\nimport sys\nprint("FIXTURE", flush=True)\nfor l in sys.stdin: pass\n'); fs.chmodSync(path.join(bin, k), 0o755); }
    const socket = `omo-share-${PORT}`;
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(S, 'theia'), OMO_SPATIAL_DATA: path.join(S, 'data'), OMO_SPATIAL_TMUX_SOCKET: socket,
        OMO_SPATIAL_HERMES_BIN: path.join(bin, 'hermes'), OMO_SPATIAL_CLAUDE_BIN: path.join(bin, 'claude'), OMO_SPATIAL_CODEX_BIN: path.join(bin, 'codex') };
    const log = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--workspace', project, '--port', String(PORT)], { env, detached: true, stdio: ['ignore', log, log] });
    // Real room server, loopback only.
    const ROOM_DATA = path.join(S, 'rooms');
    const created = execFileSync(process.execPath, [ROOM_BIN, 'create-room', '--data', ROOM_DATA, '--id', 'share-room', '--name', 'Share room', '--owner', 'Ana'], { encoding: 'utf8' });
    const ownerToken = /\b(omo1\.\S+)/.exec(created)[1];
    const rooms = spawn(process.execPath, [ROOM_BIN, '--data', ROOM_DATA, '--host', '127.0.0.1', '--port', '0', '--quiet'], { stdio: ['ignore', 'pipe', fs.openSync(path.join(OUT, 'room-server.log'), 'a')] });
    const roomInfo = await new Promise((r, j) => { rooms.stdout.once('data', d => r(JSON.parse(String(d)))); rooms.once('exit', c => j(new Error(`room server exited ${c}`))); });
    const browsers = []; const errors = { a: [], b: [] };
    let A, B;
    try {
        check('The room server listens on 127.0.0.1 only', /^http:\/\/127\.0\.0\.1:\d+$/.test(roomInfo.url), roomInfo.url);
        for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {} await pause(300); }

        const open = async tag => {
            const browser = await puppeteer.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: path.join(S, `chrome-${tag}`),
                args: ['--no-sandbox', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                    '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
            browsers.push(browser);
            const page = await browser.newPage();
            page.setDefaultTimeout(60000);
            page.on('pageerror', e => errors[tag].push(String(e.message || e)));
            await browser.defaultBrowserContext().overridePermissions(`http://127.0.0.1:${PORT}`, ['microphone']);
            await page.evaluateOnNewDocument(() => {
                try { localStorage.setItem('omo.coach.v1', 'seen'); localStorage.setItem('omo.focus.clickAttach', 'false'); } catch {}
                new MutationObserver(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors')?.click()).observe(document, { childList: true, subtree: true });
            });
            const downloads = path.join(S, `downloads-${tag}`); fs.mkdirSync(downloads);
            const cdp = await page.createCDPSession();
            await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
            await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', { timeout: 180000 });
            for (let i = 0; i < 3; i++) { await page.$eval('[data-testid="create-room"]', e => e.click()).catch(() => {}); try { await page.waitForSelector(`${CANVAS}[data-navigation="walk"]`, { timeout: 8000 }); break; } catch {} }
            await page.waitForFunction(() => !document.querySelector('.theia-preload'), { timeout: 60000 }); await pause(2000);
            const w = {
                tag, page, browser, downloads,
                click: sel => page.$eval(sel, e => e.click()),
                shot: name => page.screenshot({ path: path.join(OUT, `${name}.png`) }),
                visible: sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; }, sel),
                data: key => page.$eval(CANVAS, (c, k) => c.dataset[k] ?? '', key),
                json: async key => { try { return JSON.parse(await w.data(key) || 'null'); } catch { return null; } },
                pose: () => page.$eval(CANVAS, c => ({ x: Number(c.dataset.playerX), z: Number(c.dataset.playerZ) })),
                savedWorld: () => page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('omo.world.v2:')); return k ? JSON.parse(localStorage.getItem(k)) : null; }),
                palette: async () => { await page.evaluate(() => window.dispatchEvent(new CustomEvent('omo:palette-toggle'))); await page.waitForSelector('[data-testid="command-palette"]', { timeout: 5000 }); },
                command: async id => { await w.palette(); await page.waitForSelector(`[data-testid="palette-item"][data-command="${id}"]`, { timeout: 5000 }); await w.click(`[data-testid="palette-item"][data-command="${id}"]`); await pause(400); },
                typeInto: async (sel, text) => { await page.click(sel, { count: 3 }); await page.keyboard.press('Backspace'); await page.type(sel, text, { delay: 5 }); },
                /** Open the room panel (the share sheet when immersive; the dock chip otherwise). */
                roomPanel: async () => {
                    if (await w.visible('[data-testid="remote-room-panel"]')) return;
                    if (!await w.visible('[data-testid="remote-room-chip"]')) await w.command('share');
                    await page.waitForSelector('[data-testid="remote-room-chip"]', { timeout: 8000 }); await pause(300);
                    if (!await w.visible('[data-testid="remote-room-panel"]')) await w.click('[data-testid="remote-room-chip"]');
                    await page.waitForSelector('[data-testid="remote-room-panel"]', { timeout: 8000 });
                },
                closePanels: async () => { await page.evaluate(() => document.querySelector('[data-testid="remote-room-panel"] header button')?.click()); await pause(200); await page.evaluate(() => document.querySelector('[data-testid="settings-sheet-close"], .omo-sheet [aria-label="Close"]')?.click()); await pause(200); if (await page.$('[data-testid="settings-sheet"], .omo-sheet')) { await page.keyboard.press('Escape').catch(() => {}); } await pause(300); },
                apply: async () => { await page.waitForSelector('[data-testid="build-apply"]', { timeout: 15000 }); await w.click('[data-testid="build-apply"]'); await pause(800);
                    if (await page.$('[data-testid="build-exit"]')) { await w.click('[data-testid="build-exit"]').catch(() => {}); await pause(600); } }
            };
            return w;
        };
        A = await open('a');
        const gpu = await A.page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl'); const x = g?.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        check('Chrome renders on the GPU (not SwiftShader)', !/swiftshader|llvmpipe|software/i.test(gpu), gpu);

        // ---------------------------------------------------------------- L7: CSV -> world (A, local)
        await A.palette();
        const cmds = await A.page.$$eval('[data-testid="palette-item"]', els => els.map(e => ({ id: e.dataset.command, label: e.querySelector('.omo-palette-label')?.firstChild?.textContent, disabled: e.getAttribute('aria-disabled') === 'true' })));
        const want = { 'world-share': 'Share this world', 'world-open': 'Open a world file', 'world-from-data': 'Build a world from data' };
        check('⌘K has Share this world / Open a world file / Build a world from data (enabled)', Object.entries(want).every(([id, label]) => cmds.some(c => c.id === id && c.label === label && !c.disabled)), cmds.filter(c => c.id?.startsWith('world-')));
        await A.page.type('[data-testid="command-palette-input"]', 'world', { delay: 10 }); await pause(300);
        await A.shot('1-palette');
        await A.click('[data-testid="palette-item"][data-command="world-from-data"]');
        await A.page.waitForSelector('[data-testid="data-world-dialog"]', { timeout: 8000 });
        const csvInput = await A.page.$('[data-testid="data-csv-input"]');
        await csvInput.uploadFile(CSV);
        await A.page.waitForSelector('[data-testid="data-group-by"]', { timeout: 8000 });
        const headers = await A.page.$$eval('[data-testid="data-group-by"] option', os => os.map(o => o.textContent));
        await A.page.select('[data-testid="data-group-by"]', String(headers.indexOf('region')));
        await pause(400);
        const preview = await A.page.$$eval('[data-testid="data-preview"] li', ls => ls.map(l => ({ room: l.dataset.room, boards: l.querySelector('small')?.textContent ?? '' })));
        check('The data dialog groups customers.csv by region into 4 rooms with note boards', preview.length === 4 && preview.every(p => /North|South|East|West/.test(p.room) && p.boards.length > 0), preview);
        await A.shot('2-data-dialog');
        await A.click('[data-testid="data-build"]');
        await A.page.waitForSelector('[data-testid="build-proposal"]', { timeout: 15000 }).catch(() => {});
        const pendingText = await A.page.$eval('[data-testid="build-proposal"]', e => e.textContent).catch(() => '');
        const savedBefore = await A.savedWorld();
        check('Build makes ONE pending planner proposal (nothing saved yet)', !!pendingText && !(savedBefore?.entities ?? []).some(e => e.kind === 'room'), pendingText.slice(0, 160));
        await A.apply();
        await A.page.waitForFunction(() => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.worldRooms || '[]').length === 4, { timeout: 20000 }).catch(() => {});
        const dataWorld = await A.savedWorld();
        const roomsA = (dataWorld?.entities ?? []).filter(e => e.kind === 'room').map(e => e.label);
        const boardsA = (dataWorld?.entities ?? []).filter(e => e.kind === 'decor' && e.decor === 'whiteboard').map(e => e.label);
        check('After Apply the saved world has the 4 region rooms and their boards', roomsA.length === 4 && ['North', 'South', 'East', 'West'].every(r => roomsA.some(l => l.startsWith(r))) && boardsA.length >= 8, { roomsA, boards: boardsA.length });
        check('Boards carry CSV rows (customer names), not paths or ids', boardsA.some(b => /Acme Bakery/.test(b)) && boardsA.some(b => /Harbor, Lights & Co/.test(b)) && !boardsA.some(b => /\/home|omo1\.|omoinv/.test(b)), boardsA.slice(0, 6));
        await pause(1500); await A.shot('3-data-world');
        // Walk into the nearest room until its boards fill part of the view.
        await A.page.focus(CANVAS);
        const notesAt = async () => (await A.json('boardNotes')) ?? [];
        await A.page.keyboard.down('w');
        await A.page.waitForFunction(() => { const b = JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.boardNotes || '[]'); return b.some(n => n.visible && n.box[2] - n.box[0] > 260); }, { timeout: 15000 }).catch(() => {});
        await A.page.keyboard.up('w'); await pause(1200);
        const notes = await notesAt();
        const close = notes.filter(n => n.visible && n.box[2] - n.box[0] > 200);
        check('Up close the data boards are drawn with their notes (readable size on screen)', close.length >= 1 && close.every(n => n.note.length > 3), close.map(n => ({ note: n.note, w: n.box[2] - n.box[0], h: n.box[3] - n.box[1] })));
        await A.shot('4-boards-close');
        // Contrast on the nearest board: dark ink pixels on a light board.
        if (close[0]) {
            const [l, t, r, b] = close[0].box, clip = { x: Math.max(0, l), y: Math.max(0, t), width: Math.max(1, Math.min(1440, r) - Math.max(0, l)), height: Math.max(1, Math.min(900, b) - Math.max(0, t)) };
            const img = await A.page.screenshot({ clip, encoding: 'base64' });
            const ink = await A.page.evaluate(async data => { const i = new Image(); i.src = 'data:image/png;base64,' + data; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let light = 0, dark = 0; for (let n = 0; n < d.length; n += 4) { const y = 0.2126 * d[n] + 0.7152 * d[n + 1] + 0.0722 * d[n + 2]; if (y > 170) light++; else if (y < 110 && d[n + 2] > d[n]) dark++; } const all = d.length / 4; return { light: +(light / all).toFixed(3), ink: +(dark / all).toFixed(3) }; }, img);
            check('The nearest board shows dark ink text on a light board (pixel check)', ink.light > 0.25 && ink.ink > 0.02, ink);
        } else check('The nearest board shows dark ink text on a light board (pixel check)', false, 'no board close enough');

        // ---------------------------------------------------------------- L7: Share this world -> file (A)
        await A.roomPanel();
        const row = await A.page.$$eval('[data-testid="world-share-row"] button', bs => bs.map(b => ({ id: b.dataset.testid, text: b.textContent, disabled: b.disabled })));
        check('The room panel has the three world buttons', row.length === 3 && row.map(r => r.text).join('|') === 'Share this world|Open a world file|Build a world from data' && row.every(r => !r.disabled), row);
        await A.shot('5-room-panel');
        await A.click('[data-testid="world-share"]');
        let file;
        for (let i = 0; i < 50 && !file; i++) { file = fs.readdirSync(A.downloads).find(f => f.endsWith('.omo-world.json')); if (!file) await pause(200); }
        const filePath = file && path.join(A.downloads, file);
        const text = filePath ? fs.readFileSync(filePath, 'utf8') : '';
        const parsed = text ? JSON.parse(text) : null;
        check('Share this world downloads a .omo-world.json file', !!file && parsed?.format === 'omo-world' && parsed?.version === 1, { file, bytes: text.length });
        check('The world file holds no paths, tokens, room codes or the owner key', !!text && !text.includes(S) && !/\/home\/|\/tmp\/|omo1\.|omoinv|#invite=|[A-Z]{4}-\d{4}/.test(text) && !text.includes(ownerToken), { redacted: parsed?.redacted });
        await A.closePanels();

        // ---------------------------------------------------------------- L7: Open a world file (B)
        B = await open('b');
        await B.roomPanel();
        const [chooser] = await Promise.all([B.page.waitForFileChooser({ timeout: 10000 }), B.click('[data-testid="world-open"]')]);
        await chooser.accept([filePath]);
        await B.page.waitForSelector('[data-testid="build-proposal"]', { timeout: 15000 }).catch(() => {});
        check('Open a world file makes a pending proposal on B', await B.visible('[data-testid="build-proposal"]'), await B.page.$eval('.omo-footer [role]', e => e.textContent).catch(() => ''));
        await B.apply();
        await B.page.waitForFunction(() => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.worldRooms || '[]').length === 4, { timeout: 20000 }).catch(() => {});
        const worldB = await B.savedWorld();
        const sig = w => JSON.stringify((w?.entities ?? []).filter(e => e.kind !== 'station').map(e => [e.id, e.kind, e.label ?? '', e.decor ?? '', Math.round(e.transform.x * 10), Math.round(e.transform.z * 10)]));
        check('Round trip: B\'s world after Apply has the same rooms, boards and labels as A\'s', !!worldB && sig(worldB) === sig(dataWorld) && worldB.name === dataWorld.name && worldB.shell.width === dataWorld.shell.width,
            { a: (dataWorld?.entities ?? []).length, b: (worldB?.entities ?? []).length, name: worldB?.name });
        await pause(1500); await B.shot('6-opened-on-b');

        // ---------------------------------------------------------------- L6: room code (A hosts, B joins by code)
        await A.roomPanel();
        await A.click('[data-testid="remote-tab-host"]');
        await A.typeInto('[data-testid="remote-room-name"]', 'Ana');
        await A.typeInto('[data-testid="remote-room-server"]', roomInfo.url);
        await A.typeInto('[data-testid="remote-room-owner-token"]', ownerToken);
        await A.typeInto('[data-testid="remote-room-code"]', 'share-room');
        await A.click('[data-testid="remote-room-host"]');
        await A.page.waitForFunction(() => /Connected to/.test(document.querySelector('[data-testid="remote-room-status"]')?.textContent ?? ''), { timeout: 30000 }).catch(() => {});
        await pause(1500);
        check('A hosts the room on the room server', /Connected to/.test(await A.page.$eval('[data-testid="remote-room-status"]', e => e.textContent).catch(() => '')), { err: await A.page.$eval('[data-testid="remote-room-error"]', e => e.textContent).catch(() => ''), transport: await A.data('voiceTransport') });
        await A.click('[data-testid="remote-room-invite"]');
        await A.page.waitForSelector('[data-testid="remote-room-code-value"]', { timeout: 15000 }).catch(() => {});
        const code = await A.page.$eval('[data-testid="remote-room-code-value"]', e => e.textContent.trim()).catch(() => '');
        check('The owner sees a short room code (4 letters, 4 digits)', /^[A-HJKMNP-Z]{4}-[2-9]{4}$/.test(code), code);
        await A.shot('7-room-code');
        await A.closePanels();

        await B.roomPanel();
        await B.click('[data-testid="remote-tab-join"]').catch(() => {});
        await B.typeInto('[data-testid="remote-room-name"]', 'Ben');
        await B.typeInto('[data-testid="remote-room-code-input"]', code.toLowerCase());
        await B.typeInto('[data-testid="remote-room-code-server"]', roomInfo.url);
        await B.click('[data-testid="remote-room-code-join"]');
        await B.page.waitForFunction(() => /Connected to/.test(document.querySelector('[data-testid="remote-room-status"]')?.textContent ?? ''), { timeout: 30000 }).catch(() => {});
        const statusB = await B.page.$eval('[data-testid="remote-room-status"]', e => e.textContent).catch(() => '');
        await pause(1500);
        check('B joins with only the code and the server address', /Connected to/.test(statusB) && /member/.test(statusB), { statusB, err: await B.page.$eval('[data-testid="remote-room-error"]', e => e.textContent).catch(() => ''), transport: await B.data('voiceTransport') });
        await B.page.waitForFunction(() => document.querySelectorAll('[data-testid="remote-room-members"] li').length === 2, { timeout: 15000 }).catch(() => {});
        check('Both people are in the room', (await B.page.$$('[data-testid="remote-room-members"] li')).length === 2);
        const memberRow = await B.page.$$eval('[data-testid="world-share-row"] button', bs => bs.map(b => ({ id: b.dataset.testid, disabled: b.disabled })));
        check('A member (B) may share the world but cannot open or build a world', memberRow.find(r => r.id === 'world-share')?.disabled === false && memberRow.filter(r => r.id !== 'world-share').every(r => r.disabled), memberRow);
        await B.shot('8-joined-b');
        await B.closePanels();
        await B.page.waitForFunction(() => JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.worldRooms || '[]').length === 4, { timeout: 15000 }).catch(() => {});
        const roomWorldB = await B.json('worldRooms');
        const diag = async w => ({ rooms: await w.json('worldRooms'), name: await w.data('worldName'), peers: await w.data('peerPositions'), pose: await w.pose(), transport: await w.data('voiceTransport'), presence: await w.page.$eval('[data-testid="presence-bar"]', e => e.dataset.phase).catch(() => '?'), chip: await w.page.$eval('[data-testid="remote-room-chip"]', e => e.dataset.phase + ' ' + e.textContent).catch(() => '?'), people: await w.page.$eval('[data-testid="topbar-people"]', e => e.textContent).catch(() => '?'), alert: await w.page.$eval('[data-testid="topbar-alert"]', e => e.textContent).catch(() => ''), footer: await w.page.$eval('.omo-footer [role]', e => e.textContent).catch(() => '') });
        check('B sees the shared room world (the data world A seeded)', Array.isArray(roomWorldB) && roomWorldB.length === 4, { a: await diag(A), b: await diag(B) });

        const roomState = async w => { await w.roomPanel().catch(() => {}); const s = await w.page.evaluate(() => ({ status: document.querySelector('[data-testid="remote-room-status"]')?.textContent ?? '', err: document.querySelector('[data-testid="remote-room-error"]')?.textContent ?? '', members: document.querySelectorAll('[data-testid="remote-room-members"] li').length })); await w.closePanels(); return s; };
        try { const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); for (const f of walk(ROOM_DATA)) { const t = fs.readFileSync(f, 'utf8'); const m = /"shell":\{[^}]*\}/.exec(t); console.log('room data', path.relative(ROOM_DATA, f), m ? m[0] : t.length); } } catch (e) { console.log('room data read failed', e.message); }
        console.log('poses', JSON.stringify({ a: await A.page.evaluate(() => { const c = document.querySelector('canvas[data-testid="omo-world-canvas"]'); return [c.dataset.playerX, c.dataset.playerZ, c.dataset.playerYaw, c.dataset.playerPitch]; }) }));
        console.log('room state after join', JSON.stringify({ a: await roomState(A), b: await roomState(B), ta: await A.data('voiceTransport'), tb: await B.data('voiceTransport') }));
        // ---------------------------------------------------------------- L5 setup: voice on for both
        for (const w of [A, B]) { await w.command('voice'); }
        const voiceOn = async w => w.page.waitForFunction(() => { try { return JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.voiceGains || '[]').some(g => typeof g.gain === 'number'); } catch { return false; } }, { timeout: 30000 }).then(() => true, () => false);
        const [aAudio, bAudio] = await Promise.all([voiceOn(A), voiceOn(B)]);
        check('Voice is on for both and each hears the other through a real gain node', aAudio && bAudio, { a: await A.data('voiceGains'), b: await B.data('voiceGains'), da: await diag(A), db: await diag(B), voiceA: await A.page.$eval('[data-testid="voice-panel"]', e => e.textContent).catch(() => 'no panel'), footer: await A.page.$eval('.omo-footer [role]', e => e.textContent).catch(() => '') });

        // ---------------------------------------------------------------- L10: shared pointer
        // Both stand at the plaza home. A turns a little and holds Q.
        const selfA = await A.page.evaluate(() => [...document.querySelectorAll('[data-testid="remote-room-members"] li')].map(l => l.dataset.memberId));
        await A.page.focus(CANVAS);
        await A.page.keyboard.down('q');
        await B.page.waitForFunction(() => { try { return JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.pointers || '[]').some(p => p.id !== 'self'); } catch { return false; } }, { timeout: 15000 }).catch(() => {});
        const pointersB = await B.json('pointers'), pointingA = await A.data('pointing'), pointersA = await A.json('pointers');
        check('A holds Q: A draws its own beam', pointingA === 'true' && (pointersA ?? []).some(p => p.id === 'self'), { pointingA, pointersA });
        check('B sees A\'s pointer dot (a remote beam to A\'s spot, in A\'s colour)', (pointersB ?? []).some(p => p.id !== 'self' && p.to && Number.isFinite(p.to.x) && /^#[0-9a-f]{6}$/i.test(p.colour)), { pointersB, selfA, da: await diag(A), db: await diag(B) });
        await pause(500); await B.shot('9-pointer-b');
        await A.page.keyboard.up('q');
        await B.page.waitForFunction(() => { try { return !JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.pointers || '[]').some(p => p.id !== 'self'); } catch { return false; } }, { timeout: 10000 }).catch(() => {});
        check('Release Q: the pointer is gone for B', !((await B.json('pointers')) ?? []).some(p => p.id !== 'self'), await B.data('pointers'));

        // ---------------------------------------------------------------- L5: proximity falloff
        const gainForB = async () => { const g = (await A.json('voiceGains')) ?? []; return g.find(x => x.name === 'Ben') ?? g[0]; };
        const local = async () => { const [a, b] = [await A.pose(), await B.pose()]; return Math.hypot(a.x - b.x, a.z - b.z); };
        const walkB = async (key, goal) => {
            await B.page.focus(CANVAS); await B.page.keyboard.down(key);
            const t0 = Date.now(); while (Date.now() - t0 < 20000 && await local() < goal) await pause(15);
            await B.page.keyboard.up(key);
        };
        const settle = async target => { for (let i = 0; i < 60; i++) { const g = await gainForB(); if (g && typeof g.distance === 'number' && Math.abs(g.distance - target) < 0.35 && Math.abs((g.gain ?? g.volume) - g.volume) < 0.02) return g; await pause(150); } return gainForB(); };
        const d0 = await local();
        if (d0 > 1.0) { /* already apart: walk B forward until within 1 m */ await B.page.focus(CANVAS); await B.page.keyboard.down('w'); const t0 = Date.now(); while (Date.now() - t0 < 15000 && await local() > 1.0) await pause(15); await B.page.keyboard.up('w'); }
        else await walkB('s', 1.0);
        const near = await settle(await local());
        check('At ~1 m the volume A hears for B is ~1.0 (volume and the real gain node)', !!near && near.distance >= 0.7 && near.distance <= 1.4 && near.volume >= 0.99 && (near.gain ?? 0) >= 0.97, near);
        await A.shot('10-voice-near');
        await walkB('s', 7.0); const mid = await settle(await local());
        check('At ~7 m it is about half', !!mid && mid.volume > 0.35 && mid.volume < 0.65, mid);
        await walkB('s', 13.0); const far = await settle(await local());
        check('At ~13 m the volume A hears for B is 0 (volume and the real gain node)', !!far && far.distance >= 12.6 && far.distance <= 13.8 && far.volume === 0 && (far.gain ?? 1) <= 0.01, far);
        await A.shot('11-voice-far');

        // ---------------------------------------------------------------- security: guests get no terminal text or tokens
        const bHolds = await B.page.evaluate(token => { const all = document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }); return { owner: all.includes(token), invite: /omoinv|#invite=/.test(all) }; }, ownerToken);
        const aTerminal = await A.data('terminalText');
        const bText = await B.page.evaluate(() => document.body.innerText);
        check('B never holds the owner key, an invite token or A\'s terminal text', !bHolds.owner && !bHolds.invite && (!aTerminal.trim() || !bText.includes(aTerminal.trim().slice(0, 40))), bHolds);
        check('no page errors', errors.a.length === 0 && errors.b.length === 0, [...errors.a, ...errors.b].slice(0, 4));
    } catch (e) {
        failed++; console.log('FAIL run —', e.stack || e.message);
        try { for (const w of [A, B]) if (w) await w.page.screenshot({ path: path.join(OUT, `fail-${w.tag}.png`) }); } catch {}
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ failed, checks, errors }, null, 1));
        for (const b of browsers) await b.close().catch(() => {});
        try { rooms.kill('SIGTERM'); } catch {}
        try { process.kill(-server.pid, 'SIGTERM'); } catch {}
        await pause(2500); try { process.kill(-server.pid, 'SIGKILL'); } catch {}
        const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
        if (tmux) spawnSync(tmux, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
        fs.rmSync(S, { recursive: true, force: true });
        console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);
        process.exitCode = failed ? 1 : 0;
    }
})();
