'use strict';
// Parser + analyzer + advisor tests: per-fixture invariants, advisor spot
// checks, index-DDL checks, input-contract checks, per-worker stats,
// truncation recovery and diagnostics.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PgPlan, fixtureFiles, readFixture, parseFixture } = require('./helpers.js');
const Expr = require('../src/pgplan-expr.js');

/* ---------------- per-fixture invariants ---------------- */

for (const f of fixtureFiles()) {
  test('invariants: ' + f, () => {
    const plan = parseFixture(f);
    assert.ok(plan.nodes.length > 0, 'no nodes');
    const root = plan.nodes[0];
    if (plan.nodes.some(x => x.timeTotal != null)) {
      assert.ok(root.timeIncl != null, 'root has no inclusive time');
    }
    for (const node of plan.nodes) {
      if (node.timeExcl != null) assert.ok(node.timeExcl >= 0, `node ${node.id} excl<0`);
      assert.ok(node.spec || node.type, `node ${node.id} has no type`);
    }
    // sum of exclusive time must not exceed root inclusive time
    // (small slack for clamped CTE/parallel rounding)
    const sumExcl = plan.nodes.filter(x => !x.spec && x.timeExcl != null)
      .reduce((s, x) => s + x.timeExcl, 0);
    if (root.timeIncl != null) {
      assert.ok(sumExcl <= root.timeIncl * 1.35 + 1,
        `sumExcl ${sumExcl.toFixed(3)} vs rootIncl ${root.timeIncl.toFixed(3)}`);
    }
  });
}

/* ---------------- advisor spot checks ---------------- */

const expectAdvice = {
  'plan-05.txt': ['GTH_WRKS', 'SEQ_RRBF'],
  'plan-07.txt': ['LIM_SORT', 'DSK_SORT'],
  'plan-11.txt': ['HSH_ROWS'],
};
for (const [f, codes] of Object.entries(expectAdvice)) {
  test('advice: ' + f, () => {
    const got = new Set(parseFixture(f).advice.map(a => a.code));
    for (const c of codes) assert.ok(got.has(c), `advice ${c} not raised (got: ${[...got]})`);
  });
}

const expectIdx = {
  // jsonb expression index for the filtered parallel seq scan
  'plan-05.txt': /USING btree \(\(doc ->> 'kind'::text\)\)/,
  // sort-key index from LIM_SORT
  'plan-07.txt': /USING btree \(amount, id\)/,
  // FK index on the join key
  'plan-14.txt': /ON inventory USING btree \(film_id\)/,
};
for (const [f, re] of Object.entries(expectIdx)) {
  test('index DDL: ' + f, () => {
    const defs = parseFixture(f).advice.flatMap(a => a.idxs || []).map(i => i.def).join('\n');
    assert.match(defs, re);
  });
}

test('schema: plan-11 relations and joins', () => {
  const s = parseFixture('plan-11.txt').schema;
  assert.ok(s, 'no schema');
  assert.equal(s.rels.length, 3);
  assert.equal(s.joins.length, 2);
});

/* ---------------- input contract ---------------- */

test('strict mode rejects garbage', () => {
  assert.throws(() => PgPlan.parse('hello world, this is not a plan'),
    /does not look like/);
});

test('tolerant mode accepts garbage', () => {
  const p = PgPlan.parse('hello world, this is not a plan', { tolerant: true });
  assert.equal(p.nodes.length, 1);
});

test('COSTS OFF plan accepted', () => {
  const p = PgPlan.parse('Sort\n  Sort Key: t.a\n  ->  Seq Scan on t\n        Filter: (a > 1)');
  assert.equal(p.nodes.length, 2);
  assert.equal(p.nodes[1].relation, 't');
});

test('input size limit', () => {
  assert.throws(() => PgPlan.parse('x'.repeat(9 * 1024 * 1024)), /too large/);
});

test('quoteIdent escaping', () => {
  assert.equal(Expr.quoteIdent('film_id'), 'film_id');
  assert.equal(Expr.quoteIdent('MyTable'), '"MyTable"');
  assert.equal(Expr.quoteIdent('we"ird'), '"we""ird"');
});

test('DDL quotes non-simple relation', () => {
  const idxs = Expr.suggestIndexes({
    relation: '"Weird Table"', alias: null,
    conds: [{ key: 'Filter', text: '(customer_id = 42)' }],
  });
  assert.match(idxs[0].def, /ON "Weird Table" USING btree \(customer_id\)/);
});

test('JSON root metadata retained', () => {
  const json = JSON.stringify([{
    'Plan': { 'Node Type': 'Seq Scan', 'Relation Name': 't', 'Alias': 't',
      'Startup Cost': 0, 'Total Cost': 10, 'Plan Rows': 1, 'Plan Width': 4,
      'Actual Startup Time': 0.01, 'Actual Total Time': 0.05,
      'Actual Rows': 1, 'Actual Loops': 1 },
    'Query Identifier': 1234567890123456789,
    'Serialization': { 'Time': 0.008, 'Output Volume': 1, 'Format': 'text' },
    'Execution Time': 0.1,
  }]);
  const keys = PgPlan.parse(json).ext.map(e => e.key);
  assert.ok(keys.includes('Query Identifier'), 'Query Identifier lost: ' + keys);
  assert.ok(keys.includes('Serialization'), 'Serialization lost: ' + keys);
});

test('text Serialization line retained', () => {
  const p = PgPlan.parse('Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)'
    + ' (actual time=0.01..0.02 rows=1 loops=1)\n'
    + 'Serialization: time=0.008 ms  output=1kB  format=text\n'
    + 'Execution Time: 0.1 ms');
  assert.ok(p.ext.some(e => e.key === 'Serialization'));
});

/* ---------------- per-worker stats (batch 1) ---------------- */

const PARALLEL_PLAN = `Gather Merge  (cost=1000.00..2000.00 rows=100 width=8) (actual time=50.000..60.000 rows=300 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  Buffers: shared hit=300 read=90
  ->  Sort  (cost=0.00..900.00 rows=50 width=8) (actual time=40.000..45.000 rows=100 loops=3)
        Sort Key: t.a
        Sort Method: external merge  Disk: 4920kB
        Buffers: shared hit=300 read=90, temp written=200
        Worker 0:  Sort Method: external merge  Disk: 5880kB
          Buffers: shared hit=90 read=30, temp written=70
        Worker 1:  actual time=41.000..44.000 rows=99 loops=1
          Buffers: shared hit=95 read=31, temp written=65
        ->  Parallel Seq Scan on t  (cost=0.00..500.00 rows=50 width=8) (actual time=1.000..30.000 rows=100 loops=3)
              Buffers: shared hit=280 read=80
Execution Time: 61.000 ms`;

test('Worker blocks parsed structurally', () => {
  const sort = PgPlan.parse(PARALLEL_PLAN).nodes[1];
  assert.equal(sort.workers.length, 2);
  const [w0, w1] = sort.workers;
  assert.equal(w0.num, 0);
  assert.equal(w0.sortSpace, 'Disk');
  assert.equal(w0.sortSizeKb, 5880);
  assert.deepEqual(w0.buf, { 'shared-hit': 90, 'shared-read': 30, 'temp-written': 70 });
  assert.equal(w1.timeTotal, 44);
  assert.equal(w1.rows, 99);
  assert.equal(w1.loops, 1);
});

test('worker buffers are not double-counted into the node', () => {
  const sort = PgPlan.parse(PARALLEL_PLAN).nodes[1];
  // node-level Buffers already include workers; worker sub-lines must not add
  assert.deepEqual(sort.buf, { 'shared-hit': 300, 'shared-read': 90, 'temp-written': 200 });
});

test('parallel attribution diagnostic is emitted', () => {
  const p = PgPlan.parse(PARALLEL_PLAN);
  assert.ok(p.diagnostics.some(d => d.code === 'parallel_estimate'),
    'codes: ' + p.diagnostics.map(d => d.code));
});

test('JSON Workers blocks parse identically', () => {
  const json = JSON.stringify([{ 'Plan': {
    'Node Type': 'Gather', 'Workers Planned': 2, 'Workers Launched': 2,
    'Startup Cost': 0, 'Total Cost': 10, 'Plan Rows': 3, 'Plan Width': 4,
    'Actual Startup Time': 1, 'Actual Total Time': 9,
    'Actual Rows': 3, 'Actual Loops': 1,
    'Plans': [{
      'Node Type': 'Seq Scan', 'Parent Relationship': 'Outer', 'Parallel Aware': true,
      'Relation Name': 't', 'Alias': 't',
      'Startup Cost': 0, 'Total Cost': 9, 'Plan Rows': 1, 'Plan Width': 4,
      'Actual Startup Time': 1, 'Actual Total Time': 8,
      'Actual Rows': 1, 'Actual Loops': 3,
      'Shared Hit Blocks': 30,
      'Workers': [
        { 'Worker Number': 0, 'Actual Startup Time': 1, 'Actual Total Time': 7.5,
          'Actual Rows': 1, 'Actual Loops': 1, 'Shared Hit Blocks': 10 },
        { 'Worker Number': 1, 'Actual Startup Time': 1, 'Actual Total Time': 7.9,
          'Actual Rows': 1, 'Actual Loops': 1, 'Shared Hit Blocks': 9 },
      ],
    }],
  }, 'Execution Time': 10 }]);
  const scan = PgPlan.parse(json).nodes[1];
  assert.equal(scan.workers.length, 2);
  assert.equal(scan.workers[1].timeTotal, 7.9);
  assert.deepEqual(scan.workers[0].buf, { 'shared-hit': 10 });
  assert.deepEqual(scan.buf, { 'shared-hit': 30 }); // no worker double-count
});

/* ---------------- truncation & diagnostics (batch 1) ---------------- */

test('truncated tail: detected, advice disabled', () => {
  const p = PgPlan.parse('Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)'
    + ' (actual time=0.01..0.02 rows=500 loops=1)\n'
    + '  Filter: (a > 1)\n'
    + '  Rows Removed by Filter: 100000\n'
    + '  ->  Sort  (cost=0.00..118', { tolerant: true });
  assert.equal(p.truncated, true);
  assert.ok(p.diagnostics.some(d => d.code === 'truncated_input' && d.severity === 'warn'));
  assert.deepEqual(p.advice, []);
});

test('plan starting mid-tree (arrow root) is flagged truncated', () => {
  const p = PgPlan.parse('->  Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)'
    + ' (actual time=0.01..0.02 rows=5 loops=1)');
  assert.equal(p.truncated, true);
  assert.equal(p.nodes[0].relation, 't'); // node itself is still recovered
  assert.ok(p.diagnostics.some(d => d.code === 'truncated_input'));
});

test('well-formed tail with missing children is flagged truncated', () => {
  // real-archive pattern: the stored plan ends at a join whose children were
  // cut off, with the last line itself syntactically complete — balanced
  // parens and a clean root, so only the tree shape gives the cut away
  const p = PgPlan.parse(`Sort  (cost=10.00..10.10 rows=10 width=8) (actual time=99.00..100.00 rows=10.00 loops=1)
  Sort Key: t.a
  ->  Nested Loop Semi Join  (cost=0.00..9.00 rows=10 width=8) (actual time=1.00..99.00 rows=10.00 loops=1)
        Join Filter: (t.a = q.a)`);
  assert.equal(p.truncated, true);
  const d = p.diagnostics.find(x => x.code === 'truncated_input');
  assert.ok(d && /missing their children/.test(d.message), JSON.stringify(p.diagnostics));
  assert.deepEqual(p.advice, []);
  // never-executed joins keep their children in real output — not truncated
  const ok = PgPlan.parse(`Nested Loop  (cost=0.00..9.00 rows=10 width=8) (never executed)
  ->  Seq Scan on t  (cost=0.00..4.00 rows=10 width=8) (never executed)
  ->  Seq Scan on q  (cost=0.00..4.00 rows=1 width=8) (never executed)`, { tolerant: true });
  assert.equal(ok.truncated, false);
});

test('PG10/11 lowercase tail spellings are canonicalized', () => {
  // before PG 12 the TEXT format prints "Planning time:" / "Execution time:"
  // (and 9.x printed "Total runtime:") while JSON/YAML always capitalize
  const p = PgPlan.parse(`Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=1 loops=1)
Planning time: 0.517 ms
Execution time: 16.833 ms`);
  assert.equal(p.planningTime, 0.517);
  assert.equal(p.executionTime, 16.833);
  const keys = p.ext.map(e => e.key);
  assert.ok(keys.includes('Planning Time') && keys.includes('Execution Time'), keys);
});

test('dropped lines outside any node are diagnosed', () => {
  const p = PgPlan.parse('Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)'
    + ' (actual time=0.01..0.02 rows=1 loops=1)\n'
    + 'Execution Time: 0.1 ms\n'
    + 'some stray trailing garbage');
  const d = p.diagnostics.find(x => x.code === 'unknown_line');
  assert.ok(d, 'no unknown_line diagnostic');
  assert.ok(d.samples[0].includes('stray'));
});

test('complete plans produce no truncation or unknown-line diagnostics', () => {
  for (const f of fixtureFiles()) {
    const p = parseFixture(f);
    assert.equal(p.truncated, false, f + ' flagged truncated');
    assert.ok(!p.diagnostics.some(d => d.code === 'unknown_line'),
      f + ' has unknown_line: ' + JSON.stringify(p.diagnostics));
  }
});

test('diagnostics carry stable shape', () => {
  const p = PgPlan.parse(PARALLEL_PLAN);
  for (const d of p.diagnostics) {
    assert.ok(/^[a-z_]+$/.test(d.code), 'bad code: ' + d.code);
    assert.ok(['info', 'warn'].includes(d.severity), 'bad severity: ' + d.severity);
    assert.ok(typeof d.message === 'string' && d.message.length > 10);
    assert.ok(d.count >= 1);
  }
});

/* ---------------- review fixes (2026-09-01) ---------------- */

test('schema-qualified quoted relation parses', () => {
  const p = PgPlan.parse('Seq Scan on public."Mixed Case" mc'
    + '  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=1 loops=1)');
  const n = p.nodes[0];
  assert.equal(n.relation, 'public."Mixed Case"');
  assert.equal(n.relationRef, 'public."Mixed Case"');
  assert.equal(n.alias, 'mc');
});

test('relation with escaped quotes parses and undoubles', () => {
  const p = PgPlan.parse('Seq Scan on "we""ird"'
    + '  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=1 loops=1)');
  assert.equal(p.nodes[0].relation, 'we"ird');
  assert.equal(p.nodes[0].relationRef, '"we""ird"');
});

test('JSON emitter doubles embedded quotes in identifiers', () => {
  const conv = PgPlan._internal.jsonToText({ Plan: {
    'Node Type': 'Seq Scan', 'Relation Name': 'we"ird', 'Alias': 'we"ird',
    'Startup Cost': 0, 'Total Cost': 1, 'Plan Rows': 1, 'Plan Width': 4 } });
  assert.match(conv.text.split('\n')[0], /on "we""ird"/);
});

test('YAML scalar list items parse (Sort Key)', () => {
  const p = PgPlan.parse([
    '- Plan:',
    '    Node Type: "Sort"',
    '    Startup Cost: 1.00',
    '    Total Cost: 2.00',
    '    Plan Rows: 10',
    '    Plan Width: 4',
    '    Sort Key: ',
    '      - "amount DESC"',
    '      - "id"',
    '    Plans: ',
    '      - Node Type: "Seq Scan"',
    '        Parent Relationship: "Outer"',
    '        Relation Name: "t"',
    '        Alias: "t"',
    '        Startup Cost: 0.00',
    '        Total Cost: 1.00',
    '        Plan Rows: 10',
    '        Plan Width: 4',
  ].join('\n'));
  assert.equal(p.nodes[0].sortKey, 'amount DESC, id');
});

test('same-name tables in different schemas stay distinct', () => {
  const p = PgPlan.parse(`Hash Join  (cost=10.00..20.00 rows=10 width=8) (actual time=0.10..1.00 rows=10 loops=1)
  Hash Cond: (u.id = a.user_id)
  ->  Seq Scan on public.users u  (cost=0.00..5.00 rows=100 width=8) (actual time=0.01..0.30 rows=100 loops=1)
  ->  Hash  (cost=5.00..5.00 rows=100 width=8) (actual time=0.20..0.20 rows=100 loops=1)
        ->  Seq Scan on audit.users a  (cost=0.00..5.00 rows=100 width=8) (actual time=0.01..0.15 rows=100 loops=1)
Execution Time: 1.2 ms`);
  assert.equal(p.schema.rels.length, 2);
  assert.deepEqual(p.schema.rels.map(r => r.schema + '.' + r.name).sort(),
    ['audit.users', 'public.users']);
  assert.equal(p.schema.joins.length, 1);
});

test('self-join via two aliases keeps its join edge', () => {
  const p = PgPlan.parse(`Hash Join  (cost=10.00..20.00 rows=10 width=8) (actual time=0.10..1.00 rows=10 loops=1)
  Hash Cond: (e.manager_id = m.id)
  ->  Seq Scan on employees e  (cost=0.00..5.00 rows=100 width=8) (actual time=0.01..0.30 rows=100 loops=1)
  ->  Hash  (cost=5.00..5.00 rows=100 width=8) (actual time=0.20..0.20 rows=100 loops=1)
        ->  Seq Scan on employees m  (cost=0.00..5.00 rows=100 width=8) (actual time=0.01..0.15 rows=100 loops=1)
Execution Time: 1.2 ms`);
  assert.equal(p.schema.rels.length, 1);
  assert.equal(p.schema.joins.length, 1);
  assert.equal(p.schema.joins[0].left.rel, 'employees');
  assert.equal(p.schema.joins[0].right.rel, 'employees');
});

test('Query Identifier survives int64 boundaries exactly (JSON)', () => {
  for (const q of ['9223372036854775807', '-9223372036854775808', '1234567890123456789']) {
    const j = '[{"Plan":{"Node Type":"Seq Scan","Relation Name":"t","Alias":"t",'
      + '"Startup Cost":0,"Total Cost":10,"Plan Rows":1,"Plan Width":4,'
      + '"Actual Startup Time":0.01,"Actual Total Time":0.05,"Actual Rows":1,"Actual Loops":1},'
      + '"Query Identifier":' + q + ',"Execution Time":0.1}]';
    const p = PgPlan.parse(j);
    assert.equal(p.queryId, q);
    assert.equal(p.ext.find(x => x.key === 'Query Identifier').value, q);
  }
});

test('Query Identifier exact in text and YAML formats', () => {
  const pt = PgPlan.parse('Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)'
    + ' (actual time=0.01..0.02 rows=1 loops=1)\n'
    + 'Query Identifier: -9223372036854775808\nExecution Time: 0.1 ms');
  assert.equal(pt.queryId, '-9223372036854775808');
  const py = PgPlan.parse([
    '- Plan:',
    '    Node Type: "Seq Scan"',
    '    Relation Name: "t"',
    '    Alias: "t"',
    '    Startup Cost: 0.00',
    '    Total Cost: 1.00',
    '    Plan Rows: 1',
    '    Plan Width: 4',
    '  Query Identifier: 9223372036854775807',
  ].join('\n'), { tolerant: true });
  assert.equal(py.queryId, '9223372036854775807');
  // plans without the field expose null
  assert.equal(parseFixture('plan-01.txt').queryId, null);
});

test('YAML double-quoted scalars decode JSON escapes', () => {
  const p = PgPlan.parse([
    '- Plan:',
    '    Node Type: "Seq Scan"',
    '    Relation Name: "we\\"ird\\\\tbl"',
    '    Alias: "we\\"ird\\\\tbl"',
    '    Startup Cost: 0.00',
    '    Total Cost: 1.00',
    '    Plan Rows: 1',
    '    Plan Width: 4',
    '    Filter: "(val = \'a\\\\b\'::text)"',
  ].join('\n'), { tolerant: true });
  assert.equal(p.nodes[0].relation, 'we"ird\\tbl');
  assert.equal(p.nodes[0].filters[0].val, "(val = 'a\\b'::text)");
});

test('SubPlan inside an Index Cond is charged to the scan that evaluates it', () => {
  // real-archive pattern: Index Cond: (id = (SubPlan 2)) — the subplan runs
  // during the scan's own condition evaluation, so its time is subtracted
  // from the scan, not from the parent join
  const p = PgPlan.parse(`Nested Loop Left Join  (cost=546.00..552.00 rows=1 width=219) (actual time=1.00..100.00 rows=21 loops=1)
  ->  Seq Scan on orders o  (cost=0.00..10.00 rows=21 width=8) (actual time=0.01..1.00 rows=21 loops=1)
  ->  Index Scan using items_pkey on items it  (cost=3.16..5.18 rows=1 width=26) (actual time=0.731..0.731 rows=1 loops=21)
        Index Cond: ((snapshot_id = (SubPlan 2)) AND (sku_id = o.sku_id))
        SubPlan 2
          ->  Limit  (cost=0.57..2.58 rows=1 width=8) (actual time=0.491..0.497 rows=1 loops=21)
                ->  Index Scan using snap_pkey on snapshots s  (cost=0.57..2.58 rows=1 width=8) (actual time=0.490..0.495 rows=1 loops=21)
Execution Time: 100.4 ms`);
  const scan = p.nodes.find(n => n.index === 'items_pkey');
  const sub = p.nodes.find(n => n.spec === 'SubPlan');
  assert.ok(scan && sub);
  assert.equal(sub.chargedTo, scan.id, 'subplan must be charged to the evaluating scan');
  // scan incl = 0.731*21 = 15.351; subplan incl = 0.497*21 = 10.437
  assert.ok(Math.abs(scan.timeIncl - 15.351) < 0.01);
  assert.ok(Math.abs(scan.timeExcl - (15.351 - 10.437)) < 0.02,
    'scan self time must exclude the subplan: ' + scan.timeExcl);
  // and the join above is NOT double-discounted
  const join = p.nodes[0];
  assert.ok(join.timeExcl > 80, 'join self time wrongly reduced: ' + join.timeExcl);
});

test('CTE with several scans is charged to the scan that absorbs its time', () => {
  // real-archive pattern (233-node plan, 684 s): two CTE Scans read the same
  // CTE; the document-first one is a cheap tuplestore re-reader, the later
  // one paid for the CTE's execution (huge startup time). Charging the CTE
  // to the first scan clamped that scan to zero and double-counted the whole
  // CTE subtree in Σ self (sumExcl reached 2× the root).
  const p = PgPlan.parse(`Nested Loop  (cost=1.00..20.00 rows=1 width=8) (actual time=95.00..100.00 rows=1.00 loops=1)
  CTE heavy
    ->  Seq Scan on big  (cost=0.00..10.00 rows=1000 width=8) (actual time=0.50..90.00 rows=1000.00 loops=1)
  ->  CTE Scan on heavy  (cost=0.00..0.04 rows=2 width=8) (actual time=0.01..0.05 rows=1.00 loops=1)
  ->  CTE Scan on heavy heavy_1  (cost=0.00..0.04 rows=2 width=8) (actual time=91.00..95.00 rows=1.00 loops=1)
Execution Time: 100.4 ms`);
  const cte = p.nodes.find(n => n.spec === 'CTE');
  const cheap = p.nodes.find(n => n.xtype === 'CTE Scan' && !/heavy_1/.test(n.rawHead));
  const payer = p.nodes.find(n => n.xtype === 'CTE Scan' && /heavy_1/.test(n.rawHead));
  assert.ok(cte && cheap && payer);
  assert.equal(cte.chargedTo, payer.id, 'CTE must be charged to the covering scan');
  assert.ok(Math.abs(payer.timeExcl - 5) < 0.02, 'payer self = incl - CTE: ' + payer.timeExcl);
  assert.ok(Math.abs(cheap.timeExcl - 0.05) < 0.02, 'cheap re-reader keeps its own time: ' + cheap.timeExcl);
  const sumExcl = p.nodes.filter(n => !n.spec).reduce((s, n) => s + n.timeExcl, 0);
  assert.ok(Math.abs(sumExcl - 100) < 0.1, 'Σ self must converge to root: ' + sumExcl);
});

test('bare InitPlan header (no "returns $N") is charged by time fit', () => {
  // mangled sources drop "(returns $N)" from spec headers, so the $-marker
  // search finds nothing and the section used to stay on the root — double
  // counting its time (real archive case: four bare InitPlans, +70% Σ self).
  // The fallback picks the tightest covering main-tree node; the body of the
  // CTE the InitPlan reads mirrors its time exactly and must NOT be picked.
  const p = PgPlan.parse(`Result  (cost=10.00..10.10 rows=20 width=8) (actual time=0.00..10.00 rows=20.00 loops=1)
  CTE data
    ->  Seq Scan on src  (cost=0.00..5.00 rows=100 width=8) (actual time=0.10..6.00 rows=100.00 loops=1)
  InitPlan 2
    ->  Aggregate  (cost=6.00..6.01 rows=1 width=8) (actual time=6.50..6.50 rows=1.00 loops=1)
          ->  CTE Scan on data  (cost=0.00..5.00 rows=100 width=8) (actual time=0.10..6.20 rows=100.00 loops=1)
  ->  Seq Scan on big  (cost=0.00..8.00 rows=20 width=8) (actual time=6.60..9.90 rows=20.00 loops=1)
        Filter: (v > $0)`);
  const init = p.nodes.find(n => n.spec && /^InitPlan/.test(n.type));
  const big = p.nodes.find(n => n.relation === 'big');
  const cteBody = p.nodes.find(n => n.relation === 'src');
  assert.ok(init && big && cteBody);
  assert.equal(init.chargedTo, big.id, 'InitPlan must be charged to the covering main-tree node');
  assert.ok(Math.abs(big.timeExcl - 3.4) < 0.02, 'executor self = incl - InitPlan: ' + big.timeExcl);
  assert.ok(Math.abs(cteBody.timeExcl - 6.0) < 0.02);
  const sumExcl = p.nodes.filter(n => !n.spec).reduce((s, n) => s + n.timeExcl, 0);
  assert.ok(Math.abs(sumExcl - 10) < 0.05, 'Σ self must converge to root: ' + sumExcl);
});

test('parallel attribution overshoot is diagnosed, not silent', () => {
  // two single-loop scans under one Gather each keep their full time via
  // ceil(loops/workers), adding up to more than the parent — the archive
  // sweep found real plans overshooting the root by 12-23%
  const p = PgPlan.parse(`Gather  (cost=0.00..500.00 rows=1000 width=8) (actual time=1.00..200.00 rows=1000 loops=1)
  Workers Planned: 3
  Workers Launched: 3
  ->  Parallel Append  (cost=0.00..400.00 rows=250 width=8) (actual time=0.50..158.00 rows=250 loops=4)
        ->  Seq Scan on part_a  (cost=0.00..190.00 rows=500 width=8) (actual time=0.40..158.00 rows=500 loops=1)
        ->  Seq Scan on part_b  (cost=0.00..190.00 rows=500 width=8) (actual time=0.40..158.00 rows=500 loops=1)
Execution Time: 201.0 ms`);
  const d = p.diagnostics.find(x => x.code === 'excl_overshoot');
  assert.ok(d, 'no excl_overshoot diagnostic: ' + p.diagnostics.map(x => x.code));
  assert.equal(d.severity, 'warn');
  assert.match(d.message, /\d+%/);
});

test('non-parallel plans do not report excl_overshoot', () => {
  for (const f of ['plan-01.txt', 'plan-11.txt', 'plan-16-psql-analyze.txt']) {
    const p = parseFixture(f);
    assert.ok(!p.diagnostics.some(d => d.code === 'excl_overshoot'), f);
  }
});

test('plan pasted without its head node is flagged truncated', () => {
  // real-archive pattern: the first line(s) are attributes of a node that
  // was cut off above (Sort Key / Sort Method / Buffers), credible nodes
  // follow — the tree has no real root, so advice must be disabled
  const p = PgPlan.parse(`Sort Key: t1.f_007
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=417762, local hit=3
  ->  Nested Loop Left Join  (cost=866175.44..866192.08 rows=1 width=239) (actual time=4707.131..4707.168 rows=1 loops=1)
        ->  Seq Scan on big t  (cost=0.00..9000.00 rows=100 width=8) (actual time=0.10..4000.00 rows=100 loops=1)
              Filter: (a = 1)
              Rows Removed by Filter: 500000
        ->  Seq Scan on small s  (cost=0.00..10.00 rows=1 width=8) (actual time=0.01..0.10 rows=1 loops=100)`);
  assert.equal(p.truncated, true);
  const d = p.diagnostics.find(x => x.code === 'truncated_input');
  assert.ok(d && /head node is missing/.test(d.message), JSON.stringify(p.diagnostics));
  assert.deepEqual(p.advice, [], 'advice must be disabled on a headless plan');
});
