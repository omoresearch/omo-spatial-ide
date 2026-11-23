// foundation:v3 milestone 2 — the world compiler (common/world-compiler.ts): determinism, 0 overlaps, stations and
// web walls, valid v3 worlds, and parity with the lab's layout.py on out/coastal/spec.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const typescript = require('typescript');
const loader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const model = require('../src/common/world-model.ts');
const catalogue = require('../src/common/asset-catalogue.ts');
const compiler = require('../src/common/world-compiler.ts');
Module._extensions['.ts'] = loader;

const LAB = '/home/harry/dev/omo-sky-lab/world-director';
const readJson = p => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : undefined);
const haveLab = fs.existsSync(path.join(LAB, 'kits/coastal/kit.json'));
function pack(kit) {
  const d = path.join(LAB, 'kits', kit);
  return catalogue.catalogueFromKitJson(readJson(path.join(d, 'kit.json')), {
    bounds: readJson(path.join(d, 'tools/bounds.json')), measured: readJson(path.join(d, 'measured.json')),
    manifest: readJson(path.join(d, 'manifest.json')) ?? readJson(path.join(d, 'tools/fetch_manifest.json')),
    generated: (readJson(path.join(d, 'tools/specs/simple_props.json'))?.props ?? []).map(p => p.id)
  });
}
const skip = !haveLab && 'lab kits not on this machine';

test('compiler: same spec + same seed = identical ops; a valid v3 world with 0 overlaps, stations and web walls', { skip }, () => {
  for (const kit of ['coastal', 'kyoto', 'mars']) {
    const spec = readJson(path.join(LAB, 'out', kit, 'spec.json'));
    const a = compiler.compileWorld(spec, pack(kit)), b = compiler.compileWorld(JSON.parse(JSON.stringify(spec)), pack(kit));
    assert.deepEqual(a.ops, b.ops, kit);
    assert.equal(model.validateWorld(a.world).ok, true, kit);
    assert.equal(a.world.version, 3);
    assert.equal(a.world.site.kit, kit);
    assert.deepEqual(a.overlaps, [], kit);
    const desks = spec.rooms.reduce((n, r) => n + (r.desks ?? 0), 0);
    assert.equal(a.world.entities.filter(e => e.kind === 'station').length, desks, `${kit}: one station per desk`);
    const main = spec.rooms.filter(r => r.purpose !== 'entry').length;
    assert.equal(a.world.entities.filter(e => e.kind === 'web-wall').length, main, `${kit}: one web wall per main room`);
    assert.ok(a.world.entities.every(e => e.kind !== 'room' || e.purpose), 'every room has a purpose');
    assert.ok(a.world.entities.filter(e => e.kind === 'prop').every(e => pack(kit).assets.some(x => x.id === e.asset)), 'props come from the catalogue');
    const other = compiler.compileWorld({ ...spec, seed: 99 }, pack(kit));
    assert.equal(model.validateWorld(other.world).ok, true);
  }
});

test('compiler: an 8 x 6 studio gets the studio module, stations on its desk spots and the module screen as web wall', { skip }, () => {
  const r = compiler.compileWorld({ kit: 'coastal', seed: 1, rooms: [{ id: 'studio', purpose: 'studio', width: 8, depth: 6, desks: 3 }] }, pack('coastal'));
  const room = r.world.entities.find(e => e.kind === 'room');
  assert.equal(room.module, 'studio');
  assert.deepEqual(r.world.entities.filter(e => e.kind === 'station').map(e => [e.transform.x, e.transform.z]), [[-0.55, 0.27], [-0.55, -1.17], [0.55, 0.27]]);
  const web = r.world.entities.filter(e => e.kind === 'web-wall');
  assert.equal(web.length, 1);
  assert.deepEqual([web[0].transform.x, web[0].width], [3.87, 3.6]);
  assert.deepEqual(r.overlaps, []);
});

test('compiler parity with the lab: layout.py on out/coastal/spec.json (rooms, rects, doors, prop count)', { skip }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omo-parity-')), 'plan.json');
  try { execFileSync('python3', [path.join(LAB, 'director/layout.py'), path.join(LAB, 'out/coastal/spec.json'), path.join(LAB, 'kits/coastal/kit.json'), out], { stdio: 'pipe', timeout: 60000 }); }
  catch (e) { return void test.skip?.(`python3 layout.py failed: ${e.message}`); }
  const lab = readJson(out);
  const spec = readJson(path.join(LAB, 'out/coastal/spec.json'));
  const p = pack('coastal');
  const plan = compiler.layoutPlan(spec, p);
  assert.equal(plan.rooms.length, lab.rooms.length);
  for (const r of plan.rooms) {
    const L = lab.rooms.find(x => x.id === r.id);
    assert.deepEqual(r.rect, L.rect, r.id);
    assert.deepEqual(r.inner, L.inner, r.id);
    assert.deepEqual(r.wall_segments, L.wall_segments, r.id);
    assert.equal(r.reserved.length, L.reserved.length, r.id);
  }
  assert.deepEqual(plan.doors.map(d => [d.id, d.pos]), lab.doors.map(d => [d.id, d.pos]));
  const labRun = compiler.compileWorld(spec, p, { mode: 'lab' });
  const labInterior = lab.props.filter(x => !x.exterior).length;
  assert.ok(Math.abs(labRun.plan.props.length - labInterior) <= Math.ceil(labInterior * 0.1), `props ${labRun.plan.props.length} vs lab ${labInterior}`);
  assert.deepEqual(labRun.overlaps, []);
  assert.deepEqual(lab.solver_overlaps, []);
});
