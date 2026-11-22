/* promise:share (L7) — shareable world files and data worlds. Pure modules + fixtures in extension/test/fixtures/.
 * Run: node --test extension/test/world-share.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }, fileName: filename }).outputText;
  module._compile(output, filename);
};
const src = p => path.resolve(__dirname, '../src', p);
const model = require(src('common/world-model.ts'));
const share = require(src('common/world-share.ts'));
const data = require(src('common/world-data.ts'));
const rules = require(src('common/world-admin-rules.ts'));
const store = require(src('browser/world-store.ts'));
Module._extensions['.ts'] = originalTsLoader;

const FIX = path.join(__dirname, 'fixtures');
const TOKEN = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const GH = 'ghp_1234567890abcdefghijABCDEFGHIJ';

/** A fixture world with private text in every free-text field it has. */
function leakyWorld() {
  const w = model.worldFromRoomV1({ theme: 'station', projectName: 'harry-secret-project', layout: 'classic', kit: 'hermes-desk' });
  w.name = 'Team room /home/harry/dev/omo';
  const desk = w.entities.find(e => e.id === 'terminal');
  desk.label = `Desk ${TOKEN}`;
  desk.station = { ...desk.station, name: 'Ops /home/harry/.ssh', profile: 'omo-dev', tabs: [{ name: 'Hermes', kind: 'hermes' }, { name: `Shell ${GH}`, kind: 'shell' }] };
  const web = w.entities.find(e => e.id === 'web');
  web.home = 'https://user:pw@dash.example.com/board?token=abc123#frag';
  w.entities.push({ id: 'room-a', kind: 'room', label: 'Lounge', transform: { x: 0, z: 0, rotation: 0 }, width: 4, depth: 4, doors: ['front'] });
  w.entities.push({ id: 'plant-1', kind: 'decor', decor: 'plant', label: 'C:\\Users\\harry\\plant', transform: { x: 3, z: 2, rotation: 0 }, scale: 1.2 });
  w.entities.push({ id: 'mail', kind: 'decor', decor: 'whiteboard', label: 'harry@example.com', transform: { x: -3, z: 2, rotation: 0 } });
  w.plan = 'make it like /home/harry/notes with key ' + TOKEN;
  assert.ok(model.validateWorld(w).ok, 'the leaky fixture is itself a valid world');
  return w;
}

test('share: a world with a token-like string and a /home path comes out clean', () => {
  const out = share.shareWorld(leakyWorld());
  const text = out.text;
  for (const bad of [TOKEN, GH, '/home/', 'harry-secret-project', 'omo-dev', 'token=', 'user:pw', '#frag', 'C:\\', 'harry@example.com', '.ssh', 'notes']) assert.ok(!text.includes(bad), `file leaks ${bad}`);
  assert.ok(!/"plan"|"profile"|invite|roomCode|terminal-text|lines/.test(text), 'no plan, profile, invite or terminal fields');
  const w = out.file.world;
  assert.equal(w.name, 'Shared world');
  const desk = w.entities.find(e => e.id === 'terminal');
  assert.equal(desk.label, undefined); assert.equal(desk.station.name, 'Desk'); assert.equal(desk.station.profile, undefined);
  assert.deepEqual(desk.station.tabs.map(t => t.name), ['Hermes', 'Shell']);
  assert.equal(w.entities.find(e => e.id === 'web').home, 'https://dash.example.com/board');
  assert.equal(w.entities.find(e => e.id === 'room-a').label, 'Lounge', 'safe labels are kept');
  assert.equal(w.entities.find(e => e.id === 'plant-1').scale, 1.2, 'decor keeps its size');
  assert.ok(out.redacted >= 9, `counts the replaced texts (${out.redacted})`);
  assert.match(out.filename, /^shared-world\.omo-world\.json$/);
  assert.equal(w.revision, 0);
});

test('share: layout survives exactly (rooms, desks, tabs, walls, decor, positions)', () => {
  const w = model.worldFromRoomV1({ theme: 'jungle', projectName: 'Studio', layout: 'classic', kit: 'hermes-desk' });
  w.entities.push({ id: 'lounge', kind: 'room', label: 'Lounge', transform: { x: 0, z: 0, rotation: Math.PI / 2 }, width: 5, depth: 4, theme: 'skyline', doors: ['front', 'left'] });
  w.entities.push({ id: 'chair', kind: 'decor', decor: 'sofa', prop: 'sofa_02', transform: { x: 1.5, z: 1, rotation: 0.5 } });
  w.entities.find(e => e.id === 'web').home = 'https://example.com/docs/start';
  const out = share.shareWorld(w);
  const back = share.openWorldFile(out.text).world;
  assert.equal(back.name, 'Studio');
  assert.deepEqual(back.shell, w.shell);
  assert.deepEqual(back.entities, w.entities, 'every entity comes back field for field');
  assert.equal(out.redacted, 0);
});

test('round trip: share -> open -> share gives the same file; open is a new world at revision 0', () => {
  const first = share.shareWorld(leakyWorld());
  const opened = share.openWorldFile(first.text);
  assert.equal(opened.redacted, 0, 'a clean file needs no more cleaning');
  assert.equal(opened.world.revision, 0);
  const second = share.shareWorld({ ...opened.world, revision: 7 });
  assert.equal(second.text, first.text.replace(/"redacted": \d+/, '"redacted": 0'));
  assert.match(opened.summary, /“Shared world”: 1 room, 2 desks, 1 wall, 2 decor items/);
});

test('open: refuses broken, foreign, unknown-field and oversized files with readable messages', () => {
  const good = JSON.parse(share.shareWorld(model.worldFromRoomV1({ theme: 'station', projectName: 'A' })).text);
  const bad = mutate => { const f = JSON.parse(JSON.stringify(good)); mutate(f); return JSON.stringify(f); };
  assert.throws(() => share.openWorldFile(''), /empty/);
  assert.throws(() => share.openWorldFile('{nope'), /not valid JSON/);
  assert.throws(() => share.openWorldFile('{"format":"omo-world-preset","version":2}'), /not an Omo world file/);
  assert.throws(() => share.openWorldFile(bad(f => { f.version = 9; })), /newer version/);
  assert.throws(() => share.openWorldFile(bad(f => { f.invite = 'omoinv1.x'; })), /unknown fields/);
  assert.throws(() => share.openWorldFile(bad(f => { f.world.entities[0].workspaceId = 'tw_deadbeef01'; })), /unknown fields/);
  assert.throws(() => share.openWorldFile(bad(f => { f.world.entities[0].station.token = 'x'; })), /unknown fields/);
  assert.throws(() => share.openWorldFile(bad(f => { f.world.shell.width = 99999; })), /not valid/);
  assert.throws(() => share.openWorldFile(bad(f => { f.world.entities.push({ ...f.world.entities[0] }); })), /Duplicate id/);
  assert.throws(() => share.openWorldFile(bad(f => { f.redacted = -1; })), /damaged/);
  assert.throws(() => share.openWorldFile('x'.repeat(share.WORLD_FILE_MAX_BYTES + 1)), /at most/);
  // A hand-edited file with private text opens, cleaned.
  const edited = share.openWorldFile(bad(f => { f.world.entities[0].label = 'see /home/harry/x'; f.world.name = TOKEN; f.world.plan = 'secret'; }));
  assert.equal(edited.world.entities[0].label, undefined); assert.equal(edited.world.name, 'Shared world'); assert.equal(edited.world.plan, undefined);
  assert.equal(edited.redacted, 3);
});

test('open: the imported world replaces the current one as ONE validated change (planner -> apply)', () => {
  const current = model.worldFromRoomV1({ theme: 'station', projectName: 'Mine' });
  current.revision = 5;
  const theirs = share.openWorldFile(share.shareWorld(leakyWorld()).text).world;
  const plan = rules.planDataWorld(current, theirs, 'Open a world file');
  assert.ok(plan.proposal, plan.explanation);
  const applied = model.applyWorldOps(current, plan.proposal.ops);
  assert.ok(applied.ok, applied.error);
  assert.ok(store.sameWorld(applied.world, theirs));
  assert.equal(applied.world.revision, 6);
});

// ------------------------------------------------------------------------------------------- data worlds

test('csv: customers.csv grouped by region -> 4 rooms, signs with counts, up to 4 boards of row summaries', () => {
  const table = data.parseCsv(fs.readFileSync(path.join(FIX, 'customers.csv'), 'utf8'));
  assert.deepEqual(table.headers, ['id', 'name', 'region', 'plan', 'mrr']);
  assert.equal(table.rows.length, 12);
  assert.equal(table.rows[7][1], 'Harbor, Lights & Co', 'quoted comma kept');
  assert.equal(table.headers[data.suggestGroupColumn(table)], 'plan', 'suggests the column with the fewest groups (2..12)');
  const plan = data.planFromCsv(table, 'region', { name: 'Customers' });
  assert.deepEqual(plan.rooms.map(r => r.name), ['North · 5 rows', 'South · 3 rows', 'East · 2 rows', 'West · 2 rows']);
  assert.deepEqual(plan.rooms[0].boards, ['1 · Acme Bakery · Pro', '3 · Cobalt Books · Pro', '6 · Fable Toys · Starter', '+2 more rows']);
  assert.deepEqual(plan.rooms[2].boards, ['4 · Delta Dental · Team', '8 · Harbor, Lights & Co · Pro']);
  const world = data.worldFromPlan(plan);
  assert.ok(model.validateWorld(world).ok);
  const rooms = data.dataRooms(world);
  assert.deepEqual(rooms.map(r => r.name), plan.rooms.map(r => r.name));
  assert.deepEqual(rooms[0].boards, plan.rooms[0].boards);
  assert.ok(world.shell.open && world.entities.some(e => e.kind === 'station'), 'open world with one desk on the plaza');
  // Boards stand inside their room.
  for (const r of world.entities.filter(e => e.kind === 'room')) {
    const rect = model.roomRect(r);
    for (const b of world.entities.filter(e => e.id.startsWith(`${r.id}-board-`))) assert.ok(b.transform.x > rect.minX && b.transform.x < rect.maxX && b.transform.z > rect.minZ && b.transform.z < rect.maxZ, `${b.id} inside ${r.id}`);
  }
});

test('csv: more than 12 groups -> 12 rooms with "Other"; private cells never reach a board; bad csv is readable', () => {
  const lines = ['who,team,note'];
  for (let i = 0; i < 30; i++) lines.push(`P${i},Team ${String.fromCharCode(65 + (i % 20))},${i === 0 ? '/home/harry/secret' : i === 1 ? TOKEN : i === 2 ? 'x@y.com' : 'ok'}`);
  const table = data.parseCsv(lines.join('\r\n'));
  const plan = data.planFromCsv(table, 1);
  assert.equal(plan.rooms.length, 12);
  assert.match(plan.rooms[11].name, /^Other · \d+ rows$/);
  assert.match(plan.notes[0], /20 groups: the 9 smallest share the “Other” room/);
  const all = JSON.stringify(data.worldFromPlan(plan));
  assert.ok(!all.includes('/home/') && !all.includes(TOKEN) && !all.includes('x@y.com'));
  assert.ok(model.validateWorld(data.worldFromPlan(plan)).ok);
  assert.ok(data.worldFromPlan(plan).entities.length <= data.DATA_MAX_ENTITIES, 'fits one shared-room batch');
  assert.throws(() => data.parseCsv(''), /empty/);
  assert.throws(() => data.parseCsv('a,b\n'), /no rows/);
  assert.throws(() => data.parseCsv('a,b\n"x,1\n'), /never closed/);
  assert.throws(() => data.planFromCsv(table, 'nope'), /no column “nope”/);
  assert.equal(data.parseCsv('a;b\n1;2\n').delimiter, ';');
});

/** Read-only reader over a real folder (what the IDE adapter does through the file service). */
function fsReader(root) {
  const at = segs => { const p = path.resolve(root, ...segs); if (p !== root && !p.startsWith(root + path.sep)) throw new Error('outside'); return p; };
  return {
    async list(segs) { return fs.readdirSync(at(segs), { withFileTypes: true }).map(d => ({ name: d.name, dir: d.isDirectory() })); },
    async read(segs) { const p = at(segs); return fs.statSync(p).size < 64 * 1024 ? fs.readFileSync(p, 'utf8') : undefined; }
  };
}

test('repo: tiny-repo -> one room per top-level folder; boards = README first line, file counts, types', async () => {
  const before = JSON.stringify(fs.readdirSync(path.join(FIX, 'tiny-repo'), { recursive: true }).sort());
  const plan = await data.planFromRepo(fsReader(path.join(FIX, 'tiny-repo')), 'tiny-repo');
  assert.equal(plan.name, 'tiny-repo');
  assert.deepEqual(plan.rooms.map(r => r.name), ['api/', 'web/', 'docs/']);
  assert.deepEqual(plan.rooms[0].boards, ['API service', '4 files', 'Mostly .ts (3), .md (1)', '1 subfolder']);
  assert.deepEqual(plan.rooms[1].boards, ['Web app', '3 files', 'Mostly .css (1), .md (1), .tsx (1)', '1 subfolder']);
  assert.deepEqual(plan.rooms[2].boards, ['1 file', 'Mostly .md (1)']);
  const world = data.worldFromPlan(plan);
  assert.ok(model.validateWorld(world).ok);
  assert.ok(!JSON.stringify(world).includes(FIX), 'no local path in the world');
  assert.equal(JSON.stringify(fs.readdirSync(path.join(FIX, 'tiny-repo'), { recursive: true }).sort()), before, 'read-only: the folder is unchanged');
});

test('repo: skips .git / node_modules / build folders; caps at 12 rooms; empty folder is readable', async () => {
  const tree = { '': ['.git/', 'node_modules/', 'dist/', ...Array.from({ length: 15 }, (_, i) => `pkg${i}/`)] };
  for (let i = 0; i < 15; i++) tree[`pkg${i}`] = Array.from({ length: i + 1 }, (_, k) => `f${k}.js`);
  const reader = { async list(segs) { return (tree[segs.join('/')] ?? []).map(n => ({ name: n.replace(/\/$/, ''), dir: n.endsWith('/') })); }, async read() { return undefined; } };
  const plan = await data.planFromRepo(reader, 'mono');
  assert.equal(plan.rooms.length, 12);
  assert.equal(plan.rooms[0].name, 'pkg14/');
  assert.ok(!plan.rooms.some(r => /git|node_modules|dist/.test(r.name)));
  assert.match(plan.notes[0], /15 folders/);
  await assert.rejects(data.planFromRepo({ async list() { return [{ name: 'a.txt', dir: false }]; }, async read() {} }, 'x'), /no subfolders/);
  assert.equal(data.readmeFirstLine('![badge](x.svg)\n\n# [Hello](http://x) *world*\n'), 'Hello world');
});

test('planner: the admin rules planner turns a data world into ONE proposal that applies and validates', () => {
  const current = model.worldFromRoomV1({ theme: 'station', projectName: 'Mine' });
  const target = data.worldFromPlan(data.planFromCsv(data.parseCsv(fs.readFileSync(path.join(FIX, 'customers.csv'), 'utf8')), 'region', { name: 'Customers' }));
  const result = rules.planDataWorld(current, target, 'Build a world from customers.csv by region');
  assert.ok(result.proposal, result.explanation);
  assert.equal(result.proposal.baseRevision, current.revision);
  assert.ok(result.proposal.ops.length <= 64, 'fits one room-server batch');
  assert.equal(result.steps.length, result.proposal.ops.length);
  const applied = model.applyWorldOps(current, result.proposal.ops);
  assert.ok(applied.ok, applied.error);
  assert.deepEqual(data.dataRooms(applied.world).map(r => r.name), ['North · 5 rows', 'South · 3 rows', 'East · 2 rows', 'West · 2 rows']);
  // A locked desk in the current world blocks the plan readably (the lock still holds).
  const locked = JSON.parse(JSON.stringify(current)); locked.entities.find(e => e.id === 'terminal').station.locked = true;
  const refused = rules.planDataWorld(locked, target, 'x');
  assert.equal(refused.proposal, null); assert.match(refused.explanation, /locked/);
});
