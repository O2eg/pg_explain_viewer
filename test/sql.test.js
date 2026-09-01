'use strict';
// SQL-source scanner: the lexer edge cases that decide whether a span is
// trustworthy, the FROM/JOIN sweep, the pairing gate that guards every
// SQL-derived finding, and the advisor wording that changes once the query
// text is known.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sql = require('../src/pgplan-sql.js');
const { PgPlan } = require('./helpers.js');

const types = sql => Sql.lex(sql).map(t => t.t + ':' + t.v);
const names = sc => sc.relations.map(r => (r.name || r.kind) + (r.alias ? ' ' + r.alias : ''));

/* ---------------- lexer ---------------- */

test('line and block comments are dropped, block comments nest', () => {
  assert.deepEqual(types('a -- b\nc /* d /* e */ f */ g'),
    ['word:a', 'word:c', 'word:g']);
});

test('string literals keep doubled quotes together', () => {
  const t = Sql.lex("x = 'it''s here' AND y = 1");
  assert.equal(t[2].t, 'str');
  assert.equal(t[2].v, "'it''s here'");
});

test('E-strings honour backslash escapes', () => {
  const t = Sql.lex("x = E'a\\'b' AND y");
  assert.equal(t[2].t, 'str');
  assert.equal(t[2].v, "E'a\\'b'");
  assert.equal(t[3].v.toUpperCase(), 'AND');
});

test('dollar-quoted bodies are one token and never look like parameters', () => {
  const t = Sql.lex("DO $tag$ SELECT $1 FROM t $tag$");
  assert.equal(t[1].t, 'str');
  assert.ok(t.every(x => x.t !== 'param'), 'a $N inside a dollar-quoted body leaked out');
});

test('$N parameters are recognised outside dollar quotes', () => {
  const t = Sql.lex('a = $12');
  assert.equal(t[2].t, 'param');
  assert.equal(t[2].v, '$12');
});

test('quoted identifiers keep doubled quotes and dots', () => {
  const t = Sql.lex('SELECT * FROM "we""ird.tbl" x');
  const qid = t.find(x => x.t === 'qid');
  assert.equal(qid.v, '"we""ird.tbl"');
});

test('token offsets point back into the original text', () => {
  const sql = 'SELECT a FROM orders o';
  for (const t of Sql.lex(sql)) assert.equal(sql.slice(t.s, t.e), t.v);
});

/* ---------------- FROM / JOIN sweep ---------------- */

test('plain joins with and without AS', () => {
  const sc = Sql.scan(`SELECT *
    FROM public.orders o
    JOIN lab.customers AS c ON c.id = o.customer_id
    LEFT JOIN items i ON i.order_id = o.id`);
  assert.deepEqual(names(sc), ['orders o', 'customers c', 'items i']);
  assert.equal(sc.relations[0].schema, 'public');
});

test('comma-separated FROM list', () => {
  const sc = Sql.scan('SELECT * FROM a x, b y, c WHERE x.id = y.id');
  assert.deepEqual(names(sc), ['a x', 'b y', 'c']);
});

test('USING after a join is a column list, not a relation', () => {
  const sc = Sql.scan('SELECT * FROM a JOIN b USING (id) WHERE a.x = 1');
  assert.deepEqual(names(sc), ['a', 'b']);
});

test('subqueries and functions are recorded by kind, not guessed at', () => {
  const sc = Sql.scan(`SELECT * FROM (SELECT id FROM inner_t) s
     JOIN generate_series(1, 10) g ON g = s.id`);
  const kinds = sc.relations.map(r => r.kind + ':' + (r.alias || r.name));
  assert.ok(kinds.includes('subquery:s'), kinds.join(' '));
  assert.ok(kinds.includes('table:inner_t'), kinds.join(' '));
  assert.ok(kinds.includes('function:g'), kinds.join(' '));
});

test('CTEs are collected and separated from base relations', () => {
  const sc = Sql.scan(`WITH RECURSIVE tree AS (SELECT 1),
       other AS NOT MATERIALIZED (SELECT * FROM base b)
       SELECT * FROM tree t JOIN other o ON true`);
  assert.deepEqual(sc.ctes.map(c => c.name), ['tree', 'other']);
  assert.ok(names(sc).includes('base b'), names(sc).join(' '));
});

test('DML targets are relations too', () => {
  assert.deepEqual(names(Sql.scan('INSERT INTO staging.t (a) SELECT a FROM src s')),
    ['t', 'src s']);
  assert.deepEqual(names(Sql.scan('UPDATE orders o SET x = 1 FROM lookup l WHERE o.id = l.id')),
    ['orders o', 'lookup l']);
  assert.deepEqual(names(Sql.scan('DELETE FROM orders WHERE id = 1')), ['orders']);
});

test('keywords are never mistaken for aliases', () => {
  const sc = Sql.scan('SELECT * FROM orders WHERE id = 1 ORDER BY id LIMIT 10');
  assert.deepEqual(names(sc), ['orders']);
  assert.equal(sc.relations[0].alias, null);
});

/* ---------------- shapes the plan erases ---------------- */

test('parameters, predicate literals, casts and NOT IN are recorded', () => {
  const sc = Sql.scan(`SELECT * FROM t
     WHERE t.code::numeric >= 400000 AND CAST(t.d AS text) = 'x'
       AND t.id NOT IN (SELECT id FROM excluded)`);
  assert.equal(sc.params.count, 0);
  assert.ok(sc.predicateLiterals >= 2, 'predicate literals: ' + sc.predicateLiterals);
  assert.deepEqual(sc.casts.map(c => c.col + '::' + c.type), ['code::numeric', 'd::text']);
  assert.equal(sc.forms.notIn.length, 1);
});

test('a cast span points at the written cast', () => {
  const sql = 'SELECT * FROM t WHERE t.code::numeric >= 1';
  const c = Sql.scan(sql).casts[0];
  assert.equal(sql.slice(c.s, c.e), 't.code::numeric');
});

/* ---------------- pairing gate ---------------- */

const PLAN = `Hash Join  (cost=1.00..100.00 rows=1 width=8) (actual time=0.10..50.00 rows=1 loops=1)
  Hash Cond: (o.customer_id = c.id)
  ->  Seq Scan on orders o  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..10.00 rows=100 loops=1)
  ->  Hash  (cost=1.00..1.00 rows=1 width=8) (actual time=0.05..0.05 rows=1 loops=1)
        ->  Seq Scan on customers c  (cost=0.00..1.00 rows=1 width=8) (actual time=0.01..0.02 rows=1 loops=1)
Execution Time: 50.5 ms`;

test('a matching pair binds', () => {
  const p = PgPlan.parse(PLAN, { query: 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id' });
  assert.equal(p.sql.bound, true);
  assert.equal(p.sql.coverage, 1);
  assert.ok(!p.diagnostics.some(d => d.code === 'sql_mismatch'));
});

test('a mismatched pair is refused and diagnosed, not silently used', () => {
  const p = PgPlan.parse(PLAN, { query: 'SELECT * FROM invoices i JOIN payments pm ON pm.id = i.id' });
  assert.equal(p.sql.bound, false);
  const d = p.diagnostics.find(x => x.code === 'sql_mismatch');
  assert.ok(d && d.severity === 'warn', JSON.stringify(p.diagnostics));
  assert.deepEqual(p.sql.unmatched.sort(), ['invoices', 'payments']);
});

const PARTITIONED = `Append  (cost=0.00..100.00 rows=200 width=8) (actual time=0.02..20.00 rows=200 loops=1)
  ->  Seq Scan on orders_p2026_08 o_1  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..10.00 rows=100 loops=1)
  ->  Seq Scan on orders_p2026_09 o_2  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..10.00 rows=100 loops=1)
Execution Time: 20.5 ms`;

test('a partition read through an Append counts as its parent table', () => {
  const p = PgPlan.parse(PARTITIONED, { query: 'SELECT * FROM orders o WHERE o.ts > now()' });
  assert.equal(p.sql.bound, true);
});

test('a child is recognised by the alias PostgreSQL derives, not by a name prefix', () => {
  // "orders_archive_2024" is a table in its own right: any two tables may
  // share a prefix, but only a partitioned/inherited child is aliased after
  // its parent ("orders o" -> "orders_p2026_08 o_1")
  const q = 'SELECT * FROM orders o';
  const prefixOnly = PgPlan.parse(`Append  (cost=0.00..100.00 rows=200 width=8) (actual time=0.02..20.00 rows=200 loops=1)
  ->  Seq Scan on orders_archive_2024  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..10.00 rows=100 loops=1)
  ->  Seq Scan on orders_backup  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..10.00 rows=100 loops=1)
Execution Time: 20.5 ms`, { query: q });
  assert.equal(prefixOnly.sql.bound, false, 'an Append over independent tables was read as partitions');
  assert.equal(prefixOnly.sql.matchedNodes, 0);

  // and a single surviving partition, which PostgreSQL prints without an
  // Append at all, still binds on the alias
  const single = PgPlan.parse(`Seq Scan on orders_p2026_08 o_1  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..10.00 rows=100 loops=1)
Execution Time: 10.5 ms`, { query: q });
  assert.equal(single.sql.bound, true);
  assert.equal(single.sql.matchedNodes, 1);
});

test('a relation the plan reads but the query never names breaks the pair', () => {
  // the reverse direction of the gate: the query must account for what the
  // plan touched, not only the other way round
  const q = 'SELECT * FROM orders o WHERE o.id::numeric >= 400000';
  const p = PgPlan.parse(`Hash Join  (cost=1.00..900.00 rows=1 width=8) (actual time=0.10..900.00 rows=1 loops=1)
  Hash Cond: (z.id = o.id)
  ->  Seq Scan on orders z  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..300.00 rows=100 loops=1)
  ->  Hash  (cost=1.00..1.00 rows=1 width=8) (actual time=0.05..0.05 rows=1 loops=1)
        ->  Seq Scan on payments o  (cost=0.00..400.00 rows=1 width=8) (actual time=0.01..300.00 rows=1 loops=1)
              Filter: ((id)::numeric >= 400000.0)
              Rows Removed by Filter: 200000
Execution Time: 900.5 ms`, { query: q });
  assert.equal(p.sql.bound, false);
  assert.equal(p.sql.reason, 'plan-only');
  assert.deepEqual(p.sql.planOnly, ['payments']);
  assert.equal(p.sql.matchedNodes, 0);
  assert.ok(!p.advice.some(a => a.code === 'SQL_CAST'),
    "one relation's cast was attributed to another: " + p.advice.map(a => a.code));
});

test('an alias may not speak for a node whose relation disagrees', () => {
  // even inside a bound pair, "payments o" is not the query's "orders o"
  const q = 'SELECT * FROM orders o, payments p WHERE o.id::numeric >= 1 AND p.id = o.id';
  const p = PgPlan.parse(`Hash Join  (cost=1.00..900.00 rows=1 width=8) (actual time=0.10..900.00 rows=1 loops=1)
  Hash Cond: (z.id = o.id)
  ->  Seq Scan on orders z  (cost=0.00..400.00 rows=100 width=8) (actual time=0.01..300.00 rows=100 loops=1)
  ->  Hash  (cost=1.00..1.00 rows=1 width=8) (actual time=0.05..0.05 rows=1 loops=1)
        ->  Seq Scan on payments o  (cost=0.00..400.00 rows=1 width=8) (actual time=0.01..300.00 rows=1 loops=1)
              Filter: ((id)::numeric >= 400000.0)
              Rows Removed by Filter: 200000
Execution Time: 900.5 ms`, { query: q });
  assert.equal(p.sql.bound, true, 'both relations are named, so the pair is legitimate');
  const payments = p.nodes.find(n => n.relation === 'payments');
  assert.ok(!payments.sqlCasts,
    'the alias "o" handed orders\' cast to payments: ' + JSON.stringify(payments.sqlCasts));
  assert.equal(q.slice(payments.sqlSpan.s, payments.sqlSpan.e), 'payments p');
});

test('multiple statements disable the SQL context, not just warn about it', () => {
  // nothing in a plan says which of the statements it belongs to, so
  // relations, casts and parameters from the others must not be attributed
  const p = PgPlan.parse(PLAN, {
    query: 'SELECT id::numeric FROM orders;\n'
      + 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id;',
  });
  const d = p.diagnostics.find(x => x.code === 'sql_multi_statement');
  assert.ok(d && d.severity === 'warn', JSON.stringify(p.diagnostics));
  assert.equal(p.sql.bound, false);
  assert.equal(p.sql.reason, 'multi-statement');
  assert.equal(p.sql.matchedNodes, 0);
  assert.ok(!p.advice.some(a => /^SQL_/.test(a.code)), p.advice.map(a => a.code).join(' '));
});

test('a schema the plan disagrees with breaks the pair', () => {
  // TEXT plans print no schema, so the check only bites where both sides
  // carry one — JSON and YAML do
  const mk = schema => JSON.stringify([{
    Plan: {
      'Node Type': 'Seq Scan', Schema: schema, 'Relation Name': 'orders', Alias: 'o',
      'Startup Cost': 0, 'Total Cost': 900, 'Plan Rows': 1, 'Plan Width': 8,
      'Actual Startup Time': 0.1, 'Actual Total Time': 800, 'Actual Rows': 10, 'Actual Loops': 1,
    },
    'Execution Time': 800.5,
  }]);
  const q = 'SELECT * FROM public.orders o';
  assert.equal(PgPlan.parse(mk('public'), { query: q }).sql.bound, true);
  const other = PgPlan.parse(mk('private'), { query: q });
  assert.equal(other.sql.bound, false);
  assert.deepEqual(other.sql.unmatched, ['public.orders']);
  // and a text plan, which carries no schema at all, still binds
  assert.equal(PgPlan.parse(`Seq Scan on orders o  (cost=0.00..900.00 rows=1 width=8) (actual time=0.10..800.00 rows=10 loops=1)
Execution Time: 800.5 ms`, { query: q }).sql.bound, true);
});

test('a relation the plan never reads leaves the pair unbound', () => {
  const p = PgPlan.parse(PLAN, { query: 'SELECT * FROM orders o JOIN invoices i ON i.id = o.id' });
  assert.equal(p.sql.bound, false);
  assert.equal(p.sql.reason, 'partial');
  assert.equal(p.sql.matchedNodes, 0);
});

test('casts belong to one FROM item and one target type', () => {
  // alpha.id is cast by the author; beta.id carries a planner cast to a
  // different type and only shares the column name
  const plan = `Hash Join  (cost=1.00..900.00 rows=1 width=8) (actual time=0.10..900.00 rows=1 loops=1)
  Hash Cond: (a.id = b.id)
  ->  Seq Scan on alpha a  (cost=0.00..500.00 rows=100 width=8) (actual time=0.01..400.00 rows=100 loops=1)
        Filter: ((id)::numeric >= 400000.0)
        Rows Removed by Filter: 100000
  ->  Hash  (cost=1.00..1.00 rows=1 width=8) (actual time=0.05..0.05 rows=1 loops=1)
        ->  Seq Scan on beta b  (cost=0.00..400.00 rows=1 width=8) (actual time=0.01..300.00 rows=1 loops=1)
              Filter: ((id)::text = 'x'::text)
              Rows Removed by Filter: 200000
Execution Time: 900.5 ms`;
  const p = PgPlan.parse(plan, {
    query: "SELECT * FROM alpha a JOIN beta b ON a.id = b.id"
      + " WHERE a.id::numeric >= 400000 AND b.id = 'x'",
  });
  const defs = Object.fromEntries(p.advice.filter(a => a.idxs)
    .map(a => [p.nodes[a.nodes[0].id].relation, a.idxs[0].def]));
  assert.match(defs.alpha, /\(\(id\)::numeric\)/, 'the author cast was lost: ' + defs.alpha);
  assert.match(defs.beta, /btree \(id\)/, 'a foreign cast reached beta: ' + defs.beta);
  const castNodes = p.advice.filter(a => a.code === 'SQL_CAST')
    .map(a => p.nodes[a.nodes[0].id].relation);
  assert.deepEqual(castNodes, ['alpha']);
});

test('an unqualified cast is used only when the statement reads one source', () => {
  const plan = `Seq Scan on mart m  (cost=0.00..900.00 rows=100 width=8) (actual time=0.10..800.00 rows=100 loops=1)
  Filter: ((code)::numeric >= 400000.0)
  Rows Removed by Filter: 900000
Execution Time: 800.5 ms`;
  const one = PgPlan.parse(plan, { query: 'SELECT * FROM mart m WHERE code::numeric >= 400000' });
  assert.ok(one.advice.some(a => a.code === 'SQL_CAST'), 'single source: the cast is attributable');
  // with a second source in the statement the bare column name proves nothing
  const twoPlan = plan.replace('Execution Time', "  ->  Seq Scan on other o  (cost=0.00..1.00 rows=1 width=8) (actual time=0.01..0.02 rows=1 loops=1)\nExecution Time");
  const two = PgPlan.parse(twoPlan, {
    query: 'SELECT * FROM mart m, other o WHERE code::numeric >= 400000',
  });
  assert.ok(!two.advice.some(a => a.code === 'SQL_CAST'),
    'an unqualified cast was attributed anyway: ' + two.advice.map(a => a.code));
});

test('no query means no SQL context and no diagnostics about it', () => {
  const p = PgPlan.parse(PLAN);
  assert.equal(p.sql, null);
  assert.ok(!p.diagnostics.some(d => /^sql_/.test(d.code)));
});

/* ---------------- parameters vs InitPlan outputs (S1) ---------------- */

const PARAM_PLAN = `Index Scan using t_pk on t  (cost=0.29..8.30 rows=1 width=8) (actual time=0.02..900.00 rows=5000 loops=1)
  Index Cond: (id = $1)
  Filter: (note <> '$9'::text)
Planning Time: 2811.050 ms
Execution Time: 4621.351 ms`;

test('external parameters are told apart from InitPlan outputs and literals', () => {
  const p = PgPlan.parse(`Index Scan using t_pk on t  (cost=0.29..8.30 rows=1 width=8) (actual time=0.02..0.03 rows=1 loops=1)
  Index Cond: (id = $1)
  Filter: ((note <> '$9'::text) AND (owner = $0))
  InitPlan 1 (returns $0)
    ->  Aggregate  (cost=1.00..1.01 rows=1 width=8) (actual time=0.01..0.01 rows=1 loops=1)
Execution Time: 1.0 ms`);
  assert.deepEqual(p.parameters, { external: ['$1'], internal: ['$0'] });
});

test('ROW_ESTIMATE on a parameterized node blames the generic plan, not statistics', () => {
  const a = PgPlan.parse(PARAM_PLAN).advice.find(x => x.code === 'ROW_ESTIMATE');
  assert.ok(a, 'ROW_ESTIMATE not raised');
  assert.match(a.hyp, /generic plan/);
  assert.match(a.next, /force_custom_plan/);
  assert.match(a.nodes[0].ext, /planned from a parameter/);
});

test('ROW_ESTIMATE without parameters keeps the stale-statistics reading', () => {
  const a = PgPlan.parse(PARAM_PLAN.replace('(id = $1)', "(id = 42)")).advice
    .find(x => x.code === 'ROW_ESTIMATE');
  assert.ok(a, 'ROW_ESTIMATE not raised');
  assert.match(a.hyp, /Statistics may be outdated/);
});

test('PLANNING_TIME: literals in the query make the prepared-statement advice concrete', () => {
  const a = PgPlan.parse(PARAM_PLAN, { query: 'SELECT * FROM t WHERE id = 42' }).advice
    .find(x => x.code === 'PLANNING_TIME');
  assert.match(a.ext, /carries literals, not parameters/);
  assert.match(a.next, /prepared statement/);
  // the wire protocol is not visible in a plan: no claim may be made about it
  assert.match(a.hyp, /cannot show whether the client prepares/);
});

test('PLANNING_TIME: an already-parameterized query gets a different question', () => {
  const a = PgPlan.parse(PARAM_PLAN, { query: 'SELECT * FROM t WHERE id = $1' }).advice
    .find(x => x.code === 'PLANNING_TIME');
  assert.match(a.ext, /1 parameter/);
  assert.match(a.hyp, /already parameterized/);
  assert.match(a.next, /plan_cache_mode/);
});

test('PLANNING_TIME without a query keeps the generic wording', () => {
  const a = PgPlan.parse(PARAM_PLAN).advice.find(x => x.code === 'PLANNING_TIME');
  assert.doesNotMatch(a.ext, /parameter|literal/);
  assert.match(a.hyp, /many joined relations/);
});

test('an unbound pair may not steer the advisor', () => {
  const p = PgPlan.parse(PARAM_PLAN, { query: 'SELECT * FROM totally_other x WHERE x.id = 1' });
  assert.equal(p.sql.bound, false);
  const a = p.advice.find(x => x.code === 'PLANNING_TIME');
  assert.doesNotMatch(a.ext, /literal/, 'SQL-derived wording leaked from a mismatched pair');
});

/* ---------------- casts: written by the author vs injected (S2) ---------------- */

const CAST_PLAN = `Seq Scan on mart m  (cost=0.00..9000.00 rows=100 width=8) (actual time=0.10..800.00 rows=100 loops=1)
  Filter: (((code)::numeric >= 400000.0) AND ((status)::text = 'ok'::text))
  Rows Removed by Filter: 900000
Execution Time: 800.5 ms`;

const ddlOf = (p, code) => {
  const a = p.advice.find(x => x.code === code);
  return a && a.idxs && a.idxs[0] ? a.idxs[0].def : '';
};

test('a planner-injected cast is dropped from the index candidate', () => {
  const p = PgPlan.parse(CAST_PLAN,
    { query: "SELECT * FROM mart m WHERE m.code >= 400000 AND m.status = 'ok'" });
  const def = ddlOf(p, 'SEQSCAN_DISCARD');
  assert.match(def, /btree \(status, code\)/, def);
  assert.ok(!/::/.test(def), 'an expression index was proposed for an injected cast: ' + def);
});

test('a cast written in the query is kept in the candidate and reported', () => {
  const p = PgPlan.parse(CAST_PLAN,
    { query: "SELECT * FROM mart m WHERE m.code::numeric >= 400000 AND m.status = 'ok'" });
  const def = ddlOf(p, 'SEQSCAN_DISCARD');
  assert.match(def, /\(\(code\)::numeric\)/, def);
  assert.match(def, /btree \(status,/, 'the injected cast on status should still be dropped: ' + def);
  const a = p.advice.find(x => x.code === 'SQL_CAST');
  assert.ok(a, 'SQL_CAST not raised: ' + p.advice.map(x => x.code));
  assert.match(a.nodes[0].ext, /code is cast to numeric/);
  assert.doesNotMatch(a.nodes[0].ext, /status/, 'an injected cast must not be reported as written');
});

test('without a query nothing is assumed about who wrote the cast', () => {
  const p = PgPlan.parse(CAST_PLAN);
  assert.ok(!p.advice.some(x => x.code === 'SQL_CAST'));
  assert.match(ddlOf(p, 'SEQSCAN_DISCARD'), /::/, 'casts must be kept when the query is unknown');
});

test('CAST(col AS type) counts as written too', () => {
  const p = PgPlan.parse(CAST_PLAN,
    { query: "SELECT * FROM mart m WHERE CAST(m.code AS numeric) >= 400000 AND m.status = 'ok'" });
  assert.ok(p.advice.some(x => x.code === 'SQL_CAST'), p.advice.map(x => x.code).join(' '));
});

test('an unbound pair may not rewrite index candidates either', () => {
  const p = PgPlan.parse(CAST_PLAN,
    { query: 'SELECT * FROM unrelated u WHERE u.code >= 1' });
  assert.equal(p.sql.bound, false);
  assert.match(ddlOf(p, 'SEQSCAN_DISCARD'), /::/, 'a mismatched query changed the DDL');
});

/* ---------------- node <-> SQL fragment binding (S3) ---------------- */

const BIND_SQL = `SELECT *
  FROM public.orders o
  JOIN customers c ON c.id = o.customer_id
 WHERE o.status = $1`;

test('plan nodes are bound to the FROM item they came from', () => {
  const p = PgPlan.parse(PLAN, { query: BIND_SQL });
  const spans = p.nodes.filter(n => n.sqlSpan)
    .map(n => n.relation + ' -> ' + BIND_SQL.slice(n.sqlSpan.s, n.sqlSpan.e));
  assert.deepEqual(spans, ['orders -> public.orders o', 'customers -> customers c']);
  assert.equal(p.sql.matchedNodes, 2);
});

test('a fixture carrying its own Query Text binds without a separate input', () => {
  const p = require('./helpers.js').parseFixture('plan-01.txt');
  assert.ok(p.query, 'fixture has no embedded query');
  assert.equal(p.sql.bound, true);
  const n = p.nodes.find(x => x.sqlSpan && x.relation === 'stock_items');
  assert.equal(p.query.slice(n.sqlSpan.s, n.sqlSpan.e), 'simple_stock.stock_items');
});

test('a partition node points at the parent table in the query', () => {
  const sql = 'SELECT * FROM orders o WHERE o.ts > now()';
  const p = PgPlan.parse(PARTITIONED, { query: sql });
  const n = p.nodes.find(x => x.relation === 'orders_p2026_08');
  assert.equal(sql.slice(n.sqlSpan.s, n.sqlSpan.e), 'orders o');
});

test('an alias used twice is marked ambiguous instead of guessed at', () => {
  const sql = 'SELECT * FROM (SELECT * FROM orders x) a JOIN (SELECT * FROM orders x) b ON true';
  const p = PgPlan.parse(`Hash Join  (cost=1.00..100.00 rows=1 width=8) (actual time=0.10..50.00 rows=1 loops=1)
  ->  Seq Scan on orders x  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..10.00 rows=100 loops=1)
  ->  Seq Scan on orders x_1  (cost=0.00..50.00 rows=100 width=8) (actual time=0.01..10.00 rows=100 loops=1)
Execution Time: 50.5 ms`, { query: sql });
  const n = p.nodes.find(x => x.sqlSpan);
  assert.equal(n.sqlSpan.ambiguous, true);
});

test('an unbound pair produces no spans at all', () => {
  const p = PgPlan.parse(PLAN, { query: 'SELECT * FROM invoices i' });
  assert.equal(p.sql.matchedNodes, 0);
  assert.ok(!p.nodes.some(n => n.sqlSpan), 'spans leaked from a mismatched pair');
});

/* ---------------- shapes the plan erases (S4) ---------------- */

const NOTIN_PLAN = `Seq Scan on orders o  (cost=0.00..900.00 rows=1 width=8) (actual time=0.10..800.00 rows=10 loops=1)
  Filter: (NOT (hashed SubPlan 1))
  Rows Removed by Filter: 500000
  SubPlan 1
    ->  Seq Scan on excluded e  (cost=0.00..100.00 rows=1000 width=4) (actual time=0.01..5.00 rows=1000 loops=1)
Execution Time: 800.5 ms`;

test('SQL_NOTIN positive: NOT IN with a subquery gets the anti-join advice', () => {
  const p = PgPlan.parse(NOTIN_PLAN,
    { query: 'SELECT * FROM orders o WHERE o.id NOT IN (SELECT id FROM excluded e)' });
  const a = p.advice.find(x => x.code === 'SQL_NOTIN');
  assert.ok(a, 'not raised: ' + p.advice.map(x => x.code));
  assert.match(a.hyp, /on both\s+sides|three-valued/);
  assert.match(a.next, /NOT EXISTS/);
  // NOT EXISTS is a rewrite, not an equivalence: both sides' nullability count
  assert.match(a.next, /not a drop-in/);
  assert.match(a.next, /subquery column are NOT NULL|both the compared column/);
});

test('SQL_NOTIN negative: a query already written as NOT EXISTS is left alone', () => {
  const p = PgPlan.parse(NOTIN_PLAN,
    { query: 'SELECT * FROM orders o WHERE NOT EXISTS (SELECT 1 FROM excluded e WHERE e.id = o.id)' });
  assert.ok(!p.advice.some(x => x.code === 'SQL_NOTIN'), p.advice.map(x => x.code).join(' '));
});

test('SQL_NOTIN negative: no query text, no claim about the written form', () => {
  assert.ok(!PgPlan.parse(NOTIN_PLAN).advice.some(x => x.code === 'SQL_NOTIN'));
});

test('SQL_NOTIN negative: NOT IN over a value list is not a subquery', () => {
  const p = PgPlan.parse(`Seq Scan on orders o  (cost=0.00..900.00 rows=1 width=8) (actual time=0.10..800.00 rows=10 loops=1)
  Filter: (id <> ALL ('{1,2,3}'::integer[]))
  Rows Removed by Filter: 500000
Execution Time: 800.5 ms`, { query: 'SELECT * FROM orders o WHERE o.id NOT IN (1, 2, 3)' });
  assert.ok(!p.advice.some(x => x.code === 'SQL_NOTIN'), p.advice.map(x => x.code).join(' '));
});

test('FOR UPDATE SKIP LOCKED is a locking clause, not a relation', () => {
  const sc = Sql.scan("SELECT id FROM q.tasks WHERE status='p' ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED;");
  assert.deepEqual(names(sc), ['tasks']);
  const sc2 = Sql.scan('SELECT * FROM t FOR NO KEY UPDATE');
  assert.deepEqual(names(sc2), ['t']);
  // a real UPDATE statement still reads its target
  assert.deepEqual(names(Sql.scan('UPDATE t SET a = 1')), ['t']);
});

test('a CTE Scan points at the CTE definition, not at a reference', () => {
  // the plan below reads nothing but the CTE, so the query must not name a
  // table the plan never touches — that pair would (correctly) not bind
  const sql = 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 5)'
    + ' SELECT count(*) FROM r';
  const p = PgPlan.parse(`Aggregate  (cost=1.00..1.01 rows=1 width=8) (actual time=0.10..50.00 rows=1 loops=1)
  ->  CTE Scan on r  (cost=0.00..1.00 rows=5 width=4) (actual time=0.01..0.05 rows=5 loops=1)
  CTE r
    ->  Recursive Union  (cost=0.00..1.00 rows=5 width=4) (actual time=0.01..0.04 rows=5 loops=1)
Execution Time: 50.5 ms`, { query: sql });
  const n = p.nodes.find(x => x.nodeType === 'CTE Scan');
  assert.match(sql.slice(n.sqlSpan.s, n.sqlSpan.e), /^r\(n\) AS \(SELECT 1 UNION ALL/);
});
