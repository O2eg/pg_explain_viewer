#!/usr/bin/env python3
"""Build the self-contained single-file viewer from viewer.template.html.

Writes two identical copies: dist/pg-explain-viewer.html (the release and
Pages artifact) and ./pg-explain-viewer.html — the page you open while
working. It has to be self-contained too: only a page that carries its own
styles and scripts can export a working copy of itself. Both are build
output; neither is tracked.

Inlines css/pgplan-theme.css, css/pgplan.css, src/pgplan-expr.js,
src/pgplan-sql.js, src/pgplan.js and src/pgplan-render.js.
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
    html = read(ROOT / "viewer.template.html")

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

    # A literal closing script tag inside an inline script ends it, wherever it
    # appears — in a string, in a comment, anywhere. The page then dies with
    # "Unexpected end of input", so check every inline block instead of
    # trusting review.
    for i, block in enumerate(re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>",
                                         html, re.S)):
        assert "</script" not in block.lower(), (
            f"inline script #{i} spells a closing script tag; it would cut the page short")

    # the page states its version in the header; keep it and package.json from
    # drifting apart rather than shipping a stale number
    version = json.loads(read(ROOT / "package.json"))["version"]
    shown = re.search(r'<span id="version">([^<]*)</span>', html)
    assert shown, "the page carries no version marker"
    assert shown.group(1) == version, (
        f'page says version {shown.group(1)}, package.json says {version}')

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
    # the same file at the root: it is what a developer opens directly, and
    # only a self-contained page can export a working copy of itself
    (ROOT / "pg-explain-viewer.html").write_text(html, encoding="utf-8")
    print(f"built {out} and ./pg-explain-viewer.html ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
