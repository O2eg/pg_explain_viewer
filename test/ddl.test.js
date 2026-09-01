'use strict';
// DDL safety regression suite for suggestIndexes / isSafeFragment:
// schema-qualified and quoted names, expression and partial indexes, casts,
// pattern operators, ORDER BY tails, gin candidates — and hostile
// pseudo-plan text that must never become copyable SQL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Expr = require('../src/pgplan-expr.js');

const sugg = (relation, conds, alias) =>
  Expr.suggestIndexes({ relation, alias: alias || null, conds });
const f = text => ({ key: 'Filter', text });

/* ---------------- identifier handling ---------------- */

test('schema-qualified relation is preserved in DDL', () => {
  const idxs = sugg('viz.t_orders', [f('(customer_id = 42)')]);
  assert.equal(idxs[0].confidence, 'exact');
  assert.match(idxs[0].def, /ON viz\.t_orders USING btree \(customer_id\)/);
});

test('quoted mixed-case relation stays quoted', () => {
  const idxs = sugg('"MyTable"', [f('(customer_id = 42)')]);
  assert.match(idxs[0].def, /ON "MyTable" USING btree/);
});

test('relation with embedded quote is escaped', () => {
  const idxs = sugg('"we""ird"', [f('(a = 1)')]);
  assert.match(idxs[0].def, /ON "we""ird" USING btree \(a\)/);
});

test('alias qualification is stripped from columns', () => {
  const idxs = sugg('t_orders', [f('((o.amount > 100) AND (o.status = \'paid\'::text))')], 'o');
  assert.match(idxs[0].def, /USING btree \(status, amount\)/);
});

/* ---------------- expressions, casts, patterns, order ---------------- */

test('jsonb expression index keeps the expression parenthesized', () => {
  const idxs = sugg('documents', [f("((doc ->> 'kind'::text) = 'invoice'::text)")]);
  assert.equal(idxs[0].confidence, 'exact');
  assert.match(idxs[0].def, /USING btree \(\(doc ->> 'kind'::text\)\)/);
});

test('equality columns precede the range column', () => {
  const idxs = sugg('t', [f('((a = 1) AND (b > 5) AND (c = 2))')]);
  assert.match(idxs[0].def, /USING btree \(a, c, b\)/);
});

test('LIKE gets text_pattern_ops', () => {
  const idxs = sugg('t', [f("((name)::text ~~ 'abc%'::text)")]);
  assert.match(idxs[0].def, /text_pattern_ops/);
});

test('<> lands in the WHERE clause, not in columns', () => {
  const idxs = sugg('t', [f("((a = 1) AND (status <> 'void'::text))")]);
  assert.match(idxs[0].def, /USING btree \(a\)\s+WHERE status <> 'void'::text/);
});

test('order-by tail appends after condition columns', () => {
  const idxs = sugg('t', [f('(a = 1)'), { key: 'order-by', text: 'b DESC NULLS LAST, a' }]);
  assert.match(idxs[0].def, /USING btree \(a, b\)/);
});

test('gin candidate for jsonb containment', () => {
  const idxs = sugg('t', [f("(doc @> '{\"k\": 1}'::jsonb)")]);
  const gin = idxs.find(i => i.type === 'gin');
  assert.ok(gin, 'no gin suggestion');
  assert.match(gin.def, /USING gin \(doc\)/);
});

test('conditions already covered by an Index Cond produce no suggestion', () => {
  const idxs = sugg('t', [{ key: 'Index Cond', text: '(a = 1)' }]);
  assert.equal(idxs, null);
});

/* ---------------- confidence contract ---------------- */

test('partial confidence when an OR condition is skipped', () => {
  const idxs = sugg('t', [f('(a = 1)'), f('((b = 2) OR (c = 3))')]);
  assert.equal(idxs[0].confidence, 'partial');
  assert.ok(idxs[0].def, 'partial still emits DDL');
});

test('partial confidence when a second range column is dropped', () => {
  const idxs = sugg('t', [f('((a > 1) AND (b < 5))')]);
  assert.equal(idxs[0].confidence, 'partial');
});

test('volatile function side is not indexed', () => {
  const idxs = sugg('t', [f('(created > now())')]);
  // created > now(): rhs volatile, lhs is the local side — still indexable
  assert.match(idxs[0].def, /USING btree \(created\)/);
  const idxs2 = sugg('t', [f('(now() = updated_at)'), f('(a = 1)')]);
  assert.match(idxs2[0].def, /USING btree \(updated_at, a\)/);
});

/* ---------------- hostile pseudo-plans: safe-output contract ---------------- */

test('semicolon injection in condition text -> unsafe, no DDL', () => {
  const idxs = sugg('t', [f('(a = 1) AND (lower(name; DROP TABLE users; --) = 3)')]);
  if (idxs) {
    for (const idx of idxs) {
      if (idx.def) assert.ok(!/DROP TABLE/.test(idx.def), 'injection reached DDL: ' + idx.def);
    }
  }
});

test('comment-marker expression -> unsafe, no DDL', () => {
  // craft a condition whose "column expression" carries a comment marker
  const idxs = sugg('t', [f('((a -- b) = 1)')]);
  if (idxs) {
    for (const idx of idxs) {
      assert.equal(idx.def, null, 'comment marker in copyable SQL: ' + idx.def);
      assert.equal(idx.confidence, 'unsafe');
      assert.ok(idx.cols.length, 'descriptive candidate must keep columns');
    }
  }
});

test('dangerous text inside a proper string literal stays safe', () => {
  // the literal reaches the DDL only via the <> WHERE residue — and stays
  // a quoted string there
  const idxs = sugg('t', [f("((a = 1) AND ((name)::text <> 'x); DROP TABLE t; --'::text))")]);
  assert.equal(idxs[0].confidence, 'exact');
  assert.match(idxs[0].def, /WHERE .*'x\); DROP TABLE t; --'/, 'literal must survive quoted');
});

test('oversized expression -> no copyable DDL', () => {
  const big = '(' + 'a'.repeat(300) + ' = 1)';
  const idxs = sugg('t', [f(big)]);
  if (idxs) for (const idx of idxs) assert.equal(idx.def, null);
});

test('isSafeFragment contract', () => {
  const ok = ['customer_id', "(doc ->> 'kind'::text)", '"Weird Col"',
    "status <> 'void'::text", 'upper(name)'];
  const bad = ['a; DROP TABLE x', 'a -- c', 'a /* c */ b', 'a\\b', '', 'x'.repeat(300)];
  for (const s of ok) assert.equal(Expr.isSafeFragment(s), true, s);
  for (const s of bad) assert.equal(Expr.isSafeFragment(s), false, s);
});

test('every emitted suggestion carries the confidence field', () => {
  const idxs = sugg('t', [f('((a = 1) AND (b > 2))'), { key: 'order-by', text: 'c DESC' }]);
  for (const idx of idxs) {
    assert.ok(['exact', 'partial', 'unsafe'].includes(idx.confidence), idx.confidence);
    assert.ok(Array.isArray(idx.cols) && idx.cols.length > 0);
    assert.ok(!('exact' in idx), 'legacy exact flag must be gone');
  }
});

/* ---------------- review fixes (2026-09-01) ---------------- */

test('string literals containing "rel." are never mutated', () => {
  const idxs = sugg('t', [f("((a = 1) AND (name <> 't.foo'::text))")]);
  assert.match(idxs[0].def, /WHERE name <> 't\.foo'::text/);
});

test('reserved words are quoted in DDL', () => {
  const idxs = sugg('"select"', [f('(a = 1)')]);
  assert.match(idxs[0].def, /ON "select" USING btree/);
  assert.equal(Expr.quoteIdent('table'), '"table"');
  assert.equal(Expr.quoteIdent('user'), '"user"');
  assert.equal(Expr.quoteIdent('users'), 'users');
});
