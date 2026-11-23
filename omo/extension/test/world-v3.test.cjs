// foundation:v3 — world contract v3 (site, room purpose, catalogue-backed prop entities, lossless v2 upgrade)
// and the asset catalogue (common/asset-catalogue.ts) built from the World Director lab kits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const loader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const model = require('../src/common/world-model.ts');
const templates = require('../src/common/world-templates.ts');
const onboarding = require('../src/browser/onboarding-planner.ts');
const share = require('../src/common/world-share.ts');
const preset = require('../src/common/world-preset.ts');
const rm = require('../src/common/room-modules.ts');
const catalogue = require('../src/common/asset-catalogue.ts');
const styleKits = require('../src/common/world-style-kits.ts');
Module._extensions['.ts'] = loader;

const clone = v => JSON.parse(JSON.stringify(v));
const asV2 = w => ({ ...clone(w), version: 2 });
/** Every id and every field of a v2 world survives the upgrade: only `version` changes. */
function assertLossless(v2) {
  const before = clone(v2);
  const up = model.upgradeWorld(v2);
  assert.deepEqual(v2, before, 'upgradeWorld does not touch its input');
  assert.equal(up.version, 3);
  assert.deepEqual({ ...up, version: 2 }, before);
  const read = model.readWorld(v2);
  assert.equal(read.ok, true, read.error);
  assert.deepEqual(read.world.entities.map(e => e.id), before.entities.map(e => e.id));
  return read.world;
}

/** A world of three room-module rooms on the tidy grid, with a desk in the studio (the planner's shape). */
function moduleWorld() {
  const slots = rm.moduleGrid(3), mods = ['library', 'studio', 'lounge'];
  const entities = slots.map((s, i) => ({ id: `room-${i + 1}`, kind: 'room', label: mods[i], transform: { x: s.x, z: s.z, rotation: s.rotation }, width: 8, depth: 6, doors: ['front'], module: mods[i] }));
  const desk = rm.toWorld(slots[1], rm.MODULES.studio.desks[0]);
  entities.push({ id: 'terminal', kind: 'station', label: 'Desk one', transform: desk, station: model.defaultStation('Desk one') });
  return { version: 2, name: 'Modules', shell: { theme: 'station', width: 40, depth: 24, open: true }, entities, revision: 4 };
}

// ------------------------------------------------------------------------------------------------ contract
test('WORLD_VERSION is 3 and validateWorld accepts version 3 only (the v2 reader is readWorld / upgradeWorld)', () => {
  assert.equal(model.WORLD_VERSION, 3);
  const v3 = model.worldFromRoomV1({ theme: 'station', projectName: 'p' });
  assert.equal(v3.version, 3);
  assert.equal(model.validateWorld(v3).ok, true);
  assert.equal(model.validateWorld(asV2(v3)).ok, false);
  assert.equal(model.readWorld(asV2(v3)).ok, true);
  for (const bad of [null, 'x', [], { version: 1 }, { version: 4, name: 'n' }]) {
    assert.equal(model.readWorld(bad).ok, false);
    assert.equal(model.upgradeWorld(bad), bad);
  }
});

test('v2 -> v3 upgrade keeps every id and field: every template world', () => {
  assert.ok(templates.WORLD_TEMPLATES.length >= 5);
  for (const t of templates.WORLD_TEMPLATES) assertLossless(asV2(t.world));
});

test('v2 -> v3 upgrade keeps every id and field: onboarding worlds (small, zoned and big)', () => {
  for (const prompt of ['research lab: 3 Hermes desks for literature, data and writing, a shared monitor wall, a web wall for papers', '12 Hermes desks', 'a jungle room with 4 claude desks for a, b, c and d, 2 monitor walls', '']) {
    const w = onboarding.planWorld(prompt).world;
    assert.equal(w.version, 3, prompt);
    assertLossless(asV2(w));
  }
});

test('v2 -> v3 upgrade keeps room modules (module, doors, label) and the station', () => {
  const v2 = moduleWorld();
  const up = assertLossless(v2);
  assert.deepEqual(model.rooms(up).map(r => r.module), ['library', 'studio', 'lounge']);
  assert.equal(up.revision, 4);
});

test('v3 fields: site, room purpose and prop entities validate; junk is refused', () => {
  const w = model.upgradeWorld(moduleWorld());
  w.site = { kit: 'coastal', time: 'dusk', weather: 'clear', vista: 'sea', seed: 7 };
  w.entities[0].purpose = 'library';
  w.entities.push({ id: 'shelf-1', kind: 'prop', asset: 'wooden_bookshelf_worn', transform: { x: -10, z: -3, rotation: 0 }, slot: 'wall:shelf' });
  w.entities.push({ id: 'vase-1', kind: 'prop', asset: 'brass_vase_01', y: 0.75, scale: 1.2, transform: { x: -10, z: -2, rotation: 0.3 } });
  assert.equal(model.validateWorld(w).ok, true, model.validateWorld(w).error);
  const bad = (mutate) => { const c = clone(w); mutate(c); return model.validateWorld(c).ok; };
  assert.equal(bad(c => { c.site.kit = 'Coastal Kit'; }), false);
  assert.equal(bad(c => { c.site.time = 'noon'; }), false);
  assert.equal(bad(c => { c.site.weather = 'hail'; }), false);
  assert.equal(bad(c => { c.site.vista = 'moon'; }), false);
  assert.equal(bad(c => { c.site.seed = 1.5; }), false);
  assert.equal(bad(c => { delete c.site.kit; }), false);
  assert.equal(bad(c => { c.entities[0].purpose = 'A Library!'; }), false);
  assert.equal(bad(c => { c.entities[0].purpose = 42; }), false);
  assert.equal(bad(c => { c.entities.at(-1).asset = '../../etc/passwd'; }), false);
  assert.equal(bad(c => { c.entities.at(-1).asset = 'Brass_Vase'; }), false);
  assert.equal(bad(c => { c.entities.at(-1).asset = ''; }), false);
  assert.equal(bad(c => { c.entities.at(-1).scale = 0; }), false);
  assert.equal(bad(c => { c.entities.at(-1).y = -1; }), false);
  assert.equal(bad(c => { c.entities.at(-1).slot = 'Wall Shelf'; }), false);
  // the asset id FORMAT only: an id no installed catalogue has is still a valid world (catalogues install separately)
  assert.equal(bad(c => { c.entities.at(-1).asset = 'not_in_any_kit_yet'; }), true);
});

test("applyWorldOps: 'site' merges and validates; add 'prop' works; a bad asset id is refused atomically", () => {
  const w = model.worldFromRoomV1({ theme: 'skyline', projectName: 'p' });
  let r = model.applyWorldOps(w, [{ op: 'site', site: { time: 'day' } }]);
  assert.equal(r.ok, false, 'a world with no site needs a kit');
  r = model.applyWorldOps(w, [{ op: 'site', site: { kit: 'kyoto', time: 'dawn', seed: 3 } }]);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.world.site, { kit: 'kyoto', time: 'dawn', seed: 3 });
  r = model.applyWorldOps(r.world, [{ op: 'site', site: { weather: 'fog', time: undefined } }]);
  assert.deepEqual(r.world.site, { kit: 'kyoto', weather: 'fog', seed: 3 });
  assert.equal(model.applyWorldOps(r.world, [{ op: 'site', site: { vista: 'ocean' } }]).ok, false);
  const prop = { id: 'lamp-1', kind: 'prop', asset: 'andon_floor_lamp', transform: { x: 2, z: 1, rotation: 0 }, slot: 'corner:lantern' };
  const added = model.applyWorldOps(r.world, [{ op: 'add', entity: prop }, { op: 'move', id: 'lamp-1', transform: { x: 3, z: 1, rotation: 0 } }, { op: 'rename', id: 'lamp-1', label: 'Andon' }]);
  assert.equal(added.ok, true, added.error);
  assert.deepEqual(added.world.entities.find(e => e.id === 'lamp-1'), { ...prop, transform: { x: 3, z: 1, rotation: 0 }, label: 'Andon' });
  const refused = model.applyWorldOps(r.world, [{ op: 'add', entity: { ...prop, id: 'lamp-2' } }, { op: 'add', entity: { ...prop, id: 'lamp-3', asset: 'C:\\models\\lamp.glb' } }]);
  assert.equal(refused.ok, false);
  assert.equal(r.world.entities.some(e => e.id === 'lamp-2'), false);
  // a v2 world in memory: its next edit upgrades it (no field lost)
  const v2 = asV2(w);
  const edited = model.applyWorldOps(v2, [{ op: 'name', name: 'Renamed' }]);
  assert.equal(edited.ok, true, edited.error);
  assert.equal(edited.world.version, 3);
  assert.deepEqual({ ...edited.world, version: 2, name: v2.name, revision: v2.revision }, v2);
});

test('world-model.ts stays free of the voice settings words (voice-settings.test.cjs contract)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/common/world-model.ts'), 'utf8');
  assert.doesNotMatch(src, /\b(turns?|stuns?|iceServers?|credential|voice)\b/i);
});

// ------------------------------------------------------------------------------------------------ share + presets
function richWorld() {
  const w = model.upgradeWorld(moduleWorld());
  w.site = { kit: 'coastal', time: 'dusk', weather: 'rain', vista: 'sea', seed: 11 };
  w.entities[0].purpose = 'library';
  w.entities[2].purpose = 'lounge';
  w.entities.push({ id: 'shelf-1', kind: 'prop', label: 'Bookshelf', asset: 'wooden_bookshelf_worn', transform: { x: -10, z: -3, rotation: 0 }, slot: 'wall:shelf', scale: 1 });
  w.entities.push({ id: 'vase-1', kind: 'prop', asset: 'brass_vase_01', y: 0.75, transform: { x: -10, z: -2, rotation: 0.3 } });
  w.entities.push({ id: 'old-decor', kind: 'decor', decor: 'sofa', prop: 'Ottoman_01', transform: { x: 0, z: 8, rotation: 0 } });
  return w;
}
const strip = w => { const c = clone(w); for (const e of c.entities) if (e.kind === 'station') delete e.station.profile; return c; };

test('world-share export/import round trip keeps site, purpose, prop entities and room modules', () => {
  const w = richWorld();
  const shared = share.shareWorld(w);
  const opened = share.openWorldFile(shared.text);
  assert.deepEqual(opened.world.site, w.site);
  assert.deepEqual(opened.world.entities, strip(w).entities);
  assert.deepEqual(model.rooms(opened.world).map(r => [r.module, r.purpose]), [['library', 'library'], ['studio', undefined], ['lounge', 'lounge']]);
  // a hand-edited file with an unknown site field is refused
  const file = JSON.parse(shared.text); file.world.site.path = '/home/x';
  assert.throws(() => share.openWorldFile(JSON.stringify(file)), /unknown fields/);
  // a v2 world file (made before v3) still opens, losslessly
  const v2file = JSON.parse(share.shareWorld(moduleWorld()).text); v2file.world.version = 2;
  const reopened = share.openWorldFile(JSON.stringify(v2file));
  assert.equal(reopened.world.version, 3);
  assert.deepEqual(model.rooms(reopened.world).map(r => r.module), ['library', 'studio', 'lounge']);
});

test('world preset export/import keeps site, purpose, prop entities, room modules and decor prop ids', () => {
  const w = richWorld();
  const raw = preset.exportWorldPreset(w, { name: 'Coastal' });
  const back = preset.parseWorldPreset(raw).world;
  assert.deepEqual(back.site, w.site);
  assert.deepEqual(back.entities, w.entities);
  const any = preset.parseAnyRoomPreset(raw);
  assert.equal(any.version, 2); // the PRESET file format version (not the world version)
  const v2 = JSON.parse(preset.exportWorldPreset(moduleWorld())); v2.world.version = 2;
  assert.deepEqual(model.rooms(preset.parseWorldPreset(JSON.stringify(v2)).world).map(r => r.module), ['library', 'studio', 'lounge']);
});

// ------------------------------------------------------------------------------------------------ server
test('room server world-guard keeps module, purpose, site and prop; new ops are listed and shape-checked', () => {
  const W = require('../../server/vendor/world-model.cjs');
  const guard = require('../../server/src/world-guard.cjs');
  assert.equal(W.WORLD_VERSION, 3, 're-vendor: node server/scripts/vendor-world-model.cjs');
  assert.deepEqual(guard.OP_KEYS.site, ['site']);
  const w = richWorld();
  const canon = guard.canonicalWorld(w);
  assert.deepEqual(canon, w);
  // regression: canonicalEntity dropped `module` for rooms, so multiplayer lost room modules
  const v2room = guard.canonicalWorld(W.upgradeWorld(moduleWorld()));
  assert.deepEqual(v2room.entities.filter(e => e.kind === 'room').map(e => e.module), ['library', 'studio', 'lounge']);
  // a batch: site op + add prop, on a room saved as v2
  const stored = moduleWorld();
  const res = guard.applyBatch(stored, stored.revision, [
    { op: 'site', site: { kit: 'mars', vista: 'desert', extra: 'dropped' } },
    { op: 'add', entity: { id: 'desk-lamp', kind: 'prop', asset: 'desk_lamp_arm_01', y: 0.79, slot: 'desks:lamp', transform: { x: 0, z: -4, rotation: 0 }, junk: 1 } }
  ]);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.world.version, 3);
  assert.deepEqual(res.world.site, { kit: 'mars', vista: 'desert' });
  assert.deepEqual(res.world.entities.find(e => e.id === 'desk-lamp'), { id: 'desk-lamp', kind: 'prop', asset: 'desk_lamp_arm_01', y: 0.79, slot: 'desks:lamp', transform: { x: 0, z: -4, rotation: 0 } });
  assert.deepEqual(res.world.entities.filter(e => e.kind === 'room').map(e => e.module), ['library', 'studio', 'lounge']);
  assert.deepEqual(res.ops[0], { op: 'site', site: { kit: 'mars', vista: 'desert' } });
  assert.equal(guard.applyBatch(stored, stored.revision, [{ op: 'site', site: 'coastal' }]).ok, false);
  assert.equal(guard.applyBatch(stored, stored.revision, [{ op: 'add', entity: { id: 'p', kind: 'prop', asset: '/etc/passwd', transform: { x: 0, z: 0, rotation: 0 } } }]).ok, false);
});

// ------------------------------------------------------------------------------------------------ catalogue
const LAB = '/home/harry/dev/omo-sky-lab/world-director/kits';
const readJson = p => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : undefined);
function labPack(kit) {
  const dir = path.join(LAB, kit);
  const generated = (readJson(path.join(dir, 'tools/specs/simple_props.json'))?.props ?? []).map(p => p.id);
  return catalogueFromLab(dir, generated);
}
function catalogueFromLab(dir, generated) {
  return catalogue.catalogueFromKitJson(readJson(path.join(dir, 'kit.json')), {
    bounds: readJson(path.join(dir, 'tools/bounds.json')) ?? readJson(path.join(dir, 'bounds.json')),
    measured: readJson(path.join(dir, 'measured.json')),
    manifest: readJson(path.join(dir, 'manifest.json')) ?? readJson(path.join(dir, 'tools/fetch_manifest.json')),
    generated
  });
}
const haveLab = fs.existsSync(path.join(LAB, 'coastal/kit.json'));

test('catalogueFromKitJson converts the three lab kits with no invalid entries', { skip: !haveLab && 'lab kits not on this machine' }, () => {
  // kit.json props + the lab CORE props (built-in bookcase unless shoji; rug unless tatami) — director/kitlib.py rules
  const expected = { coastal: 40 + 2, kyoto: 38 + 0, mars: 35 + 2 };
  let total = 0;
  for (const [kit, count] of Object.entries(expected)) {
    const pack = labPack(kit);
    const kitJson = readJson(path.join(LAB, kit, 'kit.json'));
    assert.equal(pack.id, kit);
    assert.deepEqual(catalogue.packProblems(pack), [], kit);
    assert.equal(pack.assets.length, count, `${kit} asset count`);
    assert.equal(pack.assets.filter(a => !catalogue.validAsset(a)).length, 0, kit);
    total += pack.assets.length;
    // every kit prop is there, sizes in metres from the kit footprint, heights from the kit / measured bounds
    for (const p of kitJson.props) {
      const a = pack.assets.find(x => x.id === p.id.toLowerCase());
      assert.ok(a, `${kit}/${p.id}`);
      assert.equal(a.size.x, Math.round(p.footprint[0] * 1000) / 1000, `${kit}/${p.id} width`);
      assert.equal(a.footprint.z, Math.round(p.footprint[1] / 2 * 1000) / 1000, `${kit}/${p.id} depth`);
      assert.ok(a.size.y > 0 && a.size.y < 12, `${kit}/${p.id} height`);
      if (p.mount === 'ceiling' || p.place === 'ceiling') assert.equal(a.placement, 'ceiling');
      if ((p.mount ?? '').startsWith('on:')) { assert.equal(a.placement, 'surface'); assert.equal(a.on, p.mount.slice(3)); }
      if (a.model) assert.ok(!path.isAbsolute(a.model) && !a.model.includes('..'), a.model);
    }
    assert.ok(pack.lighting.hdri.startsWith('hdri/'), kit);
    assert.ok(pack.architecture.ceiling >= 2.5 && pack.architecture.wall > 0, kit);
    assert.equal(catalogueFromLab(path.join(LAB, kit), (readJson(path.join(LAB, kit, 'tools/specs/simple_props.json'))?.props ?? []).map(p => p.id)).version, pack.version, 'deterministic version');
  }
  assert.equal(total, 117);
  const kyoto = labPack('kyoto');
  assert.deepEqual(kyoto.assets.filter(a => a.license === 'generated').map(a => a.id).sort(), ['andon_floor_lamp', 'kakejiku_scroll', 'stone_toro_lantern', 'tea_tray_chawan', 'tokonoma_platform', 'washi_pendant_lamp', 'zabuton_cushion', 'zataku_low_table']);
  assert.equal(kyoto.assets.find(a => a.id === 'wooden_display_shelves_01').frontYaw, Math.PI / 2); // front -x
  assert.equal(labPack('mars').assets.find(a => a.id === 'desk_lamp_arm_01').front, '+y');
  assert.equal(labPack('mars').assets.find(a => a.id === 'power_box_01').part, 'power_box_01_box');
  assert.ok(kyoto.assets.filter(a => a.exterior).length >= 8, 'garden rocks/moss/pines are exterior');
  assert.equal(labPack('coastal').assets.find(a => a.id === 'ottoman_01').aliases[0], 'Ottoman_01');
});

test('the skyline penthouse style kit is a KitPack: every old decor prop id resolves', () => {
  const pack = catalogue.SKYLINE_PACK;
  assert.deepEqual(catalogue.packProblems(pack), []);
  assert.equal(pack.assets.length, styleKits.KIT_PROPS.length);
  for (const p of styleKits.KIT_PROPS) {
    const a = catalogue.findAsset(p.id);
    assert.ok(a, p.id);
    assert.equal(a.footprint.x, p.half.x);
  }
  assert.equal(catalogue.findAsset('sofa_02').affordances.includes('sit'), true);
  assert.equal(catalogue.findAsset('metal_office_desk').affordances.includes('work'), true);
  assert.equal(catalogue.findAsset('nope'), undefined);
});

test('validAsset refuses bad entries', () => {
  const good = catalogue.SKYLINE_PACK.assets[0];
  assert.equal(catalogue.validAsset(good), true);
  const bad = (patch) => catalogue.validAsset({ ...clone(good), ...patch });
  assert.equal(bad({ id: 'Upper' }), false);
  assert.equal(bad({ license: 'GPL' }), false);
  assert.equal(bad({ size: { x: 0, y: 1, z: 1 } }), false);
  assert.equal(bad({ footprint: { x: -1, z: 1 } }), false);
  assert.equal(bad({ affordances: [] }), false);
  assert.equal(bad({ affordances: ['fly'] }), false);
  assert.equal(bad({ placement: 'roof' }), false);
  assert.equal(bad({ front: '+x' }), false);
  assert.equal(bad({ model: '/home/harry/x.gltf' }), false);
  assert.equal(bad({ model: '../x.gltf' }), false);
  assert.equal(bad({ sha256: 'abc' }), false);
  assert.equal(bad({ sha256: 'a'.repeat(64) }), true);
});
