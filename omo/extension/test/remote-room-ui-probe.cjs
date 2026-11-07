// UI probe: real Omo app + mock room server; host a room in browser A, join by invite link in browser B.
// Run: start the app on OMO_URL (default http://127.0.0.1:3291) with a throwaway THEIA_CONFIG_DIR, then node extension/test/remote-room-ui-probe.cjs
const path = require('path');
const omo = path.join(__dirname, '..', '..');
const APP = process.env.OMO_URL || 'http://127.0.0.1:3291';
const { launch } = require(path.join(omo, 'node_modules/puppeteer'));
const fs = require('fs'), os = require('os');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Start the mock server by loading the probe's server half: reuse the probe file but only the server part.
const W = require(path.join(omo, 'extension/lib/common/room-wire-protocol.js'));
const { applyWorldOps, worldFromRoomV1 } = require(path.join(omo, 'extension/lib/common/world-model.js'));
const { WebSocketServer } = require(path.join(omo, 'node_modules/ws'));
const OWNER = 'owner-token-0123456789abcdef';
const rooms = new Map(), invites = new Map(), tokens = new Map(); let n = 1, port;
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: W.ROOM_WS_PATH });
const send = (ws, f) => ws.send(W.encodeFrame(f));
const view = room => [...room.members.values()].filter(m => m.ws && m.joined).map(m => ({ id: m.id, name: m.name, pose: m.pose, role: m.role, ...(m.colour ? { colour: m.colour } : {}), ...(m.agents?.length ? { agents: m.agents } : {}) }));
const bc = (room, f, ex) => { for (const m of room.members.values()) if (m.ws && m.joined && m !== ex) send(m.ws, f); };
wss.on('connection', ws => { let me, room;
    ws.on('message', raw => { let f; try { f = W.parseClientFrame(raw.toString()); } catch (e) { console.log('bad frame', e.message); return; } if (!f) return;
        if (f.t === 'hello') { const a = f.auth; room = rooms.get(a.roomId);
            if (a.kind === 'owner') { if (a.ownerToken !== OWNER) { send(ws, { t: 'error', rid: f.rid, code: 'auth', message: 'Bad owner token.', fatal: true }); return ws.close(4001); }
                if (!room) { room = { id: a.roomId, name: a.roomName || a.roomId, world: a.seedWorld || worldFromRoomV1({ theme: 'station', projectName: 'R' }), members: new Map() }; rooms.set(a.roomId, room); } me = { id: 'm00000' + n++, role: 'owner' }; }
            else if (a.kind === 'invite') { if (!room || !invites.has(a.invite)) { send(ws, { t: 'error', rid: f.rid, code: 'invite-expired', message: 'Invite expired.', fatal: true }); return ws.close(4001); } me = { id: 'm00000' + n++, role: 'member' }; }
            else { const t = tokens.get(a.token); if (!room || !t) { send(ws, { t: 'error', rid: f.rid, code: 'auth', message: 'Unknown member.', fatal: true }); return ws.close(4001); } me = room.members.get(t) || { id: t, role: 'member' }; }
            me.pose = me.pose || { x: 0, z: 2, yaw: 0, pitch: 0 }; me.ws = ws; room.members.set(me.id, me);
            const tok = 'tok_' + me.id + '_xxxxxxxxxxxxxxxx'; tokens.set(tok, me.id);
            return send(ws, { t: 'welcome', rid: f.rid, proto: 1, roomId: room.id, roomName: room.name, memberId: me.id, role: me.role, memberToken: tok, serverTime: Date.now() }); }
        switch (f.t) {
            case 'join': me.name = f.name; me.joined = true; send(ws, { t: 'room', rid: f.rid, roomId: room.id, roomName: room.name, selfId: me.id, members: view(room), world: room.world }); return bc(room, { t: 'presence', members: view(room) }, me);
            case 'pose': me.pose = f.pose; return bc(room, { t: 'presence', members: view(room) }, me);
            case 'colour': me.colour = f.colour; return bc(room, { t: 'presence', members: view(room) });
            case 'agents': me.agents = f.agents; return bc(room, { t: 'agents', memberId: me.id, agents: f.agents });
            case 'chat': case 'emote': { const m = { id: 'c' + n++, from: me.id, fromName: me.name, at: Date.now(), kind: f.t === 'chat' ? 'text' : 'emote', ...(f.t === 'chat' ? { text: f.text } : { emote: f.emote }) }; send(ws, { t: 'chat-ack', rid: f.rid, message: m }); return bc(room, { t: 'chat', message: m }, me); }
            case 'invite-create': { const code = 'inv_' + Math.random().toString(36).slice(2).padEnd(20, 'q'); invites.set(code, 1); return send(ws, { t: 'invite', rid: f.rid, link: W.inviteLink(`http://127.0.0.1:${port}`, room.id, code), expiresAt: Date.now() + 864e5 }); }
            case 'world-get': return send(ws, { t: 'world', rid: f.rid, world: room.world });
            case 'ping': return send(ws, { t: 'pong', at: f.at, serverTime: Date.now() });
            case 'leave': room.members.delete(me.id); bc(room, { t: 'presence', members: view(room) }); return ws.close(1000);
        } });
    ws.on('close', () => { if (me && room && me.ws === ws) { me.ws = undefined; bc(room, { t: 'presence', members: view(room) }); } });
});
(async () => {
    await new Promise(r => wss.on('listening', r)); port = wss.address().port; console.log('mock server', port);
    const profileA = fs.mkdtempSync(path.join((process.env.TMPDIR || os.tmpdir()), 'chA-')), profileB = fs.mkdtempSync(path.join((process.env.TMPDIR || os.tmpdir()), 'chB-'));
    const opts = p => ({ executablePath: '/opt/google/chrome/chrome', headless: true, userDataDir: p, args: ['--window-size=1600,1000', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1600, height: 1000 } });
    const bA = await launch(opts(profileA)), bB = await launch(opts(profileB));
    const open = async b => { const page = await b.newPage();
        await page.evaluateOnNewDocument(() => { try { localStorage.setItem('omo.focus.clickAttach', 'false'); localStorage.setItem('omo.coach.v1', 'seen'); } catch {} });
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('[data-testid="omo-world"]', { timeout: 60000 }); await sleep(4500);
        await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes, I trust the authors'); if (b) b.click(); });
        await sleep(800);
        await page.waitForSelector('[data-testid="create-room"]', { timeout: 60000 });
        await page.click('[data-testid="create-room"]');
        await page.waitForSelector('[data-testid="remote-room-chip"]', { timeout: 30000 });
        return page; };
    const A = await open(bA), B = await open(bB);
    const txt = (p, s) => p.$eval(s, e => e.textContent);
    console.log('PASS chip visible:', await txt(A, '[data-testid="remote-room-chip"]'));
    // Host in A
    await A.click('[data-testid="remote-room-chip"]'); await A.click('[data-testid="remote-tab-host"]');
    const type = async (p, s, v) => { await p.$eval(s, e => e.focus()); await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control'); await p.keyboard.press('Backspace'); await p.type(s, v); };
    await type(A, '[data-testid="remote-room-name"]', 'Harry');
    await type(A, '[data-testid="remote-room-server"]', `http://127.0.0.1:${port}`);
    await type(A, '[data-testid="remote-room-owner-token"]', OWNER);
    await type(A, '[data-testid="remote-room-code"]', 'ui-room');
    await A.click('[data-testid="remote-room-host"]');
    await A.waitForFunction(() => document.querySelector('[data-testid="remote-room-chip"]')?.getAttribute('data-phase') === 'joined', { timeout: 15000 });
    console.log('PASS A hosted:', await txt(A, '[data-testid="remote-room-status"]'));
    await A.click('[data-testid="remote-room-invite"]');
    await A.waitForSelector('[data-testid="remote-room-invite-link"]', { timeout: 10000 });
    const link = await A.$eval('[data-testid="remote-room-invite-link"]', e => e.value);
    console.log('PASS invite link shown:', link.replace(/invite=.*/, 'invite=<redacted>'));
    // Join in B
    await B.click('[data-testid="remote-room-chip"]');
    await type(B, '[data-testid="remote-room-name"]', 'Bob');
    await type(B, '[data-testid="remote-room-link"]', link);
    await B.click('[data-testid="remote-room-join"]');
    await B.waitForFunction(() => document.querySelector('[data-testid="remote-room-chip"]')?.getAttribute('data-phase') === 'joined', { timeout: 15000 });
    // Existing presence strip (HUD path) shows both people in both tabs
    const members = p => p.waitForFunction(() => { const t = document.querySelector('[data-testid="presence-members"]')?.textContent || ''; return t.includes('Harry') && t.includes('Bob') ? t : false; }, { timeout: 15000 }).then(h => h.jsonValue());
    console.log('PASS A presence strip:', await members(A));
    console.log('PASS B presence strip:', await members(B));
    console.log('PASS A chip:', await txt(A, '[data-testid="remote-room-chip"]'));
    const ls = await B.evaluate(() => JSON.stringify(Object.keys(localStorage).filter(k => /token|remote|invite/i.test(k)).concat(Object.values(localStorage).filter(v => /tok_|inv_/.test(v)).map(() => 'VALUE-WITH-TOKEN'))));
    console.log(ls === '[]' ? 'PASS no token or invite in browser localStorage' : 'FAIL localStorage has: ' + ls);
    await B.screenshot({ path: path.join((process.env.TMPDIR || os.tmpdir()), 'remote-room-B.png') });
    // Leave in B
    await B.click('[data-testid="remote-room-leave"]');
    await A.waitForFunction(() => !(document.querySelector('[data-testid="presence-members"]')?.textContent || '').includes('Bob'), { timeout: 15000 });
    console.log('PASS B left; A strip now:', await txt(A, '[data-testid="presence-members"]'), '| B chip:', await txt(B, '[data-testid="remote-room-chip"]'));
    await bA.close(); await bB.close(); wss.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
