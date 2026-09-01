'use strict';
// Golden-model tests: the normalized model of every fixture is snapshotted
// to test/golden/<fixture>.golden.json. Any parser/analyzer change shows up
// as an explicit diff. Regenerate deliberately with:
//   UPDATE_GOLDEN=1 npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GOLDEN_DIR, fixtureFiles, parseFixture, snapshot } = require('./helpers.js');

const UPDATE = !!process.env.UPDATE_GOLDEN;
if (UPDATE) fs.mkdirSync(GOLDEN_DIR, { recursive: true });

for (const f of fixtureFiles()) {
  test('golden: ' + f, () => {
    // round-trip through JSON so Infinity/undefined normalization matches
    // what is stored on disk
    const snap = JSON.parse(JSON.stringify(snapshot(parseFixture(f))));
    const goldenPath = path.join(GOLDEN_DIR, f + '.golden.json');
    if (UPDATE) {
      fs.writeFileSync(goldenPath, JSON.stringify(snap, null, 1) + '\n');
      return;
    }
    assert.ok(fs.existsSync(goldenPath),
      'missing golden snapshot ' + path.basename(goldenPath)
      + ' — run UPDATE_GOLDEN=1 npm test to create it');
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    assert.deepEqual(snap, golden);
  });
}
