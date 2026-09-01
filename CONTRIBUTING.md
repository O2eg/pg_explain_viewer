# Contributing

Thanks for taking a look. The project is intentionally small and
dependency-free — please keep it that way.

## Ground rules

- **Zero runtime dependencies.** The library is plain JS (UMD), the
  viewer is one static HTML file. No frameworks, no build-time
  transpilers, no npm packages at runtime. highlight.js stays vendored
  and optional.
- **One parsing pipeline.** JSON/YAML are converted to canonical text
  and go through the same text parser. Do not add per-format parsing
  paths unless the golden/parity corpus proves material data loss.
- **Honest output.** Advisor entries separate observation from
  hypothesis; heuristics and approximations must surface in
  `plan.diagnostics[]` or the advice contract — never silently.
- **Safe generated SQL.** Anything derived from plan text must pass
  `isSafeFragment()` before it can appear in copyable DDL. When in
  doubt, emit a descriptive candidate instead of SQL.
- English everywhere: code, comments, UI strings, messages.

## Development

Node.js ≥ 18 and Python 3 are enough. Install the lockfile-pinned build
tooling before the first build (and after lockfile changes):

```bash
npm ci                      # install the pinned build-time minifier
npm test                     # node:test suite (see test/)
UPDATE_GOLDEN=1 npm test     # regenerate golden snapshots after an
                             # intentional model change — review the diff!
npm run build                # build dist/pg-explain-viewer.html with minified JS
```

Headless-browser regression (needs playwright + a Chromium/Chrome):

```bash
python3 -m pip install --target="$PWD/.pwlib" playwright
PWLIB="$PWD/.pwlib" python3 -m playwright install chromium
PWLIB="$PWD/.pwlib" PW_CHANNEL= python3 tools/browser-smoke.py
```

## Release

Set `package.json` to the release version and push a matching annotated tag
(`v0.7.1` for package version `0.7.1`). The Release workflow rejects a version
mismatch, runs the tests, builds the self-contained HTML and publishes it with
its SHA-256 checksum and license notices on GitHub Releases.

Regenerating the PostgreSQL 10…18 format matrix (needs Docker):

```bash
tools/gen-fixtures.sh                       # all versions, all shapes
VERSIONS="18" ONLY="parallel-sort" tools/gen-fixtures.sh
```

## Pull requests

- Every behavior change needs a test: parser/analyzer changes show up in
  golden diffs; advisor changes need the 4-case matrix
  (positive / negative / low-impact / missing-evidence) for actionable
  rules, positive+negative for observational ones.
- New input-format quirks need a committed fixture (`test/plans/` or the
  matrix) — not just code.
- Keep the CSS contract: all colors/fonts as `--pv-*` custom properties
  in `pgplan-theme.css`; `pgplan.css` stays structural.
- Run `npm test` and `npm run build` before submitting; CI runs the
  same plus the browser regression.

## Security & data sensitivity

`EXPLAIN` output contains no result rows, but it is **not** free of
sensitive data. A plan can reveal:

- literal values from your queries (`Filter: (email = 'user@host'::text)`,
  `Index Cond`, `Hash Cond` — these are your data);
- the SQL text itself (auto_explain `Query Text`, the query pane);
- schema, table, index, and function names — your database structure;
- server settings (`Settings:`), file paths and internal details.

Before attaching a plan to a public issue, **redact everything you would
not post publicly**: replace literals with placeholders, rename
identifiers consistently (the tree structure and metrics are what matters
for a parser bug). This applies doubly to plans lifted from diagnostic
reports (pg_diag and similar) — they may aggregate plans you did not
write yourself.

The viewer itself never sends data anywhere: parsing and rendering are
fully local, the offline build makes no network requests.

## Reporting plans that parse wrong

Open an issue with the plan text (redacted per the section above) and the
PostgreSQL version. Keep the plan structure intact — node heads, clauses
and indentation are exactly what the parser needs.
