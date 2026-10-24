import assert from 'node:assert/strict';

export const scenarios = Object.freeze({
  'catalog-desktop': ['firstPaintMs', 'completePaintMs'],
  'catalog-narrow': ['firstPaintMs', 'completePaintMs'],
  'session-desktop': ['firstPaintMs', 'readyMs'],
  'session-warm-desktop': ['firstPaintMs', 'readyMs'],
  'session-narrow': ['firstPaintMs', 'readyMs'],
  'session-warm-narrow': ['firstPaintMs', 'readyMs'],
  'session-navigation-cold-desktop': ['firstPaintMs'],
  'session-navigation-cached-desktop': ['firstPaintMs'],
  'session-navigation-cold-narrow': ['firstPaintMs'],
  'session-navigation-cached-narrow': ['firstPaintMs'],
  'sidebar-update-30': ['ms'], 'sidebar-update-200': ['ms'],
  'sidebar-menu-30': ['ms'], 'sidebar-menu-200': ['ms'],
});
const exactKeys = (object, keys, label) => assert.deepEqual(Object.keys(object).sort(), [...keys].sort(), label);
const duration = value => assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Durations must be finite nonnegative milliseconds');
export function summarize(evidence) {
  assert.ok(Array.isArray(evidence));
  const result = {};
  for (const row of evidence) {
    assert.ok(Object.hasOwn(scenarios, row.id) && !Object.hasOwn(result, row.id), `Unknown or duplicate scenario: ${row.id}`);
    assert.ok(Array.isArray(row.samples) && row.samples.length >= 10, `${row.id}: at least ten samples required`);
    const metrics = {};
    for (const key of scenarios[row.id]) {
      const values = row.samples.map(sample => { assert.ok(Object.hasOwn(sample, key), `${row.id}: missing ${key}`); duration(sample[key]); return sample[key]; }).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      metrics[key] = { p50: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, p95: values[Math.ceil(values.length * .95) - 1] };
    }
    result[row.id] = { count: row.samples.length, metrics };
  }
  exactKeys(result, Object.keys(scenarios), 'Missing required performance scenario');
  return result;
}
export function candidate(summary, workload, environment) {
  return { schemaVersion: 1, workload, unit: 'ms', calibration: environment, scenarios: Object.fromEntries(Object.entries(summary).map(([id, row]) => [id,
    Object.fromEntries(Object.entries(row.metrics).map(([metric, quantiles]) => [metric, { ...quantiles, relativeTolerance: .30, absoluteToleranceMs: id.startsWith('sidebar-') ? 50 : id.startsWith('catalog-') && metric === 'completePaintMs' ? 150 : 100 }]))])) };
}
export function sidebarEvidence(id, rows) {
  assert.ok(id === 'sidebar-update' || id === 'sidebar-menu', 'Unknown sidebar evidence kind');
  assert.ok(Array.isArray(rows), 'Sidebar receipt must be an array');
  const evidence = [];
  for (const row of rows) {
    if (!Array.isArray(row.samples)) {
      assert.ok(id === 'sidebar-menu' && row.rows === undefined
        && ['listContext', 'groupHeading', 'availability', 'titleOnly'].some(key => row[key] === true),
      'Unknown sidebar behavior receipt');
      continue;
    }
    assert.ok([30, 200].includes(row.rows), 'Unknown sidebar row count');
    for (const sample of row.samples) {
      assert.equal(sample.rowsProcessed, 0);
      assert.equal(sample.projections, 0);
    }
    evidence.push({ id: `${id}-${row.rows}`, samples: row.samples });
  }
  assert.deepEqual(evidence.map(row => row.id).sort(), [`${id}-200`, `${id}-30`],
    'Sidebar receipt requires exactly one 30-row and one 200-row measurement');
  return evidence;
}
export function compare(summary, baseline, workload) {
  assert.equal(baseline.schemaVersion, 1, 'Unknown baseline schema');
  assert.equal(baseline.unit, 'ms', 'Baseline unit mismatch');
  assert.deepEqual(baseline.workload, workload, 'Workload changed: calibrate an explicit baseline candidate');
  exactKeys(baseline.scenarios, Object.keys(scenarios), 'Baseline scenario mismatch');
  const comparisons = [];
  for (const [id, metrics] of Object.entries(scenarios)) {
    exactKeys(baseline.scenarios[id], metrics, `${id}: baseline metric mismatch`);
    for (const metric of metrics) {
      const budget = baseline.scenarios[id][metric];
      duration(budget.relativeTolerance); duration(budget.absoluteToleranceMs);
      assert.ok(budget.relativeTolerance <= 1, 'Tolerance cannot exceed 100%');
      for (const quantile of ['p50', 'p95']) {
        duration(budget[quantile]); duration(summary[id].metrics[metric][quantile]);
        const limit = budget[quantile] * (1 + budget.relativeTolerance) + budget.absoluteToleranceMs;
        const actual = summary[id].metrics[metric][quantile];
        comparisons.push({ scenario: id, metric, quantile, baseline: budget[quantile], actual, deltaMs: actual - budget[quantile], deltaPercent: budget[quantile] === 0 ? null : (actual / budget[quantile] - 1) * 100, limit, passed: actual <= limit });
      }
    }
  }
  return { passed: comparisons.every(row => row.passed), comparisons };
}
export function markdown(report) {
  const lines = ['# Performance regression report', '', `Result: **${report.passed ? 'PASS' : 'FAIL'}**`, '',
    `Source: ${report.environment?.sourceRevision ?? 'unknown'}; workload: ${report.workload?.sha256 ?? 'unknown'}`, '',
    'Sample p95 is a nearest-rank statistic from this synthetic workload, not a user-population percentile.', '',
    '| Scenario | Metric | Quantile | Baseline (ms) | Actual (ms) | Change | Limit (ms) | Result |',
    '| --- | --- | --- | ---: | ---: | --- | ---: | --- |'];
  for (const r of report.comparisons ?? []) lines.push(`| ${r.scenario} | ${r.metric} | ${r.quantile} | ${r.baseline.toFixed(1)} | ${r.actual.toFixed(1)} | ${r.deltaPercent === null ? "n/a" : `${r.deltaPercent.toFixed(1)}%`} (${r.deltaMs.toFixed(1)}ms) | ${r.limit.toFixed(1)} | ${r.passed ? 'PASS' : 'FAIL'} |`);
  if (report.error) lines.push('', '```text', report.error, '```');
  return lines.join('\n') + '\n';
}

// The same report feeds the release log, Actions annotation and job summary.
export function annotations(report) {
  const escape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const failures = (report.comparisons ?? []).filter(row => !row.passed);
  const messages = failures.map(row => `${row.scenario}/${row.metric}/${row.quantile}: ${row.actual.toFixed(1)}ms vs baseline ${row.baseline.toFixed(1)}ms (${row.deltaPercent === null ? 'n/a' : `${row.deltaPercent.toFixed(1)}%`}, +${row.deltaMs.toFixed(1)}ms); budget ${row.limit.toFixed(1)}ms. See performance report artifact.`);
  if (report.error) messages.push(`Performance measurement/behavior failed: ${report.error}. See performance report and child logs.`);
  return messages.map(message => `::error title=Performance regression::${escape(message)}`);
}
