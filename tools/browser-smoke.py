#!/usr/bin/env python3
"""Headless-browser regression for the built viewer (dist/pg-explain-viewer.html).

Covers what node tests cannot: every sample x every tab x both themes with a
console-error watch, the hostile-input (XSS) fixture, and the advice-pane
safe-output contract (impact chips, minor section, no copy button for
unsafe DDL).

Needs playwright + Chrome. Point PWLIB at a pip --target directory holding
playwright if it is not importable, e.g.:
    python -m pip install --target="$PWLIB" playwright
    PWLIB=... python3 tools/browser-smoke.py [path/to/pg-explain-viewer.html]
"""
import os
import pathlib
import sys

if os.environ.get("PWLIB"):
    sys.path.insert(0, os.environ["PWLIB"])
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEWER = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "dist", "pg-explain-viewer.html")
HOSTILE = open(os.path.join(ROOT, "test", "hostile", "xss-plan.txt")).read()

failures = []
errors = []


def open_input(page):
    """The input form moves into the widget's "Input data" tab after the first
    render, so anything that types into it has to open that tab first."""
    page.evaluate("""() => {
      for (const t of document.querySelectorAll('.pv-tab'))
        if (t.textContent === 'Input data') t.click();
    }""")


def check(name, ok, detail=""):
    print(("ok  " if ok else "FAIL") + " " + name + (": " + str(detail) if detail and not ok else ""))
    if not ok:
        failures.append(name)


with sync_playwright() as p:
    # PW_BROWSER: chromium (default) | firefox | webkit.
    # PW_CHANNEL=chrome uses the system Chrome (local chromium default);
    # PW_CHANNEL= (empty) uses playwright's own build (CI).
    name = os.environ.get("PW_BROWSER", "chromium")
    btype = {"chromium": p.chromium, "firefox": p.firefox, "webkit": p.webkit}[name]
    channel = os.environ.get("PW_CHANNEL", "chrome" if name == "chromium" else "")
    browser = btype.launch(channel=channel) if channel else btype.launch()
    print("browser:", name + (" (channel=" + channel + ")" if channel else ""))
    page = browser.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: (failures.append("dialog opened: " + d.message), d.dismiss()))
    page.goto("file://" + VIEWER)

    # ---- sweep: every repo sample plan x tabs x both themes ----
    plans = sorted(pathlib.Path(ROOT, "test", "plans").glob("plan-*.txt"))
    for pf in plans:
        open_input(page)
        page.fill("#src", pf.read_text())
        page.click("#go")
        page.wait_for_selector(".pv-summary", timeout=5000)
        for t in page.query_selector_all(".pv-tab"):
            t.click()
        page.click("#theme")
        for t in page.query_selector_all(".pv-tab"):
            t.click()
        page.click("#theme")
    check("plan sweep (%d plans, both themes)" % len(plans), True)

    # ---- hostile input: nothing executes, payloads render as text ----
    open_input(page)
    page.fill("#src", HOSTILE)
    page.click("#go")
    page.wait_for_selector(".pv-summary")
    for t in page.query_selector_all(".pv-tab"):
        t.click()
    xss = page.evaluate(
        "[1,2,3,4,5,6].map(i => window['__xss' + i]).filter(v => v !== undefined).length")
    check("no XSS payload executed", xss == 0, "%d payload(s) ran" % xss)
    body_text = page.eval_on_selector(".pv", "el => el.textContent")
    check("hostile relation renders as text", "evil<img src=x" in body_text)
    injected = page.query_selector_all(".pv img, .pv svg[onload], .pv script")
    # the diagram legitimately uses svg; only foreign img/script are proof
    bad = [e for e in injected if e.evaluate("el => el.tagName.toLowerCase()") != "svg"]
    check("no injected img/script elements", not bad, len(bad))

    # ---- advice pane: schema v2 rendering & safe-output contract ----
    page.evaluate("""() => {
      for (const t of document.querySelectorAll('.pv-tab'))
        if (t.textContent.startsWith('Recommendations')) t.click();
    }""")
    check("impact chips rendered", page.query_selector(".pv-impact") is not None)
    check("exact DDL keeps its copy button",
          page.evaluate("""() => [...document.querySelectorAll('.pv-adv-idx')]
            .some(w => w.querySelector('pre.pv-sql') && w.querySelector('.pv-copy'))"""))
    check("unsafe DDL: description only, no SQL, no copy",
          page.evaluate("""() => [...document.querySelectorAll('.pv-adv-idx')]
            .some(w => w.querySelector('.pv-adv-idx-desc')
              && !w.querySelector('pre.pv-sql') && !w.querySelector('.pv-copy'))"""))
    check("candidate-only note present", page.query_selector(".pv-adv-idx-note") is not None)

    # coaching block shows for under-instrumented plans (hostile plan has no BUFFERS)
    check("coaching block rendered", page.query_selector(".pv-coach") is not None)

    # ---- the SQL field is user input rendered as HTML: it must not execute ----
    page.evaluate("() => { window.__pwXss = 0; }")
    open_input(page)
    page.fill("#src", """Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=1 loops=1)
Execution Time: 0.5 ms""")
    page.fill("#sql", "SELECT * FROM t WHERE x = '<img src=x onerror=\"window.__pwXss=1\">'"
                      " -- <script>window.__pwXss=1</script>")
    page.click("#go")
    page.wait_for_selector(".pv-summary")
    page.evaluate("""() => {
      for (const t of document.querySelectorAll('.pv-tab'))
        if (t.textContent.trim() === 'SQL query') t.click();
    }""")
    page.wait_for_timeout(150)
    check("hostile SQL text executes nothing", page.evaluate("() => window.__pwXss") == 0)
    check("hostile SQL injects no elements",
          page.evaluate("""() => !document.querySelector('.pv-query img, .pv-query script')"""))

    # ---- SQL binding: the "sql" button highlights the FROM item ----
    SQL_PLAN = """Hash Join  (cost=1.00..900.00 rows=1 width=8) (actual time=0.10..900.00 rows=1 loops=1)
  Hash Cond: (o.customer_id = c.id)
  ->  Seq Scan on orders o  (cost=0.00..500.00 rows=100 width=8) (actual time=0.01..800.00 rows=100 loops=1)
        Filter: (status = 'x'::text)
        Rows Removed by Filter: 100000
  ->  Hash  (cost=1.00..1.00 rows=1 width=8) (actual time=0.05..0.05 rows=1 loops=1)
        ->  Seq Scan on customers c  (cost=0.00..1.00 rows=1 width=8) (actual time=0.01..0.02 rows=1 loops=1)
Execution Time: 900.5 ms"""
    SQL_TEXT = "SELECT * FROM public.orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'x'"
    open_input(page)
    page.fill("#src", SQL_PLAN)
    page.fill("#sql", SQL_TEXT)
    page.click("#go")
    page.wait_for_selector(".pv-summary")
    page.evaluate("""() => {
      for (const t of document.querySelectorAll('.pv-tab'))
        if (t.textContent.startsWith('Recommendations')) t.click();
    }""")
    sql_btn = page.query_selector(".pv-card-sql")
    check("advice card offers a link into the query text", sql_btn is not None)
    if sql_btn:
        sql_btn.click()
        page.wait_for_timeout(150)
        marked = page.evaluate("""() => {
          const m = document.querySelector('.pv-sqlmark');
          const onQueryTab = [...document.querySelectorAll('.pv-tab')]
            .some(t => t.textContent.trim() === 'SQL query' && t.classList.contains('pv-tab-on'));
          return { text: m ? m.textContent : null, onQueryTab };
        }""")
        check("clicking it opens the query tab", marked["onQueryTab"], marked)
        check("and highlights the FROM item the node came from",
              marked["text"] == "public.orders o", marked)
    open_input(page)
    page.fill("#sql", "")

    # ---- minor-observations section: collapsed by default, toggles ----
    MINOR_PLAN = """Sort  (cost=0.00..100.00 rows=10 width=8) (actual time=0.20..100.00 rows=10 loops=1)
  Sort Key: t.a
  ->  Seq Scan on t  (cost=0.00..10.00 rows=100 width=8) (actual time=0.01..0.40 rows=100 loops=1)
        Filter: (b = 3)
        Rows Removed by Filter: 10000
Execution Time: 100.4 ms"""
    open_input(page)
    page.fill("#src", MINOR_PLAN)
    page.click("#go")
    page.wait_for_selector(".pv-summary")
    page.evaluate("""() => {
      for (const t of document.querySelectorAll('.pv-tab'))
        if (t.textContent.startsWith('Recommendations')) t.click();
    }""")
    mh = page.query_selector(".pv-minorhead")
    check("minor section present for demoted findings", mh is not None)
    if mh:
        hidden_before = page.eval_on_selector(".pv-minorbox", "el => el.hidden")
        mh.click()
        hidden_after = page.eval_on_selector(".pv-minorbox", "el => el.hidden")
        check("minor section collapsed by default and toggles",
              hidden_before and not hidden_after)

    # ---- accessibility: ARIA tabs + keyboard operation ----
    # ---- layout: navigation on top, readouts under it, host pane first ----
    layout = page.evaluate("""() => {
      const kids = [...document.querySelector('.pv').children].map(e => e.className.split(' ')[0]);
      const tabs = [...document.querySelectorAll('.pv-tab')].map(t => t.textContent);
      return { tabbarBeforeSummary: kids.indexOf('pv-tabbar') < kids.indexOf('pv-summary'),
               first: tabs[0], active: (document.querySelector('.pv-tab-on') || {}).textContent,
               inputInPane: !!document.querySelector('.pv-pane #inputbox') };
    }""")
    check("tab bar sits above the summary chips", layout["tabbarBeforeSummary"], layout)
    check("the host input pane is the first tab", layout["first"] == "Input data", layout)
    check("a rendered plan does not land on the input tab",
          layout["active"] != "Input data", layout)
    check("the host element really moved into the pane", layout["inputInPane"], layout)

    # the findings tabs are outlined in the theme accent — assert the colour
    # the browser computes, not just the class, and check the widget's own
    # controls are not wearing the host page's button styles
    tabs = page.evaluate("""() => {
      const pv = document.querySelector('.pv');
      const accent = getComputedStyle(pv).getPropertyValue('--pv-accent').trim();
      const probe = document.createElement('span');
      probe.style.color = accent; document.body.appendChild(probe);
      const want = getComputedStyle(probe).color; probe.remove();
      const of = sel => { const e = document.querySelector(sel); const s = getComputedStyle(e);
        return { border: s.borderTopColor, radius: s.borderTopLeftRadius, pad: s.paddingLeft }; };
      return { want, accentTab: of('.pv-tab-accent'), plainTab: of('.pv-tab:not(.pv-tab-accent)') };
    }""")
    check("Diagnostics/Recommendations tabs are outlined in the accent colour",
          tabs["accentTab"]["border"] == tabs["want"], tabs)
    check("other tabs keep the plain border",
          tabs["plainTab"]["border"] != tabs["want"], tabs)
    check("tabs keep the widget's own pill shape",
          tabs["accentTab"]["radius"] == "999px" and tabs["plainTab"]["pad"] == "15px", tabs)

    # the widget resets bare <button>s; host controls must survive the move
    controls = page.evaluate("""() => {
      const pick = id => { const s = getComputedStyle(document.getElementById(id));
        return [s.backgroundColor, s.border, s.padding, s.fontSize].join('|'); };
      return { go: pick('go'), clear: pick('clear') };
    }""")
    check("host buttons keep their own styling inside the widget pane",
          "0px none" not in controls["go"] and "0px none" not in controls["clear"]
          and controls["clear"].split("|")[2] != "0px",
          controls)

    check("tablist role present", page.query_selector(".pv-tabbar[role=tablist]") is not None)
    check("tabs are buttons with role=tab and aria-selected",
          page.evaluate("""() => [...document.querySelectorAll('.pv-tab')]
            .every(t => t.tagName === 'BUTTON' && t.getAttribute('role') === 'tab'
              && t.hasAttribute('aria-selected'))"""))
    before = page.evaluate("() => document.querySelector('.pv-tab-on').textContent")
    page.focus(".pv-tab-on")
    page.keyboard.press("ArrowRight")
    after = page.evaluate("() => document.querySelector('.pv-tab-on').textContent")
    check("arrow key switches tabs", before != after, f"{before!r} -> {after!r}")
    check("interactive controls are buttons",
          page.evaluate("""() => {
            const sel = '.pv-copy, .pv-nodelink, .pv-dg-mode, .pv-minorhead';
            return [...document.querySelectorAll(sel)].every(x => x.tagName === 'BUTTON');
          }"""))

    # ---- lifecycle: destroy() and re-render observer disposal ----
    lifecycle = page.evaluate("""() => {
      const c = document.createElement('div');
      document.body.appendChild(c);
      const plan = window.PgPlan.parse(
        'Hash Join  (cost=10.00..20.00 rows=10 width=8) (actual time=0.10..1.00 rows=10 loops=1)\\n'
        + '  Hash Cond: (a.id = b.id)\\n'
        + '  ->  Seq Scan on ta a  (cost=0.00..5.00 rows=100 width=8) (actual time=0.01..0.30 rows=100 loops=1)\\n'
        + '  ->  Hash  (cost=5.00..5.00 rows=100 width=8) (actual time=0.20..0.20 rows=100 loops=1)\\n'
        + '        ->  Seq Scan on tb b  (cost=0.00..5.00 rows=100 width=8) (actual time=0.01..0.15 rows=100 loops=1)\\n'
        + 'Execution Time: 1.2 ms');
      let api = null;
      for (let i = 0; i < 4; i++) {
        api = window.PgPlanRender.render(c, plan);
        api.setTab('relations'); // instantiates the ResizeObserver
      }
      const cleanupsAfterRerenders = c.__pvCleanups ? c.__pvCleanups.length : -1;
      const hasDestroy = typeof api.destroy === 'function';
      api.destroy();
      const emptied = c.childNodes.length === 0 && !c.classList.contains('pv')
        && !c.__pvCleanups && !c.__pvTipEl;
      c.remove();
      return { cleanupsAfterRerenders, hasDestroy, emptied };
    }""")
    check("re-render disposes previous observers",
          0 <= lifecycle["cleanupsAfterRerenders"] <= 1, lifecycle)
    check("destroy() exists and clears the container",
          lifecycle["hasDestroy"] and lifecycle["emptied"], lifecycle)

    browser.close()

check("no console errors", not errors, errors[:3])
print("\n%s: %d failure(s)" % (os.path.basename(VIEWER), len(failures)))
sys.exit(1 if failures else 0)
