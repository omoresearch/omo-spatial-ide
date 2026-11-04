const test = require('node:test');
const assert = require('node:assert/strict');
const { workstationLabelVisible } = require('../src/browser/workstation-label-visibility.ts');

test('walk labels are visible for a finite screen distance at or below reach', () => {
  assert.equal(workstationLabelVisible('walk', -1, 0), true);
  assert.equal(workstationLabelVisible('walk', 0, 3.2), true);
  assert.equal(workstationLabelVisible('walk', 1, 3.2), true);
});

test('walk labels are hidden when the screen is missing or unreachable', () => {
  assert.equal(workstationLabelVisible('walk', 0, undefined), false);
  assert.equal(workstationLabelVisible('walk', 0, 3.200001), false);
  assert.equal(workstationLabelVisible('walk', 0, -0.01), false);
});

test('walk labels are hidden for invalid screen distances', () => {
  assert.equal(workstationLabelVisible('walk', 0, Number.NaN), false);
  assert.equal(workstationLabelVisible('walk', 0, Number.POSITIVE_INFINITY), false);
  assert.equal(workstationLabelVisible('walk', 0, Number.NEGATIVE_INFINITY), false);
});

test('labels outside projected clip depth are hidden in every mode', () => {
  for (const mode of ['walk', 'overview']) {
    assert.equal(workstationLabelVisible(mode, -1.000001, 0), false, `${mode} near clip`);
    assert.equal(workstationLabelVisible(mode, 1.000001, 0), false, `${mode} far clip`);
    assert.equal(workstationLabelVisible(mode, Number.NaN, 0), false, `${mode} invalid clip`);
  }
});

test('overview labels stay visible in the frustum regardless of reach data', () => {
  assert.equal(workstationLabelVisible('overview', -1, undefined), true);
  assert.equal(workstationLabelVisible('overview', 0, Number.NaN), true);
  assert.equal(workstationLabelVisible('overview', 1, 999), true);
});
