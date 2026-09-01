# Charts pane — design and implementation plan

A tab of donut charts answering questions the other panes make you compute
by hand: *is the plan even to blame for the latency?*, *which relation ate
the execution time?*, *did the cache work?*

Status: planned. Nothing below is implemented yet.

## 1. What a pie is allowed to show

A pie is honest only when its parts add up to a whole that means something.
Everything in this pane is therefore built from a quantity the model already
guarantees to be a whole, and **a chart that cannot be trusted is not drawn**
— the pane says why instead. That is the same fail-closed line the SQL
pairing gate and the truncated-plan advisor already hold.

Coverage figures below are measured over the 214-plan public archive corpus
described in `tensor-archive-harness.md` (outside this repository).

### 1.1 Latency composition — *the plan is not always the problem*

| slice | source |
| --- | --- |
| planning | `plan.planningTime` |
| JIT compilation | `plan.jit.total` |
| execution, inside the tree | `plan.totals.time` − JIT (JIT is charged to execution but belongs to no node) |
| outside the tree | `plan.executionTime` − `plan.totals.time` (result transfer, triggers, serialization) |

Whole: `planningTime + executionTime`. Centre: that total.

Available for **82%** of corpus plans; 42% of them spend measurable time
outside the tree, 4% carry JIT — and in one case JIT is 98.9% of execution.
This is the chart that pays for the pane: `PLANNING_TIME`, `JIT_TIME` and
`OUTSIDE_PLAN` become visible before anyone reads a card.

Gate: needs `planningTime` or `executionTime`; the `totals_missing`
diagnostic already names the case where neither exists.

### 1.2 Where execution time went — *which relation is expensive*

Self time per relation, from `plan.stats[]` (`relation`, `time`, `ids`),
with a toggle to group by `nodeType` instead. Spec nodes are already
excluded from stats. Whole: the sum of self times ≈ `plan.totals.time`.

Available for **87%** of corpus plans.

Gates, both already diagnosed by the model:
- `plan.truncated` (3%) — self times of nodes whose children are missing
  include the whole missing subtree. No chart; show the truncation notice.
- `excl_overshoot` (9%) — the parts exceed the whole. Draw, but state the
  overshoot in the centre label and repeat the diagnostic's own sentence;
  never silently normalise the slices to 100%.

### 1.3 Buffer traffic — *did the cache work, and what was written*

Slices from `plan.totals.buf`: `shared-hit`, `shared-read`,
`shared-dirtied`, `shared-written`, `local-*`, `temp-read`, `temp-written`.
Whole: all blocks touched. Centre: the total in bytes (block size 8 kB, as
`fmtBytes` already assumes).

Available for **51%** of corpus plans — the other half were captured without
`BUFFERS`, which `plan.coaching` already reports on the diagnostics pane.
Gate: no buffer counters → no chart, and point at that coaching entry.

### 1.4 Rows: kept vs discarded — *how much work was thrown away*

`plan.totals.rows` against `plan.totals.rowsRemoved`. Available for **71%**.
Two slices only, so the donut is small and the centre carries the number
that matters: the share discarded. This is the quantity
`SEQSCAN_DISCARD` / `INDEX_DISCARD` / `NESTLOOP_DISCARD` are about.

### 1.5 I/O time vs the rest — *was it the disk*

`plan.totals.ioRead` + `ioWrite` against `plan.totals.time`. Available for
**44%**. Visualises exactly the split `DSK_READ` and `UNEXPLAINED_TIME`
reason about. Gate: needs `I/O Timings` in the input.

## 2. Deliberately not charted

- **Advice impact.** The rules do not partition time: several findings may
  legitimately cover the same node, and the residual `UNEXPLAINED_TIME`
  stands down where a cause exists. A pie would assert a partition that
  does not exist. If this is wanted later, it is a ranked bar list, not a
  pie.
- **Per-worker time.** Parallel attribution is approximate and we say so in
  `parallel_estimate`; charting it would contradict our own diagnostic.
- **Triggers.** 0% of the corpus. No fixture, no chart.

## 3. Tooltips

Hover is where the numbers live, so this is a requirement, not a polish
item. The widget already has the machinery — reuse it, do not invent a
second one:

- `tip(el, text)` sets `data-pv-tip`; `bindTooltips(container)` installs one
  delegated `mouseover`/`mousemove` listener and one themed `.pv-tooltip`
  element per widget. Delay 160 ms, viewport flip, `pre-line` text.
- **SVG targets take the same attribute** — `setAttribute('data-pv-tip', …)`
  — never an SVG `<title>` child: the pane's tooltips must look like the
  rest of the widget, and `<title>` cannot be styled or delayed.
- Every slice **and** its legend row carry the same tooltip, so the numbers
  are reachable whichever one the pointer lands on.

Tooltip text, one fact per line:

```
shared read
1 284 blocks · 10.0 MiB
41.2% of buffer traffic
blocks fetched from disk into shared buffers
```

Line 1 — slice name. Line 2 — absolute value in the unit that suits it
(ms via `fmtMs`, bytes via `fmtBytes`, counts via `fmtInt`). Line 3 — share
of the whole. Line 4 — what the quantity means, for the slices where the
name is not self-explanatory (`shared-dirtied`, `temp-written`, "outside
the tree").

The `other` slice lists what it merged, capped at eight names with a
`+N more` tail.

## 4. Rendering

- Inline SVG, one `<path>` arc per slice (`M … A … Z`), which gives the
  whole sector as the hover and click target — unlike a dashed circle,
  where only the stroke is hittable.
- Donut, not a full pie: the hole carries the whole as a number. A chart
  whose absolute value is not readable is decoration.
- **At most six slices plus `other`**, sorted by size descending, `other`
  in a muted colour. Slices below 1% fold into `other` regardless of count.
- A legend beside the donut with name, absolute value and share. The legend
  does the reading; the ring gives the proportion at a glance. For 1.2,
  where categories often exceed four, this is not a nicety — the eye
  compares angles badly, and the legend is what makes the chart usable.
- Two charts per row on wide viewports, one per row below ~900 px, using
  the same `clamp`/flex approach as the relations pane.
- No animation, no 3D, no exploded slices, no percentage labels drawn on
  the slices themselves (they collide at small angles).

## 5. Colours

`css/pgplan.css` contains no literal colours by rule, so the palette lands
in `css/pgplan-theme.css` as new tokens:

```
--pv-cat-1 … --pv-cat-6   /* categorical slices, light and dark variants */
--pv-cat-other            /* the merged tail, deliberately muted        */
```

Constraints: readable on both `--pv-bg` values, distinguishable in
grayscale (the report is printed), and not colliding with the severity
tokens `--pv-sev-*` that already mean something specific in this widget.
Fixed slices keep fixed colours — planning, JIT, execution and out-of-tree
must not swap hues between two plans.

## 6. Interaction

- Clicking a slice or its legend row navigates like the rest of the widget:
  for 1.2, `ctx.goToNode(stats[i].ids[0])` — the same cross-link the stats
  pane and the diagram already provide. Slices with no node behind them
  (planning, JIT) are not clickable and say so in the tooltip.
- Keyboard: slices get `role="button"` and a tabindex through the existing
  `keyable()` helper, with the same visible focus ring as everywhere else.
- The pane is inert on re-render — no observers, no timers — so it needs no
  entry in `container.__pvCleanups`.

## 7. Model changes

None required. Everything above reads `plan.totals`, `plan.stats`,
`plan.planningTime`, `plan.executionTime`, `plan.jit` and
`plan.diagnostics` as they are today.

One helper is worth extracting for testability:

```js
buildCharts(plan) -> [{ id, title, whole, unit, slices: [{label, value, ids, note}],
                        blocked: null | {reason, message} }]
```

Pure, no DOM, exported from `pgplan-render.js` (or kept internal and
exercised through it). The renderer then contains no arithmetic, and the
gates are unit-testable without a browser.

## 8. Pane wiring

A `charts` pane placed after **Stats** — it is a summary of the same
numbers, and the tab order stays "the plan, then views of it, then what the
widget concluded":

```
Input data · Plan · Stats · Charts · Diagram · Relations · Model ·
Diagnostics · Recommendations                       … Plan text · SQL query
```

`applicable: p => buildCharts(p).some(c => !c.blocked)` — no tab at all
when nothing can be charted honestly, matching how every other optional
pane behaves. Label: **Charts**.

## 9. Tests

Node (`test/charts.test.js`), against `buildCharts`:

- each chart's slices sum to its declared whole (within rounding);
- the six-slice cap and the `<1%` fold produce a correct `other` with the
  merged names;
- gates: a truncated plan blocks 1.2; a plan without buffers blocks 1.3; a
  plan without `Planning Time` / `Execution Time` blocks 1.1; each blocked
  chart carries a message naming the reason;
- `excl_overshoot` does not block 1.2 but marks it, and the slices are not
  renormalised.

Browser (`tools/browser-smoke.py`):

- the Charts tab appears for a fixture that has the data, and does not for
  one that has none;
- every slice and every legend row carries `data-pv-tip`;
- hovering a slice shows `.pv-tooltip` with the slice name and its share;
- clicking a slice lands on the plan tab at the expected row;
- both themes render without console errors.

## 10. Order of work

1. `buildCharts` + its tests — the arithmetic and the gates, no DOM.
2. Theme tokens and the donut renderer with legend and tooltips.
3. Charts 1.1 – 1.3 (the ones that pay for the pane).
4. Pane wiring, click-through, keyboard, browser checks.
5. Charts 1.4 and 1.5 if they still look worth it once 1.1 – 1.3 are real.
