# Charts pane — trustworthy visual summaries

A compact set of charts answering questions the other panes make you compute
by hand: *how is EXPLAIN-reported time divided?*, *which operations dominate
it?*, *where are rows discarded?*, and *what resource traffic did PostgreSQL
report?*

Status: planned. Nothing below is implemented yet.

## 1. What a chart is allowed to show

A pie/donut is honest only when its parts are disjoint and add up to a whole
that means something. A ranked bar chart is the better shape when values
overlap, are cumulative, or answer a ranking question. The pane must choose
the visual from the metric contract rather than force every metric into a
donut.

Rules:

- composition -> donut or 100% stacked bar, but only with a real denominator;
- ranking/comparison -> horizontal bars with absolute values;
- per-node kept/removed -> one stacked bar per node, never one global pie;
- inferred or incomplete values carry an `approximate` label beside the
  number, not only in a remote tooltip;
- **a chart that cannot be trusted is not drawn** — the card says which input
  or model limitation blocks it and links to Diagnostics.

This is the same fail-closed line the SQL pairing gate and the truncated-plan
advisor already hold.

Coverage figures below are planning hints, not acceptance criteria. They are
produced by `tools/chart-coverage.js`, which states the counting rule for
every chart in code; §12 records the corpus, the date and the command. Run it
against your own plans before trusting any figure here — one number in the
first draft of this document (I/O timing) was off by more than a factor of
two until it was measured that way.

### 1.1 Reported time composition — *the top plan node is not always the whole execution*

| slice | source |
| --- | --- |
| planning | `plan.planningTime` |
| top-node execution time | `plan.totals.time` (root inclusive time) |
| execution outside top-node timing | `executionTime - totals.time` |

Whole: `planningTime + executionTime`. Centre: that total, labeled **reported
planning + execution**, not application latency. PostgreSQL planning time does
not include parsing/rewriting; execution time does not include network
transfer, and output conversion is measured only with `SERIALIZE`.

This is the strongest decomposition the current input proves. JIT, trigger and
serialization times are **annotations**, not extra slices:

- the plan does not establish that `jit.total` is disjoint from the root
  node's elapsed timing — and on every JIT plan in the corpus the
  out-of-tree residual is *smaller* than `jit.total` (137 ms of residual
  against 19 767 ms of JIT on the extreme one), so the compilation time is
  demonstrably counted inside the root node's elapsed time, not outside it;
- PostgreSQL includes `BEFORE` trigger time in the related DML node and also
  prints total trigger time separately, so summing `plan.triggers[].time` with
  the tree can double-count it;
- serialization is included in `Execution Time` when requested but is not yet
  a structured duration in this model.

The previous proposal subtracted JIT from the tree and also left it inside the
execution residual. Treating every printed sub-timing as an independent phase
would repeat the same error for triggers.

The three-slice decomposition is drawn only when `planningTime`,
`executionTime` and the root time are present and the execution residual is
non-negative within a small rounding tolerance. If root time exceeds
`executionTime`, fall back to the honest two-slice `planning / execution`
chart and show root/JIT/triggers as annotations. Do not clamp a negative
residual to zero and call the result exact.

Available for **80%** of the corpus (see §12); 4% carry JIT — and in one case
JIT is 98.9% of execution. This is the chart that pays for the pane:
`PLANNING_TIME` and `OUTSIDE_PLAN` become visible before anyone reads a card,
and `JIT_TIME` is stated beside it as an annotation with its own caveat —
the composition does not claim JIT as a separate phase.

Gate: full composition needs all three totals above. `totals_missing` already
names the common failure; a truncated/headless plan also blocks the chart
because its visible root may not be the real root.

### 1.2 Execution hotspots — *which operation is expensive*

Horizontal bars from `plan.stats[]` (`nodeType`, `relation`, `time`, `ids`).
Default grouping is by `nodeType`; a toggle groups by relation. Spec nodes are
already excluded from stats.

Relation grouping must keep an explicit **operators / no relation** bucket.
Sort, Aggregate, Hash and join self time cannot honestly be assigned to the
relation below them. The title is therefore “self time by relation label”,
not “which relation ate the execution time”.

Available for **93%** of corpus plans (§12).

Quality rules, already diagnosed by the model:

- `plan.truncated` (3%) — self times of nodes whose children are missing
  include the whole missing subtree. No chart; show the truncation notice.
- `excl_overshoot` (9%), `parallel_estimate`, `charge_fallback` — absolute
  bars remain useful, but percentages are hidden and the chart is marked
  approximate. A donut cannot represent parts whose sum exceeds the whole;
  “draw but do not normalise” was not implementable without a misleading
  circle.

Show the top eight groups plus a visible aggregate remainder. Clicking a bar
must not jump to an arbitrary `ids[0]`; see Interaction.

### 1.3 Buffer access and write activity — *what PostgreSQL touched*

The buffer counters do **not** form one composition: a block may be counted as
read/hit and also dirtied/written. Combining all `shared-*`, `local-*` and
`temp-*` counters in one pie double-counts blocks.

Render two views instead:

1. **Access mix** — shared hit vs shared read, and local hit vs local read as
   separate stacked bars with denominators `hit + read`. Temp read is an
   absolute bar because PostgreSQL exposes no corresponding temp-hit counter.
2. **Write activity** — shared/local dirtied, shared/local written and temp
   written as independent absolute bars. No percentages and no combined
   “whole”: dirtied and written overlap.

Call this buffer access mix, not cache efficiency. The counters are
non-distinct accesses, not unique blocks. `shared-read` means a block
was read into PostgreSQL shared buffers; it may still have come from the OS
page cache and is not proof of a physical disk read. `shared-hit` is a hit in
PostgreSQL's shared buffer cache for this execution, not a database-wide cache
hit ratio.

Blocks are canonical. Byte values are secondary and labeled **assuming 8
KiB blocks** unless the host passes a `blockSize` render option. PostgreSQL's
`BLCKSZ` is configurable; the chart must not turn the current hard-coded 8192
into a product contract.

Available for **51%** of corpus plans (§12) — the other half were captured without
`BUFFERS`, which `plan.coaching` already reports on the diagnostics pane.
Gate: no buffer counters → no chart, and point at that coaching entry.

### 1.4 Filter-discard hotspots — *where work was thrown away*

`plan.totals.rows` is the root output, while `plan.totals.rowsRemoved` is a sum
over many nodes. They are not two parts of one population: rows flow through
several operators and can be counted at several stages. A global kept/discarded
donut would therefore be false.

Use per-node stacked bars instead. For each material node with removed-row
evidence, show `rowsTotal` vs `rowsRemovedTotal`, the discard ratio, self time,
relation and filter kind. Rank by attributable time first, removed rows second,
and keep at most eight visible rows. This is directly actionable for
`SEQSCAN_DISCARD`, `INDEX_DISCARD` and `NESTLOOP_DISCARD`, and each row can link
to the matching recommendation.

### 1.5 Reported block I/O timing — *how much timed I/O was observed*

Show read and write I/O timings as absolute horizontal bars. Only on a
non-parallel plan, when `ioRead + ioWrite <= totals.time` within tolerance,
may a third `non-I/O / unaccounted` segment turn this into a wall-clock
composition. In a parallel plan summed worker I/O can exceed elapsed
wall-clock time; show absolute values and an `accumulated worker time` caveat,
never a percentage.

Available for **19%** of the corpus (§12) — the rarest of the five, and the
first draft of this document claimed 44% by mistaking a plan count for a
percentage. This visualises evidence used
by `DISK_READ` and `UNEXPLAINED_TIME`, but the title must not claim “it was the
disk”: timings can include storage and OS-cache behaviour the plan cannot
separate. Gate: needs reported `I/O Timings`; shared-read buffer counts alone
are insufficient.

### 1.6 Phase-two charts worth adding

These are more useful than additional donuts and use fields already present:

- **estimate error** — log-scale dumbbell/bars for planned vs actual rows,
  comparing per-loop `planRows` with per-loop `rows` and ranked by material
  node time; useful to developers and statistics work;
- **parallel worker skew** — reported per-worker rows/time as bars for nodes
  with complete `workers[]`; show the leader separately only if measured,
  never derive an equal share;
- **spill hotspots** — sort/hash disk usage and temp blocks by node, absolute
  values with links to `DISK_SORT`, `DISK_HASH` and `TEMP_SPILL`;
- **loop/fan-out hotspots** — loops × rows / join-filter removals for repeated
  inner work, linked to nested-loop and repeated-work recommendations.

### 1.7 The charts, ranked

Ordered by what they are worth per unit of work: how often the data is
there (§12), whether the shape can be honest, and whether the answer is one
the existing panes make you assemble by hand. Coverage is the share of
corpus plans that carry enough evidence to draw the chart at all.

| # | chart | answers | shape | data | drives |
| --- | --- | --- | --- | --- | --- |
| 1 | Execution hotspots (§1.2) | which operation eats the time | bars | 93% | reading order for everything else |
| 2 | Latency composition (§1.1) | is the plan even to blame | donut | 80% | `PLANNING_TIME`, `OUTSIDE_PLAN` |
| 3 | Estimate error (§1.6) | where the planner is wrong about volume | log bars, planned vs actual per loop | 73% | `ROW_ESTIMATE`, statistics work |
| 4 | Filter-discard hotspots (§1.4) | where work is read and thrown away | stacked bars per node | 71% | `SEQSCAN_DISCARD`, `INDEX_DISCARD`, `NESTLOOP_DISCARD` |
| 5 | Buffer access mix (§1.3) | did shared buffers serve the reads | stacked bars, `hit + read` | 51% | the `BUFFERS` coaching entry |
| 6 | Fan-out hotspots (§1.6) | which inner side is executed over and over | bars, loops × rows | 35% | `NESTLOOP_DISCARD`, `REPEATED_WORK`, `MEMOIZE_MISS` |
| 7 | Write activity (§1.3) | what a read query still wrote | absolute bars | 21% | `TABLE_WRITTEN` |
| 8 | I/O timing (§1.5) | how much time is *reported* as block I/O | bars | 19% | `DISK_READ`, `UNEXPLAINED_TIME` |
| 9 | Memoize effectiveness (§1.6) | is the cache paying for itself | stacked bar, hits vs misses | 19% | `MEMOIZE_MISS` |
| 10 | Spill hotspots (§1.6) | which node exceeded `work_mem`, and by how much | bars, disk kB and batches | 14% | `DISK_SORT`, `DISK_HASH`, `TEMP_SPILL` |
| 11 | Parallel worker skew (§1.6) | did the workers share the work | bars per worker | 4% | `GATHER_WORKERS`, `parallel_estimate` |

Two things this ordering says out loud:

- **Only #2 is a pie.** Everything else either lacks a shared denominator or
  has too many categories for angles to be read. That is the honest answer to
  "a tab of pie charts": one composition survives as a donut, the rest are
  bars. The pane is named for what it shows, not for the shape.
- **Low coverage is not low value.** Spill hotspots reach 14% of plans, but
  on those plans the spill is usually the finding — `DISK_SORT` was the
  single largest impact on several corpus plans. Rarity decides *ordering
  within the pane*, never inclusion: a card that is absent 86% of the time
  costs nothing when it is gated properly.

### 1.8 How they divide into tabs

One tab, three sections, in this order:

```
Charts
  Time      latency composition · execution hotspots · spill hotspots · I/O timing
  Rows      discard hotspots · estimate error · fan-out hotspots
  Resources buffer access mix · write activity · memoize · worker skew
```

Rationale, and the alternatives rejected:

- **Not one chart per tab.** The bar already carries ten tabs; four more
  would push the raw-input pair off the right edge on a laptop and make the
  charts harder to find, not easier.
- **Not "Time" and "Data" as separate tabs.** The three questions are asked
  in one sitting — *is it the plan, which operation, and why* — and a reader
  who has to change tabs mid-thought loses the comparison.
- **Sections, not a flat grid.** With gating, a given plan typically draws
  three to six cards; unlabelled they read as a dashboard. The section
  heading states the question each group answers.
- Blocked cards collapse into one row per §8 — the sections themselves
  disappear when everything in them is blocked.

A second tab becomes justified only if phase-two charts land and the pane
grows past roughly eight visible cards; at that point the split is
**Charts** (time and rows) and **Resources** (buffers, I/O, workers), not an
alphabet of small tabs.

## 2. Deliberately not charted

- **Advice impact.** The rules do not partition time: several findings may
  legitimately cover the same node, and the residual `UNEXPLAINED_TIME`
  stands down where a cause exists. A pie would assert a partition that
  does not exist. If this is wanted later, it is a ranked bar list, not a
  pie.
- **All buffer counters in one pie.** Hit/read and dirtied/written overlap.
- **Global kept vs discarded rows.** Root output and removals summed across
  nodes do not share a denominator.
- **Planner cost vs elapsed time.** They have different units; two adjacent
  bars would invite a numerical comparison that has no meaning.
- **Derived per-worker shares.** Parallel attribution is approximate. Reported
  worker values may be shown as phase-two bars, but not as a share of elapsed
  time.
- **JIT/trigger/serialization as independent latency slices.** Their printed
  timings can overlap node or execution timing. Keep them as annotations until
  the normalized model can prove a non-overlapping contract. The historical
  corpus also had no trigger examples and the repository has no trigger
  regression fixture.

## 3. Tooltips

The legend/bar label is where the essential numbers live. A tooltip adds
definitions and evidence but must never be the only way to read a value:
hover is unavailable on touch devices and is not a keyboard interaction.
The widget already has the tooltip machinery — reuse it, do not invent a
second one:

- `tip(el, text)` sets `data-pv-tip`; `bindTooltips(container)` installs one
  delegated `mouseover`/`mousemove` listener and one themed `.pv-tooltip`
  element per widget. Delay 160 ms, viewport flip, `pre-line` text.
- **SVG targets take the same attribute** — `setAttribute('data-pv-tip', …)`
  — never an SVG `<title>` child: the pane's tooltips must look like the
  rest of the widget, and `<title>` cannot be styled or delayed.
- Every slice/bar and its legend row carry the same tooltip. Interactive
  marks show it on pointer hover and keyboard focus; touch users can read the
  same facts in the visible legend/details row.

Tooltip text, one fact per line:

```
shared read
1 284 blocks · 10.0 MiB
41.2% of shared-buffer accesses
blocks read into PostgreSQL shared buffers; the OS cache may have served them
```

Line 1 — mark name. Line 2 — absolute value in the unit that suits it (ms via
`fmtMs`, blocks and optionally bytes via the configured block size, counts via
`fmtInt`). Line 3 is present only when a valid denominator exists. Line 4
explains quantities whose names are not self-explanatory (`shared-dirtied`,
`temp-written`, “unaccounted execution overhead”). Approximate charts add a
final line naming the exact limitation and diagnostic code.

The `other` slice lists what it merged, capped at eight names with a
`+N more` tail.

## 4. Rendering

- Inline SVG for the latency donut; semantic HTML/CSS bars are preferable for
  ranked and stacked-bar views because labels, focus order and responsive
  layout are simpler.
- A donut slice is an annular path with outer **and inner** arcs. `M … A … Z`
  alone creates a full pie sector; covering its centre with another circle
  leaves a misleading hit target underneath the hole.
- The donut hole carries the whole as a number. A chart whose absolute value
  is not readable without hovering is decoration.
- The six-slice plus `other` rule applies only to high-cardinality categorical
  views. Fixed semantic phases in any future proven composition are never
  silently merged into `other`; latency annotations such as JIT are never
  converted into slices merely to fill the donut.
- Ranked bars show at most eight rows plus an aggregate remainder and are
  ordered by the metric that answers the chart's question.
- A visible legend/detail row always carries label, absolute value, and share
  only where a valid whole exists. The graphic gives the shape at a glance;
  the text does the precise reading.
- Every card has a quality line: `exact`, `approximate`, or `unavailable`,
  followed by the relevant diagnostic link when needed.
- Two charts per row on wide viewports, one per row below ~900 px, using
  the same `clamp`/flex approach as the relations pane.
- No animation, 3D, exploded slices, dual axes, or percentage labels drawn
  on the slices themselves. Respect `prefers-reduced-motion` for focus/scroll
  behaviour inherited from the host.

## 5. Colours

`css/pgplan.css` contains no literal colours by rule, so the palette lands
in `css/pgplan-theme.css` as new tokens:

```
--pv-chart-planning
--pv-chart-tree
--pv-chart-overhead
--pv-cat-1 … --pv-cat-8
--pv-cat-other
```

Constraints: readable on both `--pv-bg` values, colour-blind safe, and not
colliding with `--pv-sev-*`, which already means something specific in this
widget. Fixed phases keep fixed colours between plans. Colour is never the
only identifier: every mark has a text label, and print styles may add simple
SVG hatch patterns for adjacent slices that collapse to the same grayscale.

## 6. Interaction

- A mark backed by exactly one node uses `ctx.goToNode(id)`.
- A group backed by several nodes must not jump to arbitrary `ids[0]`. It
  opens Stats filtered/highlighted to that group, or expands an inline list
  ordered by self time from which the user chooses a node. If that supporting
  interaction is not implemented in the first increment, grouped marks are
  non-clickable.
- Filter-discard rows link both to their plan node and to the corresponding
  recommendation card when one exists (`ctx.setTab('advice', nodeId)` already
  supports that destination).
- Annotations such as JIT, aggregate remainder and other marks with no
  meaningful node target are non-interactive. They do not receive `role="button"` or a
  `tabindex`.
- Interactive marks use `keyable()` and the existing visible focus ring;
  chart containers expose an accessible name/summary, while all numeric data
  remains available as ordinary text in DOM order.
- The pane is inert on re-render — no observers, no timers — so it needs no
  entry in `container.__pvCleanups`.

## 7. Data and view-model changes

No parser/analyzer change is required for the first increment. Everything
reads `plan.totals`, `plan.stats`, `plan.planningTime`, `plan.executionTime`,
`plan.jit`, `plan.triggers`, node-local row counters and `plan.diagnostics` as
they are today. The renderer gains `opts.blockSize` (positive integer,
default 8192) for secondary byte labels; the plan model remains in blocks.
ROADMAP §3.3 already lists a `blockSize` control under Batch 6 — one option,
introduced here and reused there, not two.

One helper is worth extracting for testability:

```js
buildCharts(plan, {blockSize = 8192} = {}) -> [{
  id, title,
  kind: 'donut' | 'bars' | 'stacked-bars',
  unit, whole,
  quality: 'exact' | 'approximate',
  diagnostics: ['parallel_estimate', ...],
  items: [{label, value, total, segments: [{label, value}], ids, note}],
  annotations: [{label, value, note}],
  blocked: null | {reason, message}
}]
```

Pure, no DOM, exported from `pgplan-render.js` (or kept internal and
exercised through it). `whole` is nullable for rankings; `total` is per-item
for ratios, and `segments` carries stacked values such as kept/removed or
hit/read. The renderer then contains no metric arithmetic, and gates/quality
propagation are unit-testable without a browser.

Do not store preformatted strings or chart-only percentages back into
`plan`: the same normalized model must remain usable by embedded hosts.

## 8. Pane wiring

A `charts` pane placed after **Stats** — it is a summary of the same
numbers, and the tab order stays "the plan, then views of it, then what the
widget concluded":

```
[Input data ·] Plan · Stats · Charts · Diagram · Relations · Model ·
Diagnostics · Recommendations                        … Plan text · SQL query
```

`Input data` remains the optional host-provided `opts.inputPane`; it is not a
built-in plan pane.

`applicable: p => buildCharts(p).some(c => !c.blocked)` — no tab at all
when nothing can be charted honestly, matching how every other optional
pane behaves. When at least one chart is available, blocked siblings collapse
into one “more charts need additional evidence” row linked to Diagnostics;
do not render a dashboard of empty cards. Label: **Charts**.

## 9. Tests

Node (`test/charts.test.js`), against `buildCharts`:

- every composition has finite, non-negative slices that sum to its declared
  whole within an explicit tolerance;
- latency slices are exactly `planning`, `root execution` and the execution
  residual; JIT/triggers are annotations and are never subtracted again;
- a negative execution residual triggers the two-slice fallback rather than a
  clamp;
- no buffer chart mixes access counters with dirtied/written counters;
- bytes honour `blockSize`, while labels identify the default as an
  assumption;
- the rows view uses per-node denominators and never combines root output with
  plan-wide removals;
- gates: truncation blocks latency/self-time composition; no buffers blocks
  1.3; missing summary totals blocks 1.1; each block names the reason;
- `excl_overshoot`, `parallel_estimate` and `charge_fallback` keep absolute
  hotspot bars but remove shares and mark them approximate;
- parallel I/O never receives a wall-clock percentage;
- high-cardinality grouping preserves the value and names behind `other`.

Browser (`tools/browser-smoke.py`):

- the Charts tab appears for a fixture that has the data, and does not for
  one that has none;
- visible text exposes every value without a hover;
- marks and legend rows carry matching `data-pv-tip`; pointer hover and
  keyboard focus show the tooltip where appropriate;
- non-interactive marks have no button role/tab stop; interactive single-node
  marks activate from Enter/Space and land on the expected row;
- a grouped mark never navigates silently to an arbitrary first node;
- approximate/blocked states and their diagnostic links are visible;
- narrow viewport, both themes, print CSS and reduced-motion mode render
  without overflow or console errors.

Fixtures required before implementation is called complete:

- JIT plus known outside-tree overhead;
- trigger timing;
- shared hit/read plus dirtied/written in the same plan;
- parallel plan whose summed I/O or worker time exceeds wall-clock;
- severe estimate error and a multi-node discard hotspot;
- truncated and `excl_overshoot` counterexamples.

## 10. Order of work

1. Add the missing semantic fixtures, then implement `buildCharts` and its
   contract tests — arithmetic, denominators and quality gates, no DOM.
   This step, not the drawing, is where the schedule goes: trigger timing and
   a parallel plan whose summed worker I/O exceeds wall-clock cannot be
   written by hand and have to be generated against a real server through
   `tools/gen-fixtures.sh` (docker, PG 10–18 matrix). A JIT plan with a known
   out-of-tree overhead needs a rigged query rather than a captured one.
   The remaining counterexamples — truncation, `excl_overshoot`, discard and
   estimate-error hotspots — are synthetic and cheap.
2. Implement latency composition plus the generic bar/stacked-bar renderer;
   add theme tokens, visible legends and tooltip/focus support.
3. Ship 1.1, 1.2 and 1.4 first: latency, execution hotspots and discarded-row
   hotspots give the clearest DBA/developer value.
4. Add the split buffer views and reported I/O timing after their overlap and
   parallel counterexamples pass.
5. Wire the pane, diagnostic/recommendation links, responsive/keyboard/print
   browser checks and `blockSize` option.
6. Evaluate phase-two charts from real usage; do not add them merely to fill
   the grid.

## 11. PostgreSQL contracts referenced

- [`EXPLAIN`](https://www.postgresql.org/docs/18/sql-explain.html) defines
  BUFFERS hit/read/dirtied/written semantics, I/O timing availability,
  SERIALIZE and SUMMARY.
- [`Using EXPLAIN`](https://www.postgresql.org/docs/18/using-explain.html)
  documents that buffer counts are non-distinct/inclusive, `Execution Time`
  includes trigger execution, `BEFORE` triggers overlap DML-node timing, and
  serialization timing is included when requested.
- [`shared_buffers`](https://www.postgresql.org/docs/18/runtime-config-resource.html)
  documents that `BLCKSZ` is typically, not invariably, 8 KiB.
- [The cumulative statistics system](https://www.postgresql.org/docs/18/monitoring-stats.html)
  notes that PostgreSQL I/O statistics cannot distinguish a kernel call that
  reached physical storage from one served by the kernel page cache.

## 12. Coverage measurement

The percentages in §1 come from `tools/chart-coverage.js`, which prints the
share of plans carrying enough evidence for each chart and states every
counting rule in code:

```
node tools/chart-coverage.js <dir-with-plan-*.txt>
```

Figures quoted here: **2026-09-02**, 214 unique plans harvested from the
public `explain.tensor.ru` archive for 2026-08-29…31 via the harness in
`tensor-archive-harness.md`. That corpus is deliberately **not** in this
repository — the plans carry production identifiers — so the numbers are
reproducible only against a comparable corpus. Running the same script over
`test/plans` (17 fixtures) gives a different and much smaller picture, which
is the point: these are planning hints about what real plans carry, not
acceptance criteria.
