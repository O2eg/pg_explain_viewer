'use strict';
// Performance budgets: parse+analyze must stay near-linear in input size.
// Budgets are generous to absorb slow CI machines — they exist to catch
// quadratic regressions (like the end-anchored trim regex that once made a
// 2000-deep plan take 6+ seconds), not to benchmark.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PgPlan } = require('./helpers.js');

function deepPlan(n) {
  const lines = ['Nested Loop  (cost=0.00..90.00 rows=10 width=8) (actual time=0.10..30.00 rows=10 loops=1)'];
  for (let i = 1; i < n; i++) {
    lines.push('  '.repeat(i)
      + '->  Nested Loop  (cost=0.00..90.00 rows=10 width=8) (actual time=0.10..29.00 rows=10 loops=1)');
  }
  lines.push('  '.repeat(n)
    + '->  Seq Scan on t  (cost=0.00..5.00 rows=10 width=8) (actual time=0.01..0.10 rows=10 loops=1)');
  return lines.join('\n');
}

function widePlan(n) {
  const lines = ['Append  (cost=0.00..900.00 rows=1000 width=8) (actual time=0.10..50.00 rows=1000 loops=1)'];
  for (let i = 0; i < n; i++) {
    lines.push('  ->  Seq Scan on part_' + i
      + '  (cost=0.00..5.00 rows=10 width=8) (actual time=0.01..0.05 rows=10 loops=1)');
  }
  return lines.join('\n');
}

test('deep plan (2000 nodes, ~4MB of indentation) parses within budget', () => {
  const s = deepPlan(2000);
  const t0 = Date.now();
  const p = PgPlan.parse(s);
  const ms = Date.now() - t0;
  assert.equal(p.nodes.length, 2001);
  assert.ok(ms < 5000, `took ${ms}ms (budget 5000ms)`);
});

test('wide plan (10000 partitions) parses within budget', () => {
  const s = widePlan(10000);
  const t0 = Date.now();
  const p = PgPlan.parse(s);
  const ms = Date.now() - t0;
  assert.equal(p.nodes.length, 10001);
  assert.ok(ms < 3000, `took ${ms}ms (budget 3000ms)`);
});

test('input limit is byte-based, not UTF-16 code units', () => {
  // 5M cyrillic chars = 10 MiB UTF-8: must be rejected by the 8 MB limit
  assert.throws(() => PgPlan.parse('я'.repeat(5 * 1024 * 1024)), /too large/);
});

test('separate SQL text is limited too', () => {
  const plan = 'Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=1 loops=1)';
  assert.throws(() => PgPlan.parse(plan, { query: 'x'.repeat(2 * 1024 * 1024) }),
    /SQL text too large/);
  // a normal-sized query still works
  assert.equal(PgPlan.parse(plan, { query: 'SELECT 1' }).query, 'SELECT 1');
});
