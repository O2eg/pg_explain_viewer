'use strict';
// Shared test utilities: fixture loading and the golden-snapshot view of
// the normalized plan model.
const fs = require('fs');
const path = require('path');
const PgPlan = require('../src/pgplan.js');

const PLANS_DIR = path.join(__dirname, 'plans');
const GOLDEN_DIR = path.join(__dirname, 'golden');

function fixtureFiles() {
  return fs.readdirSync(PLANS_DIR)
    .filter(f => /\.(txt|json|yaml)$/.test(f)
      && fs.statSync(path.join(PLANS_DIR, f)).isFile())
    .sort();
}

const readFixture = f => fs.readFileSync(path.join(PLANS_DIR, f), 'utf8');
const parseFixture = f => PgPlan.parse(readFixture(f));

// Stable, JSON-safe view of the normalized model. Everything derived is
// included so any parser/analyzer change surfaces as an explicit diff;
// only the raw input echo (plan.text) is omitted.
function snapshot(plan) {
  const nodes = plan.nodes.map(n => {
    const c = Object.assign({}, n);
    if (c.advice) c.advice = c.advice.map(a => a.code);
    if (c.ratio === Infinity) c.ratio = 'Infinity';
    return c;
  });
  const max = Object.assign({}, plan.max);
  if (max.ratio === Infinity) max.ratio = 'Infinity';
  return {
    format: plan.format,
    duration: plan.duration,
    query: plan.query,
    planningTime: plan.planningTime,
    executionTime: plan.executionTime,
    inProgress: plan.inProgress,
    truncated: plan.truncated,
    queryId: plan.queryId,
    columns: plan.columns,
    totals: plan.totals,
    max,
    ext: plan.ext,
    triggers: plan.triggers,
    diagnostics: plan.diagnostics,
    domain: plan.domain,
    stats: plan.stats,
    schema: plan.schema || null,
    advice: plan.advice,
    nodes,
  };
}

module.exports = { PgPlan, PLANS_DIR, GOLDEN_DIR, fixtureFiles, readFixture, parseFixture, snapshot };
