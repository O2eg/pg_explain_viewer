/*
 * pgplan-render.js — HTML renderer for plans parsed by pgplan.js.
 *
 * Pure JS, zero dependencies. All static styling lives in pgplan.css /
 * pgplan-theme.css; the renderer only computes data-driven heat colors,
 * reading the hue tokens from CSS custom properties so themes can retune
 * them.
 *
 * High-level API (self-contained widget with internal tabs):
 *   PgPlanRender.render(container, plan[, opts])
 *     opts.tabs       : array of pane names to show
 *                       (default: every applicable one of
 *                        'plan','advice','stats','diagram','text','query')
 *     opts.defaultTab : pane to open first (default 'plan')
 *     opts.expanded   : start with all plan nodes expanded
 *     opts.summary    : show the summary chip row (default true)
 *
 * Low-level API (render a single pane into your own layout):
 *   PgPlanRender.renderTable(container, plan, ctx, opts)
 *   PgPlanRender.renderAdvice(container, plan, ctx)
 *   PgPlanRender.renderStats(container, plan, ctx)
 *   PgPlanRender.renderDiagram(container, plan, ctx)
 *   PgPlanRender.renderText(container, plan)
 *   PgPlanRender.renderQuery(container, plan, ctx) -> {focusNode(id)}
 *   ctx is optional: { goToNode(id), setTab(name), showSql(id) } for
 *   cross-pane navigation; omit it when embedding a single pane.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.PgPlanRender = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NNBSP = ' '; // narrow no-break space, thousands separator

  /* ================= formatting ================= */

  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function groupDigits(str) {
    return str.replace(/\d{4,}(?=$|\.)/g,
      m => m.replace(/\d(?=(?:\d{3})+$)/g, '$&\u0001'))
      .replace(/\u0001/g, NNBSP);
  }

  // drop a trailing all-zero fraction: "24.000" -> "24", "24.300" -> "24.3"
  const trimZeros = s => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

  function fmtNum(v, dec) {
    if (v == null || Number.isNaN(v)) return '';
    const s = dec != null ? trimZeros(v.toFixed(dec)) : String(v);
    return groupDigits(s);
  }

  function fmtInt(v) {
    if (v == null) return '';
    return groupDigits(String(Math.round(v)));
  }

  // binary sizes with IEC (ISO/IEC 80000-13) unit symbols
  function fmtBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const v = bytes / Math.pow(1024, i);
    return trimZeros(v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2))
      + ' ' + units[i];
  }

  function fmtRatio(r) {
    if (r === Infinity) return '∞';
    const units = ['', 'K', 'M', 'G', 'T'];
    let i = 0;
    while (r >= 1000 && i < units.length - 1) { r /= 1000; i++; }
    return (i || !Number.isInteger(r) ? r.toFixed(1).replace(/\.0$/, '') : String(r)) + units[i];
  }

  function fmtMs(v) {
    if (v == null) return '—';
    if (v >= 60000) {
      const m = Math.floor(v / 60000);
      const s = trimZeros(((v % 60000) / 1000).toFixed(1));
      return s === '0' ? m + ' min' : m + ' min ' + s + ' s';
    }
    if (v >= 1000) return trimZeros((v / 1000).toFixed(2)) + ' s';
    return fmtNum(v, 3) + ' ms';
  }

  /* ================= theme hues ================= */

  const HUE_DEFAULTS = {
    hot: 0, warm: 60, incl: 120, loops: 240, over: 0, under: 240,
    'buf-hit': 120, 'buf-read': 0, 'buf-dirtied': 300, 'buf-written': 240,
    sat: 85, light: 42,
  };

  function themeHues(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const k of Object.keys(HUE_DEFAULTS)) {
      const v = parseFloat(cs.getPropertyValue('--pv-hue-' + k));
      out[k] = Number.isNaN(v) ? HUE_DEFAULTS[k] : v;
    }
    return out;
  }

  const heat = (hues, hue, alpha) =>
    `hsla(${hue}, ${hues.sat}%, ${hues.light}%, ${alpha.toFixed(3)})`;

  const heatWarm = (hues, r, alpha) =>
    heat(hues, hues.warm - (hues.warm - hues.hot) * r, alpha != null ? alpha : 0.1 + 0.9 * r);

  /* ================= node text markup ================= */

  const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function markupHead(node) {
    let html = esc(node.head);
    const wrap = (val, cls) => {
      if (!val) return;
      const re = new RegExp('(^|[\\s.])(' + reEscape(esc(val)) + ')(?=[\\s:.]|$)');
      html = html.replace(re, (m, p1, p2) => p1 + '<span class="' + cls + '">' + p2 + '</span>');
    };
    wrap(node.spec ? node.spec : node.rawType, 'pv-t-type');
    wrap(node.index, 'pv-t-index');
    wrap(node.relation, 'pv-t-rel');
    if (node.alias && node.alias !== node.relation) wrap(node.alias, 'pv-t-alias');
    if (node.spec && node.specName) {
      const re = new RegExp('(' + reEscape(esc(node.specName)) + ')(?=$)');
      html = html.replace(re, '<span class="pv-t-rel">$1</span>');
    }
    return html;
  }

  // highlight numbers in already-escaped text (no lookbehind: the leading
  // non-word character is captured and re-emitted, widening browser support)
  function markupNumbers(escd, numCls) {
    return escd.replace(
      /(&#?\w+;)|('(?:[^'\\]|\\.)*')|(^|[^\w.])(-?\d+(?:\.\d+)?)/g,
      (m, ent, str, pre, num) => {
        if (ent) return ent;
        if (str) return '<span class="pv-s">' + str + '</span>';
        return pre + '<span class="' + (numCls || 'pv-n') + '">'
          + num.replace(/\d(?=(?:\d{3})+(?:$|\.))/g, '$&<span class="pv-dv">′</span>')
          + '</span>';
      });
  }

  // highlight a full attribute/detail line
  function markupDetailLine(line) {
    const attr = line.split(':')[0].trim();
    const isCond = /Filter$|Cond$|^Order By$/.test(attr);
    return markupNumbers(esc(line), isCond ? 'pv-n2' : 'pv-n');
  }

  /* ================= shared helpers ================= */

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function pulse(row) {
    row.classList.remove('pv-pulse');
    void row.offsetWidth; // restart animation
    row.classList.add('pv-pulse');
    setTimeout(() => row.classList.remove('pv-pulse'), 1600);
  }

  /* ---- custom tooltips (replace native title attributes) ----
   * Elements opt in via data-pv-tip; one delegated listener + one themed
   * tooltip element per widget container. Works for HTML and SVG targets. */

  const tip = (elm, text) => { if (text) elm.setAttribute('data-pv-tip', text); };

  function bindTooltips(container) {
    if (container.__pvTipEl) {
      // a re-render may have wiped the container — re-attach the tooltip
      if (!container.contains(container.__pvTipEl)) {
        container.appendChild(container.__pvTipEl);
      }
      return;
    }
    const tt = el('div', 'pv-tooltip');
    tt.hidden = true;
    container.appendChild(tt);
    container.__pvTipEl = tt;
    let anchor = null, timer = null;

    const hide = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      anchor = null;
      tt.hidden = true;
    };
    const place = (x, y) => {
      tt.style.left = '0px'; tt.style.top = '0px';
      const w = tt.offsetWidth, h = tt.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      let left = x + 14, top = y + 16;
      if (left + w + 8 > vw) left = Math.max(8, x - w - 10);
      if (top + h + 8 > vh) top = Math.max(8, y - h - 12);
      tt.style.left = left + 'px';
      tt.style.top = top + 'px';
    };
    const onOver = e => {
      const t = e.target.closest && e.target.closest('[data-pv-tip]');
      if (!t || !container.contains(t)) { if (!tt.contains(e.target)) hide(); return; }
      if (t === anchor) return;
      anchor = t;
      if (timer) clearTimeout(timer);
      const x = e.clientX, y = e.clientY;
      timer = setTimeout(() => {
        if (anchor !== t) return;
        tt.textContent = t.getAttribute('data-pv-tip');
        tt.hidden = false;
        place(x, y);
      }, 160);
    };
    const onMove = e => {
      if (!tt.hidden && anchor) place(e.clientX, e.clientY);
    };
    container.addEventListener('mouseover', onOver);
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', hide);
    container.addEventListener('mousedown', hide);
    document.addEventListener('scroll', hide, { passive: true, capture: true });
    // full teardown: all four container listeners, the document-level
    // scroll listener and the tooltip element itself
    container.__pvTipCleanup = () => {
      hide();
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', hide);
      container.removeEventListener('mousedown', hide);
      document.removeEventListener('scroll', hide, { capture: true });
      if (container.__pvTipEl && container.__pvTipEl.parentNode) {
        container.__pvTipEl.remove();
      }
      delete container.__pvTipEl;
      delete container.__pvTipCleanup;
    };
  }

  let instanceSeq = 0; // per-widget id prefix: multiple widgets on one page

  // real <button> for interactive controls (keyboard + screen readers)
  function btn(cls, parent) {
    const b = el('button', cls, parent);
    b.type = 'button';
    return b;
  }

  // keyboard operability for elements that cannot be <button> (th, svg g)
  function keyable(elm, handler) {
    elm.setAttribute('role', 'button');
    elm.setAttribute('tabindex', '0');
    elm.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(e); }
    });
  }

  /* ================= canvas pan & zoom ================= */

  // drag-to-pan on a scroll container. A press that never crosses the
  // threshold stays a click (node navigation keeps working); once it does,
  // the pointer is captured and the trailing click is swallowed.
  function attachPan(scrollEl) {
    let sx = 0, sy = 0, sl = 0, st = 0, active = false, moved = false;
    scrollEl.classList.add('pv-pan');
    scrollEl.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      active = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      sl = scrollEl.scrollLeft; st = scrollEl.scrollTop;
    });
    scrollEl.addEventListener('pointermove', e => {
      if (!active) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!moved) {
        moved = true;
        scrollEl.classList.add('pv-grabbing');
        try { scrollEl.setPointerCapture(e.pointerId); } catch (err) { /* detached */ }
      }
      scrollEl.scrollLeft = sl - dx;
      scrollEl.scrollTop = st - dy;
      e.preventDefault();
    });
    const end = () => { active = false; scrollEl.classList.remove('pv-grabbing'); };
    scrollEl.addEventListener('pointerup', end);
    scrollEl.addEventListener('pointercancel', end);
    scrollEl.addEventListener('click', e => {
      if (moved) { moved = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  // − / + buttons with an animated zoom anchored to the viewport centre.
  // applyScale(z) resizes the pane content for scale z; it is called every
  // animation frame, so it must be cheap and idempotent.
  function attachZoom(head, scrollEl, applyScale) {
    const group = el('div', 'pv-zoom', head);
    let z = 1, zTarget = 1, anim = null;
    const zoomTo = target => {
      target = Math.min(4, Math.max(0.25, target));
      zTarget = target;
      const from = z;
      if (anim) cancelAnimationFrame(anim);
      const cx = (scrollEl.scrollLeft + scrollEl.clientWidth / 2) / from;
      const cy = (scrollEl.scrollTop + scrollEl.clientHeight / 2) / from;
      const t0 = performance.now(), DUR = 180;
      const step = now => {
        const t = Math.min(1, (now - t0) / DUR);
        const e = 1 - (1 - t) * (1 - t); // ease-out
        z = from + (target - from) * e;
        applyScale(z);
        scrollEl.scrollLeft = cx * z - scrollEl.clientWidth / 2;
        scrollEl.scrollTop = cy * z - scrollEl.clientHeight / 2;
        anim = t < 1 ? requestAnimationFrame(step) : null;
      };
      anim = requestAnimationFrame(step);
    };
    const mk = (label, factor, name) => {
      const b = btn('pv-dg-mode pv-zoom-btn', group);
      b.textContent = label;
      b.setAttribute('aria-label', name);
      tip(b, name);
      // rapid clicks compound from the target, not the mid-animation value
      b.addEventListener('click', () => zoomTo(zTarget * factor));
    };
    mk('−', 1 / 1.4, 'zoom out');
    mk('+', 1.4, 'zoom in');
  }

  function nodeLink(ctx, id, label) {
    const a = btn('pv-nodelink');
    a.textContent = label != null ? label : '#' + id;
    tip(a, 'go to plan node #' + id);
    a.addEventListener('click', e => {
      e.stopPropagation();
      ctx.goToNode(id);
    });
    return a;
  }

  const nodeAbbr = n => {
    if (n.spec) return n.spec;
    const a = n.nodeType.replace(/[a-z ()]+/g, '');
    return a === 'IOS' ? 'IS' : a || n.nodeType.slice(0, 2);
  };

  /* ================= plan table ================= */

  function metricCell(cls, val, max, color, opts) {
    opts = opts || {};
    const td = el('td', 'pv-c ' + (cls || ''));
    if (val == null || val === 0 || !max) return td;
    const r = val / max;
    if (r > 0.05 && color) {
      const bar = el('div', 'pv-bar', td);
      bar.style.width = Math.min(100, Math.round(r * 100)) + '%';
      bar.style.background = color;
    }
    const dv = el('div', 'pv-val', td);
    dv.textContent = opts.dec != null ? fmtNum(val, opts.dec) : fmtInt(val);
    if (opts.sub) {
      const sub = el('div', 'pv-sub', td);
      sub.textContent = opts.sub;
    }
    if (opts.title) tip(td, opts.title);
    return td;
  }

  const emptyCell = cls => el('td', 'pv-c ' + (cls || ''));

  const BUF_ABBR = {
    shared: 'sh', local: 'lc', temp: 'tm',
    hit: 'ht', read: 'rd', dirtied: 'dr', written: 'wr',
  };

  function renderTable(container, plan, ctx, opts) {
    const uid = 'pv' + (++instanceSeq);
    opts = opts || {};
    ctx = ctx || makeLocalCtx(container);
    bindTooltips(container.closest('.pv') || container);
    const hues = themeHues(container);
    const max = plan.max, cols = plan.columns, totals = plan.totals;
    const hasAdvice = plan.advice && plan.advice.some(a => a.nodes.length);

    const wrap = el('div', 'pv-tablewrap', container);
    const table = el('table', 'pv-table', wrap);

    // hottest node per metric, for header click navigation
    const hotBy = {};
    const trackHot = (key, val, id) => {
      if (val == null || val <= 0) return;
      if (!hotBy[key] || val > hotBy[key].val) hotBy[key] = { val, id };
    };
    for (const n of plan.nodes) {
      if (n.spec) continue;
      trackHot('timeExcl', n.timeExcl, n.id);
      trackHot('ioRead', n.ioReadExcl, n.id);
      trackHot('ioWrite', n.ioWriteExcl, n.id);
      trackHot('rows', n.rowsTotal, n.id);
      trackHot('rowsRemoved', n.rowsRemovedTotal, n.id);
      trackHot('loops', n.loops != null && n.loops > 1 ? n.loops : null, n.id);
      trackHot('ratio', n.ratio === Infinity ? 1e12 : n.ratio, n.id);
      trackHot('cost', n.costExcl, n.id);
      for (const k of cols.buf) trackHot('buf:' + k, n.bufExcl[k], n.id);
    }

    const thead = el('thead', null, table);
    const hrow = el('tr', null, thead);
    const th = (label, title, hotKey, cls) => {
      const e = el('th', cls, hrow);
      e.innerHTML = label;
      if (title) tip(e, title);
      if (hotKey && hotBy[hotKey]) {
        e.classList.add('pv-th-hot');
        tip(e, (title ? title + ' — ' : '') + 'click: go to the hottest node (#'
          + hotBy[hotKey].id + ')');
        const go = () => ctx.goToNode(hotBy[hotKey].id);
        e.addEventListener('click', go);
        keyable(e, go);
      }
      return e;
    };
    th('#', 'plan node number');
    if (cols.cost) th('cost', 'planner cost of the node itself (children excluded)', 'cost');
    if (cols.estRows) th('est rows', 'planner row estimate');
    if (cols.time) th('node, ms', 'node self time (children excluded)', 'timeExcl');
    if (cols.ioRead) th('io.rd, ms', 'I/O read time (self)', 'ioRead');
    if (cols.ioWrite) th('io.wr, ms', 'I/O write time (self)', 'ioWrite');
    if (cols.time) th('tree, ms', 'node time including its subtree');
    if (cols.rows) th('rows', 'rows returned × loops', 'rows');
    if (cols.ratio) th('ratio', 'estimated vs actual rows: ↑ underestimated, ↓ overestimated', 'ratio');
    if (cols.rowsRemoved) th('rows removed', 'Rows Removed by Filter × loops', 'rowsRemoved');
    if (cols.filter) th('<span class="pv-flt-ico">⚲</span>', 'node has filter / condition');
    if (cols.loops) th('loops', 'number of node executions', 'loops');
    if (hasAdvice) th('', 'recommendations');
    const thNode = th('node', null, null, 'pv-h-node');
    for (const k of cols.buf) {
      const [kind, type] = k.split('-');
      th(BUF_ABBR[kind] + '.' + BUF_ABBR[type],
        'buffers ' + kind + ' ' + type + ' (self), 8KB blocks', 'buf:' + k);
    }

    const tbody = el('tbody', null, table);

    // expand/collapse-all toggle in the node header
    const toggleAll = btn('pv-toggle-all');
    toggleAll.textContent = '▸';
    tip(toggleAll, 'expand / collapse all nodes');
    thNode.prepend(toggleAll);

    /* ---- totals row ---- */
    const totRow = el('tr', 'pv-row-total', tbody);
    totRow.appendChild(emptyCell('pv-num'));
    if (cols.cost) {
      const td = emptyCell('pv-r');
      const root = plan.nodes[0];
      if (root && root.costTotal != null) td.textContent = fmtNum(root.costTotal, 2);
      totRow.appendChild(td);
    }
    if (cols.estRows) totRow.appendChild(emptyCell());
    if (cols.time) totRow.appendChild(emptyCell());
    if (cols.ioRead) {
      const td = emptyCell('pv-r');
      td.textContent = totals.ioRead ? fmtNum(totals.ioRead, 3) : '';
      totRow.appendChild(td);
    }
    if (cols.ioWrite) {
      const td = emptyCell('pv-r');
      td.textContent = totals.ioWrite ? fmtNum(totals.ioWrite, 3) : '';
      totRow.appendChild(td);
    }
    if (cols.time) {
      const td = emptyCell('pv-r');
      td.textContent = totals.time != null ? fmtNum(totals.time, 3) : '';
      totRow.appendChild(td);
    }
    if (cols.rows) {
      const td = emptyCell('pv-r');
      td.textContent = totals.rows ? fmtInt(totals.rows) : '';
      totRow.appendChild(td);
    }
    if (cols.ratio) totRow.appendChild(emptyCell());
    if (cols.rowsRemoved) {
      const td = emptyCell('pv-r');
      td.textContent = totals.rowsRemoved ? fmtInt(totals.rowsRemoved) : '';
      totRow.appendChild(td);
    }
    if (cols.filter) totRow.appendChild(emptyCell());
    if (cols.loops) totRow.appendChild(emptyCell());
    if (hasAdvice) totRow.appendChild(emptyCell());
    {
      const td = emptyCell('pv-nodecell');
      const root = plan.nodes[0];
      let txt = 'result';
      if (root && root.rowsTotal && root.planWidth != null) {
        txt += ': ' + fmtInt(root.rowsTotal) + ' rows × ' + root.planWidth + ' B ≈ '
          + fmtBytes(root.rowsTotal * root.planWidth);
      } else if (root && root.rowsTotal) {
        txt += ': ' + fmtInt(root.rowsTotal) + ' rows';
      }
      el('span', 'pv-total-label', td).textContent = txt;
      const readBlocks = (totals.buf['shared-read'] || 0) + (totals.buf['local-read'] || 0)
        + (totals.buf['temp-read'] || 0);
      if (totals.ioRead && readBlocks) {
        el('span', 'pv-total-io', td).textContent =
          'avg read ' + fmtBytes(readBlocks * 8192 / (totals.ioRead / 1000)) + '/s';
      }
      totRow.appendChild(td);
    }
    for (const k of cols.buf) {
      const td = emptyCell('pv-r pv-bufcell');
      if (totals.buf[k]) {
        td.textContent = fmtInt(totals.buf[k]);
        tip(td, 'Σ ' + k.replace('-', ' ') + ' · ' + fmtBytes(totals.buf[k] * 8192));
      }
      totRow.appendChild(td);
    }

    /* ---- node rows ---- */
    const rowsByNode = [];
    for (const n of plan.nodes) {
      const tr = el('tr', 'pv-row' + (n.spec ? ' pv-row-spec' : ''), tbody);
      tr.dataset.node = String(n.id);
      tr.dataset.depth = String(n.depth);
      tr.id = uid + '-node-' + n.id;
      const hot = n.timeExcl != null && max.timeExcl > 0 && n.timeExcl / max.timeExcl >= 0.1;
      if (!n.spec && !hot) tr.classList.add('pv-row-cool');
      if (n.never || n.loops === 0) tr.classList.add('pv-row-never');

      // #
      {
        const td = emptyCell('pv-num');
        td.textContent = String(n.id);
        tip(td, 'node #' + n.id);
        tr.appendChild(td);
      }

      // cost / est rows (EXPLAIN without ANALYZE)
      if (cols.cost) {
        if (!n.spec && n.costExcl != null && n.costExcl > 0) {
          const r = max.costExcl ? n.costExcl / max.costExcl : 0;
          const color = r >= 0.1 ? heatWarm(hues, r) : null;
          tr.appendChild(metricCell('', n.costExcl, max.costExcl, color,
            { dec: 2, title: 'total cost ' + fmtNum(n.costTotal, 2) }));
        } else tr.appendChild(emptyCell());
      }
      if (cols.estRows) {
        const td = emptyCell('pv-r');
        if (!n.spec && n.planRows != null) td.textContent = fmtInt(n.planRows);
        tr.appendChild(td);
      }

      // node ms (excl)
      if (cols.time) {
        if (!n.spec && n.timeExcl != null) {
          const r = max.timeExcl ? n.timeExcl / max.timeExcl : 0;
          const color = r >= 0.1 ? heatWarm(hues, r) : null;
          const title = n.exclClamped
            ? 'self time clamped: children overlap by ' + fmtNum(n.exclClamped, 3) + ' ms'
            : (max.timeExcl ? fmtNum(100 * r, 1) + '% of the hottest node' : null);
          tr.appendChild(metricCell('pv-t-excl', n.timeExcl, max.timeExcl, color, {
            dec: 3, title,
            sub: n.parallelTime != null ? '∑' + fmtNum(n.parallelTime, 3) : null,
          }));
        } else tr.appendChild(emptyCell());
      }
      // io read / write
      if (cols.ioRead) {
        const v = n.spec ? null : n.ioReadExcl;
        if (v) {
          const r = v / max.ioRead;
          const color = r >= 0.1 ? heatWarm(hues, r) : null;
          const readB = ((n.bufExcl['shared-read'] || 0) + (n.bufExcl['local-read'] || 0)
            + (n.bufExcl['temp-read'] || 0)) * 8192;
          tr.appendChild(metricCell('', v, max.ioRead, color, {
            dec: 3,
            sub: readB ? fmtBytes(readB / (v / 1000)) + '/s' : null,
          }));
        } else tr.appendChild(emptyCell());
      }
      if (cols.ioWrite) {
        const v = n.spec ? null : n.ioWriteExcl;
        if (v) {
          const r = v / max.ioWrite;
          const color = r >= 0.1 ? heatWarm(hues, r) : null;
          const wrB = ((n.bufExcl['shared-written'] || 0) + (n.bufExcl['local-written'] || 0)
            + (n.bufExcl['temp-written'] || 0)) * 8192;
          tr.appendChild(metricCell('', v, max.ioWrite, color, {
            dec: 3,
            sub: wrB ? fmtBytes(wrB / (v / 1000)) + '/s' : null,
          }));
        } else tr.appendChild(emptyCell());
      }
      // tree ms (incl)
      if (cols.time) {
        if (n.timeIncl != null) {
          const r = max.timeIncl ? n.timeIncl / max.timeIncl : 0;
          const color = r >= 0.1 ? heat(hues, hues.incl, 0.1 + 0.9 * r) : null;
          const td = metricCell('pv-t-incl', n.timeIncl, max.timeIncl, color, { dec: 3 });
          if (n.spec) td.classList.add('pv-spec-val');
          tr.appendChild(td);
        } else tr.appendChild(emptyCell());
      }
      // rows
      if (cols.rows) {
        if (!n.spec && n.rowsTotal) {
          const r = n.rowsTotal / max.rows;
          const color = n.rowsTotal > 1 && r >= 0.01 ? heatWarm(hues, r) : null;
          tr.appendChild(metricCell('', n.rowsTotal, max.rows, color, {}));
        } else tr.appendChild(emptyCell());
      }
      // ratio
      if (cols.ratio) {
        const td = emptyCell('pv-r pv-ratio');
        if (!n.spec && n.ratio != null) {
          const r = n.ratio;
          const a = r === Infinity ? 1
            : max.ratio > 1 ? 0.25 + 0.75 * Math.min(1, Math.log(r) / Math.log(max.ratio)) : 0.6;
          td.style.color = heat(hues, n.ratioDir > 0 ? hues.under : hues.over, a);
          td.innerHTML = esc(fmtRatio(r))
            + '<span class="pv-arrow">' + (n.ratioDir > 0 ? '↑' : '↓') + '</span>';
          tip(td, 'estimated ' + fmtInt(n.planRows) + ' rows, actual '
            + fmtInt(n.rows) + (n.ratioDir > 0 ? ' — underestimated' : ' — overestimated'));
        } else if (!n.spec && n.planRows != null && n.rows != null && !n.never) {
          td.innerHTML = '<span class="pv-ratio-ok">――</span>';
          tip(td, 'estimate matches actual rows');
        }
        tr.appendChild(td);
      }
      // rows removed
      if (cols.rowsRemoved) {
        if (!n.spec && n.rowsRemovedTotal) {
          const r = n.rowsRemovedTotal / max.rowsRemoved;
          const color = heatWarm(hues, r, 0.1 + 0.9 * Math.max(r, 0.3));
          tr.appendChild(metricCell('', n.rowsRemovedTotal, max.rowsRemoved, color, {}));
        } else tr.appendChild(emptyCell());
      }
      // filter indicator
      if (cols.filter) {
        const td = emptyCell('pv-flt');
        if (!n.spec && n.filters.length && n.loops !== 0) {
          const dot = el('span', 'pv-flt-dot', td);
          const kept = n.rows || 0, rem = n.rowsRemoved || 0;
          let selRatio = null;
          if (kept + rem > 0) selRatio = kept / (kept + rem);
          if (selRatio == null) dot.classList.add('pv-flt-na');
          else dot.style.background = heat(hues, selRatio * 120, 0.9);
          tip(dot, (selRatio != null
            ? fmtNum(100 * (1 - selRatio), 1) + '% rows discarded\n' : '')
            + n.filters.map(f => f.key + ': ' + f.val).join('\n'));
        }
        tr.appendChild(td);
      }
      // loops
      if (cols.loops) {
        const td = emptyCell('pv-r pv-loops');
        if (!n.spec && n.loops != null && n.loops !== 1) {
          if (n.loops === 0) {
            td.textContent = 'never';
          } else {
            td.textContent = fmtInt(n.loops);
            const a = 0.75 * Math.max(
              max.loops > 1 ? Math.log(n.loops) / Math.log(max.loops) : 1, 0.3);
            td.style.color = heat(hues, hues.loops, a);
            if (n.gatherWorkers > 1) {
              el('div', 'pv-sub', td).textContent = '÷' + n.gatherWorkers + ' wrk';
            }
          }
        }
        tr.appendChild(td);
      }
      // advice badges
      if (hasAdvice) {
        const td = emptyCell('pv-adv');
        if (n.advice) {
          const seen = new Set();
          for (const a of n.advice) {
            if (seen.has(a.code)) continue;
            seen.add(a.code);
            const b = btn('pv-badge pv-sev-' + a.sev, td);
            b.textContent = a.badge;
            tip(b, a.code + ': ' + a.obs + '\nclick for details');
            b.addEventListener('click', e => {
              e.stopPropagation();
              ctx.setTab('advice', n.id);
            });
          }
        }
        tr.appendChild(td);
      }
      // node
      {
        const td = emptyCell('pv-nodecell');
        const line = el('div', 'pv-nodeline', td);
        for (let d = 0; d < n.depth; d++) {
          const g = el('span', 'pv-guide', line);
          g.dataset.g = String(d);
        }
        const body = el('div', 'pv-nodebody', line);
        const headEl = el('div', 'pv-nodehead', body);
        headEl.innerHTML = (n.id > 0 && !n.spec ? '<span class="pv-arrowpfx">→ </span>' : '')
          + markupHead(n);
        if (n.lines.length) {
          const det = el('div', 'pv-nodedetail', body);
          det.innerHTML = n.lines.map(l => markupDetailLine(l)).join('\n');
          det.hidden = true;
          tr.classList.add('pv-has-detail');
          tr.tabIndex = 0;
        }
        tr.appendChild(td);
      }
      // buffers
      for (const k of cols.buf) {
        const v = n.spec ? null : n.bufExcl[k];
        if (v) {
          const [kind, type] = k.split('-');
          const color = heat(hues, hues['buf-' + type], 0.1 + 0.9 * (v / max.buf[k]));
          tr.appendChild(metricCell('pv-bufcell', v, max.buf[k], color, {
            title: kind + ' ' + type,
            sub: fmtBytes(v * 8192),
          }));
        } else tr.appendChild(emptyCell('pv-bufcell'));
      }

      rowsByNode.push(tr);
    }

    /* ---- ext rows (Planning Time / Execution Time / JIT / ...) ---- */
    const addExtRow = (label, timeVal, detailLines) => {
      const tr = el('tr', 'pv-row pv-row-ext', tbody);
      tr.appendChild(emptyCell('pv-num'));
      if (cols.cost) tr.appendChild(emptyCell());
      if (cols.estRows) tr.appendChild(emptyCell());
      if (cols.time) {
        const td = emptyCell('pv-r');
        if (timeVal != null) td.textContent = fmtNum(timeVal, 3);
        tr.appendChild(td);
      }
      if (cols.ioRead) tr.appendChild(emptyCell());
      if (cols.ioWrite) tr.appendChild(emptyCell());
      if (cols.time) tr.appendChild(emptyCell());
      if (cols.rows) tr.appendChild(emptyCell());
      if (cols.ratio) tr.appendChild(emptyCell());
      if (cols.rowsRemoved) tr.appendChild(emptyCell());
      if (cols.filter) tr.appendChild(emptyCell());
      if (cols.loops) tr.appendChild(emptyCell());
      if (hasAdvice) tr.appendChild(emptyCell());
      const td = emptyCell('pv-nodecell');
      const body = el('div', 'pv-nodebody', td);
      el('div', 'pv-nodehead pv-ext-head', body).textContent = label;
      if (detailLines && detailLines.length) {
        const det = el('div', 'pv-nodedetail', body);
        det.innerHTML = detailLines.map(l => markupDetailLine(l)).join('\n');
        det.hidden = true;
        tr.classList.add('pv-has-detail');
          tr.tabIndex = 0;
      }
      tr.appendChild(td);
      for (const k of cols.buf) tr.appendChild(emptyCell('pv-bufcell')); // eslint-disable-line
    };
    for (const t of plan.triggers) addExtRow(t.line, t.time, null);
    for (const e of plan.ext) {
      let tm = e.time != null ? e.time : null;
      if (e.key === 'Execution Time' && tm != null && totals.time != null) {
        // show the overhead beyond the root node in the self-time column
        tm = Math.max(0, Math.round((tm - totals.time) * 1000) / 1000);
      }
      addExtRow(e.lines[0], tm, e.lines.length > 1 ? e.lines.slice(1) : null);
    }

    /* ---- interactions ---- */

    let allExpanded = false;
    const setRow = (tr, on) => {
      const det = tr.querySelector('.pv-nodedetail');
      if (det) det.hidden = !on;
      tr.classList.toggle('pv-expanded', on);
    };
    const setAll = on => {
      allExpanded = on;
      toggleAll.textContent = on ? '▾' : '▸';
      for (const tr of tbody.querySelectorAll('tr.pv-has-detail')) setRow(tr, on);
    };
    toggleAll.addEventListener('click', e => { e.stopPropagation(); setAll(!allExpanded); });

    tbody.addEventListener('click', e => {
      if (getSelection && String(getSelection())) return; // text selection, not a toggle
      const tr = e.target.closest('tr.pv-has-detail');
      if (!tr || !tbody.contains(tr)) return;
      const det = tr.querySelector('.pv-nodedetail');
      setRow(tr, det ? det.hidden : false);
    });
    tbody.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest && e.target.closest('tr.pv-has-detail');
      if (!tr || !tbody.contains(tr) || e.target !== tr) return;
      e.preventDefault();
      const det = tr.querySelector('.pv-nodedetail');
      setRow(tr, det ? det.hidden : false);
    });

    // subtree highlight on hover
    tbody.addEventListener('mouseover', e => {
      const tr = e.target.closest('tr.pv-row');
      if (!tr || tr.dataset.node == null) return;
      clearHl();
      const id = Number(tr.dataset.node);
      const depth = Number(tr.dataset.depth);
      for (let j = id + 1; j < plan.nodes.length; j++) {
        if (plan.nodes[j].depth <= depth) break;
        const guides = rowsByNode[j].querySelectorAll('.pv-guide');
        const g = guides[depth];
        if (g) g.classList.add(plan.nodes[j].depth === depth + 1 ? 'pv-guide-hl' : 'pv-guide-hl2');
      }
    });
    tbody.addEventListener('mouseleave', clearHl);
    function clearHl() {
      for (const g of tbody.querySelectorAll('.pv-guide-hl, .pv-guide-hl2')) {
        g.classList.remove('pv-guide-hl', 'pv-guide-hl2');
      }
    }

    if (opts.expanded) setAll(true);

    return {
      goToNode(id, expand) {
        const tr = rowsByNode[id];
        if (!tr) return;
        if (expand !== false) setRow(tr, true);
        tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        pulse(tr);
      },
    };
  }

  /* ================= SQL highlighting (highlight.js, optional) ========= */

  // Uses the same library as the pg_diag report (highlight.js); the widget
  // works without it — SQL is then shown as plain text.
  function sqlHtml(sql) {
    const hl = (typeof self !== 'undefined' && self.hljs) || null;
    if (hl) {
      try { return hl.highlight(sql, { language: 'sql' }).value; }
      catch (e) { /* fall through */ }
    }
    return esc(sql);
  }

  /* ================= plan text pane ================= */

  function renderText(container, plan) {
    const pre = el('pre', 'pv-text', container);
    const out = [];
    for (const n of plan.nodes) {
      const pad = ' '.repeat(n.indent);
      const arrow = n.id > 0 && !n.spec ? '<span class="pv-arrowpfx">-&gt;  </span>' : '';
      let head = markupHead(n);
      const raw = n.rawHead || n.head;
      if (raw.length > n.head.length && raw.startsWith(n.head)) {
        head += markupNumbers(esc(raw.slice(n.head.length)));
      }
      out.push(pad + arrow + head);
      const dpad = ' '.repeat(n.indent + (n.spec ? 2 : 6));
      for (const l of n.lines) out.push(dpad + markupDetailLine(l));
    }
    for (const t of plan.triggers) out.push(markupDetailLine(t.line));
    for (const e of plan.ext) for (const l of e.lines) out.push(markupDetailLine(l));
    pre.innerHTML = out.join('\n');
  }

  /* ================= query pane ================= */

  // Wrap [s, e) of the pane's text content in a <mark>. The pane holds
  // highlight.js markup, so the range is applied per text node instead of
  // through Range.surroundContents, which refuses partially covered elements.
  function markSpan(root, s, e) {
    if (!(e > s) || typeof document === 'undefined') return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const jobs = [];
    let pos = 0, node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      const a = Math.max(s, pos), b = Math.min(e, pos + len);
      if (b > a) jobs.push({ node, from: a - pos, to: b - pos });
      pos += len;
      if (pos >= e) break;
    }
    let first = null;
    for (const j of jobs) {
      let t = j.node;
      if (j.to < t.nodeValue.length) t.splitText(j.to);
      if (j.from > 0) t = t.splitText(j.from);
      const mk = document.createElement('mark');
      mk.className = 'pv-sqlmark';
      t.replaceWith(mk);
      mk.appendChild(t);
      if (!first) first = mk;
    }
    return first;
  }

  function clearMarks(root) {
    for (const m of [...root.querySelectorAll('.pv-sqlmark')]) {
      m.replaceWith(document.createTextNode(m.textContent));
    }
    root.normalize();
  }

  function renderQuery(container, plan, ctx) {
    const pre = el('pre', 'pv-text pv-query pv-sql', container);
    if (!plan.query) {
      pre.textContent = '— no query text in the input —';
      return {};
    }
    pre.innerHTML = sqlHtml(plan.query);
    const note = el('div', 'pv-sqlnote', container);
    note.hidden = true;
    return {
      focusNode(id) {
        const n = plan.nodes[id];
        clearMarks(pre);
        note.hidden = true;
        if (!n || !n.sqlSpan) return false;
        const mk = markSpan(pre, n.sqlSpan.s, n.sqlSpan.e);
        if (!mk) return false;
        mk.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (n.sqlSpan.ambiguous) {
          note.hidden = false;
          note.textContent = 'this alias appears more than once in the query — '
            + 'the first occurrence is highlighted';
        }
        return true;
      },
    };
  }

  /* ================= domain pane ================= */

  function renderDomain(container, plan) {
    const pre = el('pre', 'pv-text', container);
    pre.innerHTML = (plan.domain || []).map(l => esc(l)
      .replace(/(Scan \w+( \w+)?|Join|Subquery|Insert|Update|Delete|Merge)( |$)/,
        '<span class="pv-t-type">$1</span>$3'))
      .join('\n') || '—';
  }

  /* ================= stats pane ================= */

  /* ================= diagnostics pane ================= */

  // What the reader has to know before trusting the numbers: model
  // adjustments AND the EXPLAIN options whose absence limits the analysis.
  // Both answer the same question, so they belong on the same pane.
  function diagItems(plan) {
    const items = (plan.diagnostics || []).slice();
    for (const c of (plan.coaching || [])) {
      items.push({
        code: 'missing_option',
        severity: 'info',
        message: 'Re-run with EXPLAIN (' + c.option + '): ' + c.reason,
        count: 1,
        samples: c.warning ? [c.warning] : [],
      });
    }
    return items;
  }

  function renderDiagnostics(container, plan, ctx) {
    ctx = ctx || makeLocalCtx(container);
    bindTooltips(container.closest('.pv') || container);
    const list = el('div', 'pv-diaglist', container);
    // warnings (trust-affecting) first, notes after; stable within a group
    const diags = diagItems(plan)
      .sort((a, b) => (a.severity === 'warn' ? 0 : 1) - (b.severity === 'warn' ? 0 : 1));
    for (const d of diags) {
      const item = el('div', 'pv-diagitem pv-diagitem-' + d.severity, list);
      const ico = el('span', 'pv-diag-ico pv-diag-ico-' + d.severity, item);
      ico.textContent = d.severity === 'warn' ? '!' : 'i';
      tip(ico, d.severity === 'warn'
        ? 'warning: affects how much to trust the numbers'
        : 'note: a model adjustment or approximation');
      const body = el('div', 'pv-diagbody', item);
      const head = el('div', 'pv-diaghead', body);
      el('span', 'pv-diagcode', head).textContent = d.code;
      if (d.count > 1) {
        const c = el('span', 'pv-diagcount', head);
        c.textContent = '×' + d.count;
        tip(c, d.count + ' occurrences');
      }
      el('div', 'pv-diagmsg', body).textContent = d.message;
      if (d.nodes && d.nodes.length) {
        const nl = el('div', 'pv-diagnodes', body);
        el('span', 'pv-diagnodes-l', nl).textContent = 'nodes';
        for (const id of d.nodes) nl.appendChild(nodeLink(ctx, id));
        if (d.count > d.nodes.length) {
          el('span', 'pv-diagmore', nl).textContent =
            '+' + (d.count - d.nodes.length) + ' more';
        }
      }
      if (d.samples && d.samples.length) {
        const sm = el('div', 'pv-diagsamples', body);
        for (const s of d.samples) el('div', 'pv-diagsample', sm).textContent = s;
      }
    }
  }

  function renderStats(container, plan, ctx) {
    ctx = ctx || makeLocalCtx(container);
    bindTooltips(container.closest('.pv') || container);
    const hues = themeHues(container);
    const stats = plan.stats || [];
    if (!stats.length) { el('div', 'pv-empty', container).textContent = 'no data'; return; }

    const bufCols = plan.columns.buf;
    const hasTime = stats.some(g => g.time > 0);
    const hasIo = stats.some(g => g.ioRead > 0);
    const hasRR = stats.some(g => g.rowsRemoved > 0);
    const hasLoops = stats.some(g => g.loops > g.ids.length);
    const wrap = el('div', 'pv-tablewrap', container);
    const table = el('table', 'pv-table pv-stat', wrap);
    const thead = el('thead', null, table);
    const hrow = el('tr', null, thead);

    const columns = [];
    const addCol = (label, title, sortKey, render) => {
      const e = el('th', sortKey ? 'pv-th-sort' : null, hrow);
      e.textContent = label;
      if (title) tip(e, title);
      columns.push({ th: e, sortKey, render });
      if (sortKey) {
        const go = () => sortBy(sortKey, e);
        e.addEventListener('click', go);
        keyable(e, go);
      }
    };

    const maxTime = Math.max(...stats.map(g => g.time), 0);
    const maxRows = Math.max(...stats.map(g => g.rows), 0);
    const maxRR = Math.max(...stats.map(g => g.rowsRemoved), 0);
    const maxIo = Math.max(...stats.map(g => g.ioRead), 0);

    if (hasTime) {
      addCol('time, ms', 'self time of the group', 'time', g => {
        const r = maxTime ? g.time / maxTime : 0;
        return metricCell('', g.time, maxTime, r >= 0.1 ? heatWarm(hues, r) : null, { dec: 3 });
      });
      addCol('%', 'share of total plan time', 'timePct', g => {
        const td = emptyCell('pv-r pv-pct');
        if (g.timePct != null) td.textContent = fmtNum(g.timePct, 1);
        return td;
      });
    }
    if (hasIo) {
      addCol('io.rd, ms', 'I/O read time', 'ioRead', g => {
        const r = maxIo ? g.ioRead / maxIo : 0;
        return metricCell('', g.ioRead, maxIo, r >= 0.1 ? heatWarm(hues, r) : null, { dec: 3 });
      });
    }
    addCol('rows', null, 'rows', g => {
      const r = maxRows ? g.rows / maxRows : 0;
      return metricCell('', g.rows, maxRows, g.rows > 1 && r >= 0.01 ? heatWarm(hues, r) : null, {});
    });
    if (hasRR) {
      addCol('rows removed', 'rows removed by filters', 'rowsRemoved', g => {
        const r = maxRR ? g.rowsRemoved / maxRR : 0;
        return metricCell('', g.rowsRemoved, maxRR,
          g.rowsRemoved ? heatWarm(hues, r, 0.1 + 0.9 * Math.max(r, 0.3)) : null, {});
      });
    }
    if (hasLoops) {
      addCol('loops', null, 'loops', g => {
        const td = emptyCell('pv-r');
        if (g.loops > g.ids.length || g.loops > 1) td.textContent = fmtInt(g.loops);
        return td;
      });
    }
    addCol('node type', null, 'type', g => {
      const td = emptyCell('pv-l');
      el('span', 'pv-t-type', td).textContent = g.rawType;
      return td;
    });
    addCol('relation', null, 'relation', g => {
      const td = emptyCell('pv-l');
      if (g.relation) el('span', 'pv-t-rel', td).textContent = g.relation;
      return td;
    });
    addCol('index', null, 'index', g => {
      const td = emptyCell('pv-l');
      if (g.index) el('span', 'pv-t-index', td).textContent = g.index;
      return td;
    });
    addCol('nodes', 'plan nodes in this group', null, g => {
      const td = emptyCell('pv-l pv-ids');
      for (const id of g.ids) td.appendChild(nodeLink(ctx, id));
      return td;
    });
    for (const k of bufCols) {
      const [kind, type] = k.split('-');
      const maxB = Math.max(...stats.map(g => g.buf[k] || 0), 0);
      addCol(BUF_ABBR[kind] + '.' + BUF_ABBR[type], 'buffers ' + kind + ' ' + type, null, g => {
        const v = g.buf[k];
        if (!v) return emptyCell('pv-bufcell');
        const color = heat(hues, hues['buf-' + type], 0.1 + 0.9 * (v / maxB));
        return metricCell('pv-bufcell', v, maxB, color, { title: fmtBytes(v * 8192) });
      });
    }

    const tbody = el('tbody', null, table);
    const draw = list => {
      tbody.textContent = '';
      for (const g of list) {
        const tr = el('tr', 'pv-row', tbody);
        for (const c of columns) tr.appendChild(c.render(g));
      }
    };

    let sortKey = 'time', sortAsc = false;
    const sortBy = (key, thEl) => {
      if (sortKey === key) sortAsc = !sortAsc;
      else { sortKey = key; sortAsc = typeof stats[0][key] === 'string'; }
      const list = stats.slice().sort((a, b) => {
        const x = a[key], y = b[key];
        const c = typeof x === 'string' || typeof y === 'string'
          ? String(x || '').localeCompare(String(y || ''))
          : (x || 0) - (y || 0);
        return sortAsc ? c : -c;
      });
      for (const c of columns) c.th.classList.toggle('pv-th-active', c.th === thEl);
      draw(list);
    };

    draw(stats);
  }

  /* ================= advice pane ================= */

  function renderAdvice(container, plan, ctx) {
    ctx = ctx || makeLocalCtx(container);
    bindTooltips(container.closest('.pv') || container);
    const advice = plan.advice || [];
    const coaching = plan.coaching || [];

    // EXPLAIN coaching: which missing options would answer open questions
    if (coaching.length) {
      const cb = el('div', 'pv-coach', container);
      for (const c of coaching) {
        const line = el('div', 'pv-coach-line', cb);
        line.innerHTML = 'collect more evidence with <code>EXPLAIN ('
          + esc(c.option) + ', ...)</code> — ' + esc(c.reason);
        if (c.warning) el('div', 'pv-coach-warn', cb).textContent = '⚠ ' + c.warning;
      }
    }

    if (!advice.length) {
      el('div', 'pv-empty', container).textContent = coaching.length
        ? 'no recommendations from the available data'
        : 'no recommendations — the plan looks fine';
      return {};
    }

    const totals = plan.totals;
    const cardsByNode = new Map();
    const major = advice.filter(a => !a.impact || a.impact.level !== 'minor');
    const minor = advice.filter(a => a.impact && a.impact.level === 'minor');

    const box = el('div', 'pv-advbox', container);
    renderAdviceGroup(major, box);
    if (minor.length) {
      const mh = btn('pv-minorhead', container);
      const setLbl = open => {
        mh.textContent = (open ? '▾' : '▸') + ' minor observations (' + minor.length
          + ') — measured impact too small to matter in this plan';
      };
      setLbl(false);
      const mbox = el('div', 'pv-advbox pv-minorbox', container);
      mbox.hidden = true;
      mh.addEventListener('click', () => {
        mbox.hidden = !mbox.hidden;
        setLbl(!mbox.hidden);
      });
      renderAdviceGroup(minor, mbox);
    }

    function renderAdviceGroup(list, parent) {
    // group advice entries by their primary node (first head node)
    const byNode = new Map(); // nodeId|null -> [entries]
    for (const a of list) {
      // plan-scoped findings name nodes as evidence, but they are not about
      // one node — they must not borrow a node's header and metrics
      const key = a.scope === 'plan' || !a.nodes.length ? null : a.nodes[0].id;
      if (!byNode.has(key)) byNode.set(key, []);
      byNode.get(key).push(a);
    }

    for (const [nodeId, entries] of byNode) {
      const card = el('div', 'pv-card', parent);
      if (nodeId != null && !cardsByNode.has(nodeId)) cardsByNode.set(nodeId, card);

      // header: node summary with metric shares
      if (nodeId == null) {
        const head = el('div', 'pv-card-head pv-card-head-plan', card);
        el('span', 'pv-card-scope', head).textContent = 'whole plan';
      }
      if (nodeId != null) {
        const n = plan.nodes[nodeId];
        const head = el('div', 'pv-card-head', card);
        head.appendChild(nodeLink(ctx, n.id, '# ' + n.id));
        const ht = el('span', 'pv-card-title', head);
        ht.innerHTML = markupHead(n);
        // the query text can say which FROM item this node came from
        if (n.sqlSpan && ctx && ctx.showSql) {
          const b = btn('pv-card-sql', head);
          b.textContent = 'sql';
          tip(b, n.sqlSpan.ref
            ? 'show "' + n.sqlSpan.ref + '" in the query text'
            : 'show this node in the query text');
          b.addEventListener('click', () => ctx.showSql(n.id));
        }
        const met = el('div', 'pv-card-metrics', card);
        const addMetric = (label, valueHtml, share) => {
          const m = el('span', 'pv-metric', met);
          m.innerHTML = '<span class="pv-metric-l">' + label + '</span>'
            + '<span class="pv-metric-v">' + valueHtml + '</span>'
            + (share != null ? '<span class="pv-metric-p">' + fmtNum(share, 1) + '%</span>' : '');
        };
        if (n.timeExcl != null) {
          addMetric('self time', esc(fmtMs(n.timeExcl)),
            totals.time ? n.timeExcl / totals.time * 100 : null);
        }
        let bufSum = 0, bufTot = 0;
        for (const [k, v] of Object.entries(n.bufExcl)) bufSum += v; // eslint-disable-line
        for (const [k, v] of Object.entries(totals.buf)) bufTot += v; // eslint-disable-line
        if (bufSum) {
          addMetric('buffers', fmtInt(bufSum) + ' · ' + esc(fmtBytes(bufSum * 8192)),
            bufTot ? bufSum / bufTot * 100 : null);
        }
        if (n.ioReadExcl) {
          addMetric('io read', esc(fmtMs(n.ioReadExcl)),
            totals.ioRead ? n.ioReadExcl / totals.ioRead * 100 : null);
        }
        if (n.rowsTotal) addMetric('rows', fmtInt(n.rowsTotal), null);
        if (n.rowsRemovedTotal) addMetric('rows removed', fmtInt(n.rowsRemovedTotal), null);
      }

      for (const a of entries) {
        const ad = el('div', 'pv-adv-entry', card);
        const b = el('span', 'pv-badge pv-sev-' + a.sev, ad);
        b.textContent = a.badge;
        tip(b, a.code);
        // an aggregate entry stands for several nodes: say so where it shows
        if (a.agg) {
          const g = el('span', 'pv-adv-agg', ad);
          g.textContent = '+' + a.agg + ' similar';
          tip(g, a.agg + ' more nodes with the same finding, rolled up');
        }
        // impact chip: time attributable to the flagged nodes
        if (a.impact && a.impact.ms != null) {
          const im = el('span', 'pv-impact pv-impact-' + a.impact.level, ad);
          im.textContent = a.impact.level === 'minor'
            ? 'minor'
            : fmtMs(a.impact.ms)
              + (a.impact.pct != null ? ' · ' + fmtNum(a.impact.pct, 1) + '%' : '');
          tip(im, 'self time of the flagged nodes and its share of the plan time');
        }
        const msg = el('span', 'pv-adv-msg', ad);
        msg.textContent = a.obs;
        if (a.hyp) el('div', 'pv-adv-hyp', ad).textContent = a.hyp;
        if (a.next) {
          const nx = el('div', 'pv-adv-next', ad);
          nx.innerHTML = '<span class="pv-adv-next-l">next</span> ' + esc(a.next);
        }
        if (a.ext) el('div', 'pv-adv-ext', ad).textContent = a.ext;
        // suggested indexes: DDL only under the safe-output contract
        if (a.idxs) {
          for (const idx of a.idxs) {
            const w = el('div', 'pv-adv-idx', ad);
            if (idx.confidence === 'unsafe' || !idx.def) {
              const warn = el('div', 'pv-adv-idx-warn', w);
              warn.textContent = '⚠ condition text could not be verified as safe SQL — DDL is not generated';
              const desc = el('div', 'pv-adv-idx-desc', w);
              desc.textContent = 'index candidate: ' + idx.rel + ' USING ' + idx.type
                + ' (' + idx.cols.join(', ') + ')'
                + (idx.where && idx.where.length ? ' WHERE ' + idx.where.join(' AND ') : '');
              continue;
            }
            if (idx.confidence === 'partial') {
              const warn = el('div', 'pv-adv-idx-warn', w);
              warn.textContent = '⚠ some conditions could not be analyzed — the index may not cover everything';
            }
            const pre = el('pre', 'pv-sql', w);
            pre.innerHTML = sqlHtml(idx.def)
              + (idx.comment ? '\n<span class="pv-sql-comment">-- ' + esc(idx.comment) + '</span>' : '');
            el('div', 'pv-adv-idx-note', w).textContent =
              'candidate only — the plan does not show existing indexes, write costs, or the rest of the workload';
            const cp = btn('pv-copy', w);
            cp.textContent = 'copy';
            tip(cp, 'copy CREATE INDEX to clipboard');
            cp.addEventListener('click', e => {
              e.stopPropagation();
              const done = ok => {
                cp.textContent = ok ? 'copied' : 'copy failed';
                setTimeout(() => { cp.textContent = 'copy'; }, 1800);
              };
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(idx.def)
                  .then(() => done(true), () => done(false));
              } else done(false);
            });
          }
        }
        // plan fragment: involved nodes with their context lines
        if (a.nodes.length) {
          const frag = el('div', 'pv-adv-frag', ad);
          const html = [];
          const depths = [...new Set(a.nodes.map(h => plan.nodes[h.id].depth))].sort((x, y) => x - y);
          for (const h of a.nodes) {
            const n = plan.nodes[h.id];
            const pad = '  '.repeat(depths.indexOf(n.depth));
            html.push(pad + '<span class="pv-fragid">#' + n.id + '</span> '
              + (n.id > 0 && !n.spec ? '<span class="pv-arrowpfx">-&gt; </span>' : '')
              + markupHead(n));
            if (h.ext) html.push(pad + '   <span class="pv-adv-extline">' + markupNumbers(esc(h.ext)) + '</span>');
          }
          frag.innerHTML = html.join('\n');
        }
      }
    }
    } // renderAdviceGroup

    return {
      goToCard(nodeId) {
        const card = cardsByNode.get(nodeId);
        if (card) {
          card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          pulse(card);
        }
      },
    };
  }

  /* ================= diagram pane ================= */

  function renderDiagram(container, plan, ctx) {
    ctx = ctx || makeLocalCtx(container);
    bindTooltips(container.closest('.pv') || container);
    const hues = themeHues(container);
    const nodes = plan.nodes;

    // dataflow parent: nearest real ancestor; spec subtrees hang off the
    // node their section is charged to (CTE -> its CTE Scan, InitPlan ->
    // the referencing node)
    const dgParent = new Array(nodes.length).fill(null);
    for (const n of nodes) {
      if (n.spec) continue;
      let p = n.parent != null ? nodes[n.parent] : null;
      while (p) {
        if (!p.spec) { dgParent[n.id] = p.id; break; }
        if (p.chargedTo != null && !nodes[p.chargedTo].spec) { dgParent[n.id] = p.chargedTo; break; }
        p = p.parent != null ? nodes[p.parent] : null;
      }
    }
    const real = nodes.filter(n => !n.spec);
    if (!real.length) { el('div', 'pv-empty', container).textContent = 'no data'; return; }
    const children = new Map(real.map(n => [n.id, []]));
    let rootId = real[0].id;
    for (const n of real) {
      const p = dgParent[n.id];
      if (p == null) rootId = n.id;
      else children.get(p).push(n.id);
    }

    // layout: root at the right, leaves at the left (data flows rightwards)
    const depth = new Map();
    let maxDepth = 0;
    (function setDepth(id, d) {
      depth.set(id, d);
      maxDepth = Math.max(maxDepth, d);
      for (const c of children.get(id)) setDepth(c, d + 1);
    })(rootId, 0);

    const ROW = 92, COL = 180, PADX = 66, PADY = 50, R = 20;
    const pos = new Map();
    let leafRow = 0;
    (function layout(id) {
      const kids = children.get(id);
      let y;
      if (!kids.length) {
        y = leafRow++ * ROW;
      } else {
        for (const c of kids) layout(c);
        y = kids.reduce((s, c) => s + pos.get(c).y, 0) / kids.length;
      }
      pos.set(id, { y });
    })(rootId);
    for (const [id, p] of pos) {
      p.x = PADX + (maxDepth - depth.get(id)) * COL;
      p.y += PADY;
    }

    const width = PADX * 2 + maxDepth * COL + 120;
    const height = PADY * 2 + Math.max(1, leafRow) * ROW;

    const head = el('div', 'pv-dg-head', container);
    const modeBtns = {};
    const mkMode = (name, label) => {
      const b = btn('pv-dg-mode', head);
      b.textContent = label;
      b.addEventListener('click', () => setMode(name));
      modeBtns[name] = b;
    };
    const hasTime = plan.columns.time;
    const hasBuf = plan.columns.buf.length > 0;
    const hasIo = real.some(n => (n.ioReadExcl || 0) + (n.ioWriteExcl || 0) > 0);
    const hasRows = plan.columns.rows;
    const hasRemoved = real.some(n => (n.rowsRemovedTotal || 0) > 0);
    const hasRatio = real.some(n => n.ratio != null);
    if (hasTime) mkMode('time', 'by time');
    if (hasBuf) mkMode('buffers', 'by buffers');
    if (hasIo) mkMode('io', 'by I/O time');
    if (hasRows) mkMode('rows', 'by rows');
    if (hasRemoved) mkMode('removed', 'by rows removed');
    if (hasRatio) mkMode('estimate', 'by estimate error');
    if (!hasTime && !hasBuf) mkMode('cost', 'by cost');

    const scroll = el('div', 'pv-dg-scroll', container);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.classList.add('pv-dg');
    scroll.appendChild(svg);
    attachPan(scroll);
    attachZoom(head, scroll, zz => {
      svg.setAttribute('width', Math.round(width * zz));
      svg.setAttribute('height', Math.round(height * zz));
    });

    const maxRows = Math.max(...real.map(n => n.rowsTotal), 1);
    const edgeW = n => 1.5 + 10 * Math.log(1 + n.rowsTotal) / Math.log(1 + maxRows);

    const gEdges = document.createElementNS(NS, 'g');
    const gNodes = document.createElementNS(NS, 'g');
    svg.appendChild(gEdges);
    svg.appendChild(gNodes);

    // edges: child -> parent ribbons, width by row flow
    for (const n of real) {
      const p = dgParent[n.id];
      if (p == null) continue;
      const a = pos.get(n.id), b = pos.get(p);
      const path = document.createElementNS(NS, 'path');
      const x1 = a.x + R, y1 = a.y, x2 = b.x - R, y2 = b.y;
      const mx = (x1 + x2) / 2;
      path.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
      path.setAttribute('class', 'pv-dg-edge');
      path.setAttribute('stroke-width', edgeW(n).toFixed(1));
      tip(path, `#${n.id} → #${p}: ${fmtInt(n.rowsTotal)} rows`);
      gEdges.appendChild(path);
      if (n.rowsTotal > 0) {
        const label = document.createElementNS(NS, 'text');
        label.setAttribute('x', (x1 + 8));
        label.setAttribute('y', y1 + (y1 === y2 ? -8 : (y2 > y1 ? 14 : -8)));
        label.setAttribute('class', 'pv-dg-rows');
        label.textContent = fmtInt(n.rowsTotal);
        gNodes.appendChild(label);
      }
    }

    const rings = new Map();
    for (const n of real) {
      const p = pos.get(n.id);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'pv-dg-node');
      g.setAttribute('transform', `translate(${p.x},${p.y})`);

      const ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('r', R);
      ring.setAttribute('class', 'pv-dg-ring');
      g.appendChild(ring);
      rings.set(n.id, ring);

      const abbr = document.createElementNS(NS, 'text');
      abbr.setAttribute('class', 'pv-dg-abbr');
      abbr.setAttribute('dy', '4');
      abbr.textContent = nodeAbbr(n);
      g.appendChild(abbr);

      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('class', 'pv-dg-label');
      lbl.setAttribute('y', R + 13);
      const name = n.relation || n.index || '';
      lbl.textContent = name.length > 20 ? name.slice(0, 19) + '…' : name;
      g.appendChild(lbl);

      const typeLbl = document.createElementNS(NS, 'text');
      typeLbl.setAttribute('class', 'pv-dg-type');
      typeLbl.setAttribute('y', -R - 5);
      typeLbl.textContent = n.nodeType;
      g.appendChild(typeLbl);

      tip(g, `#${n.id} ${n.head}\n`
        + (n.timeExcl != null ? `self time: ${fmtMs(n.timeExcl)}\n` : '')
        + `rows: ${fmtInt(n.rowsTotal)}` + (n.loops > 1 ? `, loops: ${fmtInt(n.loops)}` : '')
        + ((n.rowsRemovedTotal || 0) > 0 ? `\nrows removed: ${fmtInt(n.rowsRemovedTotal)}` : '')
        + ((n.ioReadExcl || 0) + (n.ioWriteExcl || 0) > 0
          ? `\nself I/O: ${fmtMs((n.ioReadExcl || 0) + (n.ioWriteExcl || 0))}` : '')
        + (n.ratio != null
          ? `\nestimate: ${n.ratio === Infinity ? '∞' : '×' + fmtNum(n.ratio, 1)} `
            + (n.ratioDir > 0 ? 'underestimated' : 'overestimated') : ''));

      g.addEventListener('click', () => ctx.goToNode(n.id));
      keyable(g, () => ctx.goToNode(n.id));
      gNodes.appendChild(g);
    }

    function setMode(mode) {
      for (const [k, b] of Object.entries(modeBtns)) {
        b.classList.toggle('pv-dg-mode-on', k === mode);
      }
      const reset = ring => { ring.style.stroke = ''; ring.style.strokeWidth = ''; };
      if (mode === 'estimate') {
        // diverging scale, not a heat ramp: hue encodes the direction of the
        // planner's miss (blue = underestimated, red = overestimated — same
        // mapping as the plan table), intensity its log-scaled magnitude
        // misses under 2× are within planner noise — no ring, only real ones
        const mag = n => n.ratio == null || n.ratio < 2 ? 0
          : n.ratio === Infinity ? Infinity : Math.log(n.ratio);
        let maxMag = 0;
        for (const n of real) {
          const m = mag(n);
          if (m !== Infinity && m > maxMag) maxMag = m;
        }
        for (const n of real) {
          const ring = rings.get(n.id);
          const m = mag(n);
          if (m > 0) {
            const f = m === Infinity ? 1 : maxMag > 0 ? m / maxMag : 1;
            ring.style.stroke = heat(hues, n.ratioDir > 0 ? hues.under : hues.over,
              0.25 + 0.75 * f);
            ring.style.strokeWidth = (2 + 4 * f).toFixed(1);
          } else {
            reset(ring);
          }
        }
        return;
      }
      const val = n => mode === 'time' ? (n.timeExcl || 0)
        : mode === 'buffers' ? Object.values(n.bufExcl).reduce((s, v) => s + v, 0)
        : mode === 'io' ? (n.ioReadExcl || 0) + (n.ioWriteExcl || 0)
        : mode === 'rows' ? (n.rowsTotal || 0)
        : mode === 'removed' ? (n.rowsRemovedTotal || 0)
        : (n.costExcl || 0);
      const maxV = Math.max(...real.map(val), 0);
      for (const n of real) {
        const ring = rings.get(n.id);
        const r = maxV > 0 ? val(n) / maxV : 0;
        if (r >= 0.02) {
          ring.style.stroke = heatWarm(hues, r, 0.25 + 0.75 * r);
          ring.style.strokeWidth = (2 + 4 * r).toFixed(1);
        } else {
          reset(ring);
        }
      }
    }
    setMode(hasTime ? 'time' : hasBuf ? 'buffers' : 'cost');
  }

  /* ================= relations pane ================= */

  const ROLE_LABEL = { cond: 'cond', join: 'join', filter: 'filter', sort: 'sort' };
  const ROLE_ORDER = { cond: 0, join: 1, filter: 2, sort: 3 };

  function renderRelations(container, plan, ctx) {
    ctx = ctx || makeLocalCtx(container);
    bindTooltips(container.closest('.pv') || container);
    const schema = plan.schema;
    if (!schema || !schema.rels.length) {
      el('div', 'pv-empty', container).textContent = 'no relations recognized in the plan';
      return;
    }

    const head = el('div', 'pv-dg-head', container);
    const box = el('div', 'pv-relbox', container);
    // box (scroll viewport) > sizer (reserves the scaled extent) > wrap
    // (transform: scale) — cards and the edge overlay scale together
    const sizer = el('div', 'pv-relsizer', box);
    const wrap = el('div', 'pv-relwrap', sizer);
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.classList.add('pv-rel-edges');
    wrap.appendChild(svg);
    const flow = el('div', 'pv-relflow', wrap);
    let zoom = 1;
    const applyScale = zz => {
      zoom = zz;
      if (zz === 1) {
        wrap.style.transform = '';
        wrap.style.width = '';
        sizer.style.height = '';
      } else {
        // narrow the layout so the scaled content still fills the pane
        // width (browser-zoom feel: cards grow and reflow, growth is
        // vertical), then reserve the scaled height for the scrollbars
        wrap.style.width = (box.clientWidth / zz) + 'px';
        wrap.style.transform = 'scale(' + zz + ')';
        sizer.style.height = (wrap.scrollHeight * zz) + 'px';
      }
      drawEdges();
    };
    attachPan(box);
    attachZoom(head, box, applyScale);

    // order relations: joined neighbours near each other (simple: by first node id)
    const rels = schema.rels.slice()
      .sort((a, b) => Math.min(...a.nodes) - Math.min(...b.nodes));

    const colEls = new Map(); // "rel|col" -> element

    for (const r of rels) {
      const card = el('div', 'pv-relcard', flow);
      const head = el('div', 'pv-relhead', card);
      const nm = el('span', 'pv-t-rel', head);
      nm.textContent = (r.schema ? r.schema + '.' : '') + r.name;
      if (r.aliases.length) {
        el('span', 'pv-relalias', head).textContent = r.aliases.join(', ');
      }
      if (r.virtual) el('span', 'pv-relvirtual', head).textContent = r.virtual;
      const links = el('span', 'pv-rellinks', head);
      const relNodeIds = [...new Set(r.nodes)];
      for (const id of relNodeIds) links.appendChild(nodeLink(ctx, id));
      tip(head, [
        (r.schema ? r.schema + '.' : '') + r.name + (r.virtual ? ' — ' + r.virtual : ''),
        r.aliases.length ? 'aliases: ' + r.aliases.join(', ') : null,
        'nodes: ' + relNodeIds
          .map(id => '#' + id + ' ' + plan.nodes[id].nodeType
            + (plan.nodes[id].rowsTotal ? ' (' + fmtInt(plan.nodes[id].rowsTotal) + ' rows)' : ''))
          .join(', '),
        r.indexes.length ? 'indexes used: ' + r.indexes.map(i => i.name).join(', ') : null,
      ].filter(Boolean).join('\n'));

      for (const idx of r.indexes) {
        const row = el('div', 'pv-relidx', card);
        const iname = el('span', 'pv-t-index', row);
        iname.textContent = idx.name;
        if (idx.cols.length) {
          el('span', 'pv-relidxcols', row).textContent = ' (' + idx.cols.join(', ') + ')';
        }
      }

      const cols = r.cols.slice().sort((a, b) => {
        const ra = Math.min(...a.roles.map(x => ROLE_ORDER[x] ?? 9));
        const rb = Math.min(...b.roles.map(x => ROLE_ORDER[x] ?? 9));
        return ra - rb || a.col.localeCompare(b.col);
      });
      for (const c of cols) {
        const row = el('div', 'pv-relcol', card);
        el('span', 'pv-relcolname', row).textContent = c.col;
        for (const role of c.roles.slice().sort((x, y) => (ROLE_ORDER[x] ?? 9) - (ROLE_ORDER[y] ?? 9))) {
          el('span', 'pv-role pv-role-' + role, row).textContent = ROLE_LABEL[role] || role;
        }
        tip(row, 'nodes: ' + c.nodes.map(id => '#' + id).join(', '));
        // qualified key: matches the rel spelling used in schema.joins
        colEls.set((r.schema ? r.schema + '.' : '') + r.name + '|' + c.col, row);
      }
    }

    // join edges between column rows
    function drawEdges() {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      // coordinates in wrap space (unscaled): the wrap rect moves with the
      // scroll and scales with the zoom, so dividing by the current zoom is
      // the whole correction
      const base = wrap.getBoundingClientRect();
      svg.setAttribute('width', wrap.scrollWidth);
      svg.setAttribute('height', wrap.scrollHeight);
      for (const j of schema.joins) {
        const a = colEls.get(j.left.rel + '|' + j.left.col);
        const b = colEls.get(j.right.rel + '|' + j.right.col);
        if (!a || !b) continue;
        // self-join on the same column: nothing to draw, the join is still
        // listed in the column roles/tooltips
        if (a === b) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        // connect nearest edges
        const aRight = ra.right < rb.left;
        const x1 = ((aRight ? ra.right : ra.left) - base.left) / zoom;
        const x2 = ((aRight ? rb.left : rb.right) - base.left) / zoom;
        const y1 = (ra.top + ra.height / 2 - base.top) / zoom;
        const y2 = (rb.top + rb.height / 2 - base.top) / zoom;
        const dx = Math.max(24, Math.abs(x2 - x1) / 3) * (aRight ? 1 : -1);
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
        path.setAttribute('class', 'pv-rel-edge');
        tip(path, `${j.left.rel}.${j.left.col} ${j.op} ${j.right.rel}.${j.right.col}`
          + ' · nodes ' + j.nodes.map(id => '#' + id).join(', '));
        svg.appendChild(path);
      }
    }
    // draw after layout; on pane resize re-apply the scale (the layout
    // width depends on the pane width) and redraw
    requestAnimationFrame(drawEdges);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => applyScale(zoom));
      ro.observe(box);
      ctx.addCleanup(() => ro.disconnect());
    }
  }

  /* ================= summary chips ================= */

  function renderSummary(container, plan, ctx) {
    const summary = el('div', 'pv-summary', container);
    const totals = plan.totals;
    const chip = (label, value, title) => {
      if (value == null || value === '') return;
      const c = el('span', 'pv-chip', summary);
      c.innerHTML = '<span class="pv-chip-l">' + esc(label) + '</span>'
        + '<span class="pv-chip-v">' + esc(value) + '</span>';
      if (title) tip(c, title);
    };
    const execMs = plan.executionTime != null ? plan.executionTime
      : plan.duration != null ? plan.duration : totals.time;
    chip('execution', fmtMs(execMs));
    if (plan.planningTime != null) chip('planning', fmtMs(plan.planningTime));
    if (totals.rows) chip('rows', fmtInt(totals.rows));
    if (totals.rowsRemoved) chip('rows removed', fmtInt(totals.rowsRemoved),
      'total rows discarded by filters (across loops)');
    let memBlocks = 0, dskBlocks = 0;
    for (const [k, v] of Object.entries(totals.buf)) {
      if (/-(hit|dirtied)$/.test(k)) memBlocks += v; else dskBlocks += v;
    }
    if (memBlocks) chip('buffers·mem', fmtBytes(memBlocks * 8192), 'shared/local hit + dirtied');
    if (dskBlocks) chip('buffers·io', fmtBytes(dskBlocks * 8192), 'read + written + temp');
    if (totals.ioRead) chip('io read', fmtMs(totals.ioRead));
    if (totals.ioWrite) chip('io write', fmtMs(totals.ioWrite));
    chip('nodes', String(plan.nodes.filter(n => !n.spec).length));
    if (plan.inProgress) {
      chip('state', 'in progress',
        'snapshot of a running query: "Current loop" numbers are not final');
    }
    if (plan.truncated) {
      chip('state', 'truncated',
        'the plan is incomplete: only node-local recommendations are produced, '
        + 'and per-node self times are upper bounds');
    }

    // advice badges: unique codes with node links (minor findings stay in
    // the advice pane's minor section, not in the summary)
    if (plan.advice && plan.advice.length && ctx) {
      const advBox = el('span', 'pv-summary-adv', summary);
      const seen = new Set();
      for (const a of plan.advice) {
        if (a.impact && a.impact.level === 'minor') continue;
        const key = a.code + ':' + (a.nodes[0] ? a.nodes[0].id : '');
        if (seen.has(key)) continue;
        seen.add(key);
        const b = btn('pv-badge pv-sev-' + a.sev, advBox);
        b.textContent = a.badge + (a.nodes.length ? ' #' + a.nodes[0].id : '');
        tip(b, a.code + ': ' + a.obs);
        b.addEventListener('click', () => ctx.setTab('advice', a.nodes[0] ? a.nodes[0].id : null));
      }
    }

    const fmtBadge = el('span', 'pv-chip pv-chip-fmt', summary);
    fmtBadge.textContent = plan.format;
  }

  /* ================= widget ================= */

  function makeLocalCtx(container) {
    // standalone pane renders register their cleanups on the container so
    // destroy(container) — or a later render() into it — can release them
    return {
      goToNode() {}, setTab() {},
      addCleanup(fn) {
        if (!container) return;
        (container.__pvCleanups || (container.__pvCleanups = [])).push(fn);
      },
    };
  }

  // Release everything a widget or standalone pane attached to the
  // container: observers, container/document listeners, the tooltip
  // element, rendered content and the .pv class.
  function destroyIn(container) {
    if (container.__pvCleanups) {
      for (const fn of container.__pvCleanups.splice(0)) {
        try { fn(); } catch (e) { /* already torn down */ }
      }
      delete container.__pvCleanups;
    }
    if (container.__pvTipCleanup) container.__pvTipCleanup();
    delete container.__pvTipEl;
    container.textContent = '';
    container.classList.remove('pv');
  }

  // Reading order: the plan itself, then the views that summarize it, then
  // what the widget concluded about it. The two raw-input panes are pushed to
  // the far end of the bar (`right`) — they are references, not findings.
  const PANES = [
    { name: 'plan', label: 'Plan', applicable: () => true },
    { name: 'stats', label: 'Stats', applicable: p => p.stats && p.stats.length > 0 },
    { name: 'diagram', label: 'Diagram', applicable: p => p.nodes.filter(n => !n.spec).length > 1 },
    { name: 'relations', label: 'Relations', applicable: p => p.schema && p.schema.rels.length > 0 },
    { name: 'domain', label: 'Model', applicable: p => p.domain && p.domain.length > 0 },
    {
      name: 'diagnostics',
      accent: true,
      label: p => 'Diagnostics (' + diagItems(p).length + ')',
      applicable: p => diagItems(p).length > 0,
    },
    {
      name: 'advice',
      accent: true,
      label: p => {
        const major = p.advice.filter(a => !a.impact || a.impact.level !== 'minor').length;
        const minor = p.advice.length - major;
        return 'Recommendations (' + major + (minor ? '+' + minor : '') + ')';
      },
      applicable: p => (p.advice && p.advice.length > 0)
        || (p.coaching && p.coaching.length > 0),
    },
    { name: 'text', label: 'Plan text', right: true, applicable: () => true },
    { name: 'query', label: 'SQL query', right: true, applicable: p => !!p.query },
  ];

  function render(container, plan, opts) {
    opts = opts || {};
    // a re-render into the same container disposes the previous instance's
    // observers/listeners first
    if (container.__pvCleanups) {
      for (const fn of container.__pvCleanups.splice(0)) {
        try { fn(); } catch (e) { /* already torn down */ }
      }
    }
    const cleanups = container.__pvCleanups = [];
    const uid = 'pv' + (++instanceSeq);
    container.textContent = '';
    container.classList.add('pv');
    bindTooltips(container);

    const wanted = opts.tabs || PANES.map(p => p.name);
    const panes = PANES.filter(p => wanted.includes(p.name) && p.applicable(plan));

    const ctx = {
      goToNode(id) { setTab('plan'); tableApi.goToNode(id); },
      setTab(name, nodeId) {
        setTab(name);
        if (name === 'advice' && nodeId != null && adviceApi.goToCard) adviceApi.goToCard(nodeId);
      },
      // jump to the fragment of the query text a node came from
      showSql(nodeId) {
        if (!paneEls.has('query')) return false;
        setTab('query');
        return queryApi.focusNode ? queryApi.focusNode(nodeId) : false;
      },
      addCleanup(fn) { cleanups.push(fn); },
    };

    if (opts.summary !== false) renderSummary(container, plan, ctx);

    let tabbar = null;
    if (panes.length > 1) {
      tabbar = el('div', 'pv-tabbar', container);
      tabbar.setAttribute('role', 'tablist');
    }
    const paneEls = new Map();
    const tabEls = new Map();
    const rendered = new Set();

    let pushed = false;
    for (const p of panes) {
      if (tabbar) {
        const t = btn('pv-tab', tabbar);
        // the first right-hand tab carries the auto margin that pushes it and
        // everything after it to the end of the row
        if (p.right && !pushed) { t.classList.add('pv-tab-push'); pushed = true; }
        if (p.accent) t.classList.add('pv-tab-accent');
        t.textContent = typeof p.label === 'function' ? p.label(plan) : p.label;
        t.setAttribute('role', 'tab');
        t.id = uid + '-tab-' + p.name;
        t.addEventListener('click', () => setTab(p.name));
        tabEls.set(p.name, t);
      }
      const pane = el('div', 'pv-pane', container);
      pane.hidden = true;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', uid + '-tab-' + p.name);
      paneEls.set(p.name, pane);
    }

    // roving focus on the tablist: arrows move and activate
    if (tabbar) {
      tabbar.addEventListener('keydown', e => {
        const names = panes.map(p => p.name);
        const i = names.indexOf(active);
        let target = null;
        if (e.key === 'ArrowRight') target = names[(i + 1) % names.length];
        else if (e.key === 'ArrowLeft') target = names[(i - 1 + names.length) % names.length];
        else if (e.key === 'Home') target = names[0];
        else if (e.key === 'End') target = names[names.length - 1];
        if (target) {
          e.preventDefault();
          setTab(target);
          tabEls.get(target).focus();
        }
      });
    }

    let tableApi = { goToNode() {} };
    let adviceApi = {};
    let queryApi = {};

    const renderPane = name => {
      if (rendered.has(name)) return;
      rendered.add(name);
      const pane = paneEls.get(name);
      switch (name) {
        case 'plan': tableApi = renderTable(pane, plan, ctx, opts) || tableApi; break;
        case 'advice': adviceApi = renderAdvice(pane, plan, ctx) || adviceApi; break;
        case 'diagnostics': renderDiagnostics(pane, plan, ctx); break;
        case 'stats': renderStats(pane, plan, ctx); break;
        case 'diagram': renderDiagram(pane, plan, ctx); break;
        case 'relations': renderRelations(pane, plan, ctx); break;
        case 'text': renderText(pane, plan); break;
        case 'domain': renderDomain(pane, plan); break;
        case 'query': queryApi = renderQuery(pane, plan, ctx) || queryApi; break;
      }
    };

    let active = null;
    function setTab(name) {
      if (!paneEls.has(name)) return;
      renderPane(name);
      active = name;
      for (const [k, pane] of paneEls) pane.hidden = k !== name;
      for (const [k, t] of tabEls) {
        const on = k === name;
        t.classList.toggle('pv-tab-on', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1; // roving tabindex within the tablist
      }
    }

    const destroy = () => destroyIn(container);

    setTab(opts.defaultTab && paneEls.has(opts.defaultTab) ? opts.defaultTab : panes[0].name);
    return { setTab, goToNode: ctx.goToNode, destroy };
  }

  return {
    render,
    destroy: destroyIn,
    renderTable, renderAdvice, renderDiagnostics, renderStats, renderDiagram, renderRelations,
    renderText, renderQuery, renderDomain,
    fmtBytes, fmtMs, fmtNum, fmtInt,
  };
}));
