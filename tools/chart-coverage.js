'use strict';
/*
 * How often each candidate chart of docs/charts.md would have real data.
 *
 *   node tools/chart-coverage.js <dir-with-plan-*.txt>
 *
 * Point it at any directory of plain-text plans. The figures quoted in
 * docs/charts.md come from a corpus of public archive plans that is NOT part
 * of this repository (production identifiers), so they are reproducible only
 * with a comparable corpus — the script is here so the counting rule itself
 * is not a matter of trust.
 */
const fs = require('fs'), path = require('path');
const P = require('/home/oleg/Desktop/dev/pg_explain_viewer/src/pgplan.js');
const dir = process.argv[2] || 'txtcache';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
const has = {}, bump = k => { has[k] = (has[k] || 0) + 1; };
let n = 0;
for (const f of files) {
  let p; try { p = P.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
  n++;
  const diag = c => p.diagnostics.some(d => d.code === c);
  const sum = o => Object.values(o || {}).reduce((s, v) => s + v, 0);
  if (p.planningTime != null && p.executionTime != null && p.totals.time != null
      && p.executionTime - p.totals.time >= -0.5) bump('latency 3-slice');
  if (p.stats && p.stats.length > 1 && !p.truncated) bump('execution hotspots');
  if (p.nodes.some(x => x.rowsRemovedTotal > 0)) bump('discard hotspots');
  if (p.nodes.some(x => x.ratio != null && (x.ratio === Infinity || x.ratio > 10))) bump('estimate error');
  if ((p.totals.buf['shared-hit'] || 0) + (p.totals.buf['shared-read'] || 0) > 0) bump('buffer access mix');
  if (['shared-dirtied','shared-written','local-written','temp-written'].some(k => p.totals.buf[k] > 0)) bump('write activity');
  if (p.totals.ioRead > 0 || p.totals.ioWrite > 0) bump('io timing');
  if (p.nodes.some(x => x.sortSpace === 'Disk' || x.hashBatches > 1 || (x.bufExcl['temp-written'] || 0) > 0)) bump('spill hotspots');
  if (p.nodes.some(x => x.cache && x.cache.hits + x.cache.misses >= 1000)) bump('memoize effectiveness');
  if (p.nodes.some(x => Array.isArray(x.workers) && x.workers.length > 1)) bump('worker skew');
  if (p.nodes.some(x => (x.loops || 1) > 1000 && x.rowsTotal > 0)) bump('fan-out hotspots');
  // quality gates that mute shares
  if (diag('excl_overshoot')) bump('~ gate: excl_overshoot');
  if (diag('parallel_estimate')) bump('~ gate: parallel_estimate');
  if (p.truncated) bump('~ gate: truncated');
  if (sum(p.totals.buf) === 0) bump('~ gate: no buffers');
}
console.log('plans parsed:', n);
for (const [k, v] of Object.entries(has).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + String(Math.round(100 * v / n)).padStart(3) + '%  ' + k + '  (' + v + ')');
}
