# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/), versioning is
semver-ish (0.x — public preview line). History before git starts here
was tracked manually.

## [0.7.1] — 2026-09-02

### Fixed

- The latency donut could show slices adding up to more than its whole and
  still call itself **exact**: the root's inclusive time may exceed
  Execution Time, either by rounding or because the analyzer raised it to
  the sum of its children (`metric_raised`), and the negative residual was
  clamped to zero while the raised root stayed in the chart. Reproduced on
  four `memoize` matrix fixtures at 102–103%. Any root above Execution
  Time now falls back to the honest two-slice split, and a plan carrying
  `metric_raised` is marked approximate with the reason stated. A test
  walks every matrix fixture and asserts the slices never exceed the whole.
- A parallel sort spills once per process; the chart counted only the
  leader's volume and called it exact. A leader at 1000 kB with workers at
  2000 and 3000 now reads 6000 kB, with the split in the tooltip.
- Hash spills left the ranked bars: PostgreSQL reports no volume for them,
  and the peak memory of one batch is not one — ranking it against measured
  volumes reordered the chart on a different quantity. They are annotations
  now, stating the batch count, and a plan whose only spills are hashes
  says so instead of drawing a chart.
- Worker skew was drawn from a single worker: PostgreSQL may print several
  blocks for the same one, so the two-entry check passed and the filtered
  result left one bar. It now needs two *distinct* workers that reported a
  time, and carries `partial_worker_stats` when fewer blocks were printed
  than workers launched.
- Stacked and grouped bars printed only their total: the segment values and
  the meaning of their colours lived in a tooltip, which answers to neither
  touch nor the keyboard. Both are visible text now, with a colour key per
  card.
- `opts.blockSize` is validated instead of trusted — a negative, fractional
  or non-numeric value produced negative or NaN volumes.
- The "open diagnostics" link is rendered only when that pane exists.

### Changed

- The planning documents (`charts.md`, `ROADMAP.md`) moved out of the
  repository; `docs/how-it-works.md` stays as the model contract.

## [0.7.0] — 2026-09-02

### Added

- **Charts pane**: one tab, three sections — *Time* (reported time
  composition, execution hotspots, spills, block I/O timing), *Rows*
  (discarded rows, planner estimate vs actual, repeated inner work) and
  *Resources* (buffer access mix, write activity, Memoize, worker skew).
- Only quantities the model guarantees to be a whole are drawn as a
  composition; everything else is a ranked or stacked bar. **A chart whose
  whole cannot be trusted is not drawn** — a truncated plan, parts that
  exceed the root, a plan captured without `BUFFERS` — and the pane lists
  what each missing chart would need instead of showing empty cards.
  Rejected on the same grounds: one pie over all buffer counters (hit and
  dirtied overlap), a global kept-vs-discarded pie (root output and
  plan-wide removals have no shared denominator), JIT and triggers as
  latency slices (their timings are counted inside the node timing — on
  every JIT plan measured, the out-of-tree residual is smaller than the
  compilation time).
- Every mark and every legend row carries a tooltip with the value, its
  share where one exists, and what the quantity means — and every value is
  also printed, since hover is neither a keyboard nor a touch interaction.
- `buildCharts(plan, {blockSize})` is exported: pure, no DOM, so the
  arithmetic and the gates are unit-tested without a browser
  (`test/charts.test.js`).
- `tools/chart-coverage.js` reports how often each chart would have data
  over a corpus of plans.

## [0.6.1] — 2026-09-02

### Changed

- An exported copy removes **Visualize** and **Clear** instead of
  disabling them: with read-only fields neither has anything to act on.
  Input placeholders are dropped and a field carrying no data is hidden.

## [0.6.0] — 2026-09-01

### Added

- **Export**: the viewer page saves a self-contained copy of itself, with
  the plan and query baked in. Only data travels — every tab is recomputed
  on open by the code already inlined in the file. The copy is read-only
  (a `frozen` flag in the payload): no Export button of its own, the input
  fields cannot be edited, and Visualize/Clear are removed rather than
  greyed out, since nothing there acts on the data any more. Placeholders
  go too — they instruct, and a snapshot has nothing to instruct about —
  and a field that carries no data is hidden. The Export button sits at
  the end of the tab bar through the new `opts.tabActions` slot, which
  lets a host place its own actions there.
- The viewer page is now a build output: `viewer.template.html` is the
  source, and `build.py` writes the self-contained page to both `dist/`
  and the repository root. A page that links its styles and scripts cannot
  put them into an exported copy, so the page one opens while working has
  to be self-contained too.
- `build.py` refuses to write a page whose inline scripts spell a closing
  script tag anywhere — including inside a comment, where it silently ends
  the script and leaves the page dead on load.

## [0.5.4] — 2026-09-01

### Fixed

- The **Diagnostics** and **Recommendations** tabs lost their accent
  outline — and every tab lost its pill shape and padding. 0.5.3 gave the
  page's control styles an ancestor selector (`.vw-wrap button`) so they
  would survive the move into the widget pane, but the whole widget lives
  inside `.vw-wrap` too, so that rule (0-1-1) also captured the widget's
  own tabs and outranked `.pv-tab` / `.pv-tab-accent` (0-1-0). It went
  unnoticed because the page and the widget share the pg_diag palette, so
  the wrong border was the same colour. The page now names its own
  controls by class (`.vw-input .vw-btn`) instead of by ancestry.
- `.pv-tab-accent` also sat *before* `.pv-tab` in the stylesheet; at equal
  specificity the later rule wins, so it is now placed after it.
- browser-smoke asserts the colour the browser computes for those tabs and
  the widget's own pill geometry, instead of only checking that a class is
  present — which is what let this through.

## [0.5.3] — 2026-09-01

### Fixed

- Host controls handed to the widget through `opts.inputPane` lost their
  own look: the widget's zero-specificity control reset
  (`.pv :where(button)`, specificity 0-1-0) outranks a bare `button`
  selector (0-0-1), so once the viewer's form moved into the first tab,
  **Visualize** and **Clear** dropped their padding, border and
  background. The pane now carries `.pv-pane-host` as a styling hook, the
  reset documents that it reaches host markup, and the page qualifies its
  own controls with a class. Excluding the pane in CSS would need a
  complex `:not()`, which Safari 14/15 — inside the documented browser
  floor — rejects, dropping the whole rule with it.

## [0.5.2] — 2026-09-01

### Changed

- The widget accepts `opts.inputPane`: an element the host wants shown as
  a first **Input data** tab. The viewer page hands over its own plan and
  SQL fields, so the input form now lives in the tab strip instead of
  standing above the result. The widget only moves the element — it never
  creates or disposes it — and a freshly rendered plan never lands on that
  tab.
- The tab bar moved above the summary chips: the chips describe the plan
  the tabs navigate, so they read as its caption rather than as a second
  row of controls.

## [0.5.1] — 2026-09-01

### Changed

- Summary chips got a surface of their own — a step away from the
  transparent tab pills below them, which they used to be mistaken for.
  The input-format badge on the right (`TEXT` / `JSON` / `YAML`) is now
  styled as one of them instead of as loose text.
- The **Diagnostics** and **Recommendations** tabs carry the theme's gold
  outline: they hold findings, the rest are views of the plan.
- The `diagnostics` summary chip is gone — it duplicated its own tab.
- The dev page header carries the project identity the way the pg_diag
  report does: version, repository, site, contact. `build.py` fails the
  build if the version in the page and in `package.json` disagree.

## [0.5.0] — 2026-09-01

The first release since 0.4.3. It bundles the four development entries
below (0.4.4 – 0.4.7), which were never published on their own, and takes
a minor bump for one reason: **`advice[].code` values changed**. Anything
matching on them — a report generator, a dashboard, an integration — has
to be updated. The mapping table is in the 0.4.6 entry.

In short, since 0.4.3:

- the advisor learned what a query plan cannot say on its own — JIT time,
  hash-batch spills, a Memoize that does not pay for itself, planning
  time as a share of latency — and stopped repeating itself where a
  measured cause already exists (0.4.4);
- an optional SQL query is no longer decoration: `src/pgplan-sql.js`
  binds it to the plan behind a fail-closed gate and uses it for node →
  query navigation, generic-plan wording and cast provenance (0.4.5);
- the rule codes, evidence lines and model fields were renamed to say
  what they mean (0.4.6);
- the SQL pairing gate was hardened in both directions after review
  (0.4.7).

## [0.4.7] — 2026-09-01

### Fixed

- **The pairing gate now runs in both directions.** It only checked that
  every relation the query names is read by the plan, so a plan reading
  *more* than the query names passed. Combined with an alias match that
  outranked the actual relation, a query over `orders o` bound to a plan
  reading `orders z JOIN payments o`, and `orders`'s cast was attributed
  to `payments` — producing a false `SQL_CAST` and a copyable
  `CREATE INDEX … ON payments`. A table the plan reads and the query never
  names is now `sql_mismatch` / `reason: 'plan-only'`, and an alias may
  only speak for a node whose relation agrees with the FROM item it names.
  Structural scans (CTE, Subquery, Function, Values, WorkTable) are exempt
  from the reverse check: their "relation" comes from the query's shape.
- **Partitioned children are recognised by the alias PostgreSQL derives**
  from the parent (`orders o` → `orders_p2026_08 o_1`) instead of by a
  shared name prefix under an `Append`. The prefix rule read a plain
  `UNION ALL` over `orders_archive_2024` and `orders_backup` as partitions
  of `orders`, attaching that query's casts to both and emitting DDL for
  each. The alias is the server's own construction, so it also ties a
  child to exactly one FROM item — and it keeps working for a single
  surviving partition, which PostgreSQL prints without an `Append` at all.

## [0.4.6] — 2026-09-01

Naming pass. The rule codes were inherited from the ported advisor and
squeezed into eight characters (`DSK_SORT`, `SEQ_RRBF`, `GTH_WRKS`); the
constraint was never ours. Nothing about the analysis changed — the same
214-plan corpus produces the same 882 findings, one-for-one.

### Changed

- **Rule codes renamed** (`advice[].code`; two-letter badges are derived
  and stay unique):

  | was | is | was | is |
  | --- | --- | --- | --- |
  | `DSK_SORT` | `DISK_SORT` | `CLN_SORT` | `REDUNDANT_SORT` |
  | `DSK_HASH` | `DISK_HASH` | `CLN_GROUP` | `REDUNDANT_GROUP` |
  | `DSK_READ` | `DISK_READ` | `CLN_COPY` | `REPEATED_WORK` |
  | `IDX_RRBF` | `INDEX_DISCARD` | `GTH_WRKS` | `GATHER_WORKERS` |
  | `SEQ_RRBF` | `SEQSCAN_DISCARD` | `CTE_ROWS` | `CTE_RESCAN` |
  | `NLJ_RRJF` | `NESTLOOP_DISCARD` | `ROW_RATIO` | `ROW_ESTIMATE` |
  | `IDX_COND` | `INDEX_FULLREAD` | `MEM_CACHE` | `MEMOIZE_MISS` |
  | `IDX_BUFF` | `INDEX_BUFFERS` | `JIT_COST` | `JIT_TIME` |
  | `SEQ_BUFF` | `SEQSCAN_BUFFERS` | `EXT_EXECTIME` | `OUTSIDE_PLAN` |
  | `TBL_WRTN` | `TABLE_WRITTEN` | `EXT_PLANTIME` | `PLANNING_TIME` |
  | `ANY_TEMP` | `TEMP_SPILL` | `HSH_ROWS` | `JOIN_FULLREAD` |
  | `ANY_SLOW` | `UNEXPLAINED_TIME` | `ANJ_ROWS` | `ANTIJOIN_FULLREAD` |
  | `BMP_AND` / `BMP_OR` / `BMP_LOSSY` | `BITMAP_*` | `LIM_SORT` / `LIM_OFFS` | `LIMIT_SORT` / `LIMIT_OFFSET` |

  `SQL_CAST` and `SQL_NOTIN` keep their names. Three of the renames fix an
  outright wrong name rather than an abbreviation: `IDX_COND` fired on the
  *absence* of an index condition, `HSH_ROWS` also covers merge joins, and
  `CLN_COPY` is about repeated *execution*, not a copy.

- **Evidence lines spell things out**: `RRbF=900000` is now
  `removed by filter=900000`, `bufmem=`/`bufdsk=` are `buffers in
  memory=`/`from disk=`, and the plan table's `RRbF` column header reads
  `rows removed`. A rolled-up family entry now carries a `+N similar`
  chip, so an aggregate card is no longer indistinguishable from a
  single-node one.

- **Model fields**: `node.type` → `node.rawType` (the head line as
  printed) and `node.xtype` → `node.nodeType` (the operator) — the old
  pair gave the shorter name to the derived value; `node.prlTime` →
  `node.parallelTime`. `plan.stats[].type` follows as `rawType`.

### Fixed

- A rolled-up family entry was built without a `badge`, which surfaced as
  `undefined #N` in the summary badges and an empty pill on the card.

## [0.4.5] — 2026-09-01

The SQL text stopped being decoration. It was already an accepted input
(the `#sql` field, or the `Query Text:` auto_explain prints) but nothing
read it beyond syntax highlighting, while four existing rules were making
claims only the query could settle.

### Added

- `src/pgplan-sql.js` — a shallow scanner for the accompanying query
  (never a SQL parser): a lexer that survives nested block comments,
  dollar-quoted bodies, `E''`/`U&''` strings and quoted identifiers; a
  FROM/JOIN sweep that records every source with its offsets; CTE
  definitions; `$N` parameters; casts written by the author; and
  `NOT IN (SELECT …)`.
- **The pairing gate**, fail-closed. Before anything is derived from the
  query, every relation it names must be found in the plan — compared
  schema-qualified whenever both sides carry a schema (JSON/YAML plans
  do; TEXT prints relations unqualified). A partition counts as its
  parent only when the plan reads it through an `Append`; the naming
  convention alone is not evidence. A partial match, several statements
  in the input, or no relations at all leave `plan.sql.bound` false with
  `sql_mismatch` / `sql_multi_statement`, and every SQL-derived finding
  stays off — a plan explained against somebody else's query is worse
  than a plan explained alone.
- **Node → query fragment binding.** Scan nodes get a `sqlSpan`; advice
  cards grow a `sql` button that opens the query pane and highlights the
  FROM item the node came from (a CTE Scan points at the CTE definition).
  An alias reused in several subqueries is marked ambiguous, not guessed.
- `SQL_CAST` — the query casts a column in a predicate, so no plain index
  on it can serve the comparison. Provenance is per FROM item *and* per
  target type: two tables joined on columns that share a name never
  inherit each other's casts, and an unqualified `id::numeric` counts
  only when the statement reads a single source.
- `SQL_NOTIN` — `NOT IN (SELECT …)` evaluated as a per-row subplan.
  `NOT EXISTS` is offered as a rewrite, never as an equivalence: `NOT IN`
  is three-valued on *both* sides, so the rewrite changes the result
  unless the compared column and the subquery column are both NOT NULL.
- `plan.parameters` separates external `$N` from InitPlan/SubPlan outputs
  (both print as `$N`); available with or without the query text.
- Diagnostics `sql_mismatch`, `sql_multi_statement`, `sql_unparsed`.

### Changed

- Tab bar reworked: labels are capitalized and ordered by how a plan is
  read — **Plan, Stats, Diagram, Relations, Model, Diagnostics,
  Recommendations** — while **Plan text** and **SQL query** are pushed to
  the far end of the row, since they are the raw input rather than
  something the widget concluded. Pane names (`opts.tabs`) are unchanged.
- Index candidates no longer carry a cast the planner injected while
  matching operator types: with the query text, `btree (status, type,
  lifetime_created_at)` instead of `btree (((status)::text),
  ((type)::text), lifetime_created_at)`. A cast written in the query is
  kept — and reported. Without the query text the two are
  indistinguishable in the plan, so nothing is assumed.
- `ROW_ESTIMATE` stops blaming statistics on a node planned against a
  parameter: a generic plan is estimated without the values, so the miss
  is expected, and the first step is a custom plan rather than ANALYZE.
- `PLANNING_TIME` tells "send it as a prepared statement" apart from "it
  already is one, so the reuse or the plan cache is the question" — while
  saying plainly that the plan cannot show whether the client prepares
  and reuses the statement. A query with no literals and no parameters
  is no longer labelled "sent with literals".

### Fixed

- `FOR UPDATE SKIP LOCKED` no longer reads as a relation called `skip`
  (found on a real fixture, where it also cost the pair its binding).

## [0.4.4] — 2026-09-01

Recommendations and diagnostics round, driven by ten deliberately diverse
plans picked out of a 214-plan public archive (parallel, recursive CTE,
window + incremental sort, parallel DML with a 2.8 GB temp spill, JIT,
partition pruning, a truncated 14-minute plan). Measured over the whole
corpus, the noise codes shrank (`UNEXPLAINED_TIME` 297 → 125 cards, `ROW_ESTIMATE`
175 → 47) while actionable findings grew.

### Added

- `JIT_TIME` — JIT compilation as a share of execution. The corpus holds
  a query that spent **98.9% of 20 s compiling**, previously invisible:
  the JIT tail block is now parsed into `plan.jit`
  (functions, options, per-phase timing).
- `MEMOIZE_MISS` — a Memoize whose lookups mostly miss, told apart by cause:
  entries evicted as fast as they are created (cache too small) versus a
  low hit rate with no evictions (values that barely repeat). `Hits /
  Misses / Evictions / Overflows` are now parsed (text and JSON). Both
  halves have to be bad for it to fire: a cache answering 90% of its
  lookups is working, however many entries it recycles.
- `DISK_HASH` reworked: it now fires on `Batches: N > 1` — the actual hash
  spill signal — instead of a "Disk Usage" line PostgreSQL does not print
  for hash joins, so hash spills were silently missed. A batch count that
  grew at run time is reported as a planner underestimate. `Buckets` /
  `Batches` (and their `originally` values) are parsed. A concrete
  `work_mem` is offered only when `Disk Usage` was actually reported;
  otherwise the advice says the working set is *on the order of*
  batches × peak-memory-per-batch, and points at
  `work_mem × hash_mem_multiplier` as the real budget.
- `PLANNING_TIME` now judges planning against the whole latency (≥ 10% and
  ≥ 20 ms) instead of only firing when planning exceeded execution; it
  was silent on a plan spending 2.8 s planning a 4.6 s query.
- Diagnostics: `totals_missing` (no Planning/Execution Time line),
  `never_executed` (nothing reached the node — an empty outer side, a
  false one-time filter, a LIMIT that stopped execution, or run-time
  pruning), `runtime_pruning` (`Subplans Removed`). The diagnostics pane now also lists the missing
  EXPLAIN options from `plan.coaching`.

### Changed

- Spill advice is concrete: sizes are printed in human units and
  `next` carries a `SET LOCAL work_mem = '<value>'` computed from the
  observed spill — or, when that value would be unreasonable (a 4.5 GB
  sort), says so and points at reducing the row set instead.
- `UNEXPLAINED_TIME` is treated as a residual finding: it stands down on nodes
  where another rule already names a cause, and on plans without any
  `BUFFERS` it collapses into a single plan-scoped entry listing the slow
  nodes (it used to produce up to 26 identical cards per plan).
- `ROW_ESTIMATE` compares per-loop numbers, matching the ratio it reports.
  Scaling the estimate by the loop count turned ordinary parameterized
  probes ("planner floor of 1 row, nothing found, 800 loops") into
  dozens of fake findings.
- Truncated plans keep their node-local recommendations instead of losing
  all advice; tree-dependent rules stay silent and no entry claims a
  share of the total — the rolled-up aggregate entry included, and
  `INDEX_FULLREAD` stays out because it fires on the *absence* of a line that a
  cut plan cannot vouch for. A cut 14-minute plan now yields a lossy bitmap, an
  index scan discarding 951k rows, a sort spill and a 436k-loop CTE.
- `excl_overshoot` names the mechanism that produced it (parallel
  rounding, per-loop quantization, section attribution, truncation)
  instead of always blaming parallelism.
- Plan-scoped findings render under a "whole plan" header instead of
  borrowing the first evidence node's title and metrics.

### Fixed

- Index suggestions no longer recreate the index the scan already uses:
  a candidate built only from the node's own `Index Cond` columns is
  suppressed, and range predicates that cannot be search keys are
  appended as trailing columns so the discarded filter is covered.
  (Archive case: a scan on `(inn, year)` discarding 2.9M rows by a filter
  on a third column was told to create `(inn, year)`.)

## [0.4.3] — 2026-09-01

Validation round against the 30 largest public plans available (96–449
nodes each, up to 76-minute executions, per-node times and totals
cross-checked against an independent viewer — treated as a second
opinion, not ground truth). After the fixes below, 26 of 30 plans
converge Σ self ≈ root within 1%; the rest are honestly diagnosed
(parallel estimate, quantization, a genuinely cut plan).

- **CTE with several scans charged by time fit**: the CTE used to be
  charged to the first `CTE Scan` in document order; on a real 233-node
  plan a cheap tuplestore re-reader appeared before the scan that
  actually paid for a 684-second CTE, so Σ self reached 2× the root.
  The payer is now the scan whose own time absorbs the CTE (tightest
  covering fit).
- **Bottom-fed truncation detected structurally**: a plan cut below a
  join — last line syntactically fine, children missing — used to pass
  as complete, and the advisor ran on a beheaded tree (real 118-node
  archive plan). A join with fewer than two children or a single-input
  operator (Sort, Hash, Aggregate, …) with none now flags
  `truncated_input` and disables advice.
- **Monotonic repair of quantized times (`metric_raised`)**: per-loop
  actual times are printed with 1 µs resolution, so a `Memoize` at
  21.8M loops printed `0.000` while its child accumulated 5.8 s — the
  child then double-counted into Σ self (+17% on three archive plans).
  When the deficit fits the rounding budget, the parent's inclusive
  time is raised to its children's sum bottom-up.
- **Bare spec headers re-charged only on provable overload**: mangled
  sources drop `(returns $N)` from InitPlan/SubPlan headers, leaving no
  marker to find the executor by. Such sections stay on the syntactic
  parent (a target-list SubPlan really does execute there) unless the
  parent provably cannot contain them — then the tightest covering
  main-tree node takes the charge (bodies of other spec sections are
  excluded as circular). Fixed +70% Σ self on a real plan with four
  bare InitPlans without disturbing plans where the parent was right.
- **Advice family collapsing**: a big plan fired the same rule on
  dozens of nodes (20× `ANY_SLOW`, 40× `ROW_RATIO`, 157 `ROW_RATIO`
  minors on a 449-node plan). Only the three highest-impact entries per
  code remain individual cards; the rest roll into one aggregate entry
  (`agg: N`) carrying combined impact, all affected nodes and the
  rolled-up DDL candidates. One 449-node plan went from 51 cards to 9.
- **Diagnostics tab**: parser/analyzer diagnostics moved from a
  tooltip-only summary chip into their own tab after recommendations —
  cards with severity icons (warnings first), stable code, occurrence
  count, clickable node links and sample lines; the summary chip now
  opens the tab. `renderDiagnostics` is also exported standalone.
- **Sample-plan combobox removed**: the viewer no longer embeds the 17
  demo plans or auto-loads one on open — paste a plan, get a
  visualization. The dist artifact shrank 403 → 358 KB;
  `tools/browser-smoke.py` sweeps the same plans straight from
  `test/plans/` instead.
- **Canvas pan & zoom**: the diagram and relations panes gained −/+
  zoom buttons (animated, anchored to the viewport centre, 0.25×–4×)
  and drag-to-pan; a press that does not move stays a click, so node
  navigation keeps working. Zooming the relations pane reflows the
  cards like browser zoom and the join edges track the new layout at
  any scale. Both panes are capped at 78vh so the canvas scrolls
  instead of the page.
- **Four new diagram modes**: *by I/O time* (actual milliseconds from
  I/O Timings — buffer pages may all be cache hits), *by rows*, *by
  rows removed* (work thrown away by filters) and *by estimate error* —
  the latter on a diverging scale (blue = underestimated, red =
  overestimated, same mapping as the plan table; misses under 2× are
  ignored as planner noise). Buttons appear only when the plan carries
  the data; node tooltips gained rows-removed / self-I/O / estimate
  lines. Edge thickness by row flow was already there.
- **PostgreSQL 10 and 11 in the format matrix** (legacy systems still
  run them): `tools/gen-fixtures.sh` now covers 10…18 — legacy images,
  `EXECUTE PROCEDURE` trigger spelling, a pre-12 `cte-spill` variant
  (`AS MATERIALIZED` is 12+ syntax), JIT probed per build (absent on
  10). Found and fixed: the pre-12 TEXT tail spellings
  `Planning time:` / `Execution time:` (and 9.x `Total runtime:`) were
  not recognized as plan totals — they are canonicalized now, so
  planning/execution time chips and `EXT_*` advice work on legacy
  plans. 37 new parity triples committed.

## [0.4.2] — 2026-09-01

Advisor precision round, driven by a real 61-node production plan and a
sequential sweep of 10 public plan samples (per-node
inclusive/exclusive times, counters and totals cross-checked; note that
the archive viewer itself charges SubPlans inside an Index Cond to the
parent join — this tool charges them to the evaluating scan, matching
PostgreSQL's instrumentation semantics, covered by a regression test):

- **`ANY_SLOW` fires without buffer data**: a multi-minute CPU-bound node
  in a plan captured without BUFFERS previously produced no material
  advice at all; zero buffer traffic is now evidence, not an alibi.
- **`ANY_SLOW` counts local (temp-table) buffers**: an INSERT moving 90k
  local pages was labeled "no buffer data" and flagged as unexplained —
  local hit/read/written traffic now enters the explanation budget.
- **`excl_overshoot` diagnostic**: on parallel plans the ceil-based
  wall-clock attribution can make sibling self times add up to more than
  the root (archive plans showed +12…23%); this is now reported instead
  of silently disagreeing with itself.

- **New `DSK_READ` rule**: when the plan's own I/O Timings explain a slow
  node (e.g. 227 of 228 ms spent in 54 disk reads, ~4 ms/read), the
  advisor now says "disk-read bound: cold cache or slow storage" instead
  of the misleading "CPU/locks/overload" hypothesis; `ANY_SLOW` fires
  only on time that measured I/O does not explain.
- **New `NLJ_RRJF` rule**: a nested-loop Join Filter that discards almost
  every examined pairing (246 350 removed to keep 65) is now flagged with
  an index candidate on the inner join key — previously invisible.
- **`SEQ_BUFF`/`IDX_BUFF` are loop-normalized**: a parameterized index
  lookup touching ~btree-depth pages per iteration is no longer reported
  as possible bloat.
- **`TBL_WRTN` impact = measured write cost** (`ioWriteExcl`), not the
  node's whole self time — 3 written buffers no longer inherit an 83%
  impact chip.

## [0.4.1] — 2026-09-01

Second external-review round; all findings confirmed and fixed:

- **`plan.queryId`**: the PostgreSQL Query Identifier is captured
  lexically from the source text as an exact decimal string — int64
  values (e.g. `1234567890123456789`) no longer lose precision through
  `JSON.parse`; tested at the signed-int64 boundaries in all formats.
- **YAML strings decode their escapes**: PostgreSQL emits YAML strings
  via `escape_json()`, so double-quoted scalars are now JSON-decoded
  (`\"`, `\\`, `\n`, `\uXXXX`); a real PG-generated fixture with
  quotes and a backslash in the relation name (`quoted-idents` shape)
  verifies the full round-trip into generated DDL.
- **Complete tooltip teardown**: `destroy()` now removes all four
  container listeners, the document scroll listener and the tooltip
  element (previously only the scroll listener); standalone pane renders
  register their observers on the container and the new exported
  `PgPlanRender.destroy(container)` releases them.
- CONTRIBUTING gained a **Security & data sensitivity** section: plans
  carry filter literals, SQL text and schema names — redaction is
  explicitly required for public issues.
- CI browser regression now runs on **Chromium, Firefox and WebKit**.
- ROADMAP synchronized with the current state.

## [0.4.0] — 2026-09-01

- Project renamed `pg-plan-viz` → **pg-explain-viewer**
  (repo `O2eg/pg_explain_viewer`); build artifact is now
  `dist/pg-explain-viewer.html`.
- Publication infrastructure: LICENSE (MIT), THIRD_PARTY_NOTICES,
  CONTRIBUTING, CI (tests, reproducible build, headless browser
  regression), release + Pages workflows.
- **Review fixes (external code review)**:
  - YAML plans: scalar list items (Sort/Group keys, Output) parsed
    correctly — previously they collapsed to `[object Object]` and could
    reach generated DDL; format-parity tests now also compare sort/group
    keys and filter conditions;
  - index adviser no longer mutates string literals while stripping
    alias qualifiers (token-based `cleanExpr`);
  - identifier round-trip completed: `public."Mixed Case"` and
    `"we""ird"` heads parse, the JSON/YAML emitter doubles embedded
    quotes, reserved words (`select`, `table`, …) are quoted in DDL;
  - relations pane keeps same-name tables from different schemas apart
    and preserves self-join edges between aliases;
  - the offline viewer embeds the MIT license and the full highlight.js
    BSD-3 text; the release workflow attaches license files;
  - input limits are UTF-8 byte-based; the separate SQL text is capped
    (1 MB); a quadratic trailing-trim regex made deep plans parse in
    seconds — fixed (2000-node deep plan: 6.4 s → 0.3 s), with CI
    performance budgets.
- **Renderer lifecycle**: `render()` returns `{setTab, goToNode,
  destroy}`; document listeners and ResizeObservers are cleaned up,
  re-rendering into the same container disposes the previous instance,
  row ids are instance-scoped.
- **Baseline accessibility**: tabs are real buttons with ARIA
  tablist/tab semantics, roving tabindex and arrow-key navigation; copy
  buttons, node links, diagram modes and sortable headers are keyboard
  operable with a visible focus outline.

## [0.3.5] — 2026-08-31

- **Advice schema v2**: every recommendation separates the observation
  (facts from the plan) from the hypothesis (explicitly hedged) and an
  optional safe next step; high-risk wording audited (bloat, stale
  statistics, missing FK index, overload/locks are hypotheses with
  verification steps, never verdicts).
- **Impact gating**: findings carry measured impact (self time of
  flagged nodes, share of plan time); tiny findings are demoted to a
  collapsed "minor observations" section; advice sorted by impact.
- **EXPLAIN coaching** (`plan.coaching`): suggests only the missing
  EXPLAIN options that would answer an open question, with an explicit
  side-effect warning for DML.
- **DDL safety contract**: suggestions carry
  `confidence: exact|partial|unsafe`; every plan-derived fragment must
  pass a safe-SQL check (`isSafeFragment`) or no DDL is generated at all
  (descriptive candidate only, no copy button).
- Fixed: AND-ed parts of a single Filter were never analyzed (composite
  indexes now suggested); `Hash Anti Join` was misclassified as
  HSH_ROWS; embedded double quotes in identifiers were not undoubled;
  quoted dotted relation names were mis-split in generated DDL
  (`relationRef` preserves the printed spelling).
- Tests: 4-case rule matrix for all actionable advisor rules, DDL
  regression suite, hostile-input (XSS) fixture + committed
  headless-browser harness (`tools/browser-smoke.py`).

## [0.3.4] — 2026-08-31

- **`plan.diagnostics[]`** with stable codes (`unknown_line`,
  `truncated_input`, `unsupported_field`, `metric_clamped`,
  `partial_worker_stats`, `charge_inferred`, `charge_fallback`,
  `parallel_estimate`) + a summary chip; approximations and clamps are
  no longer silent.
- **Per-worker stats**: `Worker N:` blocks parsed structurally into
  `node.workers[]`; fixed worker buffers double-counting into the node;
  worker skew computed; the loops/(workers+1) wall-clock attribution is
  validated against per-worker times.
- **Truncated plans**: cut-off tail or arrow-root inputs are recovered,
  flagged (`plan.truncated`), and advice is disabled for them.
- **Golden-model tests** for all fixtures; tests migrated to `node:test`.
- **PostgreSQL 12…18 format matrix**: 28 query shapes (version-gated)
  × TEXT/JSON/YAML committed for every major (486 fixtures / 162
  triples) + format-parity assertions; generator `tools/gen-fixtures.sh`.
- JSON/YAML fields with no text representation are reported
  (`unsupported_field`) instead of silently dropped.

## [0.3.3] — 2026-08-31

- Strict input mode by default: non-plans are rejected
  (`{tolerant: true}` opts into recovery); input limits (8 MB, 50k
  nodes).
- Safe DDL identifiers (`quoteIdent`/`quoteRelRef`); truthful clipboard
  feedback; `Serialization`/`Query Identifier` retained from all
  formats; regex-lookbehind removed (wider browser floor).

## [0.3.0–0.3.2] — 2026-08-31

- Expression parser (`pgplan-expr.js`): relations pane (tables, columns,
  roles, join edges) and `CREATE INDEX` candidate generation.
- pg_diag report theme, unified three-step type scale, custom tooltips,
  IEC units and number formatting.
- Running-query snapshot support (`Current loop: …`).

## [0.1.0–0.2.0] — 2026-08-31

- Initial parser and visualizer implementation:
  single text-canonical parsing pipeline (text/JSON/YAML/auto_explain/
  psql/csvlog), charged exclusive-metrics analyzer, plan table with heat
  maps, stats, SVG dataflow diagram, 25 advisor rules, offline
  single-file viewer built by `build.py`.
