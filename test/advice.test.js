'use strict';
// Advisor rule tests. Actionable (DDL-emitting) rules get the full 4-case
// matrix: positive / negative / low-impact (demoted to minor) /
// missing-evidence (must not fire). Observational rules get
// positive + negative pairs. Plus the advice-schema and impact-gating
// contracts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PgPlan } = require('./helpers.js');

const P = s => PgPlan.parse(s);
const codes = p => new Set(p.advice.map(a => a.code));
const entry = (p, c) => p.advice.find(a => a.code === c);
const fired = (p, c) => codes(p).has(c);

/* ---------------- SEQSCAN_DISCARD (actionable) ---------------- */

const SEQSCAN_DISCARD_POS = `Seq Scan on big_t  (cost=0.00..1000.00 rows=100 width=8) (actual time=0.10..50.00 rows=100 loops=1)
  Filter: (status = 'x'::text)
  Rows Removed by Filter: 10000
Execution Time: 50.5 ms`;

test('SEQSCAN_DISCARD positive: fires with high impact and safe DDL', () => {
  const p = P(SEQSCAN_DISCARD_POS);
  const a = entry(p, 'SEQSCAN_DISCARD');
  assert.ok(a, 'not raised');
  assert.equal(a.impact.level, 'high');
  assert.ok(a.idxs && a.idxs.length, 'no index candidate');
  assert.equal(a.idxs[0].confidence, 'exact');
  assert.match(a.idxs[0].def, /USING btree \(status\)/);
});

test('SEQSCAN_DISCARD negative: small removed-rows count does not fire', () => {
  const p = P(SEQSCAN_DISCARD_POS.replace('Rows Removed by Filter: 10000', 'Rows Removed by Filter: 40'));
  assert.ok(!fired(p, 'SEQSCAN_DISCARD'), [...codes(p)]);
});

test('SEQSCAN_DISCARD low impact: demoted to minor', () => {
  const p = P(`Sort  (cost=0.00..100.00 rows=10 width=8) (actual time=0.20..100.00 rows=10 loops=1)
  Sort Key: t.a
  ->  Seq Scan on t  (cost=0.00..10.00 rows=100 width=8) (actual time=0.01..0.40 rows=100 loops=1)
        Filter: (b = 3)
        Rows Removed by Filter: 10000
Execution Time: 100.4 ms`);
  const a = entry(p, 'SEQSCAN_DISCARD');
  assert.ok(a, 'not raised');
  assert.equal(a.impact.level, 'minor');
});

test('SEQSCAN_DISCARD missing evidence: no Rows Removed line, no advice', () => {
  const p = P(`Seq Scan on big_t  (cost=0.00..1000.00 rows=100 width=8) (actual time=0.10..50.00 rows=100 loops=1)
  Filter: (status = 'x'::text)
Execution Time: 50.5 ms`);
  assert.ok(!fired(p, 'SEQSCAN_DISCARD'));
});

/* ---------------- INDEX_DISCARD (actionable) ---------------- */

const INDEX_DISCARD_POS = `Index Scan using idx_t_a on t  (cost=0.42..500.00 rows=10 width=8) (actual time=0.05..40.00 rows=10 loops=1)
  Index Cond: (a > 5)
  Filter: (b = 3)
  Rows Removed by Filter: 5000
Execution Time: 40.4 ms`;

test('INDEX_DISCARD positive', () => {
  const a = entry(P(INDEX_DISCARD_POS), 'INDEX_DISCARD');
  assert.ok(a, 'not raised');
  assert.equal(a.impact.level, 'high');
  assert.ok(a.idxs && a.idxs[0].def.includes('b'), 'filter column missing from DDL');
});

test('INDEX_DISCARD negative: few rows removed', () => {
  const p = P(INDEX_DISCARD_POS.replace('Rows Removed by Filter: 5000', 'Rows Removed by Filter: 15'));
  assert.ok(!fired(p, 'INDEX_DISCARD'));
});

test('INDEX_DISCARD low impact: minor', () => {
  const p = P(`Sort  (cost=0.00..100.00 rows=10 width=8) (actual time=0.20..90.00 rows=10 loops=1)
  Sort Key: t.a
  ->  Index Scan using idx_t_a on t  (cost=0.42..5.00 rows=10 width=8) (actual time=0.01..0.30 rows=10 loops=1)
        Index Cond: (a > 5)
        Filter: (b = 3)
        Rows Removed by Filter: 5000
Execution Time: 90.4 ms`);
  const a = entry(p, 'INDEX_DISCARD');
  assert.ok(a && a.impact.level === 'minor', a && a.impact.level);
});

test('INDEX_DISCARD missing evidence: no rows-removed data', () => {
  const p = P(`Index Scan using idx_t_a on t  (cost=0.42..500.00 rows=10 width=8) (actual time=0.05..40.00 rows=10 loops=1)
  Index Cond: (a > 5)
  Filter: (b = 3)
Execution Time: 40.4 ms`);
  assert.ok(!fired(p, 'INDEX_DISCARD'));
});

/* ---------------- JOIN_FULLREAD / ANTIJOIN_FULLREAD (actionable) ---------------- */

const HSH_POS = `Hash Join  (cost=100.00..200.00 rows=7 width=16) (actual time=1.00..30.00 rows=7 loops=1)
  Hash Cond: (i.film_id = r.film_id)
  ->  Seq Scan on inventory i  (cost=0.00..100.00 rows=604 width=8) (actual time=0.01..20.00 rows=604 loops=1)
  ->  Hash  (cost=50.00..50.00 rows=100 width=8) (actual time=0.50..0.50 rows=100 loops=1)
        ->  Seq Scan on rental r  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..0.40 rows=100 loops=1)
              Filter: (rental_date > '2020-01-01'::date)
Execution Time: 30.5 ms`;

test('JOIN_FULLREAD positive with join-key DDL', () => {
  const a = entry(P(HSH_POS), 'JOIN_FULLREAD');
  assert.ok(a, 'not raised');
  assert.ok(a.idxs, 'no candidate');
  assert.match(a.idxs[0].def, /ON inventory USING btree \(film_id\)/);
});

test('JOIN_FULLREAD negative: join keeps most rows', () => {
  const p = P(HSH_POS
    .replace('rows=7 width=16) (actual time=1.00..30.00 rows=7', 'rows=600 width=16) (actual time=1.00..30.00 rows=600'));
  assert.ok(!fired(p, 'JOIN_FULLREAD'));
});

test('JOIN_FULLREAD low impact: minor', () => {
  const p = P(`Aggregate  (cost=0.00..500.00 rows=1 width=8) (actual time=0.10..80.00 rows=1 loops=1)
  ->  Hash Join  (cost=100.00..200.00 rows=7 width=16) (actual time=0.10..0.50 rows=7 loops=1)
        Hash Cond: (i.film_id = r.film_id)
        ->  Seq Scan on inventory i  (cost=0.00..100.00 rows=604 width=8) (actual time=0.01..0.30 rows=604 loops=1)
        ->  Hash  (cost=50.00..50.00 rows=100 width=8) (actual time=0.05..0.05 rows=100 loops=1)
              ->  Seq Scan on rental r  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..0.04 rows=100 loops=1)
Execution Time: 80.4 ms`);
  const a = entry(p, 'JOIN_FULLREAD');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('JOIN_FULLREAD missing evidence: filtered scan is not attributed to the join', () => {
  const p = P(HSH_POS.replace(
    '  ->  Seq Scan on inventory i  (cost=0.00..100.00 rows=604 width=8) (actual time=0.01..20.00 rows=604 loops=1)',
    '  ->  Seq Scan on inventory i  (cost=0.00..100.00 rows=604 width=8) (actual time=0.01..20.00 rows=604 loops=1)\n'
    + '        Filter: (store_id = 1)'));
  assert.ok(!fired(p, 'JOIN_FULLREAD'));
});

test('ANTIJOIN_FULLREAD positive: Hash Anti Join classifies as anti-join, not JOIN_FULLREAD', () => {
  const p = P(HSH_POS.replace('Hash Join ', 'Hash Anti Join '));
  assert.ok(fired(p, 'ANTIJOIN_FULLREAD'), [...codes(p)]);
  assert.ok(!fired(p, 'JOIN_FULLREAD'));
});

test('ANTIJOIN_FULLREAD negative', () => {
  const p = P(HSH_POS.replace('Hash Join ', 'Hash Anti Join ')
    .replace('rows=7 width=16) (actual time=1.00..30.00 rows=7', 'rows=600 width=16) (actual time=1.00..30.00 rows=600'));
  assert.ok(!fired(p, 'ANTIJOIN_FULLREAD'));
});

/* ---------------- LIMIT_SORT (actionable) ---------------- */

const LIMIT_SORT_POS = `Limit  (cost=800.00..800.03 rows=10 width=8) (actual time=45.00..45.01 rows=10 loops=1)
  ->  Sort  (cost=800.00..825.00 rows=10000 width=8) (actual time=45.00..45.00 rows=10 loops=1)
        Sort Key: t.amount DESC
        ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..20.00 rows=10000 loops=1)
Execution Time: 45.4 ms`;

test('LIMIT_SORT positive with sort-key DDL', () => {
  const p = P(LIMIT_SORT_POS);
  const a = entry(p, 'LIMIT_SORT');
  assert.ok(a, 'not raised');
  assert.ok(!fired(p, 'LIMIT_OFFSET'), 'LIMIT_OFFSET must not double-fire');
  assert.ok(a.idxs, 'no candidate');
  assert.match(a.idxs[0].def, /USING btree \(amount\)/);
});

test('LIMIT_SORT negative: limit consumes most of the scan', () => {
  const p = P(LIMIT_SORT_POS
    .replace('rows=10 width=8) (actual time=45.00..45.01 rows=10', 'rows=9000 width=8) (actual time=45.00..45.01 rows=9000'));
  assert.ok(!fired(p, 'LIMIT_SORT'));
});

test('LIMIT_SORT low impact: minor', () => {
  const p = P(`Nested Loop  (cost=0.00..900.00 rows=10 width=16) (actual time=0.10..60.00 rows=10 loops=1)
  ->  Limit  (cost=8.00..8.03 rows=10 width=8) (actual time=0.30..0.31 rows=10 loops=1)
        ->  Sort  (cost=8.00..8.25 rows=1000 width=8) (actual time=0.30..0.30 rows=10 loops=1)
              Sort Key: t.amount DESC
              ->  Seq Scan on t  (cost=0.00..6.00 rows=1000 width=8) (actual time=0.01..0.10 rows=1000 loops=1)
  ->  Seq Scan on u  (cost=0.00..80.00 rows=1 width=8) (actual time=0.01..5.90 rows=1 loops=10)
Execution Time: 60.4 ms`);
  const a = entry(p, 'LIMIT_SORT');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('LIMIT_SORT missing evidence: no Sort Key -> advice without DDL', () => {
  const p = P(LIMIT_SORT_POS.replace('        Sort Key: t.amount DESC\n', ''));
  const a = entry(p, 'LIMIT_SORT');
  assert.ok(a, 'not raised');
  assert.ok(!a.idxs, 'DDL must not be generated without the sort key');
});

/* ---------------- BITMAP_AND (actionable) ---------------- */

const BITMAP_AND_POS = `Bitmap Heap Scan on t  (cost=50.00..300.00 rows=10 width=8) (actual time=1.00..30.00 rows=10 loops=1)
  Recheck Cond: ((a = 1) AND (b = 2))
  ->  BitmapAnd  (cost=50.00..50.00 rows=10 width=0) (actual time=0.90..0.90 rows=0 loops=1)
        ->  Bitmap Index Scan on idx_a  (cost=0.00..25.00 rows=100 width=0) (actual time=0.50..0.50 rows=100 loops=1)
              Index Cond: (a = 1)
        ->  Bitmap Index Scan on idx_b  (cost=0.00..25.00 rows=100 width=0) (actual time=0.30..0.30 rows=100 loops=1)
              Index Cond: (b = 2)
Execution Time: 30.5 ms`;

test('BITMAP_AND positive with composite DDL', () => {
  const a = entry(P(BITMAP_AND_POS), 'BITMAP_AND');
  assert.ok(a, 'not raised');
  assert.ok(a.idxs, 'no candidate');
  assert.match(a.idxs[0].def, /USING btree \(a, b\)/);
});

test('BITMAP_AND negative: single bitmap index scan', () => {
  const p = P(`Bitmap Heap Scan on t  (cost=25.00..300.00 rows=10 width=8) (actual time=1.00..30.00 rows=10 loops=1)
  Recheck Cond: (a = 1)
  ->  Bitmap Index Scan on idx_a  (cost=0.00..25.00 rows=100 width=0) (actual time=0.50..0.50 rows=100 loops=1)
        Index Cond: (a = 1)
Execution Time: 30.5 ms`);
  assert.ok(!fired(p, 'BITMAP_AND'));
});

test('BITMAP_AND low impact: minor', () => {
  const p = P(`Aggregate  (cost=0.00..500.00 rows=1 width=8) (actual time=0.10..90.00 rows=1 loops=1)
  ->  ${BITMAP_AND_POS.split('\n').slice(0, -1).map((l, i) => (i ? '      ' + l : l)).join('\n')
    .replace('actual time=1.00..30.00 rows=10', 'actual time=0.05..0.40 rows=10')
    .replace('actual time=0.90..0.90', 'actual time=0.09..0.09')
    .replace('actual time=0.50..0.50', 'actual time=0.05..0.05')
    .replace('actual time=0.30..0.30', 'actual time=0.03..0.03')}
Execution Time: 90.4 ms`);
  const a = entry(p, 'BITMAP_AND');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('BITMAP_AND missing evidence: non-index child blocks the rule', () => {
  const p = P(BITMAP_AND_POS.replace('Bitmap Index Scan on idx_b', 'Seq Scan on t2'));
  assert.ok(!fired(p, 'BITMAP_AND'));
});

/* ---------------- DISK_SORT / DISK_HASH (actionable) ---------------- */

const DISK_SORT_POS = `Sort  (cost=800.00..825.00 rows=10000 width=8) (actual time=1.00..40.00 rows=10000 loops=1)
  Sort Key: t.a
  Sort Method: external merge  Disk: 5000kB
  ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..10.00 rows=10000 loops=1)
Execution Time: 40.4 ms`;

test('DISK_SORT positive: spill volume in evidence, SET LOCAL in next steps', () => {
  const a = entry(P(DISK_SORT_POS), 'DISK_SORT');
  assert.ok(a, 'not raised');
  assert.match(a.nodes[0].ext, /4\.9 MB/);        // 5000 kB, spelled for humans
  assert.match(a.next, /SET LOCAL work_mem = '8MB'/); // concrete, sized from the spill
  assert.match(a.next, /concurrent/i);
});

test('DISK_SORT huge spill: no absurd work_mem, tells you to cut the row set', () => {
  const p = P(DISK_SORT_POS.replace('Disk: 5000kB', 'Disk: 4765552kB'));
  const a = entry(p, 'DISK_SORT');
  assert.match(a.nodes[0].ext, /4\.5 GB/);
  assert.doesNotMatch(a.next, /SET LOCAL/);
  assert.match(a.next, /not realistic/);
});

test('DISK_SORT negative: in-memory sort', () => {
  const p = P(DISK_SORT_POS.replace('Sort Method: external merge  Disk: 5000kB', 'Sort Method: quicksort  Memory: 25kB'));
  assert.ok(!fired(p, 'DISK_SORT'));
});

test('DISK_SORT low impact: minor', () => {
  const p = P(`Hash Join  (cost=0.00..900.00 rows=10 width=8) (actual time=0.10..80.00 rows=10 loops=1)
  Hash Cond: (t.a = u.a)
  ->  Seq Scan on u  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..78.00 rows=10000 loops=1)
  ->  Hash  (cost=8.00..8.00 rows=100 width=8) (actual time=0.60..0.60 rows=100 loops=1)
        ->  Sort  (cost=8.00..8.25 rows=100 width=8) (actual time=0.30..0.50 rows=100 loops=1)
              Sort Key: t.a
              Sort Method: external merge  Disk: 80kB
              ->  Seq Scan on t  (cost=0.00..6.00 rows=100 width=8) (actual time=0.01..0.10 rows=100 loops=1)
Execution Time: 80.4 ms`);
  const a = entry(p, 'DISK_SORT');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('DISK_SORT missing evidence: no Sort Method line', () => {
  const p = P(DISK_SORT_POS.replace('  Sort Method: external merge  Disk: 5000kB\n', ''));
  assert.ok(!fired(p, 'DISK_SORT'));
});

const DISK_HASH_POS = `Hash Join  (cost=100.00..200.00 rows=100 width=16) (actual time=1.00..40.00 rows=100 loops=1)
  Hash Cond: (a.id = b.id)
  ->  Seq Scan on a  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.01..10.00 rows=1000 loops=1)
  ->  Hash  (cost=50.00..50.00 rows=10000 width=8) (actual time=20.00..20.00 rows=10000 loops=1)
        Buckets: 1024  Batches: 4  Memory Usage: 33kB  Disk Usage: 5000kB
        ->  Seq Scan on b  (cost=0.00..50.00 rows=10000 width=8) (actual time=0.01..8.00 rows=10000 loops=1)
Execution Time: 40.4 ms`;

test('DISK_HASH positive: a reported Disk Usage may drive a concrete work_mem', () => {
  const a = entry(P(DISK_HASH_POS), 'DISK_HASH');
  assert.ok(a, 'not raised');
  assert.match(a.next, /SET LOCAL work_mem/);
  assert.match(a.next, /hash_mem_multiplier/);
});

test('DISK_HASH negative: hash fits in memory', () => {
  const p = P(DISK_HASH_POS.replace('Buckets: 1024  Batches: 4  Memory Usage: 33kB  Disk Usage: 5000kB',
    'Buckets: 16384  Batches: 1  Memory Usage: 600kB'));
  assert.ok(!fired(p, 'DISK_HASH'));
});

test('DISK_HASH low impact: minor', () => {
  const p = P(DISK_HASH_POS
    .replace('actual time=20.00..20.00 rows=10000', 'actual time=0.40..0.40 rows=10000')
    .replace('actual time=0.01..8.00 rows=10000', 'actual time=0.01..0.20 rows=10000'));
  const a = entry(p, 'DISK_HASH');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('DISK_HASH missing evidence: no buckets line', () => {
  const p = P(DISK_HASH_POS.replace('        Buckets: 1024  Batches: 4  Memory Usage: 33kB  Disk Usage: 5000kB\n', ''));
  assert.ok(!fired(p, 'DISK_HASH'));
});

/* ---------------- TEMP_SPILL (actionable) ---------------- */

const TEMP_SPILL_POS = `Materialize  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.50..20.00 rows=1000 loops=1)
  Buffers: temp read=100 written=500
  ->  Seq Scan on t  (cost=0.00..80.00 rows=1000 width=8) (actual time=0.01..5.00 rows=1000 loops=1)
Execution Time: 20.4 ms`;

test('TEMP_SPILL positive', () => {
  const a = entry(P(TEMP_SPILL_POS), 'TEMP_SPILL');
  assert.ok(a, 'not raised');
  assert.match(a.nodes[0].ext, /temp written=500/);
});

test('TEMP_SPILL negative: no temp traffic', () => {
  const p = P(TEMP_SPILL_POS.replace('  Buffers: temp read=100 written=500\n', ''));
  assert.ok(!fired(p, 'TEMP_SPILL'));
});

test('TEMP_SPILL low impact: minor', () => {
  const p = P(`Hash Join  (cost=0.00..900.00 rows=10 width=8) (actual time=0.10..80.00 rows=10 loops=1)
  Hash Cond: (t.a = u.a)
  ->  Seq Scan on u  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..78.00 rows=10000 loops=1)
  ->  Materialize  (cost=0.00..10.00 rows=100 width=8) (actual time=0.05..0.40 rows=100 loops=1)
        Buffers: temp written=8
        ->  Seq Scan on t  (cost=0.00..6.00 rows=100 width=8) (actual time=0.01..0.10 rows=100 loops=1)
Execution Time: 80.4 ms`);
  const a = entry(p, 'TEMP_SPILL');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('TEMP_SPILL suppressed when the spill is already reported as DISK_SORT', () => {
  const p = P(DISK_SORT_POS.replace('  Sort Method: external merge  Disk: 5000kB',
    '  Sort Method: external merge  Disk: 5000kB\n  Buffers: temp read=100 written=625'));
  assert.ok(fired(p, 'DISK_SORT'));
  assert.ok(!fired(p, 'TEMP_SPILL'), 'double-reported spill');
});

/* ---------------- observational rules: positive + negative ---------------- */

test('BITMAP_OR pair', () => {
  const pos = P(BITMAP_AND_POS.replace('BitmapAnd', 'BitmapOr').replace('(a = 1) AND (b = 2)', '(a = 1) OR (b = 2)'));
  assert.ok(fired(pos, 'BITMAP_OR'));
  assert.ok(!fired(pos, 'BITMAP_AND'));
  assert.ok(!fired(P(BITMAP_AND_POS), 'BITMAP_OR'));
});

test('BITMAP_LOSSY pair', () => {
  const pos = P(BITMAP_AND_POS.replace('  Recheck Cond: ((a = 1) AND (b = 2))',
    '  Recheck Cond: ((a = 1) AND (b = 2))\n  Heap Blocks: exact=100 lossy=500'));
  assert.ok(fired(pos, 'BITMAP_LOSSY'));
  assert.ok(!fired(P(BITMAP_AND_POS), 'BITMAP_LOSSY'));
});

test('LIMIT_OFFSET pair', () => {
  const pos = P(`Limit  (cost=600.00..600.03 rows=10 width=8) (actual time=20.00..20.01 rows=10 loops=1)
  ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..19.00 rows=10000 loops=1)
Execution Time: 20.4 ms`);
  assert.ok(fired(pos, 'LIMIT_OFFSET'));
  const neg = P(`Limit  (cost=600.00..600.03 rows=5000 width=8) (actual time=20.00..20.01 rows=5000 loops=1)
  ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..19.00 rows=10000 loops=1)
Execution Time: 20.4 ms`);
  assert.ok(!fired(neg, 'LIMIT_OFFSET'));
});

test('CTE_RESCAN pair', () => {
  const mk = loops => P(`Nested Loop  (cost=0.00..900.00 rows=100 width=16) (actual time=0.10..50.00 rows=100 loops=1)
  CTE big
    ->  Seq Scan on src  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.01..5.00 rows=1000 loops=1)
  ->  Seq Scan on u  (cost=0.00..10.00 rows=${loops} width=8) (actual time=0.01..0.50 rows=${loops} loops=1)
  ->  CTE Scan on big  (cost=0.00..20.00 rows=1000 width=8) (actual time=0.00..1.50 rows=1000 loops=${loops})
Execution Time: 50.4 ms`);
  assert.ok(fired(mk(20), 'CTE_RESCAN'));
  assert.ok(!fired(mk(2), 'CTE_RESCAN'));
});

test('INDEX_FULLREAD pair', () => {
  const pos = P(`Index Scan using idx_t_a on t  (cost=0.42..500.00 rows=10000 width=8) (actual time=0.05..40.00 rows=10000 loops=1)
Execution Time: 40.4 ms`);
  assert.ok(fired(pos, 'INDEX_FULLREAD'));
  assert.ok(!fired(P(INDEX_DISCARD_POS), 'INDEX_FULLREAD'));
});

test('ROW_ESTIMATE pair (hedged wording)', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=10 width=8) (actual time=0.05..40.00 rows=5000 loops=1)
Execution Time: 40.4 ms`);
  const a = entry(pos, 'ROW_ESTIMATE');
  assert.ok(a, 'not raised');
  assert.match(a.hyp, /may/);
  assert.match(a.next, /ANALYZE/);
  const neg = P(`Seq Scan on t  (cost=0.00..100.00 rows=4900 width=8) (actual time=0.05..40.00 rows=5000 loops=1)
Execution Time: 40.4 ms`);
  assert.ok(!fired(neg, 'ROW_ESTIMATE'));
});

test('SEQSCAN_BUFFERS pair (bloat is a hypothesis, not a verdict)', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..40.00 rows=100 loops=1)
  Buffers: shared hit=1000
Execution Time: 40.4 ms`);
  const a = entry(pos, 'SEQSCAN_BUFFERS');
  assert.ok(a, 'not raised');
  assert.match(a.hyp, /can indicate/);
  assert.match(a.next, /Verify bloat first/);
  const neg = P(`Seq Scan on t  (cost=0.00..100.00 rows=100000 width=8) (actual time=0.05..40.00 rows=100000 loops=1)
  Buffers: shared hit=1000
Execution Time: 40.4 ms`);
  assert.ok(!fired(neg, 'SEQSCAN_BUFFERS'));
});

test('INDEX_BUFFERS pair', () => {
  const pos = P(`Index Scan using idx_t_a on t  (cost=0.42..100.00 rows=100 width=8) (actual time=0.05..40.00 rows=100 loops=1)
  Index Cond: (a > 5)
  Buffers: shared hit=1000
Execution Time: 40.4 ms`);
  assert.ok(fired(pos, 'INDEX_BUFFERS'));
  const neg = P(pos.text.replace('rows=100 loops=1', 'rows=100000 loops=1').replace('rows=100 width', 'rows=100000 width'));
  assert.ok(!fired(neg, 'INDEX_BUFFERS'));
});

test('TABLE_WRITTEN pair', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=10000 width=8) (actual time=0.05..40.00 rows=10000 loops=1)
  Buffers: shared hit=100 written=5
Execution Time: 40.4 ms`);
  assert.ok(fired(pos, 'TABLE_WRITTEN'));
  const neg = P(pos.text.replace(' written=5', ''));
  assert.ok(!fired(neg, 'TABLE_WRITTEN'));
});

test('UNEXPLAINED_TIME pair (no overload verdict)', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.05..200.00 rows=1000 loops=1)
  Buffers: shared hit=10
Execution Time: 200.4 ms`);
  const a = entry(pos, 'UNEXPLAINED_TIME');
  assert.ok(a, 'not raised');
  assert.match(a.hyp, /cannot tell/);
  assert.match(a.next, /pg_stat_activity/);
  const neg = P(pos.text.replace('shared hit=10', 'shared hit=2000000'));
  assert.ok(!fired(neg, 'UNEXPLAINED_TIME'));
});

test('GATHER_WORKERS pair', () => {
  const mk = launched => P(`Gather  (cost=1000.00..2000.00 rows=100 width=8) (actual time=1.00..30.00 rows=100 loops=1)
  Workers Planned: 4
  Workers Launched: ${launched}
  ->  Parallel Seq Scan on t  (cost=0.00..900.00 rows=25 width=8) (actual time=0.50..20.00 rows=${launched ? 33 : 100} loops=${launched + 1})
Execution Time: 30.4 ms`);
  assert.ok(fired(mk(2), 'GATHER_WORKERS'));
  assert.ok(!fired(mk(4), 'GATHER_WORKERS'));
});

test('REDUNDANT_SORT pair', () => {
  const pos = P(`Sort  (cost=900.00..925.00 rows=1000 width=8) (actual time=10.00..30.00 rows=1000 loops=1)
  Sort Key: t.a
  ->  Sort  (cost=800.00..825.00 rows=1000 width=8) (actual time=5.00..8.00 rows=1000 loops=1)
        Sort Key: t.b
        ->  Seq Scan on t  (cost=0.00..600.00 rows=1000 width=8) (actual time=0.01..2.00 rows=1000 loops=1)
Execution Time: 30.4 ms`);
  assert.ok(fired(pos, 'REDUNDANT_SORT'));
  const neg = P(`Sort  (cost=900.00..925.00 rows=1000 width=8) (actual time=10.00..30.00 rows=1000 loops=1)
  Sort Key: t.a
  ->  Seq Scan on t  (cost=0.00..600.00 rows=1000 width=8) (actual time=0.01..2.00 rows=1000 loops=1)
Execution Time: 30.4 ms`);
  assert.ok(!fired(neg, 'REDUNDANT_SORT'));
});

test('REDUNDANT_GROUP pair', () => {
  const pos = P(`HashAggregate  (cost=900.00..925.00 rows=100 width=8) (actual time=10.00..30.00 rows=100 loops=1)
  Group Key: t.a
  ->  GroupAggregate  (cost=800.00..825.00 rows=100 width=8) (actual time=5.00..8.00 rows=100 loops=1)
        Group Key: t.a
        ->  Seq Scan on t  (cost=0.00..600.00 rows=1000 width=8) (actual time=0.01..2.00 rows=1000 loops=1)
Execution Time: 30.4 ms`);
  assert.ok(fired(pos, 'REDUNDANT_GROUP'));
  const neg = P(pos.text.replace('        Group Key: t.a', '        Group Key: t.b'));
  assert.ok(!fired(neg, 'REDUNDANT_GROUP'));
});

test('REPEATED_WORK pair', () => {
  const pos = P(`Nested Loop  (cost=0.00..900.00 rows=10 width=16) (actual time=0.10..30.00 rows=10 loops=1)
  ->  Materialize  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..5.00 rows=100 loops=1)
        ->  Seq Scan on t  (cost=0.00..80.00 rows=100 width=8) (actual time=0.01..3.00 rows=100 loops=1)
  ->  Materialize  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..5.00 rows=100 loops=10)
        ->  Seq Scan on t  (cost=0.00..80.00 rows=100 width=8) (actual time=0.01..3.00 rows=100 loops=1)
Execution Time: 30.4 ms`);
  assert.ok(fired(pos, 'REPEATED_WORK'), [...codes(pos)]);
  const neg = P(pos.text.replace('        ->  Seq Scan on t  (cost=0.00..80.00 rows=100 width=8) (actual time=0.01..3.00 rows=100 loops=1)\nExecution',
    '        ->  Seq Scan on u  (cost=0.00..80.00 rows=100 width=8) (actual time=0.01..3.00 rows=100 loops=1)\nExecution'));
  assert.ok(!fired(neg, 'REPEATED_WORK'));
});

test('OUTSIDE_PLAN pair', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..10.00 rows=100 loops=1)
Execution Time: 100.4 ms`);
  assert.ok(fired(pos, 'OUTSIDE_PLAN'));
  const neg = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..10.00 rows=100 loops=1)
Execution Time: 10.4 ms`);
  assert.ok(!fired(neg, 'OUTSIDE_PLAN'));
});

test('PLANNING_TIME pair', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..5.00 rows=100 loops=1)
Planning Time: 50.0 ms
Execution Time: 5.4 ms`);
  assert.ok(fired(pos, 'PLANNING_TIME'));
  const neg = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..5.00 rows=100 loops=1)
Planning Time: 0.5 ms
Execution Time: 5.4 ms`);
  assert.ok(!fired(neg, 'PLANNING_TIME'));
});

/* ---------------- schema & gating contracts ---------------- */

test('advice schema v2: obs required, hyp/next optional, impact always set', () => {
  for (const plan of [P(SEQSCAN_DISCARD_POS), P(HSH_POS), P(DISK_SORT_POS)]) {
    for (const a of plan.advice) {
      assert.ok(typeof a.obs === 'string' && a.obs.length > 10, a.code + ': no observation');
      assert.ok(a.hyp === null || typeof a.hyp === 'string');
      assert.ok(a.next === null || typeof a.next === 'string');
      assert.ok(a.impact && typeof a.impact.level === 'string', a.code + ': no impact');
      assert.ok(!('msg' in a), 'legacy msg field must be gone');
    }
  }
});

test('advice is ordered by impact, minor entries last', () => {
  const p = P(`Sort  (cost=0.00..100.00 rows=10 width=8) (actual time=0.20..100.00 rows=10 loops=1)
  Sort Key: t.a
  Sort Method: external merge  Disk: 9000kB
  ->  Seq Scan on t  (cost=0.00..10.00 rows=100 width=8) (actual time=0.01..0.40 rows=100 loops=1)
        Filter: (b = 3)
        Rows Removed by Filter: 10000
Execution Time: 100.4 ms`);
  const levels = p.advice.map(a => a.impact.level);
  const firstMinor = levels.indexOf('minor');
  if (firstMinor !== -1) {
    assert.ok(levels.slice(firstMinor).every(l => l === 'minor'), levels.join(','));
  }
  const majors = p.advice.filter(a => a.impact.level !== 'minor');
  for (let i = 1; i < majors.length; i++) {
    assert.ok((majors[i - 1].impact.ms || 0) >= (majors[i].impact.ms || 0), 'not sorted by ms');
  }
});

test('cost-only plans: impact unknown, nothing demoted', () => {
  const p = P(`Sort  (cost=800.00..825.00 rows=10000 width=8)
  Sort Key: t.a
  ->  Index Scan using idx_t_b on t  (cost=0.42..600.00 rows=10000 width=8)`);
  assert.ok(p.advice.length > 0, 'expected INDEX_FULLREAD on a cost-only plan');
  for (const a of p.advice) assert.equal(a.impact.level, 'unknown');
});

/* ---------------- EXPLAIN coaching ---------------- */

test('coaching: cost-only SELECT suggests ANALYZE+BUFFERS without DML warning', () => {
  const p = P('Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8)');
  assert.equal(p.coaching.length, 1);
  assert.equal(p.coaching[0].option, 'ANALYZE, BUFFERS');
  assert.equal(p.coaching[0].warning, null);
});

test('coaching: cost-only DML carries the side-effect warning', () => {
  const p = P(`Update on t  (cost=0.00..600.00 rows=0 width=0)
  ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8)`);
  assert.equal(p.coaching[0].option, 'ANALYZE, BUFFERS');
  assert.match(p.coaching[0].warning, /executes the statement/);
  assert.match(p.coaching[0].warning, /ROLLBACK/);
});

test('coaching: analyzed plan without buffers suggests BUFFERS only', () => {
  const p = P(SEQSCAN_DISCARD_POS);
  assert.deepEqual(p.coaching.map(c => c.option), ['BUFFERS']);
});

test('coaching: TIMING OFF plans suggest TIMING', () => {
  const p = P(`Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual rows=10000 loops=1)
  Buffers: shared hit=100
Execution Time: 20.4 ms`);
  assert.ok(p.coaching.some(c => c.option === 'TIMING'), JSON.stringify(p.coaching));
});

test('coaching: fully instrumented plan needs nothing', () => {
  const p = P(`Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..5.00 rows=10000 loops=1)
  Buffers: shared hit=100
Execution Time: 5.4 ms`);
  assert.deepEqual(p.coaching, []);
});

/* ---------------- DISK_READ (actionable, I/O-aware) ---------------- */

// actual time is per loop: 2.28 ms x 100 loops = 228 ms inclusive
const DISK_READ_POS = `Index Scan using pk_t on t  (cost=0.42..500.00 rows=1 width=8) (actual time=0.05..2.28 rows=1 loops=100)
  Index Cond: (id = o.id)
  Buffers: shared hit=188 read=54
  I/O Timings: read=227.300 write=0.100
Execution Time: 228.4 ms`;

test('DISK_READ positive: I/O-dominated node diagnosed as disk reads, not UNEXPLAINED_TIME', () => {
  const p = P(DISK_READ_POS);
  const a = entry(p, 'DISK_READ');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  assert.match(a.nodes[0].ext, /ms\/read/);
  assert.ok(!fired(p, 'UNEXPLAINED_TIME'), 'UNEXPLAINED_TIME must not double-fire on explained time');
});

test('DISK_READ negative: warm-cache node with fast I/O', () => {
  const p = P(DISK_READ_POS
    .replace('actual time=0.05..228.00', 'actual time=0.05..0.80')
    .replace('  I/O Timings: read=227.300 write=0.100\n', '  I/O Timings: read=0.500\n')
    .replace('Execution Time: 228.4 ms', 'Execution Time: 1.0 ms'));
  assert.ok(!fired(p, 'DISK_READ'));
});

test('DISK_READ low impact: minor inside a much larger plan', () => {
  const p = P(`Hash Join  (cost=0.00..900.00 rows=10 width=8) (actual time=0.10..20000.00 rows=10 loops=1)
  Hash Cond: (t.id = u.id)
  ->  Seq Scan on u  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..19500.00 rows=10000 loops=1)
        Buffers: shared hit=4000000
  ->  Hash  (cost=5.00..5.00 rows=100 width=8) (actual time=150.00..150.00 rows=100 loops=1)
        ->  Index Scan using pk_t on t  (cost=0.42..5.00 rows=100 width=8) (actual time=0.05..149.00 rows=100 loops=1)
              Buffers: shared hit=10 read=40
              I/O Timings: read=148.000
Execution Time: 20000.4 ms`);
  const a = entry(p, 'DISK_READ');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('DISK_READ missing evidence: no I/O Timings -> falls back to UNEXPLAINED_TIME', () => {
  const p = P(DISK_READ_POS.replace('  I/O Timings: read=227.300 write=0.100\n', ''));
  assert.ok(!fired(p, 'DISK_READ'));
  assert.ok(fired(p, 'UNEXPLAINED_TIME'), 'unexplained slow node must still be flagged');
});

test('UNEXPLAINED_TIME subtracts measured I/O before judging', () => {
  // 150ms node where 120ms is measured I/O: remaining 30ms < 100ms floor
  const p = P(`Index Scan using pk_t on t  (cost=0.42..500.00 rows=100 width=8) (actual time=0.05..150.00 rows=100 loops=1)
  Buffers: shared hit=10 read=30
  I/O Timings: read=90.000
Execution Time: 150.4 ms`);
  assert.ok(!fired(p, 'UNEXPLAINED_TIME'), 'partially explained node must not alarm');
});

/* ---------------- NESTLOOP_DISCARD (actionable) ---------------- */

const NESTLOOP_POS = `Nested Loop Left Join  (cost=9.82..83522.70 rows=1190 width=558) (actual time=3.76..269.60 rows=65 loops=1)
  Join Filter: (p.nzp_kvar = kel.nzp_kvar)
  Rows Removed by Join Filter: 246350
  ->  Seq Scan on pays p  (cost=0.00..100.00 rows=65 width=8) (actual time=0.01..2.00 rows=65 loops=1)
  ->  Materialize  (cost=0.00..120.00 rows=3790 width=8) (actual time=0.00..0.30 rows=3790 loops=65)
        ->  Seq Scan on kvar_epd kel  (cost=0.00..100.00 rows=3790 width=8) (actual time=0.01..1.50 rows=3790 loops=1)
Execution Time: 270.0 ms`;

test('NESTLOOP_DISCARD positive: join-filter over-read with join-key DDL on the inner side', () => {
  const a = entry(P(NESTLOOP_POS), 'NESTLOOP_DISCARD');
  assert.ok(a, 'not raised');
  assert.match(a.nodes[0].ext, /removed by join filter=246350/);
  assert.ok(a.idxs, 'no index candidate');
  assert.match(a.idxs[0].def, /ON kvar_epd USING btree \(nzp_kvar\)/);
});

test('NESTLOOP_DISCARD negative: filter removes a comparable amount', () => {
  const p = P(NESTLOOP_POS
    .replace('Rows Removed by Join Filter: 246350', 'Rows Removed by Join Filter: 300')
    .replace('rows=65 loops=1)', 'rows=65 loops=1)'));
  assert.ok(!fired(p, 'NESTLOOP_DISCARD'));
});

test('NESTLOOP_DISCARD low impact: minor', () => {
  const p = P(`Sort  (cost=0.00..100.00 rows=10 width=8) (actual time=0.20..500.00 rows=10 loops=1)
  Sort Key: t.a
  ->  Nested Loop  (cost=0.00..50.00 rows=5 width=8) (actual time=0.01..0.40 rows=5 loops=1)
        Join Filter: (a.x = b.x)
        Rows Removed by Join Filter: 2000
        ->  Seq Scan on a  (cost=0.00..10.00 rows=5 width=8) (actual time=0.01..0.05 rows=5 loops=1)
        ->  Materialize  (cost=0.00..20.00 rows=401 width=8) (actual time=0.00..0.02 rows=401 loops=5)
              ->  Seq Scan on b  (cost=0.00..15.00 rows=401 width=8) (actual time=0.01..0.10 rows=401 loops=1)
Execution Time: 500.4 ms`);
  const a = entry(p, 'NESTLOOP_DISCARD');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('NESTLOOP_DISCARD missing evidence: no rows-removed line, no advice', () => {
  const p = P(NESTLOOP_POS.replace('  Rows Removed by Join Filter: 246350\n', ''));
  assert.ok(!fired(p, 'NESTLOOP_DISCARD'));
});

/* ---------------- INDEX_BUFFERS loop normalization (regression) ---------------- */

test('INDEX_BUFFERS does not fire on parameterized index lookups', () => {
  // 242 buffers over 65 loops = 3.7 pages/loop — btree depth, not bloat
  const p = P(`Index Scan using pk_t on t  (cost=0.42..5.00 rows=1 width=8) (actual time=0.01..0.30 rows=1 loops=65)
  Index Cond: (id = o.id)
  Buffers: shared hit=188 read=54
Execution Time: 25.4 ms`);
  assert.ok(!fired(p, 'INDEX_BUFFERS'), 'false positive on per-loop btree pages');
});

test('TABLE_WRITTEN impact comes from the write cost, not node self time', () => {
  const p = P(`Seq Scan on t  (cost=0.00..100.00 rows=10000 width=8) (actual time=0.05..200.00 rows=10000 loops=1)
  Buffers: shared hit=100000 written=5
  I/O Timings: write=0.200
Execution Time: 200.4 ms`);
  const a = entry(p, 'TABLE_WRITTEN');
  assert.ok(a, 'not raised');
  assert.equal(a.impact.level, 'minor', JSON.stringify(a.impact));
});

test('UNEXPLAINED_TIME fires on a CPU-bound node with no buffer data at all', () => {
  // real-archive pattern: a multi-minute hash join computing regexp over
  // jsonb, plan captured without BUFFERS — zero traffic is not an alibi
  const p = P(`Hash Left Join  (cost=100.00..500.00 rows=1000 width=8) (actual time=10.00..900.00 rows=1000 loops=1)
  Hash Cond: ((regexp_replace((doc ->> 'key'::text), '\\D'::text, ''::text))::integer = d.id)
  ->  Seq Scan on src  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.01..5.00 rows=1000 loops=1)
  ->  Hash  (cost=50.00..50.00 rows=100 width=8) (actual time=1.00..1.00 rows=100 loops=1)
        ->  Seq Scan on dict d  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..0.80 rows=100 loops=1)
Execution Time: 900.4 ms`);
  const a = entry(p, 'UNEXPLAINED_TIME');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  // without BUFFERS the finding is about the plan, not about one node
  assert.match(a.ext, /no buffer data/);
  assert.ok(a.nodes.length >= 1, 'the slow nodes must still be listed');
  assert.equal(p.advice.filter(x => x.code === 'UNEXPLAINED_TIME').length, 1);
});

test('UNEXPLAINED_TIME counts local (temp-table) buffers as explanation', () => {
  // archive pattern: a Seq Scan over a temp table moves 87k local pages in
  // 2.7s — that traffic explains the time, so UNEXPLAINED_TIME must stay silent
  const p = P(`Seq Scan on temp_data t  (cost=0.00..9000.00 rows=612797 width=40) (actual time=0.10..2702.00 rows=612797 loops=1)
  Buffers: local hit=87680
Execution Time: 2702.4 ms`);
  assert.ok(!fired(p, 'UNEXPLAINED_TIME'), 'local buffers ignored as explanation');
});

test('UNEXPLAINED_TIME evidence line does not claim "no buffer data" when local buffers exist', () => {
  // slow enough that even the buffer budget cannot explain it
  const p = P(`Seq Scan on temp_data t  (cost=0.00..9000.00 rows=1000 width=40) (actual time=0.10..9000.00 rows=1000 loops=1)
  Buffers: local hit=500
Execution Time: 9000.4 ms`);
  const a = entry(p, 'UNEXPLAINED_TIME');
  assert.ok(a, 'not raised');
  assert.doesNotMatch(a.nodes[0].ext, /no buffer data/);
  assert.match(a.nodes[0].ext, /buffers in memory=500/);
});

/* ---------------- family collapsing ---------------- */

test('same-code entries beyond three collapse into one aggregate', () => {
  // archive sweep: big plans fired the same rule on dozens of nodes
  // (20× UNEXPLAINED_TIME, 40× ROW_ESTIMATE in one plan) drowning the material top
  const scans = [];
  for (let i = 1; i <= 6; i++) {
    scans.push(`  ->  Seq Scan on t${i}  (cost=0.00..1000.00 rows=100 width=8) (actual time=0.10..5${i}.00 rows=100.00 loops=1)
        Filter: (status = 'x'::text)
        Rows Removed by Filter: 10000`);
  }
  const p = P(`Append  (cost=0.00..6000.00 rows=600 width=8) (actual time=0.10..320.00 rows=600.00 loops=1)
${scans.join('\n')}
Execution Time: 320.5 ms`);
  const fam = p.advice.filter(a => a.code === 'SEQSCAN_DISCARD');
  assert.equal(fam.length, 4, 'expected 3 kept + 1 aggregate: ' + fam.length);
  const agg = fam.find(a => a.agg);
  assert.ok(agg, 'no aggregate entry');
  assert.equal(agg.agg, 3);
  assert.match(agg.obs, /^3 more nodes match this pattern/);
  assert.equal(agg.hyp, null);
  assert.equal(agg.nodes.length, 3, 'aggregate must carry the tail nodes');
  assert.ok(agg.idxs.length >= 1, 'DDL candidates from the tail must survive');
  assert.ok(agg.impact.ms > 100, 'combined impact: ' + agg.impact.ms);
  // the three kept entries are the highest-impact ones (t6, t5, t4)
  const keptRels = fam.filter(a => !a.agg)
    .map(a => p.nodes[a.nodes[0].id].relation).join(' ');
  assert.match(keptRels, /t6/);
  // four same-code entries do NOT collapse
  const small = P(`Append  (cost=0.00..4000.00 rows=400 width=8) (actual time=0.10..215.00 rows=400.00 loops=1)
${scans.slice(0, 4).join('\n')}
Execution Time: 215.5 ms`);
  const fam4 = small.advice.filter(a => a.code === 'SEQSCAN_DISCARD');
  assert.equal(fam4.length, 4);
  assert.ok(!fam4.some(a => a.agg));
});

/* ---------------- DISK_HASH (batch spill) ---------------- */

const HASH_SPILL = `Hash Join  (cost=100.00..900.00 rows=1000 width=8) (actual time=10.00..900.00 rows=1000 loops=1)
  Hash Cond: (t.a = u.a)
  ->  Seq Scan on t  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.01..5.00 rows=1000 loops=1)
  ->  Hash  (cost=50.00..50.00 rows=100000 width=8) (actual time=300.00..300.00 rows=100000 loops=1)
        Buckets: 16384  Batches: 512  Memory Usage: 2304kB
        ->  Seq Scan on u  (cost=0.00..50.00 rows=100000 width=8) (actual time=0.01..80.00 rows=100000 loops=1)
Execution Time: 900.5 ms`;

test('DISK_HASH positive: Batches > 1 is the spill signal', () => {
  const p = P(HASH_SPILL);
  const a = entry(p, 'DISK_HASH');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  assert.match(a.nodes[0].ext, /batches=512/);
  assert.match(a.nodes[0].ext, /peak memory 2\.3 MB per batch/);
  assert.match(a.next, /hash_mem_multiplier/);
});

test('DISK_HASH never presents peak-memory x batches as a measured spill', () => {
  // EXPLAIN reports the peak memory of one batch and a batch count, never the
  // volume written: multiplying them is an order of magnitude, not a figure
  const a = entry(P(HASH_SPILL), 'DISK_HASH');
  assert.doesNotMatch(a.next, /The spill is/);
  assert.doesNotMatch(a.next, /SET LOCAL work_mem = '/);
  assert.match(a.next, /on the order of/);
});

test('DISK_HASH negative: a single batch fits in memory', () => {
  const p = P(HASH_SPILL.replace('Batches: 512', 'Batches: 1'));
  assert.ok(!fired(p, 'DISK_HASH'), [...codes(p)]);
});

test('DISK_HASH names the planner underestimate when the batch count grew', () => {
  const p = P(HASH_SPILL.replace('Batches: 512', 'Batches: 512 (originally 1)'));
  const a = entry(p, 'DISK_HASH');
  assert.match(a.nodes[0].ext, /originally 1/);
  assert.match(a.hyp, /underestimated/);
});

test('DISK_HASH missing evidence: no Buckets line, no finding', () => {
  const p = P(HASH_SPILL.replace('        Buckets: 16384  Batches: 512  Memory Usage: 2304kB\n', ''));
  assert.ok(!fired(p, 'DISK_HASH'), [...codes(p)]);
});

/* ---------------- MEMOIZE_MISS (Memoize) ---------------- */

const MEMOIZE = (hits, misses, evict) => `Nested Loop  (cost=0.00..900.00 rows=1000 width=8) (actual time=0.10..900.00 rows=1000 loops=1)
  ->  Seq Scan on t  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.01..5.00 rows=1000 loops=1)
  ->  Memoize  (cost=0.10..0.20 rows=1 width=8) (actual time=0.01..0.01 rows=1 loops=${hits + misses})
        Cache Key: t.a
        Cache Mode: logical
        Hits: ${hits}  Misses: ${misses}  Evictions: ${evict}  Overflows: 0  Memory Usage: 4195kB
        ->  Index Scan using u_pkey on u  (cost=0.10..0.20 rows=1 width=8) (actual time=0.01..0.01 rows=1 loops=${misses})
              Index Cond: (id = t.a)
Execution Time: 900.5 ms`;

test('MEMOIZE_MISS positive: evictions keep pace with misses', () => {
  const p = P(MEMOIZE(527946, 2400314, 2374680));
  const a = entry(p, 'MEMOIZE_MISS');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  assert.match(a.nodes[0].ext, /18\.0% hit/);
  assert.match(a.hyp, /evicted/);
});

test('MEMOIZE_MISS positive: low hit rate without evictions reads differently', () => {
  const p = P(MEMOIZE(1000, 9000, 0));
  const a = entry(p, 'MEMOIZE_MISS');
  assert.ok(a, 'not raised');
  assert.match(a.hyp, /barely repeat/);
});

test('MEMOIZE_MISS negative: a cache that works stays silent', () => {
  const p = P(MEMOIZE(1140868, 22, 0));
  assert.ok(!fired(p, 'MEMOIZE_MISS'), [...codes(p)]);
});

test('MEMOIZE_MISS negative: evictions alone are not a problem at a high hit rate', () => {
  // 90% of lookups answered from the cache: recycling entries is what a cache
  // does, and "most lookups miss" would simply be false here
  const p = P(MEMOIZE(9000, 1000, 900));
  assert.ok(!fired(p, 'MEMOIZE_MISS'), [...codes(p)]);
});

test('MEMOIZE_MISS negative: too few lookups to judge', () => {
  const p = P(MEMOIZE(0, 11, 0));
  assert.ok(!fired(p, 'MEMOIZE_MISS'), [...codes(p)]);
});

/* ---------------- JIT_TIME ---------------- */

const withJit = (total, exec) => `Seq Scan on t  (cost=0.00..100000.00 rows=1000 width=8) (actual time=0.10..${exec - 1}.00 rows=1000 loops=1)
Planning Time: 1.000 ms
JIT:
  Functions: 71
  Options: Inlining false, Optimization false, Expressions true, Deforming true
  Timing: Generation 1.128 ms, Inlining 0.000 ms, Optimization 0.457 ms, Emission ${total - 1.585} ms, Total ${total} ms
Execution Time: ${exec}.000 ms`;

test('JIT_TIME positive: compilation dominates a short query', () => {
  const p = P(withJit(13.477, 82));
  const a = entry(p, 'JIT_TIME');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  assert.match(a.ext, /16\.4%|16\.3%/);
  assert.match(a.ext, /71 functions/);
  assert.match(a.next, /jit_above_cost/);
});

test('JIT_TIME negative: compilation is noise next to a long query', () => {
  const p = P(withJit(13.477, 20000));
  assert.ok(!fired(p, 'JIT_TIME'), [...codes(p)]);
});

test('JIT_TIME negative: no JIT block, no finding', () => {
  const p = P(`Seq Scan on t  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.10..80.00 rows=1000 loops=1)
Execution Time: 82.000 ms`);
  assert.ok(!fired(p, 'JIT_TIME'));
  assert.equal(p.jit, null);
});

test('JIT block is parsed into a structured plan.jit', () => {
  const p = P(withJit(13.477, 82));
  assert.equal(p.jit.functions, 71);
  assert.equal(p.jit.total, 13.477);
  assert.equal(p.jit.options.expressions, true);
  assert.equal(p.jit.options.inlining, false);
  assert.equal(p.jit.timing.optimization, 0.457);
});

/* ---------------- PLANNING_TIME ---------------- */

const planned = (plan, exec) => `Seq Scan on t  (cost=0.00..100.00 rows=1 width=8) (actual time=0.10..${exec - 0.5} rows=1 loops=1)
Planning Time: ${plan} ms
Execution Time: ${exec} ms`;

test('PLANNING_TIME positive: planning is a large share of the latency', () => {
  const p = P(planned(2811.05, 4621.351));
  const a = entry(p, 'PLANNING_TIME');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  assert.match(a.ext, /37\.8%/);
  assert.equal(a.impact.level, 'high');
  assert.match(a.next, /prepared statements|plan_cache_mode/);
});

test('PLANNING_TIME fires even when execution is longer, if planning is material', () => {
  const p = P(planned(500, 2000));
  assert.ok(fired(p, 'PLANNING_TIME'), [...codes(p)]);
});

test('PLANNING_TIME negative: ordinary planning cost', () => {
  const p = P(planned(2.5, 900));
  assert.ok(!fired(p, 'PLANNING_TIME'), [...codes(p)]);
});

test('PLANNING_TIME negative: slow planning that is still a small share', () => {
  const p = P(planned(30, 5000));
  assert.ok(!fired(p, 'PLANNING_TIME'), [...codes(p)]);
});

/* ---------------- noise control ---------------- */

test('UNEXPLAINED_TIME stands down where another rule already explains the node', () => {
  const p = P(`Sort  (cost=800.00..825.00 rows=10000 width=8) (actual time=1.00..4000.00 rows=10000 loops=1)
  Sort Key: t.a
  Sort Method: external merge  Disk: 500000kB
  Buffers: shared hit=10
  ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..10.00 rows=10000 loops=1)
        Buffers: shared hit=5
Execution Time: 4000.4 ms`);
  assert.ok(fired(p, 'DISK_SORT'));
  assert.ok(!fired(p, 'UNEXPLAINED_TIME'),
    'the spill already explains the time: ' + [...codes(p)]);
});

test('ROW_ESTIMATE ignores parameterized probes that legitimately find nothing', () => {
  // 861 index probes, planner floor of 4 rows each, none matched: normal
  const p = P(`Nested Loop  (cost=0.00..900.00 rows=1 width=8) (actual time=0.10..80.00 rows=1 loops=1)
  ->  Seq Scan on t  (cost=0.00..100.00 rows=861 width=8) (actual time=0.01..5.00 rows=861 loops=1)
  ->  Index Only Scan using u_ix on u  (cost=0.10..0.20 rows=4 width=8) (actual time=0.001..0.001 rows=0 loops=861)
        Index Cond: (a = t.a)
Execution Time: 80.5 ms`);
  assert.ok(!fired(p, 'ROW_ESTIMATE'), [...codes(p)]);
});

test('ROW_ESTIMATE still fires on a real per-loop misestimate', () => {
  const p = P(`Nested Loop  (cost=0.00..900.00 rows=1 width=8) (actual time=0.10..80.00 rows=1 loops=1)
  ->  Seq Scan on t  (cost=0.00..100.00 rows=10 width=8) (actual time=0.01..5.00 rows=10 loops=1)
  ->  Index Scan using u_ix on u  (cost=0.10..0.20 rows=1 width=8) (actual time=0.10..0.50 rows=5000 loops=10)
        Index Cond: (a = t.a)
Execution Time: 80.5 ms`);
  const a = entry(p, 'ROW_ESTIMATE');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  assert.match(a.nodes[0].ext, /rows-act=5000\/loop over 10 loops/);
});

test('index suggestion never recreates the index the scan already uses', () => {
  const p = P(`Index Scan using t_a_b_idx on t  (cost=0.56..2.39 rows=1 width=21) (actual time=0.10..800.00 rows=100 loops=1)
  Index Cond: ((a = 5) AND (b >= 2025))
  Filter: ((c)::numeric >= 400000.0)
  Rows Removed by Filter: 900000
Execution Time: 800.5 ms`);
  const a = entry(p, 'INDEX_DISCARD');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  const defs = (a.idxs || []).map(i => i.def || '').join(' ');
  assert.ok(!/btree \(a, b\);/.test(defs), 'proposed the existing index: ' + defs);
  assert.match(defs, /c/, 'the discarded filter column is missing: ' + defs);
});

test('the rolled-up entry keeps the code badge of the family it replaces', () => {
  // it used to be built without one, which surfaced as "undefined #N" in the
  // summary badges and an empty pill on the card
  const lines = ['Append  (cost=0.00..900.00 rows=1000 width=8) (actual time=0.10..500.00 rows=60 loops=1)'];
  for (let i = 0; i < 6; i++) {
    lines.push(`  ->  Seq Scan on t${i}  (cost=0.00..100.00 rows=10 width=8) (actual time=0.01..80.00 rows=10 loops=1)`);
    lines.push("        Filter: (status = 'x'::text)");
    lines.push('        Rows Removed by Filter: 100000');
  }
  lines.push('Execution Time: 500.5 ms');
  const p = P(lines.join('\n'));
  const agg = p.advice.find(a => a.agg);
  assert.ok(agg, 'family was not collapsed');
  assert.equal(agg.badge, 'SD');
  assert.ok(p.advice.every(a => a.badge), 'an entry without a badge slipped through');
});
