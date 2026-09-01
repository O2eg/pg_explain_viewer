# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/), versioning is
semver-ish (0.x — public preview line). History before git starts here
was tracked manually.

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
