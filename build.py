#!/usr/bin/env python3
"""Build the self-contained single-file viewer: dist/pg-explain-viewer.html.

Inlines css/pgplan-theme.css, css/pgplan.css, src/pgplan-expr.js,
src/pgplan-sql.js, src/pgplan.js,
src/pgplan-render.js and every plan from test/plans/ into pg-explain-viewer.html.
No external resources remain — the result works from file:// offline.
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / "dist"


def read(p: pathlib.Path) -> str:
    return p.read_text(encoding="utf-8")


def main() -> None:
    html = read(ROOT / "pg-explain-viewer.html")

    def inline_css(marker: str, path: str) -> None:
        nonlocal html
        tag_re = re.compile(r'<link[^>]*>' + re.escape(marker))
        css = read(ROOT / path)
        html = tag_re.sub(lambda m: "<style>\n" + css + "\n</style>", html, count=1)

    def inline_js(marker: str, path: str) -> None:
        nonlocal html
        tag_re = re.compile(r'<script[^>]*></script>' + re.escape(marker))
        js = read(ROOT / path)
        html = tag_re.sub(lambda m: "<script>\n" + js + "\n</script>", html, count=1)

    inline_css("<!--PV:CSS-THEME-->", "css/pgplan-theme.css")
    inline_css("<!--PV:CSS-MAIN-->", "css/pgplan.css")
    inline_js("<!--PV:JS-HLJS-->", "vendor/highlight-11.11.1.min.js")
    inline_js("<!--PV:JS-EXPR-->", "src/pgplan-expr.js")
    inline_js("<!--PV:JS-SQL-->", "src/pgplan-sql.js")
    inline_js("<!--PV:JS-CORE-->", "src/pgplan.js")
    inline_js("<!--PV:JS-RENDER-->", "src/pgplan-render.js")

    assert "PV:" not in html, "unresolved build markers remain"

    # the artifact must carry its license notices: project MIT + the full
    # BSD-3 text of the embedded highlight.js (its license requires
    # reproducing copyright, conditions and disclaimer in redistributions)
    notices = (
        "<!--\n"
        "pg-explain-viewer — MIT License\n\n"
        + read(ROOT / "LICENSE").strip()
        + "\n\n" + "=" * 70 + "\n"
        "This file embeds highlight.js 11.11.1 (BSD 3-Clause):\n\n"
        + read(ROOT / "vendor" / "highlight-11.11.1.LICENSE.txt").strip()
        + "\n-->\n"
    )
    assert "--" + ">" not in notices[4:-4], "license text would break the HTML comment"
    html = notices + html

    DIST.mkdir(exist_ok=True)
    out = DIST / "pg-explain-viewer.html"
    out.write_text(html, encoding="utf-8")
    print(f"built {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
