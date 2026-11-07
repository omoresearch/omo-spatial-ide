// w2:admin — tiny fixture for the rule-based world planner. Run: node --test extension/test/world-admin-rules.test.cjs
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
const rules = require('../src/common/world-admin-rules.ts');
Module._extensions['.ts'] = originalTsLoader;

const base = () => model.worldFromRoomV1({ theme: 'station', projectName: 'Fixture', layout: 'classic', kit: 'hermes-desk' });
const plan = (world, prompt) => rules.planWithRules(world, prompt, { makeId: () => 'fixed' });
const applied = (world, result) => { const r = model.applyWorldOps(world, result.proposal.ops); assert.equal(r.ok, true, r.error); return r.world; };

const FIXTURE = [
  // [prompt, expected op kinds (in order, after optional shell growth), check(world)]
  ['add a third desk for Codex and a big monitor wall linked to it', ['add', 'add'], w => {
    const desk = w.entities.find(e => e.kind === 'station' && e.station.tabs.some(t => t.kind === 'codex'));
    assert.ok(desk, 'codex desk'); assert.equal(desk.station.tabs[0].kind, 'codex');
    const wall = w.entities.find(e => e.kind === 'monitor-wall');
    assert.equal(wall.link, desk.id); assert.ok(wall.width >= 4);
  }],
  ['add 2 shell desks named Ops', ['add', 'add'], w => {
    const ops = w.entities.filter(e => e.kind === 'station' && /^Ops/.test(e.station.name));
    assert.equal(ops.length, 2); assert.ok(ops.every(e => e.station.kind === 'shell'));
  }],
  ['add a web wall showing https://example.com/docs?token=abc&page=2', ['add'], w => {
    const web = w.entities.filter(e => e.kind === 'web-wall').find(e => e.home);
    assert.equal(web.home, 'https://example.com/docs?page=2');
  }],
  ['add a plant and a lamp', ['add', 'add'], w => {
    assert.ok(w.entities.some(e => e.kind === 'decor' && e.decor === 'plant'));
    assert.ok(w.entities.some(e => e.kind === 'decor' && e.decor === 'lamp'));
  }],
  ['move desk two left 2 m', ['move'], w => { assert.equal(w.entities.find(e => e.id === 'terminal-2').transform.x, 0.25); }],
  ['rename desk one to Build', ['rename', 'update-station'], w => { const d = w.entities.find(e => e.id === 'terminal'); assert.equal(d.label, 'Build'); assert.equal(d.station.name, 'Build'); }],
  ['lock desk two', ['update-station'], w => { assert.equal(w.entities.find(e => e.id === 'terminal-2').station.locked, true); }],
  ['remove the mirror', ['remove'], w => { assert.ok(!w.entities.some(e => e.kind === 'mirror')); }],
  ['link the mirror to desk two', ['link'], w => { assert.equal(w.entities.find(e => e.id === 'mirror').link, 'terminal-2'); }],
  ['arrange the desks in a row', ['move', 'move'], w => { const s = model.stations(w); assert.equal(s[0].transform.z, s[1].transform.z); }],
  ['switch to the jungle theme', ['shell'], w => { assert.equal(w.shell.theme, 'jungle'); }],
  ['rename the world to "Night Shift"', ['name'], w => { assert.equal(w.name, 'Night Shift'); }],
];

for (const [prompt, kinds, check] of FIXTURE) {
  test(`rules: ${prompt}`, () => {
    const world = base();
    const result = plan(world, prompt);
    assert.ok(result.proposal, `${prompt}: ${result.explanation}`);
    assert.deepEqual(result.proposal.ops.map(o => o.op).filter(k => k !== 'shell' || kinds.includes('shell')), kinds);
    assert.equal(result.proposal.baseRevision, world.revision);
    assert.equal(result.proposal.source, 'admin');
    assert.equal(result.steps.length, result.proposal.ops.length);
    check(applied(world, result));
  });
}

test('rules: U-shape with six desks grows the room if needed and stays valid', () => {
  let world = base();
  world = applied(world, plan(world, 'add 4 desks'));
  const result = plan(world, 'arrange all desks in a U-shape');
  assert.ok(result.proposal, result.explanation);
  const after = applied(world, result);
  assert.equal(model.stations(after).length, 6);
});

test('rules: a locked desk refuses move and explains', () => {
  let world = base();
  world = applied(world, plan(world, 'lock desk one'));
  const result = plan(world, 'move desk one right 1 m');
  assert.equal(result.proposal, null);
  assert.match(result.explanation, /locked/);
});

test('rules: nonsense gives no proposal and a helpful answer', () => {
  const result = plan(base(), 'sing me a song');
  assert.equal(result.proposal, null);
  assert.match(result.explanation, /did not understand|Try/);
});
