// beauty:foundation — the design-system lint. Every runtime builder (world-scene-*.ts: rooms, decor, paths, signs,
// boards, the open ground, the skyline floor and the kit loader) must take its materials and colours from
// world-look.ts. This test FAILS when a builder:
//   - creates a material itself (`new THREE.<X>Material(` outside world-look.ts),
//   - writes a colour literal (0xRRGGBB, '#rgb' / '#rrggbb', rgb()/rgba()) outside world-look.ts,
//   - uses MeshBasicMaterial (unlit) on a solid surface,
// and, built for real in Node, when any mesh of a room, every decor kind, the paths, the open ground or a skyline
// floor carries a material that did not come from world-look (userData.look).
// Run: node --test extension/test/beauty-lint.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');

const DIR = path.join(__dirname, '..', 'src', 'browser');
const BUILDERS = fs.readdirSync(DIR).filter(f => /^world-scene-.*\.ts$/.test(f)).sort();

/** Source without comments (a comment may mention a colour or a material by name). */
function code(file) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
function hits(file, re) {
  const out = [];
  code(file).split('\n').forEach((line, i) => { const m = line.match(re); if (m) out.push(`${file}:${i + 1}: ${m[0]}`); });
  return out;
}

test('the design system exists: world-look.ts exports the palette, the material recipes, the light rig and the type', () => {
  const src = fs.readFileSync(path.join(DIR, 'world-look.ts'), 'utf8');
  for (const name of ['PALETTE', 'LIGHT_RIG', 'LOOK_TYPE', 'look', 'lookPlate', 'lookScreen', 'paintSignPlate', 'paintTopicBoard', 'kitCityBackdrop'])
    assert.match(src, new RegExp(`export (const|function) ${name}\\b`), `world-look.ts exports ${name}`);
  for (const recipe of ['wall', 'floor.oak', 'floor.herringbone', 'trim', 'glass', 'fabric.accent', 'metal.brass', 'board', 'emissive.warm'])
    assert.ok(src.includes(`'${recipe}'`), `recipe ${recipe}`);
});

test('no builder creates its own material (new THREE.*Material( only in world-look.ts)', () => {
  const found = BUILDERS.flatMap(f => hits(f, /new THREE\.\w*Material\s*\(/));
  assert.deepEqual(found, [], `builders that create materials:\n${found.join('\n')}`);
});

test('no builder writes a colour literal (0xRRGGBB, #hex, rgb()/rgba() only in world-look.ts)', () => {
  const found = BUILDERS.flatMap(f => hits(f, /\b0x[0-9a-fA-F]{6}\b|['"`]#[0-9a-fA-F]{3,8}['"`]|\brgba?\s*\(/));
  assert.deepEqual(found, [], `builders with colour literals:\n${found.join('\n')}`);
});

test('no builder uses an unlit MeshBasicMaterial (solids are PBR; plates and screens come from world-look)', () => {
  const found = BUILDERS.flatMap(f => hits(f, /MeshBasicMaterial/));
  assert.deepEqual(found, [], `MeshBasicMaterial in builders:\n${found.join('\n')}`);
});

test('the old colour helpers are gone (no box/cylinder/glow/material/facet that take a colour)', () => {
  const kit = code('world-scene-kit.ts');
  for (const name of ['box', 'cylinder', 'glow', 'material', 'facet'])
    assert.ok(!new RegExp(`export function ${name}\\s*\\(`).test(kit), `world-scene-kit.ts still exports ${name}()`);
});

// ------------------------------------------------------------------------------------------- built for real
function loadBrowser(file) {
  const loader = Module._extensions['.ts'], resolve = Module._resolveFilename;
  Module._extensions['.ts'] = (module, filename) => module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
  Module._resolveFilename = function (request, parent, ...rest) { try { return resolve.call(this, request, parent, ...rest); } catch (error) { if (request.startsWith('.')) return resolve.call(this, request + '.ts', parent, ...rest); throw error; } };
  try { return require(path.join(DIR, file)); } finally { Module._extensions['.ts'] = loader; Module._resolveFilename = resolve; }
}
function offLook(root) {
  const out = [];
  root.traverse(n => {
    if (!n.isMesh && !n.isLine && !n.isPoints) return;
    for (const m of Array.isArray(n.material) ? n.material : [n.material]) if (!m || !m.userData || !m.userData.look) out.push(`${n.name || n.parent?.name || '?'} (${m?.type}${m?.name ? ' ' + m.name : ''})`);
  });
  return out;
}
const T = { x: 0, z: 0, rotation: 0 };
const room = (id, extra = {}) => ({ id, kind: 'room', transform: { ...T }, width: 12, depth: 9, label: 'Lighthouse library', ...extra });

test('every mesh of a built room, every decor kind, the paths, the open ground and a skyline floor uses a look material', () => {
  const rooms = loadBrowser('world-scene-rooms.ts');
  const decor = loadBrowser('world-scene-decor.ts');
  const entities = loadBrowser('world-scene-entities.ts');
  const paths = loadBrowser('world-scene-paths.ts');
  const shell = loadBrowser('world-scene-shell.ts');
  const skyline = loadBrowser('world-scene-skyline.ts');
  const bad = {};
  for (const jungle of [false, true]) {
    const r = rooms.buildRoom(room('r', { doors: ['front', 'left'] }), jungle).root; bad[`room ${jungle}`] = offLook(r);
  }
  for (const kind of ['plant', 'lamp', 'crystal', 'sofa', 'bookshelf', 'whiteboard', 'rug', 'window'])
    bad[`decor ${kind}`] = offLook(decor.buildDecor(kind, `d-${kind}`, false));
  bad['decor entity'] = offLook(entities.buildDecorEntity({ id: 'note-a', kind: 'decor', decor: 'whiteboard', transform: { ...T }, label: 'A note' }, false).root);
  const openShell = { theme: 'station', width: 60, depth: 50, open: true };
  const world = [room('mind-a', { transform: { x: -8, z: -6, rotation: 0 } }), room('mind-b', { transform: { x: 8, z: -6, rotation: 0 } })];
  bad.paths = offLook(paths.buildPaths(openShell, world));
  bad.open = offLook(shell.buildShell(openShell, []));
  bad.classic = offLook(shell.buildShell({ theme: 'station', width: 12, depth: 10 }, []));
  bad.jungle = offLook(shell.buildShell({ theme: 'jungle', width: 12, depth: 10 }, []));
  bad.skyline = offLook(skyline.buildSkylineShell({ theme: 'skyline', width: 30, depth: 24 }, [], { position: { x: 0, y: 1.6, z: 0 } }));
  const failing = Object.entries(bad).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.length} off-look meshes, e.g. ${v.slice(0, 3).join(', ')}`);
  assert.deepEqual(failing, [], failing.join('\n'));
});
