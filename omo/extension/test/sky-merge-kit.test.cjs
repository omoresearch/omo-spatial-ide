// sky:merge M1 — the skyline style kit is wired into worlds: the template and onboarding put stations on the kit's
// desk anchors and the web wall on its webwall_anchor, so the RoomScene draws the baked shell; baked furniture collides.
// Run: node --test extension/test/sky-merge-kit.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');

const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const model = require('../src/common/world-model.ts');
const kits = require('../src/common/world-style-kits.ts');
const templates = require('../src/common/world-templates.ts');
const onboarding = require('../src/browser/onboarding-planner.ts');
Module._extensions['.ts'] = originalTsLoader;

const KIT = kits.styleKit('skyline-penthouse');

test('M1: the NYC skyscraper template is the baked kit floor (activeKit), stations on desk anchors, web wall on webwall_anchor', () => {
  const w = templates.instantiateTemplate('nyc-skyscraper');
  assert.ok(model.validateWorld(w).ok);
  assert.equal(kits.activeKit(w)?.id, 'skyline-penthouse');
  const desks = w.entities.filter(e => e.kind === 'station');
  assert.equal(desks.length, 3);
  assert.deepEqual(desks.map(d => kits.kitDeskIndex(KIT, d.transform)), [0, 1, 2]);
  const web = w.entities.find(e => e.kind === 'web-wall');
  assert.ok(kits.onKitWebWall(KIT, web.transform));
});

test('M1: onboarding "skyline penthouse" with 3 desks takes the kit arrangement; larger worlds keep the procedural layout', () => {
  const card = 'skyline penthouse: a Hermes desk for planning, a Claude desk for code, a Codex desk for review, a web wall for docs, plants and a sofa';
  const plan = onboarding.planWorld(card);
  const w = plan.world ?? plan.proposal?.world ?? plan;
  const world = w.shell ? w : undefined;
  assert.ok(world, `planWorld returned a world: ${Object.keys(plan)}`);
  assert.equal(world.shell.theme, 'skyline');
  assert.equal(kits.activeKit(world)?.id, 'skyline-penthouse', JSON.stringify(world.shell));
  for (const d of world.entities.filter(e => e.kind === 'station')) assert.ok(kits.kitDeskIndex(KIT, d.transform) >= 0, d.id);
  const big = { ...world, entities: [...world.entities] };
  for (let i = 0; i < 2; i++) big.entities.push({ id: `extra-${i}`, kind: 'station', label: `X${i}`, transform: { x: 0, z: 0, rotation: 0 }, station: model.defaultStation(`X${i}`, 'shell') });
  assert.equal(onboarding.kitArrangement(big), undefined, '5 desks do not fit the 3-desk kit');
});

test('M1: kitArrangement only applies to skyline worlds', () => {
  const st = model.worldFromRoomV1({ theme: 'station', projectName: 'F', layout: 'classic', kit: 'hermes-desk' });
  assert.equal(onboarding.kitArrangement(st), undefined);
});
