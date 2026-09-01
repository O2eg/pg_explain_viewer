# Third-party notices

pg-explain-viewer itself is zero-dependency. The repository vendors one
third-party component, and the built offline viewer embeds it:

## highlight.js 11.11.1

- Files: `vendor/highlight-11.11.1.min.js` (embedded into
  `dist/pg-explain-viewer.html` by `build.py`)
- Purpose: SQL syntax highlighting in the query pane and generated
  `CREATE INDEX` blocks; optional at runtime (the widget falls back to
  plain escaped text when `window.hljs` is absent).
- License: BSD 3-Clause, Copyright (c) 2006 Ivan Sagalaev and other
  contributors. Full text: `vendor/highlight-11.11.1.LICENSE.txt`.
- Source: <https://github.com/highlightjs/highlight.js>
