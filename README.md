# pg-explain-viewer

Repository: <https://github.com/O2eg/pg_explain_viewer>

PostgreSQL query plan visualizer with built-in recommendations.
Pure JavaScript, zero dependencies, fully static — designed to be embedded
into reports and pages (pg_diag HTML report: "everything inline, no CDNs"),
self-hosted, or used as a single offline HTML file.

Paste a plan (with or without the SQL query text) — get a visualization
with heat maps, aggregated stats, a dataflow diagram and heuristic
recommendations. No server, no history, no network.

## Files

| File | Purpose |
| --- | --- |
| `src/pgplan.js` | Parser + analyzer. Input formats: **text / JSON / YAML**, auto_explain log entries (`duration: … ms  plan:` + `Query Text:`), csvlog CSV-quoting, psql frames (`QUERY PLAN`, `---`, `(N rows)`). Produces nodes with derived metrics, aggregated **stats**, a structural **domain** model, **advice** (see below) and the relations **schema**. UMD: browser globals (`window.PgPlan`) and node (`require`). |
| `src/pgplan-expr.js` | Condition-expression parser: tokenizes the predicate texts EXPLAIN prints (Index Cond / Filter / Hash Cond / Sort Key / …), extracts column references and comparison segments. Powers the relations pane (columns, roles, join edges) and `suggestIndexes()` — CREATE INDEX generation for the advisor. Load it **before** `pgplan.js`; it is optional (without it the widget just has no relations pane / index DDL). |
| `src/pgplan-sql.js` | Shallow scanner for the **SQL text that accompanies the plan** (never a SQL parser): FROM/JOIN items with source offsets, CTE definitions, `$N` parameters, casts written by the author, and the shapes a plan erases (`NOT IN (SELECT …)`). Also binds plan nodes to the fragment of the query they came from, and refuses a pair whose relations do not match. Load it **before** `pgplan.js`; optional (without it the query text is only displayed). |
| `src/pgplan-render.js` | Renderer (`window.PgPlanRender`). Static styling via `pv-*` classes only; data-driven heat colors are computed at render time with hues taken from CSS theme variables. |
| `vendor/highlight-11.11.1.min.js` | highlight.js — the same library and version the pg_diag report vendors. Optional peer for SQL highlighting (query pane, CREATE INDEX blocks): the renderer uses `window.hljs` when present, otherwise falls back to plain text. Token colors are themed via `--pv-hl-*`. |
| `css/pgplan-theme.css` | **Theme**: every color and font as `--pv-*` custom properties on the `.pv` container. Palette, fonts and sizing follow the **pg_diag report theme** (purple/gold surfaces, system-ui + ui-monospace). Typography is a unified three-step scale reused everywhere: `--pv-fs-lg` 15.5px (headings), `--pv-fs` 14px (base), `--pv-fs-sm` 13px (secondary) — no other text sizes exist in the widget. Built-in light (default for the bare container) and dark (`data-pv-theme="dark"` on the container or any ancestor — pg_diag's default scheme) variants. A host application re-skins the widget by overriding the variables. |
| `css/pgplan.css` | Structural styles; contains no literal colors or fonts. |
| `viewer.template.html` | Source of the viewer page: markup, page chrome and the export logic, with build markers where the CSS/JS get inlined. |
| `build.py` | Inlines CSS + JS and writes the self-contained page twice: `dist/pg-explain-viewer.html` (release / Pages artifact) and `./pg-explain-viewer.html` (the page you open while working). Both are build output and untracked — only a page carrying its own styles and scripts can export a working copy of itself. |
| `test/plans/` | Real PG18 plans harvested from the pg_stand demo stand csvlog (auto_explain: text/json/yaml, DML, parallel, CTE, InitPlan/SubPlan, partitions, external sort + temp I/O) plus `EXPLAIN`-without-ANALYZE and psql-framed fixtures. |
| `test/*.test.js` | `node:test` suite: `npm test` (parser invariants, golden-model snapshots, advisor spot checks, format-parity for the PG matrix). `UPDATE_GOLDEN=1 npm test` regenerates the snapshots in `test/golden/`. |

## Using the widget

```html
<link rel="stylesheet" href="pgplan-theme.css">
<link rel="stylesheet" href="pgplan.css">
<script src="highlight-11.11.1.min.js"></script> <!-- optional: SQL highlighting -->
<script src="pgplan-expr.js"></script>           <!-- optional: relations + index DDL -->
<script src="pgplan-sql.js"></script>            <!-- optional: what the SQL text adds -->
<script src="pgplan.js"></script>
<script src="pgplan-render.js"></script>

<div id="plan"></div>
<script>
  // text | JSON | YAML; throws on garbage. The optional second argument
  // supplies the SQL text when the plan itself carries no Query Text
  // (and overrides it otherwise): PgPlan.parse(rawPlanText, {query: sql})
  const plan = PgPlan.parse(rawPlanText);
  PgPlanRender.render(document.getElementById('plan'), plan, {
    // tabs: ['plan', 'advice', 'stats'],        // subset of panes (default: all applicable)
    // defaultTab: 'plan',
    // expanded: true,                           // start with node details expanded
    // summary: false,                           // hide the chip row
  });
</script>
```

`render()` returns `{setTab, goToNode, destroy}`; call `destroy()` to
remove the widget and release everything it attached: container and
document listeners, tooltip element, ResizeObservers. Re-rendering into
the same container disposes the previous instance automatically. For
standalone pane renders (`renderTable(el, …)` etc.) call
`PgPlanRender.destroy(el)` when the element is retired.

`render()` builds a self-contained widget: a tab bar, and under it summary
chips — plan totals as readouts, visually a step away from the tab pills —
(+ advice badges)
and internal tabs, in reading order. A host may claim the first tab for
its own markup by passing `opts.inputPane` (the dev page puts its plan and
SQL fields there as **Input data**); the widget moves that element into the
pane and never disposes it, and a freshly rendered plan does not land on
it. Then come — **Plan** (table), **Stats**,
**Diagram**, **Relations**, **Model**, **Diagnostics** (parser/analyzer
notes and warnings as cards with severity icons and node links),
**Recommendations**, and — pushed to the far
end of the bar, because they are the raw input rather than a finding —
**Plan text** and **SQL query**. Tabs without data are hidden
automatically. The pane names used by `opts.tabs` are unchanged
(`plan`, `stats`, `diagram`, `relations`, `domain`, `diagnostics`,
`advice`, `text`, `query`). All cross-links work inside the widget:
advice badges, column headers (jump to the hottest node), stats node
lists, diagram nodes and relation cards navigate to the plan row with a
pulse highlight.

The diagram highlights nodes **by time**, **by buffers**, **by I/O
time** (actual milliseconds from I/O Timings — pages in `by buffers`
may all be cache hits), **by rows**, **by rows removed** (work thrown
away by filters — index candidates at a glance) and **by estimate
error** (a diverging scale: blue = the planner underestimated, red =
overestimated, misses under 2× ignored); buttons appear only when the
plan carries the data. Edge thickness always shows the row flow.

Both canvas panes — **diagram** and **relations** — pan by dragging and
zoom with the −/+ buttons (animated, anchored to the viewport centre);
zooming the relations pane reflows the cards like browser zoom, and the
join edges follow.

Single panes can be embedded separately:

```js
PgPlanRender.renderTable(el, plan);     // just the table
PgPlanRender.renderAdvice(el, plan);    // recommendation cards (+ CREATE INDEX DDL)
PgPlanRender.renderStats(el, plan);     // aggregates by (node type, relation, index)
PgPlanRender.renderDiagram(el, plan);   // SVG dataflow diagram
PgPlanRender.renderRelations(el, plan); // tables/columns/indexes with join edges
PgPlanRender.renderText(el, plan);      // highlighted canonical plan text
```

## Data model (short)

Per node (`plan.nodes[i]`, in plan-text order):

- identity: `rawType` (the head line as printed) / `nodeType` (the operator,
  with `Parallel`/`Partial`/`Finalize` stripped), `relation`, `index`, `alias`, `spec`
  (`CTE|InitPlan|SubPlan` section headers), `parent/children/depth`;
- planner: `costStartup/costTotal/planRows/planWidth`, `costExcl`;
- actuals: `timeStartup/timeTotal/rows/loops`, `never`;
- derived: `timeIncl` (parallel-aware: loops are divided by workers+1
  under a Gather), `timeExcl` (inclusive minus charged children, clamped
  at 0, `exclClamped` marks overlap), `bufExcl`, `ioReadExcl/ioWriteExcl`,
  `rowsTotal`, `rowsRemovedTotal`, `ratio/ratioDir` (estimate vs actual);
- `advice`: recommendation entries that involve this node.

CTE / InitPlan / SubPlan sections are **charged** (`chargedTo`) to the node
that actually executes them: a CTE to the `CTE Scan` whose own time can
absorb it (tightest covering fit — a cheap tuplestore re-reader may
precede the paying scan in document order), an Init/SubPlan to the node
whose conditions reference `$N` / `(InitPlan N)` / `(SubPlan N)`.
Exclusive metrics are subtracted there, so the sum of self times matches
the root inclusive time.

Plan-level: `plan.stats` (aggregates), `plan.domain` (structural model),
`plan.advice` (all recommendations), `plan.totals`, `plan.max`,
`plan.columns` (which optional columns carry data), `planningTime`,
`executionTime`, `text` (canonical plan text), `query`, `queryId`
(the PostgreSQL Query Identifier as an **exact decimal string** — int64
values never pass through a float, so it is safe to match against
`pg_stat_statements.queryid` or report keys).

## Recommendations

Heuristic rules with an honest contract: every entry separates the
**observation** (`obs` — what the plan actually shows) from the
**hypothesis** (`hyp` — what it might mean, explicitly hedged) and an
optional safe **next step** (`next`, e.g. a scoped `SET LOCAL work_mem`
experiment instead of a global change). Each entry carries a measured
`impact` (self time of the flagged nodes and its share of plan time);
findings below 2% / 1 ms are demoted into a collapsed "minor
observations" section so they never distract from material bottlenecks.
`plan.coaching` additionally suggests missing EXPLAIN options (ANALYZE /
BUFFERS / TIMING) when they would answer a specific open question — with
an explicit side-effect warning for DML statements; those suggestions are
shown on the diagnostics pane alongside the model diagnostics.

On a **truncated** plan the tree-dependent rules stay silent, but the
node-local ones (spills, filters discarding rows, thrashing caches) still
run off the lines that did arrive — and no finding claims a share of a
total the plan cannot supply.

For the index-related codes (`SEQSCAN_DISCARD`, `INDEX_DISCARD`, `BITMAP_AND`,
`LIMIT_SORT`, `JOIN_FULLREAD`, `ANTIJOIN_FULLREAD`) the adviser also generates
`CREATE INDEX CONCURRENTLY` candidates from the node's conditions
(equality columns first, then one range column, then sort keys; short
residual predicates become a `WHERE` clause; jsonb/array operators
produce a `gin` variant; expression indexes like `((doc ->> 'kind'::text))`
are supported). Every suggestion carries `confidence`:
`exact` (all conditions analyzed and covered), `partial` (some skipped —
DDL emitted with a warning), `unsafe` (a plan-text fragment failed the
safe-SQL check — no DDL, no copy button, descriptive candidate only).
DDL is always labeled a candidate: a plan does not show existing indexes,
write costs, or the rest of the workload. Codes and their badges:

| Code | Meaning |
| --- | --- |
| `SEQSCAN_DISCARD` / `INDEX_DISCARD` | scan discards most rows by filter — missing/inefficient index |
| `JOIN_FULLREAD` / `ANTIJOIN_FULLREAD` | full read joined down to a few rows — a join-key index may help |
| `LIMIT_SORT` / `LIMIT_OFFSET` | LIMIT reads far more than it returns — index on sort keys / keyset pagination |
| `REDUNDANT_SORT` / `REDUNDANT_GROUP` / `REPEATED_WORK` | redundant sort / regrouping / duplicated subtree |
| `DISK_SORT` / `DISK_HASH` / `TEMP_SPILL` / `BITMAP_LOSSY` | working set spilled past work_mem — with a concrete `SET LOCAL work_mem` value sized from the observed spill (or, past a sane budget, the advice to cut the row set instead). `DISK_HASH` reads `Batches: N > 1` and flags a batch count that grew at run time as a planner underestimate |
| `MEMOIZE_MISS` | a Memoize whose lookups mostly miss — cache too small for the key space (evictions) or values that barely repeat |
| `SEQSCAN_BUFFERS` / `INDEX_BUFFERS` | many buffers per row (per loop) — possible bloat, verify before VACUUM FULL |
| `NESTLOOP_DISCARD` | nested-loop join filter discards almost all pairings — index the join key |
| `DISK_READ` | node time dominated by measured disk reads — cold cache / slow storage |
| `TABLE_WRITTEN` | buffers written during a read |
| `ROW_ESTIMATE` | estimate far off actual — ANALYZE, then extended statistics |
| `BITMAP_AND` / `BITMAP_OR` | composite index / UNION instead of bitmap combination |
| `CTE_RESCAN` | CTE re-scanned many times over a large row set |
| `GATHER_WORKERS` | fewer parallel workers launched than planned |
| `UNEXPLAINED_TIME` | node time unexplained by buffers and measured I/O — CPU/locks/host, plan cannot tell. Stands down where another rule already names a cause; collapses to one plan-scoped entry when the plan has no `BUFFERS` at all |
| `JIT_TIME` | JIT compilation takes a large share of execution — compare against `SET LOCAL jit = off`, then `jit_above_cost` |
| `OUTSIDE_PLAN` / `PLANNING_TIME` | time outside the plan / planning is a large share of the latency |
| `SQL_CAST` | the query casts a column in a predicate, so no plain index on it can be used (needs the query text) |
| `SQL_NOTIN` | `NOT IN (SELECT …)` is evaluated as a subplan; `NOT EXISTS` would allow an anti-join (needs the query text) |

Severity classes (`crit/warn/io/mem/idx/info/hint`) map to theme tokens
`--pv-sev-*`.

## What the SQL text adds

The query is an optional second input (`PgPlan.parse(plan, {query})`, or the
`Query Text:` auto_explain already carries). It is never trusted blindly:
`pgplan-sql.js` matches the two sides **in both directions** — every relation
the query names must be read by the plan, and every table the plan reads must
be named by the query — schema-qualified when both sides carry a schema, with
partitioned children recognised by the alias PostgreSQL derives from the
parent (`orders o` → `orders_p2026_08 o_1`) rather than by a name prefix. The
gate is **fail-closed**: a mismatch in either direction, several statements, or
no relations at all is reported as `sql_mismatch` / `sql_multi_statement` with
every SQL-derived finding switched off. What the query buys once it is bound (`plan.sql`):

- **which fragment a node came from** — every scan node gets a `sqlSpan` into
  the query text; the advice cards grow a `sql` button that opens the query
  pane and highlights that FROM item (a CTE Scan points at the CTE
  definition). An alias reused in several subqueries is marked ambiguous
  rather than guessed at.
- **parameter or literal** — `ROW_ESTIMATE` stops blaming statistics when the
  node was planned against a parameter (a generic plan is estimated without
  the values), and `PLANNING_TIME` tells "send it as a prepared statement"
  apart from "it already is one, so look elsewhere".
- **who wrote the cast** — a cast the planner injected while matching operator
  types is dropped from index candidates (`btree (status)` instead of
  `btree (((status)::text))`), while a cast written in the query raises
  `SQL_CAST`: no plain index on that column can serve the predicate. Without
  the query text the two are indistinguishable, so nothing is assumed.
- **shapes the plan erases** — `NOT IN (SELECT …)` is visible in the text but
  not in the tree, which is what `SQL_NOTIN` reports.

`plan.parameters` separates external `$N` from InitPlan/SubPlan outputs and is
available with or without the query text.

## Build & test

```bash
npm test                 # node:test suite (invariants, goldens, advisor, DDL, parity)
tools/browser-smoke.py   # headless-browser regression: tabs/themes sweep + XSS fixture
python3 build.py         # -> dist/ and ./pg-explain-viewer.html (self-contained)
```

## Embedding into pg_diag (outline)

- inline both CSS files and the three JS modules
  (`pgplan-expr.js`, `pgplan-sql.js`, `pgplan.js`, `pgplan-render.js`) into
  `render/templates/report.html` — highlight.js is already vendored there,
  the widget picks up `window.hljs` automatically;
- map the theme by overriding `--pv-*` with the report's own tokens
  (`--pv-bg: var(--panel)` etc.); switch dark via `html[data-theme]` →
  `data-pv-theme`;
- render in place: `PgPlanRender.render(container, PgPlan.parse(text))`.

## Where the test plans come from

Harvested from the pg_stand demo stand csvlog (`/pglog/*.csv`):
auto_explain ships in the stand's `shared_preload_libraries`; for the
harvest `auto_explain.sample_rate=1`, `log_min_duration=0`,
`log_timing=on` were set temporarily and reverted with
`ALTER SYSTEM RESET` afterwards.

## Limits, performance, fidelity

- Input is capped at **8 MB** (UTF-8 bytes), a separately supplied SQL
  text at 1 MB, plans at 50 000 nodes; errors are explicit. Parse time
  is near-linear in input size (CI enforces budgets on 2000-node-deep
  and 10 000-partition plans).
- JSON/YAML go through the canonical-text pipeline; structured fields
  with no text representation yet (e.g. `Grouping Sets` internals) are
  reported via the `unsupported_field` diagnostic instead of being
  dropped silently. Format-parity tests over the PostgreSQL 10…18 matrix
  assert that TEXT/JSON/YAML of the same EXPLAIN normalize to the same
  tree, estimates and conditions.
- Everything heuristic (parallel wall-clock attribution, CTE/SubPlan
  charging, clamping) surfaces in `plan.diagnostics[]` — see
  [docs/how-it-works.md](docs/how-it-works.md).

## Export

The viewer page can save a self-contained copy of itself: **Export**, at the
end of the tab bar. Only the plan text, the query and the chosen theme travel
with it — every tab is recomputed on open by the same code already inlined in
the file, so the copy is a frozen snapshot of both the input and the analysis,
not a screenshot of the tabs.

The copy opens read-only: no Export button of its own, the input fields are
not editable and the buttons are disabled. **It carries the plan and query you
pasted**, filter literals included — treat it as the data it contains.

Export needs a built page (`python3 build.py`); a page that links its styles
and scripts has no way to put them into the copy, and the button says so.

## Browser support

Evergreen Chrome/Firefox/Edge and Safari ≥ 14 (the code avoids regex
lookbehind and uses nothing newer than ES2019 + CSS `:where()`). CI runs
the headless regression on all three engines — Chromium, Firefox and
WebKit (`tools/browser-smoke.py`, `PW_BROWSER=`). The offline viewer
works from `file://` without network access. Tabs and controls are
keyboard-operable (ARIA tablist, arrow keys, visible focus).

## License

MIT — see [LICENSE](LICENSE). The vendored highlight.js is BSD 3-Clause —
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Changes are tracked in [CHANGELOG.md](CHANGELOG.md); contributions are
welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
