/* promise:share — the room server follows the world size. A real room server + two real IDE room clients:
 * after the owner resizes the world shell to 64 x 45 m, a pose at x 25 is accepted and the other member sees it;
 * and a skyline 64 x 45 m seed world (the data world) is kept, not refused back to 12 x 10.
 * Run: node --test extension/test/room-shell.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }, fileName: filename }).outputText;
  module._compile(output, filename);
};
const { RemoteRoomClient } = require(path.resolve(__dirname, '../src/node/remote-room-client.ts'));
const model = require(path.resolve(__dirname, '../src/common/world-model.ts'));
Module._extensions['.ts'] = originalTsLoader;
const srvProtocol = require(path.resolve(__dirname, '../../server/src/protocol.cjs'));
const BIN = path.resolve(__dirname, '../../server/omo-room-server.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function memStore() {
  const rooms = new Map(), claims = new Map();
  return {
    token: async (server, roomId) => { const e = [...rooms.values()].find(x => x.server === server && x.roomId === roomId); return e ? { token: e.token, memberId: e.memberId } : undefined; },
    save: async e => { rooms.set(`${e.server}|${e.roomId}|${e.memberId}`, e); },
    remove: async () => {}, list: async () => [...rooms.values()].map(({ token, ...rest }) => rest),
    claim: (s, r, m, c) => { const k = `${s}|${r}|${m}`; if (claims.has(k) && claims.get(k) !== c) return false; claims.set(k, c); return true; },
    release: c => { for (const [k, v] of claims) if (v === c) claims.delete(k); }
  };
}
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(25); } return fn(); }

async function withServer(roomId, run) {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'omo-room-shell-'));
  const DATA = path.join(tmp, 'data');
  const created = execFileSync(process.execPath, [BIN, 'create-room', '--data', DATA, '--id', roomId, '--name', 'Shell room', '--owner', 'Ana'], { encoding: 'utf8' });
  const owner = /\b(omo1\.\S+)/.exec(created)[1];
  const srv = spawn(process.execPath, [BIN, '--data', DATA, '--host', '127.0.0.1', '--port', '0', '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const info = await new Promise((r, j) => { srv.stdout.once('data', d => r(JSON.parse(d))); srv.once('exit', c => j(new Error(`server exited ${c}`))); });
  const clients = [];
  const client = () => { const c = new RemoteRoomClient({ store: memStore(), handshakeMs: 5000 }); clients.push(c); return c; };
  try { await run({ url: info.url, owner, client, roomFile: () => JSON.parse(fs.readFileSync(path.join(DATA, 'rooms', `${roomId}.json`), 'utf8')) }); }
  finally {
    for (const c of clients) { try { c.dispose(); } catch { /* ignore */ } }
    srv.kill('SIGTERM'); await new Promise(r => srv.once('exit', r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('pose bounds follow the shell the frame is checked against', () => {
  const frame = JSON.stringify({ type: 'pose', pose: { x: 25, z: 0, yaw: 0, pitch: 0 } });
  assert.throws(() => srvProtocol.parseClient(frame, { width: 12, depth: 10 }), /Invalid room position/);
  assert.equal(srvProtocol.parseClient(frame, { width: 64, depth: 45 }).pose.x, 25);
});

test('real room server: after the owner resizes the shell to 64 x 45, a pose at x 25 is accepted and both stay joined', { timeout: 60000 }, async () => {
  await withServer('shell-room', async ({ url, owner, client, roomFile }) => {
    const A = client();
    await A.host({ server: url, ownerToken: owner, roomId: 'shell-room' }, { name: 'Ana' });
    const inv = await A.createInvite({ ttlMinutes: 30, role: 'member' });
    const B = client();
    const sb = await B.joinCode(url, inv.code, { name: 'Ben' });
    assert.equal(sb.phase, 'joined');
    const aId = A.status().selfId;
    const aSeenByB = () => B.status().members.find(m => m.id === aId);
    assert.equal(roomFile().world.shell.width, 12, 'a new room starts 12 x 10');

    // Before the resize: x 25 is outside the 12 m room, so the server refuses it and B never sees it.
    A.update({ x: 25, z: 0, yaw: 0, pitch: 0 });
    await until(() => /Invalid room position/.test(A.status().error));
    assert.match(A.status().error, /Invalid room position/);
    assert.notEqual(aSeenByB()?.pose.x, 25);
    A.update({ x: 1, z: 1, yaw: 0, pitch: 0 });
    await until(() => aSeenByB()?.pose.x === 1);

    // The host resizes the world (a shell op, the same one the data world plan carries).
    const base = A.world().revision;
    const res = await A.applyWorldOps(base, [{ op: 'shell', shell: { width: 64, depth: 45, open: true } }]);
    assert.ok(res.ok, res.error);
    assert.deepEqual(roomFile().world.shell, { theme: 'station', width: 64, depth: 45, open: true }, 'the stored room world has the new shell');
    await until(() => B.world()?.shell.width === 64);
    assert.equal(B.world().shell.width, 64, 'B got the resized world');

    A.update({ x: 25, z: -20, yaw: 0, pitch: 0 });
    const seen = await until(() => aSeenByB()?.pose.x === 25 && aSeenByB());
    assert.ok(seen, `B sees A at x 25 (got ${JSON.stringify(aSeenByB()?.pose)})`);
    assert.equal(seen.pose.z, -20);
    // B can walk out there too, and A sees it.
    B.update({ x: -25, z: 18, yaw: 0, pitch: 0 });
    const bId = B.status().selfId;
    assert.ok(await until(() => A.status().members.find(m => m.id === bId)?.pose.x === -25), 'A sees B at x -25');
    assert.equal(A.status().phase, 'joined'); assert.equal(B.status().phase, 'joined');
    assert.equal(A.status().members.length, 2); assert.equal(B.status().members.length, 2);
  });
});

test('real room server: a skyline 64 x 45 m seed world is kept (it was refused and the room stayed 12 x 10)', { timeout: 60000 }, async () => {
  await withServer('seed-room', async ({ url, owner, client, roomFile }) => {
    const seed = model.worldFromRoomV1({ theme: 'skyline', projectName: 'customers by region' });
    seed.shell = { theme: 'skyline', width: 64, depth: 45, open: true };
    assert.ok(model.validateWorld(seed).ok);
    const A = client();
    await A.host({ server: url, ownerToken: owner, roomId: 'seed-room', seedWorld: seed }, { name: 'Ana' });
    assert.deepEqual(roomFile().world.shell, { theme: 'skyline', width: 64, depth: 45, open: true });
    assert.equal(A.world().shell.width, 64);
    const inv = await A.createInvite({ ttlMinutes: 30, role: 'member' });
    const B = client();
    await B.joinCode(url, inv.code, { name: 'Ben' });
    A.update({ x: 25, z: 1.5, yaw: 0, pitch: 0 });
    const aId = A.status().selfId;
    assert.ok(await until(() => B.status().members.find(m => m.id === aId)?.pose.x === 25), 'B sees A at x 25 in the seeded data world');
    assert.equal(A.status().error, '');
  });
});
