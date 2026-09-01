# How the numbers are computed — and how much to trust them

This page documents the model contract: which values come straight from
EXPLAIN, which are derived, and where the tool is honest about guessing.
Everything heuristic surfaces in `plan.diagnostics[]` and in the
recommendations' wording — nothing is silently approximated.

## Inclusive time

PostgreSQL reports per-node `actual time=a..b` as an **average per loop**.
The inclusive (subtree) time is:

```
timeIncl = timeTotal × loops
```

Under a `Gather`/`Gather Merge`, loops are spread across parallel
processes, so the wall-clock contribution is approximated as:

```
timeIncl = timeTotal × ceil(loops / (workersLaunched + 1))
```

This is an **approximation**: it assumes loops distribute evenly across
the leader and workers. When per-worker `Worker N:` blocks are present,
the tool validates the approximation against real worker times and emits
a `parallel_estimate` warning when they disagree by more than 25%. Worker
skew (`node.workerSkew`) is computed from per-worker times. Every plan
with parallel nodes carries a `parallel_estimate` info diagnostic so the
approximation is never presented as exact.

## Self (exclusive) time and charging

Self time is inclusive time minus the inclusive time of children:

```
timeExcl = timeIncl − Σ timeIncl(charged children)
```

The subtlety is CTE / InitPlan / SubPlan sections. Their execution time
is *already contained* in the node that actually runs them — a CTE runs
lazily inside the `CTE Scan` that first demands its rows, an
InitPlan/SubPlan inside the node whose conditions reference `$N` /
`(InitPlan N)` / `(SubPlan N)`. The analyzer finds that node
(`spec.chargedTo`) and subtracts the section there, not at its syntactic
parent. Without this, self times would double-count and Σ self ≠ root
inclusive.

When several `CTE Scan`s read the same CTE, the payer is chosen by time
fit — the scan whose own inclusive time can absorb the CTE (tightest
covering fit), not the first one in document order: a cheap tuplestore
re-reader can appear earlier than the scan that actually executed the
CTE. Sections whose headers lost their `(returns $N)` markers (mangled
sources) stay on the syntactic parent unless the parent *provably
cannot contain them* (its children plus charged sections exceed its own
inclusive time); only then is the tightest covering main-tree node in
the parent's subtree charged instead — bodies of other spec sections
are excluded because they mirror the section's time exactly and would
create a circular charge.

When the executing node is found heuristically, the plan carries a
`charge_inferred` diagnostic; when it cannot be found and the time stays
on the syntactic parent — `charge_fallback`.

Per-loop actual times are printed with 1 µs resolution, so at millions
of loops a parent can print *less* inclusive time than its children
accumulate (a `Memoize` at 21.8M loops prints `0.000` while its child
holds seconds). When the deficit fits the rounding budget
(`0.0005 ms × loops`), the parent's inclusive time is raised to the
children's sum bottom-up (`metric_raised`); larger deficits are left
alone and show up as `excl_overshoot` / `metric_clamped`.

Negative results (rounding, attribution overlap) are clamped to zero and
reported via `metric_clamped`. The invariant the test suite enforces on
every fixture: **the sum of self times stays within a few percent of the
root inclusive time**.

Buffers and I/O timings are reported inclusively by PostgreSQL, so the
same subtraction produces `bufExcl` / `ioReadExcl` / `ioWriteExcl`.

## Rows, loops, estimates

- `rowsTotal = rows × loops` (rows is a per-loop average; PG18 prints it
  fractionally).
- `ratio` compares planner estimate with actual (`planRows × loops` vs
  `rowsTotal`), only for completed nodes — running-query snapshots
  (`Current loop: …`) suppress it because their numbers are not final.
- `never executed` nodes contribute nothing.

## Recommendation confidence

Every advice entry separates:

- `obs` — the observation: facts the plan actually shows;
- `hyp` — the hypothesis: what those facts *might* mean, with the
  explicit caveat when the plan alone cannot prove it (bloat, stale
  statistics, missing indexes, lock waits all look like other things);
- `next` — a safe verification step (scoped `SET LOCAL` experiment,
  `pgstattuple`, `pg_stat_activity`), never a blind high-impact action;
- `impact` — measured: self time of the flagged nodes and its share of
  plan time. Findings under 2% / 1 ms are demoted to the collapsed
  "minor observations" section.

A big plan can trigger the same rule on dozens of nodes (an archive
sweep found 20× `UNEXPLAINED_TIME` and 40× `ROW_ESTIMATE` in single plans). Only
the three highest-impact entries per code are kept as individual cards;
the rest collapse into one aggregate entry (`agg: N`) that carries the
combined impact, all affected nodes (row badges still mark them), and
any DDL candidates from the rolled-up entries.

Three further rules keep the list readable and honest:

- **the residual finding stands down.** `UNEXPLAINED_TIME` means "nothing here
  explains this time". Where the same node already carries a measured
  cause (a spill, a filter discarding rows, a thrashing cache), the
  residual would only restate it and double-count the milliseconds in
  the ranking, so it is dropped.
- **without `BUFFERS` the question is not per node.** If the plan
  carries no buffer counters at all, the CPU-vs-I/O split is unknowable
  everywhere, and one plan-scoped entry lists the slow nodes instead of
  one identical card per node.
- **plan-scoped findings** (`scope: 'plan'` — planning time, JIT,
  out-of-tree time, the buffer-less residual) name nodes as evidence but
  are rendered under a "whole plan" header, never borrowing a node's
  metrics.

`CREATE INDEX` suggestions carry `confidence`:

- `exact` — every condition was analyzed and covered;
- `partial` — some conditions were skipped; the DDL is emitted with a
  warning that it may not cover everything;
- `unsafe` — a plan-text fragment could not be verified as safe SQL
  (tokenizer round-trip, no comment markers or stray bytes): **no DDL is
  generated**, only a descriptive candidate without a copy button.

All suggestions are candidates by definition: a plan does not show
existing indexes, write costs, data distribution, or the rest of the
workload.

## Diagnostics reference

| code | meaning |
| --- | --- |
| `unknown_line` | input lines outside any plan node were ignored |
| `truncated_input` | the plan is cut off (tail or missing ancestors); only node-local advice is produced and no finding claims a share of the total |
| `unsupported_field` | structured JSON/YAML fields with no text representation yet (e.g. Grouping Sets) |
| `metric_clamped` | negative self time clamped to zero |
| `metric_raised` | parent inclusive time raised to its children's sum (per-loop 1 µs rounding at high loop counts) |
| `charge_inferred` / `charge_fallback` | CTE/InitPlan/SubPlan attribution was heuristic / not found |
| `parallel_estimate` | wall-clock attribution under Gather is approximate |
| `excl_overshoot` | self times add up to more than the root wall-clock — treat them as upper bounds; the message names the mechanism (parallel rounding, per-loop quantization, section attribution or truncation) |
| `partial_worker_stats` | fewer `Worker N:` blocks than launched workers |
| `totals_missing` | no `Planning Time` / `Execution Time` line: time spent outside the tree cannot be accounted for |
| `never_executed` | branches pruned at run time: no timing, no recommendations for them |
| `runtime_pruning` | `Subplans Removed`: the plan shows only the partitions that survived pruning |
| `sql_mismatch` | the SQL text and the plan could not be matched — every SQL-derived finding is off |
| `sql_multi_statement` | the SQL text holds several statements; a plan describes one of them |
| `sql_unparsed` | the SQL text could not be scanned at all |

The diagnostics pane also lists the EXPLAIN options whose absence limits
the analysis (`plan.coaching`) — they answer the same question ("how far
can these numbers be trusted?") from the input side.

## The SQL text

The query is optional input. When it is present (`{query}` or the `Query
Text:` auto_explain prints), `pgplan-sql.js` scans it — a shallow scan, not a
parse: FROM/JOIN items with source offsets, CTE definitions, `$N` parameters,
casts written by the author, `NOT IN (SELECT …)`.

**The pairing gate comes first, it is fail-closed, and it runs in both
directions.** Every relation the query names must be read by the plan, and
every table the plan reads must be named by the query (structural scans — CTE,
Subquery, Function, Values, WorkTable — carry a name that comes from the
query's own shape and are exempt). The comparison is schema-qualified whenever
both sides carry a schema: JSON and YAML plans do, TEXT prints relations
unqualified, and a schema only one side knows cannot decide anything.

A partitioned or inherited child is recognised by the alias PostgreSQL derives
from its parent — `orders o` becomes `orders_p2026_08 o_1` — not by a shared
name prefix, which `orders_archive` and `orders_backup` would satisfy without
being partitions of anything. The same alias then ties the child to the FROM
item it belongs to.

Anything less than a full match in either direction — a relation the plan
never reads, a table the query never names, several statements in the input,
no relations at all — leaves `plan.sql.bound` false with `sql_mismatch` or
`sql_multi_statement`, and nothing downstream may use the query. A partial match is genuinely ambiguous (a view expanded, a join
eliminated — or simply the wrong query), and from here the cases are
indistinguishable, so the safe reading wins: a plan explained against somebody
else's SQL is worse than a plan explained on its own.

Once bound, the query is allowed to change exactly four things:

| what | why the plan alone cannot say it |
| --- | --- |
| `node.sqlSpan` | the plan prints aliases (`t_1`, `av_4`, `"*SELECT* 1"`), not the text they came from. An alias only speaks for a node whose relation agrees with the FROM item it names |
| `ROW_ESTIMATE` / `PLANNING_TIME` wording | a generic plan (estimated without parameter values) and a statement re-planned on every call look the same in the tree |
| index candidates and `SQL_CAST` | `(col)::text` is either a planner-injected coercion (index the plain column) or an author's cast (no plain index can serve it). Attribution is per FROM item and per target type; an unqualified cast counts only when the statement reads one source |
| `SQL_NOTIN` | `NOT IN (SELECT …)` and a `NOT EXISTS` the planner could not flatten both end up as a negated subplan |

`plan.parameters` (external `$N` vs InitPlan/SubPlan outputs) is derived from
the plan alone and stays available without any query text.
