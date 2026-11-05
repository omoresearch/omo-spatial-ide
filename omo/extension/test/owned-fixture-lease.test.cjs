'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeFixtureHermesState } = require('./owned-app-fixture.cjs');
const h = require('./runtime-test-helpers.cjs');
const lease = h.lib('hermes-profile-lease');
test('owned no-network agent fixture has a real empty profile lease database', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'omo-owned-lease-'));
  try {
    initializeFixtureHermesState(root);
    assert.ok(fs.statSync(path.join(root,'state.db')).isFile());
    assert.deepEqual(lease.inspectHermesProfileTurnLeases('default',{OMO_SPATIAL_HERMES_ROOT:root}).leases,[]);
    const before=fs.readFileSync(path.join(root,'state.db'));
    assert.throws(()=>initializeFixtureHermesState(root),/exist/i);
    assert.deepEqual(fs.readFileSync(path.join(root,'state.db')),before,'never rewrite an existing profile database');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
