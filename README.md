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
| `src/pgplan-render.js` | Renderer (`window.PgPlanRender`). Static styling via `pv-*` classes only; data-driven heat colors are computed at render time with hues taken from CSS theme variables. |
| `vendor/highlight-11.11.1.min.js` | highlight.js — the same library and version the pg_diag report vendors. Optional peer for SQL highlighting (query pane, CREATE INDEX blocks): the renderer uses `window.hljs` when present, otherwise falls back to plain text. Token colors are themed via `--pv-hl-*`. |
| `css/pgplan-theme.css` | **Theme**: every color and font as `--pv-*` custom properties on the `.pv` container. Palette, fonts and sizing follow the **pg_diag report theme** (purple/gold surfaces, system-ui + ui-monospace). Typography is a unified three-step scale reused everywhere: `--pv-fs-lg` 15.5px (headings), `--pv-fs` 14px (base), `--pv-fs-sm` 13px (secondary) — no other text sizes exist in the widget. Built-in light (default for the bare container) and dark (`data-pv-theme="dark"` on the container or any ancestor — pg_diag's default scheme) variants. A host application re-skins the widget by overriding the variables. |
| `css/pgplan.css` | Structural styles; contains no literal colors or fonts. |
| `viewer.html` | Dev page (links the files directly). |
| `build.py` | Builds the self-contained `dist/pg-explain-viewer.html` (inlines CSS + JS + sample plans; works offline from `file://`). |
| `test/plans/` | Real PG18 plans harvested from the pg_stand demo stand csvlog (auto_explain: text/json/yaml, DML, parallel, CTE, InitPlan/SubPlan, partitions, external sort + temp I/O) plus `EXPLAIN`-without-ANALYZE and psql-framed fixtures. |
| `test/*.test.js` | `node:test` suite: `npm test` (parser invariants, golden-model snapshots, advisor spot checks, format-parity for the PG matrix). `UPDATE_GOLDEN=1 npm test` regenerates the snapshots in `test/golden/`. |

## Using the widget

```html
<link rel="stylesheet" href="pgplan-theme.css">
<link rel="stylesheet" href="pgplan.css">
<script src="highlight-11.11.1.min.js"></script> <!-- optional: SQL highlighting -->
<script src="pgplan-expr.js"></script>           <!-- optional: relations + index DDL -->
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

`render()` builds a self-contained widget: summary chips (+ advice badges)
and internal tabs — **plan** (table), **recommendations**, **stats**,
**diagram**, **relations**, **text**, **model**, **query**. Tabs without
data are hidden automatically. All cross-links work inside the widget:
advice badges, column headers (jump to the hottest node), stats node
lists, diagram nodes and relation cards navigate to the plan row with a
pulse highlight.

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

- identity: `type/xtype`, `relation`, `index`, `alias`, `spec`
  (`CTE|InitPlan|SubPlan` section headers), `parent/children/depth`;
- planner: `costStartup/costTotal/planRows/planWidth`, `costExcl`;
- actuals: `timeStartup/timeTotal/rows/loops`, `never`;
- derived: `timeIncl` (parallel-aware: loops are divided by workers+1
  under a Gather), `timeExcl` (inclusive minus charged children, clamped
  at 0, `exclClamped` marks overlap), `bufExcl`, `ioReadExcl/ioWriteExcl`,
  `rowsTotal`, `rowsRemovedTotal`, `ratio/ratioDir` (estimate vs actual);
- `advice`: recommendation entries that involve this node.

CTE / InitPlan / SubPlan sections are **charged** (`chargedTo`) to the node
that actually executes them: a CTE to its first executed `CTE Scan`,
an Init/SubPlan to the node whose conditions reference `$N` /
`(InitPlan N)` / `(SubPlan N)`. Exclusive metrics are subtracted there, so
the sum of self times matches the root inclusive time.

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
an explicit side-effect warning for DML statements.

For the index-related codes (`SEQ_RRBF`, `IDX_RRBF`, `BMP_AND`,
`LIM_SORT`, `HSH_ROWS`, `ANJ_ROWS`) the adviser also generates
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
| `SEQ_RRBF` / `IDX_RRBF` | scan discards most rows by filter — missing/inefficient index |
| `HSH_ROWS` / `ANJ_ROWS` | full read joined down to a few rows — a join-key index may help |
| `LIM_SORT` / `LIM_OFFS` | LIMIT reads far more than it returns — index on sort keys / keyset pagination |
| `CLN_SORT` / `CLN_GROUP` / `CLN_COPY` | redundant sort / regrouping / duplicated subtree |
| `DSK_SORT` / `DSK_HASH` / `ANY_TEMP` / `BMP_LOSSY` | working set spilled past work_mem — scoped SET LOCAL experiment |
| `SEQ_BUFF` / `IDX_BUFF` | many buffers per row (per loop) — possible bloat, verify before VACUUM FULL |
| `NLJ_RRJF` | nested-loop join filter discards almost all pairings — index the join key |
| `DSK_READ` | node time dominated by measured disk reads — cold cache / slow storage |
| `TBL_WRTN` | buffers written during a read |
| `ROW_RATIO` | estimate far off actual — ANALYZE, then extended statistics |
| `BMP_AND` / `BMP_OR` | composite index / UNION instead of bitmap combination |
| `CTE_ROWS` | CTE re-scanned many times over a large row set |
| `GTH_WRKS` | fewer parallel workers launched than planned |
| `ANY_SLOW` | node time unexplained by buffers and measured I/O — CPU/locks/host, plan cannot tell |
| `EXT_EXECTIME` / `EXT_PLANTIME` | time outside the plan / planning dominates |

Severity classes (`crit/warn/io/mem/idx/info/hint`) map to theme tokens
`--pv-sev-*`.

## Build & test

```bash
npm test                 # node:test suite (invariants, goldens, advisor, DDL, parity)
tools/browser-smoke.py   # headless-browser regression: tabs/themes sweep + XSS fixture
python3 build.py         # -> dist/pg-explain-viewer.html (self-contained)
```

## Embedding into pg_diag (outline)

- inline both CSS files and the three JS modules
  (`pgplan-expr.js`, `pgplan.js`, `pgplan-render.js`) into
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
  dropped silently. Format-parity tests over the PostgreSQL 12…18 matrix
  assert that TEXT/JSON/YAML of the same EXPLAIN normalize to the same
  tree, estimates and conditions.
- Everything heuristic (parallel wall-clock attribution, CTE/SubPlan
  charging, clamping) surfaces in `plan.diagnostics[]` — see
  [docs/how-it-works.md](docs/how-it-works.md).

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
