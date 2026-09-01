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

/* ---------------- SEQ_RRBF (actionable) ---------------- */

const SEQ_RRBF_POS = `Seq Scan on big_t  (cost=0.00..1000.00 rows=100 width=8) (actual time=0.10..50.00 rows=100 loops=1)
  Filter: (status = 'x'::text)
  Rows Removed by Filter: 10000
Execution Time: 50.5 ms`;

test('SEQ_RRBF positive: fires with high impact and safe DDL', () => {
  const p = P(SEQ_RRBF_POS);
  const a = entry(p, 'SEQ_RRBF');
  assert.ok(a, 'not raised');
  assert.equal(a.impact.level, 'high');
  assert.ok(a.idxs && a.idxs.length, 'no index candidate');
  assert.equal(a.idxs[0].confidence, 'exact');
  assert.match(a.idxs[0].def, /USING btree \(status\)/);
});

test('SEQ_RRBF negative: small removed-rows count does not fire', () => {
  const p = P(SEQ_RRBF_POS.replace('Rows Removed by Filter: 10000', 'Rows Removed by Filter: 40'));
  assert.ok(!fired(p, 'SEQ_RRBF'), [...codes(p)]);
});

test('SEQ_RRBF low impact: demoted to minor', () => {
  const p = P(`Sort  (cost=0.00..100.00 rows=10 width=8) (actual time=0.20..100.00 rows=10 loops=1)
  Sort Key: t.a
  ->  Seq Scan on t  (cost=0.00..10.00 rows=100 width=8) (actual time=0.01..0.40 rows=100 loops=1)
        Filter: (b = 3)
        Rows Removed by Filter: 10000
Execution Time: 100.4 ms`);
  const a = entry(p, 'SEQ_RRBF');
  assert.ok(a, 'not raised');
  assert.equal(a.impact.level, 'minor');
});

test('SEQ_RRBF missing evidence: no Rows Removed line, no advice', () => {
  const p = P(`Seq Scan on big_t  (cost=0.00..1000.00 rows=100 width=8) (actual time=0.10..50.00 rows=100 loops=1)
  Filter: (status = 'x'::text)
Execution Time: 50.5 ms`);
  assert.ok(!fired(p, 'SEQ_RRBF'));
});

/* ---------------- IDX_RRBF (actionable) ---------------- */

const IDX_RRBF_POS = `Index Scan using idx_t_a on t  (cost=0.42..500.00 rows=10 width=8) (actual time=0.05..40.00 rows=10 loops=1)
  Index Cond: (a > 5)
  Filter: (b = 3)
  Rows Removed by Filter: 5000
Execution Time: 40.4 ms`;

test('IDX_RRBF positive', () => {
  const a = entry(P(IDX_RRBF_POS), 'IDX_RRBF');
  assert.ok(a, 'not raised');
  assert.equal(a.impact.level, 'high');
  assert.ok(a.idxs && a.idxs[0].def.includes('b'), 'filter column missing from DDL');
});

test('IDX_RRBF negative: few rows removed', () => {
  const p = P(IDX_RRBF_POS.replace('Rows Removed by Filter: 5000', 'Rows Removed by Filter: 15'));
  assert.ok(!fired(p, 'IDX_RRBF'));
});

test('IDX_RRBF low impact: minor', () => {
  const p = P(`Sort  (cost=0.00..100.00 rows=10 width=8) (actual time=0.20..90.00 rows=10 loops=1)
  Sort Key: t.a
  ->  Index Scan using idx_t_a on t  (cost=0.42..5.00 rows=10 width=8) (actual time=0.01..0.30 rows=10 loops=1)
        Index Cond: (a > 5)
        Filter: (b = 3)
        Rows Removed by Filter: 5000
Execution Time: 90.4 ms`);
  const a = entry(p, 'IDX_RRBF');
  assert.ok(a && a.impact.level === 'minor', a && a.impact.level);
});

test('IDX_RRBF missing evidence: no rows-removed data', () => {
  const p = P(`Index Scan using idx_t_a on t  (cost=0.42..500.00 rows=10 width=8) (actual time=0.05..40.00 rows=10 loops=1)
  Index Cond: (a > 5)
  Filter: (b = 3)
Execution Time: 40.4 ms`);
  assert.ok(!fired(p, 'IDX_RRBF'));
});

/* ---------------- HSH_ROWS / ANJ_ROWS (actionable) ---------------- */

const HSH_POS = `Hash Join  (cost=100.00..200.00 rows=7 width=16) (actual time=1.00..30.00 rows=7 loops=1)
  Hash Cond: (i.film_id = r.film_id)
  ->  Seq Scan on inventory i  (cost=0.00..100.00 rows=604 width=8) (actual time=0.01..20.00 rows=604 loops=1)
  ->  Hash  (cost=50.00..50.00 rows=100 width=8) (actual time=0.50..0.50 rows=100 loops=1)
        ->  Seq Scan on rental r  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..0.40 rows=100 loops=1)
              Filter: (rental_date > '2020-01-01'::date)
Execution Time: 30.5 ms`;

test('HSH_ROWS positive with join-key DDL', () => {
  const a = entry(P(HSH_POS), 'HSH_ROWS');
  assert.ok(a, 'not raised');
  assert.ok(a.idxs, 'no candidate');
  assert.match(a.idxs[0].def, /ON inventory USING btree \(film_id\)/);
});

test('HSH_ROWS negative: join keeps most rows', () => {
  const p = P(HSH_POS
    .replace('rows=7 width=16) (actual time=1.00..30.00 rows=7', 'rows=600 width=16) (actual time=1.00..30.00 rows=600'));
  assert.ok(!fired(p, 'HSH_ROWS'));
});

test('HSH_ROWS low impact: minor', () => {
  const p = P(`Aggregate  (cost=0.00..500.00 rows=1 width=8) (actual time=0.10..80.00 rows=1 loops=1)
  ->  Hash Join  (cost=100.00..200.00 rows=7 width=16) (actual time=0.10..0.50 rows=7 loops=1)
        Hash Cond: (i.film_id = r.film_id)
        ->  Seq Scan on inventory i  (cost=0.00..100.00 rows=604 width=8) (actual time=0.01..0.30 rows=604 loops=1)
        ->  Hash  (cost=50.00..50.00 rows=100 width=8) (actual time=0.05..0.05 rows=100 loops=1)
              ->  Seq Scan on rental r  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..0.04 rows=100 loops=1)
Execution Time: 80.4 ms`);
  const a = entry(p, 'HSH_ROWS');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('HSH_ROWS missing evidence: filtered scan is not attributed to the join', () => {
  const p = P(HSH_POS.replace(
    '  ->  Seq Scan on inventory i  (cost=0.00..100.00 rows=604 width=8) (actual time=0.01..20.00 rows=604 loops=1)',
    '  ->  Seq Scan on inventory i  (cost=0.00..100.00 rows=604 width=8) (actual time=0.01..20.00 rows=604 loops=1)\n'
    + '        Filter: (store_id = 1)'));
  assert.ok(!fired(p, 'HSH_ROWS'));
});

test('ANJ_ROWS positive: Hash Anti Join classifies as anti-join, not HSH_ROWS', () => {
  const p = P(HSH_POS.replace('Hash Join ', 'Hash Anti Join '));
  assert.ok(fired(p, 'ANJ_ROWS'), [...codes(p)]);
  assert.ok(!fired(p, 'HSH_ROWS'));
});

test('ANJ_ROWS negative', () => {
  const p = P(HSH_POS.replace('Hash Join ', 'Hash Anti Join ')
    .replace('rows=7 width=16) (actual time=1.00..30.00 rows=7', 'rows=600 width=16) (actual time=1.00..30.00 rows=600'));
  assert.ok(!fired(p, 'ANJ_ROWS'));
});

/* ---------------- LIM_SORT (actionable) ---------------- */

const LIM_SORT_POS = `Limit  (cost=800.00..800.03 rows=10 width=8) (actual time=45.00..45.01 rows=10 loops=1)
  ->  Sort  (cost=800.00..825.00 rows=10000 width=8) (actual time=45.00..45.00 rows=10 loops=1)
        Sort Key: t.amount DESC
        ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..20.00 rows=10000 loops=1)
Execution Time: 45.4 ms`;

test('LIM_SORT positive with sort-key DDL', () => {
  const p = P(LIM_SORT_POS);
  const a = entry(p, 'LIM_SORT');
  assert.ok(a, 'not raised');
  assert.ok(!fired(p, 'LIM_OFFS'), 'LIM_OFFS must not double-fire');
  assert.ok(a.idxs, 'no candidate');
  assert.match(a.idxs[0].def, /USING btree \(amount\)/);
});

test('LIM_SORT negative: limit consumes most of the scan', () => {
  const p = P(LIM_SORT_POS
    .replace('rows=10 width=8) (actual time=45.00..45.01 rows=10', 'rows=9000 width=8) (actual time=45.00..45.01 rows=9000'));
  assert.ok(!fired(p, 'LIM_SORT'));
});

test('LIM_SORT low impact: minor', () => {
  const p = P(`Nested Loop  (cost=0.00..900.00 rows=10 width=16) (actual time=0.10..60.00 rows=10 loops=1)
  ->  Limit  (cost=8.00..8.03 rows=10 width=8) (actual time=0.30..0.31 rows=10 loops=1)
        ->  Sort  (cost=8.00..8.25 rows=1000 width=8) (actual time=0.30..0.30 rows=10 loops=1)
              Sort Key: t.amount DESC
              ->  Seq Scan on t  (cost=0.00..6.00 rows=1000 width=8) (actual time=0.01..0.10 rows=1000 loops=1)
  ->  Seq Scan on u  (cost=0.00..80.00 rows=1 width=8) (actual time=0.01..5.90 rows=1 loops=10)
Execution Time: 60.4 ms`);
  const a = entry(p, 'LIM_SORT');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('LIM_SORT missing evidence: no Sort Key -> advice without DDL', () => {
  const p = P(LIM_SORT_POS.replace('        Sort Key: t.amount DESC\n', ''));
  const a = entry(p, 'LIM_SORT');
  assert.ok(a, 'not raised');
  assert.ok(!a.idxs, 'DDL must not be generated without the sort key');
});

/* ---------------- BMP_AND (actionable) ---------------- */

const BMP_AND_POS = `Bitmap Heap Scan on t  (cost=50.00..300.00 rows=10 width=8) (actual time=1.00..30.00 rows=10 loops=1)
  Recheck Cond: ((a = 1) AND (b = 2))
  ->  BitmapAnd  (cost=50.00..50.00 rows=10 width=0) (actual time=0.90..0.90 rows=0 loops=1)
        ->  Bitmap Index Scan on idx_a  (cost=0.00..25.00 rows=100 width=0) (actual time=0.50..0.50 rows=100 loops=1)
              Index Cond: (a = 1)
        ->  Bitmap Index Scan on idx_b  (cost=0.00..25.00 rows=100 width=0) (actual time=0.30..0.30 rows=100 loops=1)
              Index Cond: (b = 2)
Execution Time: 30.5 ms`;

test('BMP_AND positive with composite DDL', () => {
  const a = entry(P(BMP_AND_POS), 'BMP_AND');
  assert.ok(a, 'not raised');
  assert.ok(a.idxs, 'no candidate');
  assert.match(a.idxs[0].def, /USING btree \(a, b\)/);
});

test('BMP_AND negative: single bitmap index scan', () => {
  const p = P(`Bitmap Heap Scan on t  (cost=25.00..300.00 rows=10 width=8) (actual time=1.00..30.00 rows=10 loops=1)
  Recheck Cond: (a = 1)
  ->  Bitmap Index Scan on idx_a  (cost=0.00..25.00 rows=100 width=0) (actual time=0.50..0.50 rows=100 loops=1)
        Index Cond: (a = 1)
Execution Time: 30.5 ms`);
  assert.ok(!fired(p, 'BMP_AND'));
});

test('BMP_AND low impact: minor', () => {
  const p = P(`Aggregate  (cost=0.00..500.00 rows=1 width=8) (actual time=0.10..90.00 rows=1 loops=1)
  ->  ${BMP_AND_POS.split('\n').slice(0, -1).map((l, i) => (i ? '      ' + l : l)).join('\n')
    .replace('actual time=1.00..30.00 rows=10', 'actual time=0.05..0.40 rows=10')
    .replace('actual time=0.90..0.90', 'actual time=0.09..0.09')
    .replace('actual time=0.50..0.50', 'actual time=0.05..0.05')
    .replace('actual time=0.30..0.30', 'actual time=0.03..0.03')}
Execution Time: 90.4 ms`);
  const a = entry(p, 'BMP_AND');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('BMP_AND missing evidence: non-index child blocks the rule', () => {
  const p = P(BMP_AND_POS.replace('Bitmap Index Scan on idx_b', 'Seq Scan on t2'));
  assert.ok(!fired(p, 'BMP_AND'));
});

/* ---------------- DSK_SORT / DSK_HASH (actionable) ---------------- */

const DSK_SORT_POS = `Sort  (cost=800.00..825.00 rows=10000 width=8) (actual time=1.00..40.00 rows=10000 loops=1)
  Sort Key: t.a
  Sort Method: external merge  Disk: 5000kB
  ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..10.00 rows=10000 loops=1)
Execution Time: 40.4 ms`;

test('DSK_SORT positive: spill volume in evidence, SET LOCAL in next steps', () => {
  const a = entry(P(DSK_SORT_POS), 'DSK_SORT');
  assert.ok(a, 'not raised');
  assert.match(a.nodes[0].ext, /5000kB/);
  assert.match(a.next, /SET LOCAL work_mem/);
  assert.match(a.next, /concurrent/i);
});

test('DSK_SORT negative: in-memory sort', () => {
  const p = P(DSK_SORT_POS.replace('Sort Method: external merge  Disk: 5000kB', 'Sort Method: quicksort  Memory: 25kB'));
  assert.ok(!fired(p, 'DSK_SORT'));
});

test('DSK_SORT low impact: minor', () => {
  const p = P(`Hash Join  (cost=0.00..900.00 rows=10 width=8) (actual time=0.10..80.00 rows=10 loops=1)
  Hash Cond: (t.a = u.a)
  ->  Seq Scan on u  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..78.00 rows=10000 loops=1)
  ->  Hash  (cost=8.00..8.00 rows=100 width=8) (actual time=0.60..0.60 rows=100 loops=1)
        ->  Sort  (cost=8.00..8.25 rows=100 width=8) (actual time=0.30..0.50 rows=100 loops=1)
              Sort Key: t.a
              Sort Method: external merge  Disk: 80kB
              ->  Seq Scan on t  (cost=0.00..6.00 rows=100 width=8) (actual time=0.01..0.10 rows=100 loops=1)
Execution Time: 80.4 ms`);
  const a = entry(p, 'DSK_SORT');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('DSK_SORT missing evidence: no Sort Method line', () => {
  const p = P(DSK_SORT_POS.replace('  Sort Method: external merge  Disk: 5000kB\n', ''));
  assert.ok(!fired(p, 'DSK_SORT'));
});

const DSK_HASH_POS = `Hash Join  (cost=100.00..200.00 rows=100 width=16) (actual time=1.00..40.00 rows=100 loops=1)
  Hash Cond: (a.id = b.id)
  ->  Seq Scan on a  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.01..10.00 rows=1000 loops=1)
  ->  Hash  (cost=50.00..50.00 rows=10000 width=8) (actual time=20.00..20.00 rows=10000 loops=1)
        Buckets: 1024  Batches: 4  Memory Usage: 33kB  Disk Usage: 5000kB
        ->  Seq Scan on b  (cost=0.00..50.00 rows=10000 width=8) (actual time=0.01..8.00 rows=10000 loops=1)
Execution Time: 40.4 ms`;

test('DSK_HASH positive', () => {
  const a = entry(P(DSK_HASH_POS), 'DSK_HASH');
  assert.ok(a, 'not raised');
  assert.match(a.next, /SET LOCAL work_mem/);
});

test('DSK_HASH negative: hash fits in memory', () => {
  const p = P(DSK_HASH_POS.replace('Buckets: 1024  Batches: 4  Memory Usage: 33kB  Disk Usage: 5000kB',
    'Buckets: 16384  Batches: 1  Memory Usage: 600kB'));
  assert.ok(!fired(p, 'DSK_HASH'));
});

test('DSK_HASH low impact: minor', () => {
  const p = P(DSK_HASH_POS
    .replace('actual time=20.00..20.00 rows=10000', 'actual time=0.40..0.40 rows=10000')
    .replace('actual time=0.01..8.00 rows=10000', 'actual time=0.01..0.20 rows=10000'));
  const a = entry(p, 'DSK_HASH');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('DSK_HASH missing evidence: no buckets line', () => {
  const p = P(DSK_HASH_POS.replace('        Buckets: 1024  Batches: 4  Memory Usage: 33kB  Disk Usage: 5000kB\n', ''));
  assert.ok(!fired(p, 'DSK_HASH'));
});

/* ---------------- ANY_TEMP (actionable) ---------------- */

const ANY_TEMP_POS = `Materialize  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.50..20.00 rows=1000 loops=1)
  Buffers: temp read=100 written=500
  ->  Seq Scan on t  (cost=0.00..80.00 rows=1000 width=8) (actual time=0.01..5.00 rows=1000 loops=1)
Execution Time: 20.4 ms`;

test('ANY_TEMP positive', () => {
  const a = entry(P(ANY_TEMP_POS), 'ANY_TEMP');
  assert.ok(a, 'not raised');
  assert.match(a.nodes[0].ext, /temp written=500/);
});

test('ANY_TEMP negative: no temp traffic', () => {
  const p = P(ANY_TEMP_POS.replace('  Buffers: temp read=100 written=500\n', ''));
  assert.ok(!fired(p, 'ANY_TEMP'));
});

test('ANY_TEMP low impact: minor', () => {
  const p = P(`Hash Join  (cost=0.00..900.00 rows=10 width=8) (actual time=0.10..80.00 rows=10 loops=1)
  Hash Cond: (t.a = u.a)
  ->  Seq Scan on u  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..78.00 rows=10000 loops=1)
  ->  Materialize  (cost=0.00..10.00 rows=100 width=8) (actual time=0.05..0.40 rows=100 loops=1)
        Buffers: temp written=8
        ->  Seq Scan on t  (cost=0.00..6.00 rows=100 width=8) (actual time=0.01..0.10 rows=100 loops=1)
Execution Time: 80.4 ms`);
  const a = entry(p, 'ANY_TEMP');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('ANY_TEMP suppressed when the spill is already reported as DSK_SORT', () => {
  const p = P(DSK_SORT_POS.replace('  Sort Method: external merge  Disk: 5000kB',
    '  Sort Method: external merge  Disk: 5000kB\n  Buffers: temp read=100 written=625'));
  assert.ok(fired(p, 'DSK_SORT'));
  assert.ok(!fired(p, 'ANY_TEMP'), 'double-reported spill');
});

/* ---------------- observational rules: positive + negative ---------------- */

test('BMP_OR pair', () => {
  const pos = P(BMP_AND_POS.replace('BitmapAnd', 'BitmapOr').replace('(a = 1) AND (b = 2)', '(a = 1) OR (b = 2)'));
  assert.ok(fired(pos, 'BMP_OR'));
  assert.ok(!fired(pos, 'BMP_AND'));
  assert.ok(!fired(P(BMP_AND_POS), 'BMP_OR'));
});

test('BMP_LOSSY pair', () => {
  const pos = P(BMP_AND_POS.replace('  Recheck Cond: ((a = 1) AND (b = 2))',
    '  Recheck Cond: ((a = 1) AND (b = 2))\n  Heap Blocks: exact=100 lossy=500'));
  assert.ok(fired(pos, 'BMP_LOSSY'));
  assert.ok(!fired(P(BMP_AND_POS), 'BMP_LOSSY'));
});

test('LIM_OFFS pair', () => {
  const pos = P(`Limit  (cost=600.00..600.03 rows=10 width=8) (actual time=20.00..20.01 rows=10 loops=1)
  ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..19.00 rows=10000 loops=1)
Execution Time: 20.4 ms`);
  assert.ok(fired(pos, 'LIM_OFFS'));
  const neg = P(`Limit  (cost=600.00..600.03 rows=5000 width=8) (actual time=20.00..20.01 rows=5000 loops=1)
  ->  Seq Scan on t  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..19.00 rows=10000 loops=1)
Execution Time: 20.4 ms`);
  assert.ok(!fired(neg, 'LIM_OFFS'));
});

test('CTE_ROWS pair', () => {
  const mk = loops => P(`Nested Loop  (cost=0.00..900.00 rows=100 width=16) (actual time=0.10..50.00 rows=100 loops=1)
  CTE big
    ->  Seq Scan on src  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.01..5.00 rows=1000 loops=1)
  ->  Seq Scan on u  (cost=0.00..10.00 rows=${loops} width=8) (actual time=0.01..0.50 rows=${loops} loops=1)
  ->  CTE Scan on big  (cost=0.00..20.00 rows=1000 width=8) (actual time=0.00..1.50 rows=1000 loops=${loops})
Execution Time: 50.4 ms`);
  assert.ok(fired(mk(20), 'CTE_ROWS'));
  assert.ok(!fired(mk(2), 'CTE_ROWS'));
});

test('IDX_COND pair', () => {
  const pos = P(`Index Scan using idx_t_a on t  (cost=0.42..500.00 rows=10000 width=8) (actual time=0.05..40.00 rows=10000 loops=1)
Execution Time: 40.4 ms`);
  assert.ok(fired(pos, 'IDX_COND'));
  assert.ok(!fired(P(IDX_RRBF_POS), 'IDX_COND'));
});

test('ROW_RATIO pair (hedged wording)', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=10 width=8) (actual time=0.05..40.00 rows=5000 loops=1)
Execution Time: 40.4 ms`);
  const a = entry(pos, 'ROW_RATIO');
  assert.ok(a, 'not raised');
  assert.match(a.hyp, /may/);
  assert.match(a.next, /ANALYZE/);
  const neg = P(`Seq Scan on t  (cost=0.00..100.00 rows=4900 width=8) (actual time=0.05..40.00 rows=5000 loops=1)
Execution Time: 40.4 ms`);
  assert.ok(!fired(neg, 'ROW_RATIO'));
});

test('SEQ_BUFF pair (bloat is a hypothesis, not a verdict)', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..40.00 rows=100 loops=1)
  Buffers: shared hit=1000
Execution Time: 40.4 ms`);
  const a = entry(pos, 'SEQ_BUFF');
  assert.ok(a, 'not raised');
  assert.match(a.hyp, /can indicate/);
  assert.match(a.next, /Verify bloat first/);
  const neg = P(`Seq Scan on t  (cost=0.00..100.00 rows=100000 width=8) (actual time=0.05..40.00 rows=100000 loops=1)
  Buffers: shared hit=1000
Execution Time: 40.4 ms`);
  assert.ok(!fired(neg, 'SEQ_BUFF'));
});

test('IDX_BUFF pair', () => {
  const pos = P(`Index Scan using idx_t_a on t  (cost=0.42..100.00 rows=100 width=8) (actual time=0.05..40.00 rows=100 loops=1)
  Index Cond: (a > 5)
  Buffers: shared hit=1000
Execution Time: 40.4 ms`);
  assert.ok(fired(pos, 'IDX_BUFF'));
  const neg = P(pos.text.replace('rows=100 loops=1', 'rows=100000 loops=1').replace('rows=100 width', 'rows=100000 width'));
  assert.ok(!fired(neg, 'IDX_BUFF'));
});

test('TBL_WRTN pair', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=10000 width=8) (actual time=0.05..40.00 rows=10000 loops=1)
  Buffers: shared hit=100 written=5
Execution Time: 40.4 ms`);
  assert.ok(fired(pos, 'TBL_WRTN'));
  const neg = P(pos.text.replace(' written=5', ''));
  assert.ok(!fired(neg, 'TBL_WRTN'));
});

test('ANY_SLOW pair (no overload verdict)', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.05..200.00 rows=1000 loops=1)
  Buffers: shared hit=10
Execution Time: 200.4 ms`);
  const a = entry(pos, 'ANY_SLOW');
  assert.ok(a, 'not raised');
  assert.match(a.hyp, /cannot tell/);
  assert.match(a.next, /pg_stat_activity/);
  const neg = P(pos.text.replace('shared hit=10', 'shared hit=2000000'));
  assert.ok(!fired(neg, 'ANY_SLOW'));
});

test('GTH_WRKS pair', () => {
  const mk = launched => P(`Gather  (cost=1000.00..2000.00 rows=100 width=8) (actual time=1.00..30.00 rows=100 loops=1)
  Workers Planned: 4
  Workers Launched: ${launched}
  ->  Parallel Seq Scan on t  (cost=0.00..900.00 rows=25 width=8) (actual time=0.50..20.00 rows=${launched ? 33 : 100} loops=${launched + 1})
Execution Time: 30.4 ms`);
  assert.ok(fired(mk(2), 'GTH_WRKS'));
  assert.ok(!fired(mk(4), 'GTH_WRKS'));
});

test('CLN_SORT pair', () => {
  const pos = P(`Sort  (cost=900.00..925.00 rows=1000 width=8) (actual time=10.00..30.00 rows=1000 loops=1)
  Sort Key: t.a
  ->  Sort  (cost=800.00..825.00 rows=1000 width=8) (actual time=5.00..8.00 rows=1000 loops=1)
        Sort Key: t.b
        ->  Seq Scan on t  (cost=0.00..600.00 rows=1000 width=8) (actual time=0.01..2.00 rows=1000 loops=1)
Execution Time: 30.4 ms`);
  assert.ok(fired(pos, 'CLN_SORT'));
  const neg = P(`Sort  (cost=900.00..925.00 rows=1000 width=8) (actual time=10.00..30.00 rows=1000 loops=1)
  Sort Key: t.a
  ->  Seq Scan on t  (cost=0.00..600.00 rows=1000 width=8) (actual time=0.01..2.00 rows=1000 loops=1)
Execution Time: 30.4 ms`);
  assert.ok(!fired(neg, 'CLN_SORT'));
});

test('CLN_GROUP pair', () => {
  const pos = P(`HashAggregate  (cost=900.00..925.00 rows=100 width=8) (actual time=10.00..30.00 rows=100 loops=1)
  Group Key: t.a
  ->  GroupAggregate  (cost=800.00..825.00 rows=100 width=8) (actual time=5.00..8.00 rows=100 loops=1)
        Group Key: t.a
        ->  Seq Scan on t  (cost=0.00..600.00 rows=1000 width=8) (actual time=0.01..2.00 rows=1000 loops=1)
Execution Time: 30.4 ms`);
  assert.ok(fired(pos, 'CLN_GROUP'));
  const neg = P(pos.text.replace('        Group Key: t.a', '        Group Key: t.b'));
  assert.ok(!fired(neg, 'CLN_GROUP'));
});

test('CLN_COPY pair', () => {
  const pos = P(`Nested Loop  (cost=0.00..900.00 rows=10 width=16) (actual time=0.10..30.00 rows=10 loops=1)
  ->  Materialize  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..5.00 rows=100 loops=1)
        ->  Seq Scan on t  (cost=0.00..80.00 rows=100 width=8) (actual time=0.01..3.00 rows=100 loops=1)
  ->  Materialize  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..5.00 rows=100 loops=10)
        ->  Seq Scan on t  (cost=0.00..80.00 rows=100 width=8) (actual time=0.01..3.00 rows=100 loops=1)
Execution Time: 30.4 ms`);
  assert.ok(fired(pos, 'CLN_COPY'), [...codes(pos)]);
  const neg = P(pos.text.replace('        ->  Seq Scan on t  (cost=0.00..80.00 rows=100 width=8) (actual time=0.01..3.00 rows=100 loops=1)\nExecution',
    '        ->  Seq Scan on u  (cost=0.00..80.00 rows=100 width=8) (actual time=0.01..3.00 rows=100 loops=1)\nExecution'));
  assert.ok(!fired(neg, 'CLN_COPY'));
});

test('EXT_EXECTIME pair', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..10.00 rows=100 loops=1)
Execution Time: 100.4 ms`);
  assert.ok(fired(pos, 'EXT_EXECTIME'));
  const neg = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..10.00 rows=100 loops=1)
Execution Time: 10.4 ms`);
  assert.ok(!fired(neg, 'EXT_EXECTIME'));
});

test('EXT_PLANTIME pair', () => {
  const pos = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..5.00 rows=100 loops=1)
Planning Time: 50.0 ms
Execution Time: 5.4 ms`);
  assert.ok(fired(pos, 'EXT_PLANTIME'));
  const neg = P(`Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.05..5.00 rows=100 loops=1)
Planning Time: 0.5 ms
Execution Time: 5.4 ms`);
  assert.ok(!fired(neg, 'EXT_PLANTIME'));
});

/* ---------------- schema & gating contracts ---------------- */

test('advice schema v2: obs required, hyp/next optional, impact always set', () => {
  for (const plan of [P(SEQ_RRBF_POS), P(HSH_POS), P(DSK_SORT_POS)]) {
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
  assert.ok(p.advice.length > 0, 'expected IDX_COND on a cost-only plan');
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
  const p = P(SEQ_RRBF_POS);
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

/* ---------------- DSK_READ (actionable, I/O-aware) ---------------- */

// actual time is per loop: 2.28 ms x 100 loops = 228 ms inclusive
const DSK_READ_POS = `Index Scan using pk_t on t  (cost=0.42..500.00 rows=1 width=8) (actual time=0.05..2.28 rows=1 loops=100)
  Index Cond: (id = o.id)
  Buffers: shared hit=188 read=54
  I/O Timings: read=227.300 write=0.100
Execution Time: 228.4 ms`;

test('DSK_READ positive: I/O-dominated node diagnosed as disk reads, not ANY_SLOW', () => {
  const p = P(DSK_READ_POS);
  const a = entry(p, 'DSK_READ');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  assert.match(a.nodes[0].ext, /ms\/read/);
  assert.ok(!fired(p, 'ANY_SLOW'), 'ANY_SLOW must not double-fire on explained time');
});

test('DSK_READ negative: warm-cache node with fast I/O', () => {
  const p = P(DSK_READ_POS
    .replace('actual time=0.05..228.00', 'actual time=0.05..0.80')
    .replace('  I/O Timings: read=227.300 write=0.100\n', '  I/O Timings: read=0.500\n')
    .replace('Execution Time: 228.4 ms', 'Execution Time: 1.0 ms'));
  assert.ok(!fired(p, 'DSK_READ'));
});

test('DSK_READ low impact: minor inside a much larger plan', () => {
  const p = P(`Hash Join  (cost=0.00..900.00 rows=10 width=8) (actual time=0.10..20000.00 rows=10 loops=1)
  Hash Cond: (t.id = u.id)
  ->  Seq Scan on u  (cost=0.00..600.00 rows=10000 width=8) (actual time=0.01..19500.00 rows=10000 loops=1)
        Buffers: shared hit=4000000
  ->  Hash  (cost=5.00..5.00 rows=100 width=8) (actual time=150.00..150.00 rows=100 loops=1)
        ->  Index Scan using pk_t on t  (cost=0.42..5.00 rows=100 width=8) (actual time=0.05..149.00 rows=100 loops=1)
              Buffers: shared hit=10 read=40
              I/O Timings: read=148.000
Execution Time: 20000.4 ms`);
  const a = entry(p, 'DSK_READ');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('DSK_READ missing evidence: no I/O Timings -> falls back to ANY_SLOW', () => {
  const p = P(DSK_READ_POS.replace('  I/O Timings: read=227.300 write=0.100\n', ''));
  assert.ok(!fired(p, 'DSK_READ'));
  assert.ok(fired(p, 'ANY_SLOW'), 'unexplained slow node must still be flagged');
});

test('ANY_SLOW subtracts measured I/O before judging', () => {
  // 150ms node where 120ms is measured I/O: remaining 30ms < 100ms floor
  const p = P(`Index Scan using pk_t on t  (cost=0.42..500.00 rows=100 width=8) (actual time=0.05..150.00 rows=100 loops=1)
  Buffers: shared hit=10 read=30
  I/O Timings: read=90.000
Execution Time: 150.4 ms`);
  assert.ok(!fired(p, 'ANY_SLOW'), 'partially explained node must not alarm');
});

/* ---------------- NLJ_RRJF (actionable) ---------------- */

const NLJ_POS = `Nested Loop Left Join  (cost=9.82..83522.70 rows=1190 width=558) (actual time=3.76..269.60 rows=65 loops=1)
  Join Filter: (p.nzp_kvar = kel.nzp_kvar)
  Rows Removed by Join Filter: 246350
  ->  Seq Scan on pays p  (cost=0.00..100.00 rows=65 width=8) (actual time=0.01..2.00 rows=65 loops=1)
  ->  Materialize  (cost=0.00..120.00 rows=3790 width=8) (actual time=0.00..0.30 rows=3790 loops=65)
        ->  Seq Scan on kvar_epd kel  (cost=0.00..100.00 rows=3790 width=8) (actual time=0.01..1.50 rows=3790 loops=1)
Execution Time: 270.0 ms`;

test('NLJ_RRJF positive: join-filter over-read with join-key DDL on the inner side', () => {
  const a = entry(P(NLJ_POS), 'NLJ_RRJF');
  assert.ok(a, 'not raised');
  assert.match(a.nodes[0].ext, /removed by join filter=246350/);
  assert.ok(a.idxs, 'no index candidate');
  assert.match(a.idxs[0].def, /ON kvar_epd USING btree \(nzp_kvar\)/);
});

test('NLJ_RRJF negative: filter removes a comparable amount', () => {
  const p = P(NLJ_POS
    .replace('Rows Removed by Join Filter: 246350', 'Rows Removed by Join Filter: 300')
    .replace('rows=65 loops=1)', 'rows=65 loops=1)'));
  assert.ok(!fired(p, 'NLJ_RRJF'));
});

test('NLJ_RRJF low impact: minor', () => {
  const p = P(`Sort  (cost=0.00..100.00 rows=10 width=8) (actual time=0.20..500.00 rows=10 loops=1)
  Sort Key: t.a
  ->  Nested Loop  (cost=0.00..50.00 rows=5 width=8) (actual time=0.01..0.40 rows=5 loops=1)
        Join Filter: (a.x = b.x)
        Rows Removed by Join Filter: 2000
        ->  Seq Scan on a  (cost=0.00..10.00 rows=5 width=8) (actual time=0.01..0.05 rows=5 loops=1)
        ->  Materialize  (cost=0.00..20.00 rows=401 width=8) (actual time=0.00..0.02 rows=401 loops=5)
              ->  Seq Scan on b  (cost=0.00..15.00 rows=401 width=8) (actual time=0.01..0.10 rows=401 loops=1)
Execution Time: 500.4 ms`);
  const a = entry(p, 'NLJ_RRJF');
  assert.ok(a && a.impact.level === 'minor', a && JSON.stringify(a.impact));
});

test('NLJ_RRJF missing evidence: no rows-removed line, no advice', () => {
  const p = P(NLJ_POS.replace('  Rows Removed by Join Filter: 246350\n', ''));
  assert.ok(!fired(p, 'NLJ_RRJF'));
});

/* ---------------- IDX_BUFF loop normalization (regression) ---------------- */

test('IDX_BUFF does not fire on parameterized index lookups', () => {
  // 242 buffers over 65 loops = 3.7 pages/loop — btree depth, not bloat
  const p = P(`Index Scan using pk_t on t  (cost=0.42..5.00 rows=1 width=8) (actual time=0.01..0.30 rows=1 loops=65)
  Index Cond: (id = o.id)
  Buffers: shared hit=188 read=54
Execution Time: 25.4 ms`);
  assert.ok(!fired(p, 'IDX_BUFF'), 'false positive on per-loop btree pages');
});

test('TBL_WRTN impact comes from the write cost, not node self time', () => {
  const p = P(`Seq Scan on t  (cost=0.00..100.00 rows=10000 width=8) (actual time=0.05..200.00 rows=10000 loops=1)
  Buffers: shared hit=100000 written=5
  I/O Timings: write=0.200
Execution Time: 200.4 ms`);
  const a = entry(p, 'TBL_WRTN');
  assert.ok(a, 'not raised');
  assert.equal(a.impact.level, 'minor', JSON.stringify(a.impact));
});

test('ANY_SLOW fires on a CPU-bound node with no buffer data at all', () => {
  // real-archive pattern: a multi-minute hash join computing regexp over
  // jsonb, plan captured without BUFFERS — zero traffic is not an alibi
  const p = P(`Hash Left Join  (cost=100.00..500.00 rows=1000 width=8) (actual time=10.00..900.00 rows=1000 loops=1)
  Hash Cond: ((regexp_replace((doc ->> 'key'::text), '\\D'::text, ''::text))::integer = d.id)
  ->  Seq Scan on src  (cost=0.00..100.00 rows=1000 width=8) (actual time=0.01..5.00 rows=1000 loops=1)
  ->  Hash  (cost=50.00..50.00 rows=100 width=8) (actual time=1.00..1.00 rows=100 loops=1)
        ->  Seq Scan on dict d  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..0.80 rows=100 loops=1)
Execution Time: 900.4 ms`);
  const a = entry(p, 'ANY_SLOW');
  assert.ok(a, 'not raised: ' + [...codes(p)]);
  assert.match(a.nodes[0].ext, /no buffer data/);
});

test('ANY_SLOW counts local (temp-table) buffers as explanation', () => {
  // archive pattern: a Seq Scan over a temp table moves 87k local pages in
  // 2.7s — that traffic explains the time, so ANY_SLOW must stay silent
  const p = P(`Seq Scan on temp_data t  (cost=0.00..9000.00 rows=612797 width=40) (actual time=0.10..2702.00 rows=612797 loops=1)
  Buffers: local hit=87680
Execution Time: 2702.4 ms`);
  assert.ok(!fired(p, 'ANY_SLOW'), 'local buffers ignored as explanation');
});

test('ANY_SLOW evidence line does not claim "no buffer data" when local buffers exist', () => {
  // slow enough that even the buffer budget cannot explain it
  const p = P(`Seq Scan on temp_data t  (cost=0.00..9000.00 rows=1000 width=40) (actual time=0.10..9000.00 rows=1000 loops=1)
  Buffers: local hit=500
Execution Time: 9000.4 ms`);
  const a = entry(p, 'ANY_SLOW');
  assert.ok(a, 'not raised');
  assert.doesNotMatch(a.nodes[0].ext, /no buffer data/);
  assert.match(a.nodes[0].ext, /bufmem=500/);
});
