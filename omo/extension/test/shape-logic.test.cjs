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
  assert.match(r.prompt, /armchair, a lamp and a bookshelf by the window/);
  const plan = planWithRules(world(), r.prompt);
  assert.equal(plan.proposal.ops.filter(o => o.op === 'add').length, 3);
  assert.equal(shape.captionFor(plan.proposal.summary, r.idea), 'A reading nook: armchair, lamp and bookshelf.');
});

test('"make it bigger" refines the pending prompt: every added thing is big', () => {
  const first = shape.expandIdea('add a reading nook by the window').prompt;
  const next = shape.refinePrompt(first, 'make it bigger');
  assert.match(next, /a big armchair, a big lamp and a big bookshelf/);
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
