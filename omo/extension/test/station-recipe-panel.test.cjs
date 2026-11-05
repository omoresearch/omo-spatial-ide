const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const panel = fs.readFileSync(path.resolve(__dirname, '../src/browser/station-recipe-panel.tsx'), 'utf8');
const widget = fs.readFileSync(path.resolve(__dirname, '../src/browser/omo-world-widget.tsx'), 'utf8');
const controls = fs.readFileSync(path.resolve(__dirname, '../src/browser/first-person-controls.ts'), 'utf8');
const strip = fs.readFileSync(path.resolve(__dirname, '../src/browser/runtime-console-strip.tsx'), 'utf8');

test('station recipe component is wired to storage and explicit apply confirmation', () => {
  for (const selector of ['station-recipe-panel', 'station-recipe-form', 'station-recipe-save', 'station-recipe-apply', 'station-recipe-delete']) assert.ok(panel.includes(selector), selector);
  assert.match(widget, /saveStationRecipe/);
  assert.match(widget, /requestRecipeApply/);
  assert.doesNotMatch(panel, /newTab|openWorkspace/);
});

test('physical room selectors and shortcut ownership are wired', () => {
  for (const selector of ['station-mirror-controls', 'station-recipe-toggle', 'runtime-copy-osc52', 'runtime-board-entry']) assert.ok((widget + strip).includes(selector), selector);
  assert.match(controls, /Ctrl\\+Shift\\+T|new-shell/);
  assert.match(controls, /Alt.*2|select-tab-2/);
  assert.match(controls, /event\.ctrlKey&&event\.key\.length===1/);
});
