// shape — Shape mode's pure helpers (idea expansion, pills, refinement, caption sentence, chips) against the real rules planner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  module._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }, fileName: filename }).outputText, filename);
};
const shape = require('../src/browser/shape-logic.ts');
const { planWithRules } = require('../src/common/world-admin-rules.ts');
const model = require('../src/common/world-model.ts');
Module._extensions['.ts'] = originalTsLoader;

const room = { version: 1, theme: 'station', projectUri: 'file:///p', projectName: 'P', camera: { azimuth: 0, elevation: 0.6, distance: 20 } };
const world = () => model.worldFromRoomV1(room);

test('a reading nook becomes things the rules planner knows, and plans 3 adds', () => {
  const r = shape.expandIdea('add a reading nook by the window');
  assert.equal(r.idea, 'A reading nook');
  assert.equal(r.prompt, 'add a reading chair by the window called Armchair, then add a lamp next to the armchair, then add a bookshelf next to the armchair');
  const plan = planWithRules(world(), r.prompt);
  const adds = plan.proposal.ops.filter(o => o.op === 'add');
  assert.equal(adds.length, 3);
  // the nook's armchair is the kit's real lounge armchair (not the spindly modern_arm_chair_01), named Armchair
  const chair = adds.find(o => o.entity.id === 'armchair');
  assert.ok(chair, JSON.stringify(adds.map(o => o.entity)));
  assert.equal(chair.entity.prop, 'mid_century_lounge_chair');
  assert.equal(chair.entity.label, 'Armchair');
  assert.equal(shape.captionFor(plan.proposal.summary, r.idea, undefined, shape.spokenNames(plan.proposal.ops)), 'A reading nook: armchair, lamp and bookshelf.');
});

test('"make it bigger" refines the pending prompt: every added thing is big', () => {
  const first = shape.expandIdea('add a reading nook by the window').prompt;
  const next = shape.refinePrompt(first, 'make it bigger');
  assert.match(next, /a big reading chair by the window called Armchair, then add a big lamp next to the armchair, then add a big bookshelf/);
  const plan = planWithRules(world(), next);
  assert.ok(plan.proposal.ops.every(o => o.op !== 'add' || o.entity.scale > 1), JSON.stringify(plan.proposal.ops));
  assert.equal(shape.refinePrompt('add a sofa', 'move it left'), 'add a sofa then move it left');
});

test('pills: pronouns take the name; the screen resolves to a real screen; the planner names that entity', () => {
  let w = world();
  w = model.applyWorldOps(w, planWithRules(w, 'add a sofa').proposal.ops).world;
  const pills = [{ id: 'sofa', name: 'Sofa' }];
  assert.equal(shape.composePrompt('move this closer to the screen', pills), 'move Sofa closer to the screen');
  assert.equal(shape.composePrompt('move closer to desk one', pills), 'move Sofa closer to desk one');
  const prompt = shape.resolveScreens(shape.composePrompt('move this closer to the screen', pills), w, { x: 0, z: 2.75 });
  assert.doesNotMatch(prompt, /the screen/);
  const plan = planWithRules(w, prompt);
  assert.ok(plan.proposal, plan.explanation);
  assert.ok(plan.proposal.ops.some(o => o.op === 'move' && o.id === 'sofa'));
  assert.match(shape.captionFor(plan.proposal.summary), /^Moves sofa\.$/i);
});

test('caption: one plain sentence, no jargon, first sentence only', () => {
  assert.equal(shape.captionFor('Add desk “Claude desk”'), 'Adds a Claude desk.');
  assert.equal(shape.captionFor('Add lamp; Add lamp', 'Warmer light'), 'Warmer light: lamp and lamp.');
  assert.equal(shape.captionFor('Remove “mirror”. Extra text.'), 'Removes mirror.');
  assert.equal(shape.captionFor('Add armchair; Add lamp; Add bookshelf; Add rug; and 1 more'), 'Adds an armchair, a lamp, a bookshelf, a rug and 1 more.');
  assert.equal(shape.expandIdea('make it warmer at night').prompt, 'add 2 lamps');
});

test('chips: three, fit the room', () => {
  const chips = shape.suggestionsFor(world());
  assert.equal(chips.length, 3);
  assert.deepEqual(chips, ['Add a reading nook by the window', 'Make it warmer at night', 'Add a desk for Claude']);
  for (const c of chips) assert.ok(planWithRules(world(), shape.expandIdea(c).prompt).proposal, c);
});

test('where: the place in the request goes into the caption', () => {
  assert.equal(shape.whereOf('add a reading nook by the window'), 'by the window');
  assert.equal(shape.whereOf('make it bigger'), undefined);
  assert.equal(shape.captionFor('Add armchair; Add lamp; Add bookshelf', 'A reading nook', 'by the window'), 'A reading nook: armchair, lamp and bookshelf by the window.');
});

test('"by the window" in the skyline kit lands the reading nook next to the glass (kit windowSpot)', () => {
  const { WORLD_TEMPLATES } = require('../src/common/world-templates.ts');
  const { STYLE_KITS } = require('../src/common/world-style-kits.ts');
  const kit = STYLE_KITS[0];
  const sky = JSON.parse(JSON.stringify(WORLD_TEMPLATES.find(t => t.id === 'nyc-skyscraper').world));
  const r = shape.expandIdea('add a reading nook by the window');
  const plan = planWithRules(sky, r.prompt);
  const adds = plan.proposal.ops.filter(o => o.op === 'add');
  assert.equal(adds.length, 3);
  const chair = adds.find(o => o.entity.kind === 'decor' && /armchair|chair/i.test(JSON.stringify(o.entity)));
  assert.ok(chair, 'an armchair is added');
  assert.equal(chair.entity.prop, 'mid_century_lounge_chair', 'the nook armchair is the kit lounge armchair');
  const d = Math.hypot(chair.entity.transform.x - kit.windowSpot.x, chair.entity.transform.z - kit.windowSpot.z);
  assert.ok(d < 2.0, `armchair ${JSON.stringify(chair.entity.transform)} within 2 m of the window spot ${JSON.stringify(kit.windowSpot)} (was ${d.toFixed(2)} m)`);
  // the north glass is at z = -depth/2: "by the window" means much nearer the glass than the room centre
  assert.ok(chair.entity.transform.z < -2.5, 'the armchair sits in the north (glass) half of the room');
});

test('the window rule does not fire without a kit (a station world keeps its old behaviour)', () => {
  const plan = planWithRules(world(), 'add an armchair by the window');
  assert.ok(plan.proposal.ops.length >= 1);
});
