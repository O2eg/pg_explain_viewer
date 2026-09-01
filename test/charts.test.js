'use strict';
// The charts pane's data contract: what each chart is
// allowed to claim, and what blocks it from being drawn at all. Pure — no
// DOM is involved, so the arithmetic and the gates are testable here rather
// than through a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PgPlan } = require('./helpers.js');
const { buildCharts } = require('../src/pgplan-render.js');

const charts = (text, opts) => buildCharts(PgPlan.parse(text), opts);
const chart = (text, id, opts) => charts(text, opts).find(c => c.id === id);

const FULL = `Hash Join  (cost=1.00..900.00 rows=100 width=8) (actual time=0.10..80.00 rows=100 loops=1)
  Hash Cond: (o.id = c.id)
  Buffers: shared hit=300 read=100 dirtied=20 written=5
  I/O Timings: read=12.500 write=1.500
  ->  Seq Scan on orders o  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..40.00 rows=100 loops=1)
        Filter: (status = 'x'::text)
        Rows Removed by Filter: 9000
        Buffers: shared hit=200 read=100
  ->  Hash  (cost=1.00..1.00 rows=1 width=8) (actual time=0.05..0.05 rows=1 loops=1)
        Buckets: 1024  Batches: 1  Memory Usage: 9kB
        ->  Seq Scan on customers c  (cost=0.00..1.00 rows=1 width=8) (actual time=0.01..0.02 rows=1 loops=1)
Planning Time: 20.000 ms
Execution Time: 100.000 ms`;

/* ---------------- latency composition ---------------- */

test('latency slices are planning, root execution and the residual', () => {
  const c = chart(FULL, 'latency');
  assert.equal(c.kind, 'donut');
  assert.deepEqual(c.items.map(i => i.label),
    ['planning', 'top plan node', 'outside top-node timing']);
  assert.equal(c.whole, 120);                                  // 20 planning + 100 execution
  const sum = c.items.reduce((s, i) => s + i.value, 0);
  assert.ok(Math.abs(sum - c.whole) < 0.5, 'slices ' + sum + ' vs whole ' + c.whole);
  assert.equal(c.quality, 'exact');
});

test('JIT is an annotation, never a slice, and is never subtracted', () => {
  const withJit = FULL.replace('Execution Time: 100.000 ms',
    'JIT:\n  Functions: 12\n  Timing: Generation 1.000 ms, Total 30.000 ms\nExecution Time: 100.000 ms');
  const c = chart(withJit, 'latency');
  assert.ok(!c.items.some(i => /jit/i.test(i.label)), 'JIT became a slice');
  const jit = c.annotations.find(a => /JIT/.test(a.label));
  assert.ok(jit && jit.value === 30);
  // the tree slice still carries the full root time: compilation is counted
  // inside it, so removing it here would take it off twice
  const tree = c.items.find(i => i.label === 'top plan node');
  assert.equal(tree.value, 80);
  assert.match(jit.note, /inside the executor timing/);
});

test('triggers are an annotation for the same reason', () => {
  const withTrig = FULL.replace('Execution Time: 100.000 ms',
    'Trigger for constraint fk: time=5.000 calls=100\nExecution Time: 100.000 ms');
  const c = chart(withTrig, 'latency');
  assert.ok(!c.items.some(i => /trigger/i.test(i.label)));
  const t = c.annotations.find(a => /trigger/i.test(a.label));
  assert.ok(t && t.value === 5, JSON.stringify(c.annotations));
});

test('a negative residual falls back to two slices instead of a clamp', () => {
  // root time above Execution Time: nothing can be said about a residual
  const odd = FULL.replace('Execution Time: 100.000 ms', 'Execution Time: 50.000 ms');
  const c = chart(odd, 'latency');
  assert.deepEqual(c.items.map(i => i.label), ['planning', 'execution']);
  assert.equal(c.items.reduce((s, i) => s + i.value, 0), c.whole);
  assert.match(c.note, /two-slice/);
});

test('latency is blocked without both totals, and says which is missing', () => {
  const c = chart(FULL.replace('Planning Time: 20.000 ms\n', ''), 'latency');
  assert.equal(c.blocked.reason, 'totals_missing');
  assert.match(c.blocked.message, /no Planning Time/);
});

test('a truncated plan blocks latency and hotspots', () => {
  const cut = 'Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=500 loops=1)\n'
    + '  Rows Removed by Filter: 100000\n  ->  Sort  (cost=0.00..118';
  const cs = buildCharts(PgPlan.parse(cut, { tolerant: true }));
  for (const id of ['latency', 'hotspots']) {
    const c = cs.find(x => x.id === id);
    assert.equal(c.blocked.reason, 'truncated', id + ' was drawn on a truncated plan');
  }
  // node-local counters survive truncation, so this one still draws
  assert.equal(cs.find(c => c.id === 'discard').blocked, null);
});

/* ---------------- hotspots ---------------- */

test('hotspots rank by self time and carry a whole the parts fit in', () => {
  const c = chart(FULL, 'hotspots');
  assert.equal(c.kind, 'bars');
  assert.ok(c.items[0].value >= c.items[c.items.length - 1].value, 'not sorted');
  const sum = c.items.reduce((s, i) => s + i.value, 0);
  assert.ok(Math.abs(sum - c.whole) < 0.5);
});

test('hotspots offer both groupings, and operators keep their own bucket', () => {
  const c = chart(FULL, 'hotspots');
  const byRel = c.variants.find(v => v.id === 'by-relation');
  assert.ok(byRel.items.some(i => i.label === 'operators (no relation)'),
    'a Hash Join self time was charged to a table: ' + byRel.items.map(i => i.label));
  // both groupings describe the same total
  const total = v => v.items.reduce((s, i) => s + i.value, 0);
  assert.ok(Math.abs(total(c.variants[0]) - total(c.variants[1])) < 0.001);
});

test('hotspots lose the share when the parts exceed the whole', () => {
  // a parallel plan whose ceil(loops/workers) attribution overshoots the root
  const over = `Gather  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..10.00 rows=100 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  ->  Parallel Seq Scan on a  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..9.00 rows=100 loops=3)
  ->  Parallel Seq Scan on b  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..9.00 rows=100 loops=3)
Execution Time: 10.5 ms`;
  const p = PgPlan.parse(over);
  assert.ok(p.diagnostics.some(d => d.code === 'excl_overshoot'), 'fixture no longer overshoots');
  const c = buildCharts(p).find(x => x.id === 'hotspots');
  assert.equal(c.whole, null, 'a share was offered against a whole the parts exceed');
  assert.equal(c.quality, 'approximate');
});

/* ---------------- rows ---------------- */

test('discarded rows use per-node denominators, never a plan-wide one', () => {
  const c = chart(FULL, 'discard');
  assert.equal(c.kind, 'stacked-bars');
  assert.equal(c.whole, null, 'a plan-wide whole would mix root output with all removals');
  const it = c.items[0];
  assert.equal(it.total, it.segments.reduce((s, x) => s + x.value, 0));
  assert.deepEqual(it.segments.map(s => s.label), ['kept', 'removed by filter']);
  assert.equal(it.segments[1].value, 9000);
});

test('estimate error ignores what the planner cannot do better on', () => {
  // 800 probes estimated at 1 row each, finding none: the planner's floor
  const probe = `Nested Loop  (cost=0.00..900.00 rows=1 width=8) (actual time=0.10..80.00 rows=1 loops=1)
  ->  Seq Scan on t  (cost=0.00..100.00 rows=800 width=8) (actual time=0.01..5.00 rows=800 loops=1)
  ->  Index Only Scan using u_ix on u  (cost=0.10..0.20 rows=1 width=8) (actual time=0.001..0.001 rows=0 loops=800)
        Index Cond: (a = t.a)
Execution Time: 80.5 ms`;
  assert.equal(chart(probe, 'estimate').blocked.reason, 'no_misestimate');
});

test('estimate error charts a real per-loop miss', () => {
  const miss = `Nested Loop  (cost=0.00..900.00 rows=1 width=8) (actual time=0.10..80.00 rows=1 loops=1)
  ->  Seq Scan on t  (cost=0.00..100.00 rows=10 width=8) (actual time=0.01..5.00 rows=10 loops=1)
  ->  Index Scan using u_ix on u  (cost=0.10..0.20 rows=1 width=8) (actual time=0.10..0.50 rows=5000 loops=10)
        Index Cond: (a = t.a)
Execution Time: 80.5 ms`;
  const c = chart(miss, 'estimate');
  const it = c.items.find(i => /u_ix|on u/.test(i.label) || i.segments[1].value === 5000);
  assert.deepEqual(it.segments.map(s => s.label), ['planned', 'actual']);
  assert.equal(it.segments[0].value, 1);
  assert.equal(it.segments[1].value, 5000);
  assert.match(it.note, /per loop, over 10 loops/);
  assert.match(it.note, /underestimated/);
});

/* ---------------- resources ---------------- */

test('buffer access mix keeps hit and read together and writes apart', () => {
  const access = chart(FULL, 'bufaccess');
  const shared = access.items.find(i => i.label === 'shared');
  assert.deepEqual(shared.segments.map(s => s.label), ['hit', 'read']);
  // PostgreSQL buffer counters are inclusive, so the root's 300 hit already
  // covers the children's: the access total is the root's own 300 + 100
  assert.equal(shared.total, 400);
  const labels = JSON.stringify(access.items);
  assert.ok(!/dirtied|written/.test(labels),
    'dirtied/written blocks entered the access denominator: ' + labels);

  const writes = chart(FULL, 'writes');
  assert.equal(writes.whole, null, 'dirtied and written overlap; they have no whole');
  assert.ok(writes.items.some(i => i.label === 'shared dirtied'));
});

test('buffer charts are blocked without BUFFERS, and point at the reason', () => {
  const bare = `Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=1 loops=1)
Execution Time: 0.5 ms`;
  const c = chart(bare, 'bufaccess');
  assert.equal(c.blocked.reason, 'no_buffers');
  assert.match(c.blocked.message, /BUFFERS/);
});

test('a sort spill is charted at the volume PostgreSQL reports', () => {
  const sort = `Sort  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..80.00 rows=100 loops=1)
  Sort Key: t.a
  Sort Method: external merge  Disk: 5000kB
  ->  Seq Scan on t  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..40.00 rows=100 loops=1)
Execution Time: 80.5 ms`;
  const measured = chart(sort, 'spill');
  assert.equal(measured.quality, 'exact');
  assert.equal(measured.items[0].value, 5000 * 1024);
});

test('a parallel sort counts the leader and every worker', () => {
  // each process sorts and spills on its own; the node line carries only the
  // leader's volume
  const par = `Gather Merge  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..80.00 rows=100 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  ->  Sort  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..40.00 rows=33 loops=3)
        Sort Key: t.a
        Sort Method: external merge  Disk: 1000kB
        Worker 0:  Sort Method: external merge  Disk: 2000kB
        Worker 1:  Sort Method: external merge  Disk: 3000kB
        ->  Parallel Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.01..5.00 rows=33 loops=3)
Execution Time: 80.5 ms`;
  const c = chart(par, 'spill');
  assert.equal(c.items[0].value, 6000 * 1024, 'worker spills were dropped');
  assert.match(c.items[0].note, /leader 1000 kB \+ 2 worker/);
});

test('a hash spill is an annotation: PostgreSQL reports no volume for it', () => {
  // a plan with both a measured sort spill and a hash spill
  const mixed = `Sort  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..80.00 rows=100 loops=1)
  Sort Key: t.a
  Sort Method: external merge  Disk: 5000kB
  ->  Hash Join  (cost=1.00..400.00 rows=100 width=8) (actual time=0.05..40.00 rows=100 loops=1)
        Hash Cond: (a.id = b.id)
        ->  Seq Scan on a  (cost=0.00..200.00 rows=100 width=8) (actual time=0.01..20.00 rows=100 loops=1)
        ->  Hash  (cost=1.00..1.00 rows=1 width=8) (actual time=0.05..0.05 rows=1 loops=1)
              Buckets: 1024  Batches: 64  Memory Usage: 900kB
              ->  Seq Scan on b  (cost=0.00..1.00 rows=1 width=8) (actual time=0.01..0.02 rows=1 loops=1)
Execution Time: 80.5 ms`;
  const c = chart(mixed, 'spill');
  // peak memory of one batch is not a volume, and ranking it against measured
  // ones would reorder the chart on a different quantity
  assert.ok(!c.items.some(i => /Hash/.test(i.label)), 'a hash spill entered the ranking');
  assert.equal(c.items.length, 1);
  const ann = c.annotations.find(a => /Hash/.test(a.label));
  assert.ok(ann && ann.value === 64 && ann.unit === 'batches', JSON.stringify(c.annotations));

  // and when a plan has nothing but hash spills, the chart says so
  const onlyHash = `Hash Join  (cost=1.00..900.00 rows=100 width=8) (actual time=0.10..80.00 rows=100 loops=1)
  Hash Cond: (a.id = b.id)
  ->  Seq Scan on a  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..40.00 rows=100 loops=1)
  ->  Hash  (cost=1.00..1.00 rows=1 width=8) (actual time=0.05..0.05 rows=1 loops=1)
        Buckets: 1024  Batches: 32  Memory Usage: 900kB
        ->  Seq Scan on b  (cost=0.00..1.00 rows=1 width=8) (actual time=0.01..0.02 rows=1 loops=1)
Execution Time: 80.5 ms`;
  assert.equal(chart(onlyHash, 'spill').blocked.reason, 'no_spill_volume');
});

test('temp volumes honour blockSize, and default to 8 KiB', () => {
  const temp = `Seq Scan on t  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..80.00 rows=100 loops=1)
  Buffers: temp written=100
Execution Time: 80.5 ms`;
  assert.equal(chart(temp, 'spill').items[0].value, 100 * 8192);
  assert.equal(chart(temp, 'spill', { blockSize: 32768 }).items[0].value, 100 * 32768);
});

test('reported I/O becomes a composition only when it fits inside elapsed time', () => {
  const c = chart(FULL, 'iotiming');
  assert.ok(c.items.some(i => i.label === 'not reported as block I/O'));
  assert.equal(c.whole, 80);

  // parallel: worker I/O is summed and may exceed elapsed time, so no share
  const par = `Gather  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..10.00 rows=100 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  I/O Timings: read=30.000
  ->  Parallel Seq Scan on a  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..9.00 rows=100 loops=3)
Execution Time: 10.5 ms`;
  const pc = buildCharts(PgPlan.parse(par)).find(x => x.id === 'iotiming');
  assert.equal(pc.whole, null);
  assert.equal(pc.quality, 'approximate');
  assert.match(pc.note, /added together/);
});

/* ---------------- contract ---------------- */

test('every chart declares a section, and blocked ones explain themselves', () => {
  const cs = charts(FULL);
  const sections = new Set(cs.map(c => c.section));
  assert.deepEqual([...sections].sort(), ['resources', 'rows', 'time']);
  for (const c of cs) {
    assert.ok(c.id && c.title && c.section, JSON.stringify(c).slice(0, 120));
    if (c.blocked) {
      assert.ok(c.blocked.reason && c.blocked.message.length > 20,
        c.id + ' blocks without saying why');
      assert.deepEqual(c.items, []);
    } else {
      assert.ok(c.items.length, c.id + ' is neither blocked nor populated');
      for (const i of c.items) {
        assert.ok(Number.isFinite(i.value) && i.value >= 0,
          c.id + ' has a non-finite or negative value: ' + i.value);
      }
    }
  }
});

test('charts never write anything back into the plan', () => {
  const plan = PgPlan.parse(FULL);
  const before = JSON.stringify(plan);
  buildCharts(plan);
  assert.equal(JSON.stringify(plan), before, 'buildCharts mutated the model');
});

test('planned and actual are grouped, never stacked into one total', () => {
  // two alternatives drawn in one track would read as a sum
  const miss = `Nested Loop  (cost=0.00..900.00 rows=1 width=8) (actual time=0.10..80.00 rows=1 loops=1)
  ->  Seq Scan on t  (cost=0.00..100.00 rows=10 width=8) (actual time=0.01..5.00 rows=10 loops=1)
  ->  Index Scan using u_ix on u  (cost=0.10..0.20 rows=1 width=8) (actual time=0.10..0.50 rows=5000 loops=10)
        Index Cond: (a = t.a)
Execution Time: 80.5 ms`;
  const c = chart(miss, 'estimate');
  assert.equal(c.kind, 'grouped-bars');
  assert.match(c.note, /alternatives, not parts/);
  assert.match(c.note, /larger of its own two values/);
  // and the composition charts still declare themselves as stacked
  assert.equal(chart(FULL, 'discard').kind, 'stacked-bars');
});


/* ---------------- review fixes ---------------- */

test('latency slices never add up to more than the whole', () => {
  // the analyzer may raise a node's inclusive time to the sum of its children
  // (metric_raised), which can put the root above Execution Time
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, 'plans', 'matrix');
  let checked = 0;
  for (const ver of fs.readdirSync(dir)) {
    const sub = path.join(dir, ver);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const file of fs.readdirSync(sub)) {
      if (!file.endsWith('.txt')) continue;
      let p;
      try { p = PgPlan.parse(fs.readFileSync(path.join(sub, file), 'utf8')); } catch (e) { continue; }
      const c = buildCharts(p).find(x => x.id === 'latency');
      if (!c || c.blocked) continue;
      checked++;
      const sum = c.items.reduce((s, i) => s + i.value, 0);
      assert.ok(sum <= c.whole + 1e-9,
        `${ver}/${file}: slices ${sum} exceed the whole ${c.whole}`);
    }
  }
  assert.ok(checked > 50, 'expected the matrix fixtures to exercise this: ' + checked);
});

test('a raised root time is admitted, not hidden behind "exact"', () => {
  const fs = require('fs'), path = require('path');
  const p = PgPlan.parse(fs.readFileSync(
    path.join(__dirname, 'plans', 'matrix', 'pg18', 'memoize.txt'), 'utf8'));
  assert.ok(p.diagnostics.some(d => d.code === 'metric_raised'), 'fixture changed');
  const c = buildCharts(p).find(x => x.id === 'latency');
  assert.equal(c.quality, 'approximate');
  assert.deepEqual(c.diagnostics, ['metric_raised']);
  assert.deepEqual(c.items.map(i => i.label), ['planning', 'execution']);
});

test('worker skew needs two distinct workers, not two printed blocks', () => {
  // PostgreSQL may print several blocks for the same worker
  const dup = `Gather  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..20.00 rows=100 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  ->  Sort  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..18.00 rows=50 loops=2)
        Sort Key: t.a
        Worker 0:  Sort Method: quicksort  Memory: 25kB
        Worker 0:  actual time=0.010..18.600 rows=50 loops=1
        ->  Parallel Seq Scan on t  (cost=0.00..100.00 rows=100 width=8) (actual time=0.01..5.00 rows=50 loops=2)
Execution Time: 20.5 ms`;
  assert.equal(chart(dup, 'workers').blocked.reason, 'no_worker_stats');
});

test('blockSize is validated, never trusted', () => {
  const temp = `Seq Scan on t  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..80.00 rows=100 loops=1)
  Buffers: temp written=100
Execution Time: 80.5 ms`;
  for (const bad of [-8192, 0, 1.5, '8192', null, NaN, Infinity]) {
    const c = chart(temp, 'spill', { blockSize: bad });
    assert.equal(c.items[0].value, 100 * 8192,
      'blockSize ' + String(bad) + ' was accepted');
  }
  assert.equal(chart(temp, 'spill', { blockSize: 32768 }).items[0].value, 100 * 32768);
});
