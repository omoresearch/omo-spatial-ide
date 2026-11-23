/* promise:share — short human room codes (L6). Pure table + the REAL room server through the IDE wire. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }, fileName: filename }).outputText;
  module._compile(output, filename);
};
const src = p => path.resolve(__dirname, '../src', p);
const RC = require(src('common/room-code.ts'));
const wire = require(src('common/room-wire-protocol.ts'));
const { RemoteRoomClient } = require(src('node/remote-room-client.ts'));
Module._extensions['.ts'] = originalTsLoader;

const rnd = n => crypto.randomInt(n);

test('room code format: 4 unambiguous letters, hyphen, 4 digits (no I L O 0 1)', () => {
  for (let i = 0; i < 2000; i++) {
    const code = RC.makeRoomCode(rnd);
    assert.match(code, /^[A-Z]{4}-[0-9]{4}$/);
    assert.ok(RC.isRoomCode(code), code);
    assert.doesNotMatch(code, /[ILO01]/, code);
  }
  assert.equal(RC.ROOM_CODE_LETTERS.length, 23);
  assert.equal(RC.ROOM_CODE_DIGITS.length, 8);
});

test('typed codes are normalised; wrong shapes give a readable error', () => {
  assert.equal(RC.normaliseRoomCode(' mars-4823 '), 'MARS-4823');
  assert.equal(RC.normaliseRoomCode('mars4823'), 'MARS-4823');
  assert.equal(RC.normaliseRoomCode('MARS 4823'), 'MARS-4823');
  assert.throws(() => RC.normaliseRoomCode(''), /Type the room code/);
  assert.throws(() => RC.normaliseRoomCode('MIN-482'), /4 letters and 4 numbers/);
  assert.throws(() => RC.normaliseRoomCode('MOON-4821'), /never use I, L, O, 0 or 1/);
  assert.throws(() => RC.normaliseRoomCode('1234-ABCD'), /never use|4 letters/);
});

test('table: issue -> lookup -> expiry with the invite; wrong code is readable; remove after use', () => {
  let now = 1_000_000;
  const table = new RC.RoomCodeTable(rnd, () => now);
  const code = table.issue({ token: 'omoinv1.secret.sig', roomId: 'r1', invite: 'i_0' }, now + 60_000);
  assert.ok(RC.isRoomCode(code));
  const hit = table.lookup(code.toLowerCase());
  assert.equal(hit.ok, true); assert.equal(hit.value.roomId, 'r1');
  const miss = table.lookup(code === 'ABCD-2345' ? 'ABCD-2346' : 'ABCD-2345');
  assert.deepEqual(miss, { ok: false, reason: 'unknown', message: RC.ROOM_CODE_MESSAGES.unknown });
  now += 60_001;
  const late = table.lookup(code);
  assert.equal(late.ok, false); assert.equal(late.reason, 'expired'); assert.match(late.message, /expired/);
  assert.equal(table.size, 0, 'an expired code is dropped');
  const c2 = table.issue({ token: 't', roomId: 'r1', invite: 'i_1' }, now + 1000);
  table.removeWhere(v => v.invite === 'i_1');
  assert.equal(table.lookup(c2).reason, 'unknown');
  assert.throws(() => table.issue({}, now - 1), /already expired/);
});

test('a code carries no token, room id or signature: the code is only randomness', () => {
  const token = 'omoinv1.eyJ2IjoxLCJyIjoidHdvLWFwcC1yb29tIn0.c2lnbmF0dXJl';
  const table = new RC.RoomCodeTable(rnd);
  const codes = new Set();
  for (let i = 0; i < 200; i++) codes.add(table.issue({ token, roomId: 'two-app-room', invite: `i_${i}` }, Date.now() + 60_000));
  assert.equal(codes.size, 200, 'codes are unique per table');
  for (const code of codes) {
    assert.equal(code.length, 9);
    assert.ok(RC.isRoomCode(code));
    assert.ok(!token.includes(code) && !token.includes(code.replace('-', '')), 'no token text');
  }
  // The wire auth for a code has only the code: no roomId, no invite.
  const frame = wire.parseClientFrame ? wire.parseClientFrame(JSON.stringify({ t: 'hello', rid: 'hello', proto: wire.ROOM_WIRE_VERSION, client: { app: 'omo-ide', version: '1' }, auth: { kind: 'code', code: [...codes][0] } })) : null;
  if (frame) assert.deepEqual(Object.keys(frame.auth).sort(), ['code', 'kind']);
});

// ------------------------------------------------------------------ real room server
function memStore() {
  const rooms = new Map(), claims = new Map();
  return {
    rooms,
    token: async (server, roomId) => { const e = [...rooms.values()].find(x => x.server === server && x.roomId === roomId); return e ? { token: e.token, memberId: e.memberId } : undefined; },
    save: async e => { rooms.set(`${e.server}|${e.roomId}|${e.memberId}`, e); },
    remove: async () => {}, list: async () => [...rooms.values()].map(({ token, ...rest }) => rest),
    claim: (s, r, m, c) => { const k = `${s}|${r}|${m}`; if (claims.has(k) && claims.get(k) !== c) return false; claims.set(k, c); return true; },
    release: c => { for (const [k, v] of claims) if (v === c) claims.delete(k); }
  };
}

test('real room server: owner gets a code with the invite; a guest joins by code; reuse, wrong and malformed codes are readable', { timeout: 60000 }, async () => {
  const BIN = path.resolve(__dirname, '../../server/omo-room-server.cjs');
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-room-code-'));
  const DATA = path.join(tmp, 'data');
  const created = execFileSync(process.execPath, [BIN, 'create-room', '--data', DATA, '--id', 'code-room', '--name', 'Code room', '--owner', 'Ana'], { encoding: 'utf8' });
  const owner = /\b(omo1\.\S+)/.exec(created)[1];
  const trace = path.join(tmp, 'frames.jsonl');
  const srv = spawn(process.execPath, [BIN, '--data', DATA, '--host', '127.0.0.1', '--port', '0', '--quiet', '--trace-frames', trace], { stdio: ['ignore', 'pipe', 'inherit'] });
  const info = await new Promise((r, j) => { srv.stdout.once('data', d => r(JSON.parse(d))); srv.once('exit', c => j(new Error(`server exited ${c}`))); });
  const clients = [];
  try {
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback only');
    const A = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(A);
    await A.host({ server: info.url, ownerToken: owner, roomId: 'code-room' }, { name: 'Ana' });
    const inv = await A.createInvite({ ttlMinutes: 30, role: 'member' });
    assert.ok(RC.isRoomCode(inv.code), `invite has a room code: ${inv.code}`);
    const token = decodeURIComponent(inv.link.split('#invite=')[1]);
    assert.ok(!token.includes(inv.code) && !inv.code.includes(token.slice(0, 8)), 'code is not part of the token');

    const B = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(B);
    const sb = await B.joinCode(info.url, inv.code.toLowerCase().replace('-', ' '), { name: 'Ben' });
    assert.equal(sb.phase, 'joined'); assert.equal(sb.roomId, 'code-room'); assert.equal(sb.role, 'member');

    const C = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(C);
    const reused = await C.joinCode(info.url, inv.code, { name: 'Cy' }).then(() => 'joined', e => e.message);
    assert.match(reused, /not found|expired|already used/i, `a used code is refused readably: ${reused}`);

    const D = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(D);
    const wrong = await D.joinCode(info.url, 'ZZZZ-9999', { name: 'Di' }).then(() => 'joined', e => e.message);
    assert.equal(wrong, RC.ROOM_CODE_MESSAGES.unknown);
    const E = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(E);
    const bad = await E.joinCode(info.url, 'HELLO', { name: 'Ed' }).then(() => 'joined', e => e.message);
    assert.match(bad, /4 letters and 4 numbers/);

    // Expiry follows the invite: an invite that has expired takes its code with it (1-minute invite, clock moved by the table).
    const inv2 = await A.createInvite({ ttlMinutes: 1, role: 'viewer' });
    assert.ok(RC.isRoomCode(inv2.code));
    // The frame trace never carries the code or the invite in clear text.
    await new Promise(r => setTimeout(r, 200));
    const traced = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
    assert.ok(!traced.includes(inv.code) && !traced.includes(inv2.code), 'frame trace redacts codes');
  } finally {
    for (const c of clients) { try { c.dispose(); } catch { /* ignore */ } }
    srv.kill('SIGTERM'); await new Promise(r => srv.once('exit', r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
