# pg-explain-viewer — assessment & roadmap

Status: v0.4.1, pre-publication (git init/push pending the owner). Target: a self-contained, embeddable
PostgreSQL plan visualizer for DBAs and developers worldwide, published on
GitHub under MIT.

This document is an honest assessment of where the tool stands and a
prioritized plan. Priorities: **P0** — must be done before the first public
release; **P1** — high value, first releases after; **P2** — later.
Effort: S (hours), M (days), L (a week+).

---

## Product goal

The module has one job: **show a PostgreSQL query plan accurately and
clearly, highlight the material bottlenecks, and provide actionable
recommendations for query optimization and missing indexes.**

The primary user flow is:

1. paste a plan in a supported PostgreSQL format;
2. immediately see where execution time, I/O, rows, memory, or bad
   estimates are concentrated;
3. understand why each highlighted node is a bottleneck;
4. get a concrete next step: inspect/rewrite a query fragment, collect
   missing evidence, or evaluate a safely generated index candidate;
5. jump between the recommendation, its evidence, and the relevant plan
   nodes without losing tree context.

Success means that a DBA or developer can find the dominant problem in a
non-trivial plan within a minute. Every recommendation must show its
evidence, expected relevance, limitations, and affected nodes. Tiny or
weakly supported observations must not distract from material bottlenecks.

Feature rule: if a proposed capability does not materially improve plan
comprehension, bottleneck detection, query-optimization advice, or missing-
index advice, it is outside this roadmap.

**Scope guard**: this is a visualization *module*, not a platform. No
integrations, no plugin systems, no configuration surface beyond one small
options object, no premature abstraction layers. When in doubt, ship the
simpler thing and lean on the code that already works.

---

## 1. Where we are

Strong points worth keeping and building on:

- zero-dependency, fully static, embeddable widget + single-file offline
  build — a real differentiator vs. server-based tools;
- a shared normalized model and analyzer for text / JSON / YAML /
  auto_explain / psql / csvlog / running-query snapshots;
- an exclusive-metrics attribution model that charges CTE / InitPlan /
  SubPlan sections to the node that appears to execute them;
- recommendations with candidate `CREATE INDEX` DDL, not just warnings;
- themable to the host page via CSS tokens only.

Weak points, honestly (updated 2026-09-01; the original first-assessment
list — permissive input, structured-input loss, unsafe DDL, advisor
overconfidence, missing lifecycle/infra — is resolved in v0.3.3–v0.4.1):

- **not yet a git repository** — LICENSE/CI/release files exist on disk,
  but git init/commit/push to `O2eg/pg_explain_viewer` awaits the owner;
  until then tags, provenance of the sources and release reproducibility
  cannot be verified externally;
- **large plans are unusable in the UI** — no search, subtree folding,
  focus mode, or hotspots view; a 500-node partitioned plan is a wall of
  rows and an enormous SVG (parse/analyze is fast now — this is renderer
  UX, Batch 5);
- **advisor precision corpus is incomplete** — actionable rules carry the
  full 4-case matrix, observational rules only positive/negative pairs;
  intentional counterexamples still need to be grown (§3.2);
- **standalone pane renders have a weaker lifecycle** — their cleanups
  register on the container and need `PgPlanRender.destroy(container)`
  (or a later full `render()` into it), unlike the widget's `destroy()`;
- **model/domain pane value is unproven** — it may duplicate the tree
  and relations views; decision deferred to user feedback (§4).

---

## 2. P0 — publication blockers

### 2.1 Input contract, normalized model & parser robustness (L)

The most important property of a public plan tool is to reject non-plans,
never silently invent structure, preserve the source data, and expose any
uncertainty.

- [x] **Strict mode by default**: require credible PostgreSQL plan-node
      syntax/structure; reject arbitrary text such as `garbage` instead
      of producing a fake root node. *(v0.3.3)*
- [x] **Tolerant mode**: recover a recognizable plan while collecting
      structured `plan.diagnostics[]` entries. Each diagnostic has a
      stable code, severity, message and sample fragments / node ids.
      Implemented codes: `unknown_line`, `truncated_input`,
      `unsupported_field`, `metric_clamped`, `partial_worker_stats`,
      `charge_inferred`, `charge_fallback`, `parallel_estimate`. *(v0.3.4)*
- [ ] **Structured-input fidelity**: first fix the known field losses in
      the existing JSON/YAML→text emitters (cheap, keeps one pipeline).
      Native structured adapters are built **only if** golden parity tests
      still show material loss afterwards — not for architectural purity.
- [ ] **Clear model contract**: keep source values separate from derived
      values and attach confidence to heuristic metrics. Document the
      fields consumed by the renderer.
- [ ] **Top-level metadata**: retain Query Identifier, Settings, Planning
      buffers/I/O/memory, JIT, Triggers, Serialization, execution/planning
      times and input format. Store WAL and
      node memory/disk/index-search fields structurally, not only as
      display lines.
- [x] **PostgreSQL 10…18 format matrix**: committed TEXT/JSON/YAML
      triples for 28 query shapes, version-gated per major (486 files /
      162 triples,
      `test/plans/matrix/`, regenerated by `tools/gen-fixtures.sh`);
      `test/parity.test.js` asserts normalized parity of tree structure,
      planner estimates and the deterministic semantics (sort/group keys,
      filter conditions) (structure-only for executed DML shapes —
      three separate executions shift physical size and thus estimates).
      Covers partitioned (120 children), parallel/per-worker blocks, JIT,
      triggers, FDW, Incremental Sort, Memoize, TidRange, MERGE,
      SERIALIZE, VERBOSE, GEQO, Planning Buffers/Memory, disabled nodes,
      fractional row counts, PG18 Index Searches, CTE/WindowAgg spills,
      bitmap scans. *(v0.3.4)*
- [x] **Golden-model tests**: snapshot normalized model JSON per fixture;
      any parser/analyzer change shows an explicit diff. Move tests to
      `node:test`. *(v0.3.4: `test/golden/`, `UPDATE_GOLDEN=1 npm test`)*
- **Out of scope (owner decision 2026-08-31)**: log-wrapper adaptation
      (per-line `log_line_prefix`, jsonlog, multi-plan log pastes). The
      input contract is a plan (text/JSON/YAML) plus an optional SQL
      query; the existing auto_explain/psql/CSV preclean stays as-is.
- [x] **Partial/truncated plans**: preserve recognized nodes, flag
      missing parents/tails (`plan.truncated`), and disable advice that
      requires a complete tree. *(v0.3.4)*
- [x] **Plan-arithmetic diagnostics**: report clamping, inferred
      CTE/SubPlan charging, and parallel approximation via
      `plan.diagnostics[]` and the summary chip. *(v0.3.4)*
- [x] **Per-worker stats**: every `Worker N` block is parsed into
      `node.workers[]` (buffers no longer double-count into the node);
      `workerSkew` is computed and the loops/(workers+1) attribution is
      validated against per-worker times (warn diagnostic on mismatch).
      *(v0.3.4)*
- [x] **Resource limits**: input and separate SQL text bounded by UTF-8
      byte size (8 MB / 1 MB), node count capped (50k); parse time is
      near-linear with CI perf budgets (`test/perf.test.js`). *(v0.4.0)*
- [ ] **Explicit XML decision**: PostgreSQL and auto_explain support XML,
      but it stays unsupported until there are fixtures and user demand;
      document this rather than accepting it partially.

### 2.2 Security, untrusted input & safe generated output (M)

Plan text and structured fields are untrusted input. "The viewer does not
execute SQL" is not sufficient when it produces copyable SQL.

- [x] XSS audit + browser regression fixture (`test/hostile/xss-plan.txt`
      + `tools/browser-smoke.py`): hostile relation/alias/index names,
      conditions, diagnostics samples and stray lines render as text and
      execute nothing; tooltips use textContent, DDL goes through
      highlight.js escaping. *(v0.3.5)*
- [x] **SQL identifier round-trip**: `quoteIdent()` escapes embedded
      quotes, force-quotes non-simple names and quotes reserved words;
      `splitRelRef()` parses printed references (quotes intact, dots
      inside quotes belong to the name — `node.relationRef` preserves the
      original spelling); heads like `public."Mixed Case"` and
      `"we""ird"` parse; the JSON/YAML emitter doubles embedded quotes.
      *(v0.4.0)*
- [x] **DDL safety contract**: every plan-derived fragment must pass
      `isSafeFragment()` (full tokenizer consumption, no comment markers,
      no stray bytes, length cap) before appearing in copyable SQL;
      `confidence: exact|partial|unsafe`; unsafe → `def: null`, no copy
      button, descriptive candidate only. *(v0.3.5)*
- [x] DDL regression suite (`test/ddl.test.js`): schema-qualified and
      quoted names, aliases, expression indexes, casts, pattern ops,
      ORDER BY tails, gin, injection/comment-marker/oversize inputs.
      Found and fixed: AND-parts of a single Filter were never analyzed
      (paren stripping per segment), quote undoubling, dotted quoted
      names mis-split in DDL. *(v0.3.5)*
- [x] Clipboard paths use plain text only, handle denied/unavailable
      clipboard access visibly, and never report "copied" before the
      promise succeeds. *(v0.3.3)*
### 2.3 Advisor safety baseline (M)

Before publication, every recommendation must distinguish observed facts
from hypotheses and avoid presenting a high-impact DBA action as certain
when a plan cannot prove it.

- [x] Advice schema v2, flat and small: `obs` (facts) / `hyp` (hedged) /
      `next` (safe step) / per-node `ext` evidence / `impact` /
      `idxs[].confidence`. No nested ontology. *(v0.3.5)*
- [x] **Impact gating**: share of plan time attributable to the flagged
      nodes (pct) combined with an absolute floor (<1 ms); tiny findings
      are demoted to a collapsed "minor observations" section and hidden
      from summary badges; advice sorted by impact. *(v0.3.5)*
- [x] Audit high-risk wording: bloat, stale statistics, missing FK index
      and overload/locks are now explicitly hypotheses with verification
      steps; provable findings (redundant sort/group) stay assertive.
      *(v0.3.5)*
- [x] Spill guidance reports the observed spill volume and recommends a
      scoped `SET LOCAL work_mem` experiment with a concurrency warning.
      *(v0.3.5)*
- [x] `CREATE INDEX` output is always a candidate — a fixed note under
      every DDL block says the plan does not show existing indexes, write
      costs, or the workload. *(v0.3.5)*
- [x] **Safe EXPLAIN coaching** (`plan.coaching`): ANALYZE+BUFFERS for
      cost-only plans (with an explicit side-effect warning for DML),
      TIMING/BUFFERS when specifically missing; nothing for in-progress
      or truncated inputs. *(v0.3.5)*
- [x] Rule tests (`test/advice.test.js`): full 4-case matrix
      (positive/negative/low-impact/missing-evidence) for the actionable
      rules, positive+negative pairs for the observational rest; found
      and fixed: `Hash Anti Join` was classified as HSH_ROWS, never
      ANJ_ROWS. *(v0.3.5)*

### 2.4 Project & module infrastructure (M)

- [ ] git init, sensible history from here on; `LICENSE` (MIT),
      `THIRD_PARTY_NOTICES` (highlight.js BSD-3), `CHANGELOG.md`, and
      `CONTRIBUTING.md`.
- [ ] CI: node tests, format-parity/golden tests, build reproducibility,
      malicious-input suite, and headless browser smoke on every PR.
- [ ] Release workflow: build and attach the single-file viewer to GitHub
      Releases. Distribution stays limited to source files + CSS and the
      offline viewer.
- [ ] **Renderer lifecycle**: `render()` returns
      `{setTab, goToNode, destroy}`; clean up document listeners,
      `ResizeObserver`, timers, and detached panes. Multiple widgets must
      not create duplicate global DOM IDs or affect one another.
- [ ] **Baseline accessibility before release**: real buttons for tabs and
      toggles, keyboard operation, visible focus, ARIA tab semantics, and
      non-color values for material states. Advanced navigation and
      color-blind palette work can remain P2.
- [ ] Browser floor: remove the avoidable regex lookbehind, state the
      supported browsers in the README. One paragraph, not a contract
      document.
- [ ] README: screenshots, quick start, embedding/lifecycle guide,
      security notes, model contract, and a transparent
      "how self time / confidence works" page.

## 3. P1 — make it genuinely good for daily work

### 3.1 Large-plan ergonomics & performance (L)

- [ ] **Bottleneck summary on the default view**: show the dominant node
      or path, its share of time/I/O, the primary evidence, and a direct
      link to the highest-impact recommendation. Do not make users inspect
      every pane before learning what matters.
- [ ] **Subtree folding**: collapse/expand a node's descendants; aggregate
      repeated partition branches (`Append` with >20 equivalent scans ->
      "18 more partitions…"). Apply the same aggregation to the table,
      diagram, relations pane, and search.
- [ ] **Node Hotspots view**: a flat, sortable list of top self time, I/O,
      rows removed, estimate errors, spills, and loops, with links back to
      tree context. Keep the main plan table in tree order rather than
      making a metric sort destroy the hierarchy.
- [ ] **Search/filter** (`/` hotkey): node type, relation, index, condition,
      diagnostics, and advice; highlight matches and preserve ancestor
      context.
- [ ] **Focus mode**: highlight the selected node, ancestor path, and
      descendants; dim the unrelated plan.
- [ ] `% of total` as a real column, with clear distinction between
      elapsed attribution and worker work.
- [ ] Performance fixture: one wide (1000+ nodes, many partitions) and
      one deep plan; simple parse/render budget assertions in CI. No
      percentile tracking infrastructure.
- [ ] Prefer branch aggregation, lazy pane rendering, and CSS containment
      before row virtualization; virtualization must not break search,
      keyboard access, or printing.

### 3.2 Advisor usefulness & transparency (M)

- [ ] Rank advice by evidence-backed impact, not only severity; provide a
      concise headline describing the dominant measured bottleneck.
- [ ] Separate recommendation types in the UI: query rewrite, candidate
      index, statistics/instrumentation, memory/spill, and maintenance.
      Keep the evidence and affected nodes visible for every type.
- [ ] Index candidates explain column order, predicate, supported
      conditions, and why the current plan indicates the index may help;
      never imply that plan-only evidence proves the index is globally
      beneficial.
- [ ] Query recommendations point to the exact plan symptom they address:
      excessive filtering, repeated loops, spill, redundant sort/group,
      LIMIT/OFFSET over-read, CTE re-scan, or join fan-out.
- [ ] Show missing instrumentation separately from tuning advice:
      ANALYZE, BUFFERS, TIMING, SETTINGS, WAL, MEMORY, or SERIALIZE only
      when each option would answer a specific open question.
- [ ] Provide per-rule "why it fired", thresholds, evidence values, data
      limitations, and a link to the relevant plan nodes.
- [ ] One small options object (`minImpactPct`, `disabledRules`) —
      nothing more configurable than that.
- [ ] Maintain an advisor precision corpus containing intentional
      counterexamples, not only examples where each rule fires.

### 3.3 Metrics, phases & PostgreSQL metadata (M)

- [ ] Replace the ambiguous time equation with:
      `observed latency ~= planning + execution`; break execution into
      executor tree, triggers, JIT, serialization, and unaccounted
      overhead without double-counting.
- [ ] Show parallel wall-clock attribution and summed worker work as
      different metrics; mark inferred values and skew explicitly.
- [ ] Buffers remain canonical in blocks. Byte display uses a configurable
      `blockSize` and labels the default as "assuming 8 KiB"; never imply
      that all PostgreSQL builds use 8192-byte blocks.
- [ ] Structured views for Settings, planning resources, WAL, memory/disk,
      Index Searches, workers, JIT, triggers, and Serialization.
- [ ] Make arithmetic/coverage diagnostics visible in a plan-level chip
      and beside affected metrics.

---

## 4. P2 — visualization polish

- [ ] Advanced accessibility: j/k/e// navigation, tested screen-reader
      flow, color-blind-safe palettes, reduced-motion support, and print
      accessibility.
- [ ] `prefers-color-scheme` auto theme (host override still wins).
- [ ] Buffers display toggle: blocks <-> bytes and inclusive <-> exclusive,
      respecting configured block size and metric confidence.
- [ ] Relations pane: subquery containers only if user demand shows up.
- [ ] Reconsider the **model/domain pane** after user feedback;
      remove it if it duplicates the tree and relations views.
- [ ] Internal debts: unify numeric formatting, remove the `\x01`
      intermediate in `groupDigits`, split the parser/analyzer/advisor into
      testable modules without changing the public model gratuitously.

---

## 5. Explicit non-goals

To stay a sharp tool rather than a platform:

- no server, accounts, plan history, direct database connections, or
  collection of telemetry;
- no sharing subsystem, URL payloads, standalone snapshot generation,
  Markdown export, or other collaboration/integration features;
- no multi-plan workspace or A/B diff until the single-plan visualizer is
  complete and real users demonstrate the need;
- no query editing/formatting features beyond display;
- no attempts to predict a new planner plan or claim that a heuristic
  recommendation is guaranteed — visualize what EXPLAIN reported and
  label hypotheses as hypotheses;
- no automatic execution of SQL, EXPLAIN, DDL, VACUUM, or configuration
  changes;
- no kitchen-sink dialect support (Greenplum/Redshift/Citus text quirks)
  unless contributed with fixtures;
- no XML support until a real use case and a maintained fixture corpus
  justify another input adapter.

## 6. Execution plan — prioritized batches

Ordering principle: **every batch builds on code that already exists**
(parser pipeline, analyzer, widget, fixtures, headless-test harness) and
creates the safety net the next batch needs. Big refactors (native
structured adapters) come only *after* the golden corpus exists to prove
them — never before.

### Batch 0 — quick wins & bugs found in review (S, immediate) — ✅ done, v0.3.3

Concrete defects in the current code; each is hours of work on existing
functions:

1. **Strict-mode gate**: `parseText` accepts any non-empty text as a
   one-node plan. Validate the root line (known node type, or
   cost/actual clause present) and throw otherwise; `{tolerant: true}`
   opts in to recovery. *(touch: `parseText`, `parse`)*
2. **Clipboard truthfulness**: the copy button reports "copied" before
   `navigator.clipboard.writeText` resolves and hides denial. Await the
   promise; show failure. *(touch: `renderAdvice` copy handler)*
3. **DDL identifier safety**: `suggestIndexes` unquotes names and
   interpolates them raw. Introduce one tested `quoteIdent()` (escape
   embedded quotes, force-quote non-simple identifiers) used for every
   relation/index/column emitted. *(touch: `pgplan-expr.js`)*
4. **Input size limit** before preclean/copies. *(touch: `parse`)*
5. **Root metadata retention**: keep `Query Identifier`, `Serialization`
   and other unrecognized root-level `Key: value` lines as ext entries in
   text mode and in the JSON generic emitter. *(touch: `EXT_HEADS`
   fallback, `jsonToText`)*
6. **Drop the lookbehind regex** in `markupNumbers` (widens the browser
   floor below Safari 16.4); replace with a capture-group rewrite.
   *(touch: `pgplan-render.js`)*

### Batch 1 — trust foundation: corpus, golden tests, diagnostics (M–L) — ✅ done, v0.3.4

The safety net everything else depends on. High leverage: the Docker
throwaway-cluster recipe and headless harness already exist from earlier
work.

- [x] migrate tests to `node:test`; golden-model snapshots for the existing
  17 fixtures (§2.1 golden tests);
- [x] fixture **generator script** (`tools/gen-fixtures.sh`, Docker matrix
  PG 10…18) producing committed TEXT/JSON/YAML triples for the §2.1 shape
  list; format-parity assertions run through the *current* pipeline
  (`test/parity.test.js`);
- [x] `plan.diagnostics[]` with stable codes; wired the spots that already
  detected problems silently (`exclClamped`, unknown lines, charging
  fallbacks, parallel approximation) + renderer chip (§2.1, §3.3 chip);
- [x] truncated-plan recovery (tail cut / arrow root) with advice disabled;
  *(log_line_prefix adaptation dropped — out of scope, see §2.1)*;
- [x] per-worker `Worker N:` blocks parsed structurally (fixes worker
  buffers double-counting); loops/(workers+1) attribution validated
  against per-worker times (§2.1).

### Batch 2 — safe outputs: advisor & DDL contracts (M) — ✅ done, v0.3.5

Builds directly on the existing rule engine and `suggestIndexes`; no
rewrites, re-shaping.

- [x] advice schema v2 (`obs / hyp / next / ext / impact / idxs`) —
  existing rules mapped onto it, cards renderer adapted (§2.3);
- [x] **impact gating** on the existing `timeExcl`/totals data + collapsed
  "minor" section, advice sorted by impact (§2.3);
- [x] wording audit of the high-risk rules; spill guidance via
  `SET LOCAL` experiment phrasing; safe EXPLAIN coaching
  (`plan.coaching` + pane block) (§2.3);
- [x] DDL `confidence: exact|partial|unsafe` via `isSafeFragment()`;
  unsafe → no DDL, no copy button (§2.2); DDL regression fixtures
  (`test/ddl.test.js`);
- [x] hostile-input XSS fixture (`test/hostile/xss-plan.txt`) + headless
  assertions (`tools/browser-smoke.py`) (§2.2);
- [x] rule tests: full 4-case matrix for the actionable rules
  (SEQ_RRBF, IDX_RRBF, HSH_ROWS, ANJ_ROWS, LIM_SORT, BMP_AND, DSK_*,
  ANY_TEMP); positive+negative pairs for the observational rest
  (`test/advice.test.js`).

### Batch 3 — publication infrastructure → **v0.4 public preview** (M) — code/docs done, v0.4.0; git init/push pending owner

- git init, `LICENSE` + `THIRD_PARTY_NOTICES`, `CHANGELOG`,
  `CONTRIBUTING`; CI (node tests, golden diffs, malicious-input suite,
  build, headless smoke); release workflow attaching the offline viewer;
  GitHub Pages demo = the viewer itself (§2.4);
- renderer lifecycle: `destroy()`, listener/observer cleanup,
  instance-scoped ids (§2.4) — the listener inventory is small and known;
- baseline accessibility: real buttons, keyboard, focus, ARIA tabs
  (§2.4);
- README + "how self time works" / model contract docs (§2.4).

### Batch 4 — stable core → **v0.5** (M)

- structured metadata surfaced where it already exists in the model:
  Settings, WAL, memory/disk, JIT, triggers, Serialization (§3.3);
- worker metrics: wall-clock vs summed worker work, skew flag (§3.3);
- honest time breakdown chips `latency ≈ planning + execution(...)`
  (§3.3);
- **conditional**: native JSON/YAML adapters — only if the golden parity
  corpus from Batch 1 shows the text pipeline materially loses data;
  otherwise this item is closed as "not needed" (§2.1).

### Batch 5 — daily-use UI → **v0.6** (L)

All items reuse the existing table/stats renderers rather than new
components:

- bottleneck summary headline on the default view (§3.1) — computed from
  existing `max`/`advice` data;
- subtree folding + repeated-partition aggregation (table, diagram,
  relations, search consistently) (§3.1);
- **Hotspots view = generalization of the existing stats pane** (flat
  sortable per-node list, same `metricCell` machinery) (§3.1);
- search/filter with ancestor context; focus mode (§3.1);
- `%` column with elapsed-vs-worker distinction (§3.1);
- performance corpus + budgets (parse/analyze/render measured in CI);
  branch aggregation and CSS containment before any virtualization
  (§3.1).

### Batch 6 — advisor UX & polish → **v0.7** (M)

- impact ranking, per-rule "why it fired" transparency, the small
  advisor options object (§3.2);
- recommendation-type separation in the UI (§3.2);
- advanced accessibility, `prefers-color-scheme`, buffers toggles with
  `blockSize` (§3.3, §4);
- model/domain pane decision by feedback; internal debts (§4).

### Deliberately re-sequenced vs. a naive reading

- **Native structured adapters wait for Batch 4**: replacing the working
  JSON→text→parse path before golden tests exist would risk regressions
  for a purity win; specific field losses are fixed cheaply in Batch 0.5.
- **Hotspots before virtualization**: aggregation + a flat top-N view
  solve 95% of the 1000-node pain using existing renderers;
  virtualization only if budgets still fail.
- **Full 4-case rule-test matrix is staged**: actionable (DDL-emitting)
  rules first — they carry the risk; observational rules follow.

## 7. Definition of done for the first public preview

- arbitrary text is rejected in strict mode; tolerant recovery always
  emits visible diagnostics;
- equivalent TEXT/JSON/YAML fixtures yield the same normalized tree and
  core metrics for every supported PostgreSQL major version;
- unknown structured fields survive in `rawProperties` and do not crash
  parsing/rendering;
- no generated SQL is copyable unless all identifiers and expressions
  pass the safe-output contract;
- malicious input executes no HTML/JS in the viewer, advice, diagram, or
  clipboard paths;
- every advisor rule has positive, negative, low-impact, and incomplete-
  evidence tests;
- arithmetic approximation/clamping and incomplete plan coverage are
  visible to the user;
- a 1000-node fixture stays within documented parse/render budgets and
  remains searchable and navigable;
- the release artifact is reproducible, offline, makes no network
  requests, and carries the required third-party notices.
