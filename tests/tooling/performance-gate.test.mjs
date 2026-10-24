import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scenarios, summarize, candidate, compare, markdown, annotations, sidebarEvidence } from '../../scripts/performance/report.mjs';

const evidence = () => Object.entries(scenarios).map(([id, metrics]) => ({ id, samples: Array.from({ length: 10 }, (_, n) => Object.fromEntries(metrics.map(metric => [metric, n < 9 ? 100 : 200]))) }));
const workload = { version: 1, sha256: 'test-workload' };
const baseline = () => candidate(summarize(evidence()), workload, { sourceRevision: 'fixture' });
const sidebarReceipt = () => [30, 200].map(rows => ({ rows,
  samples: Array.from({ length: 10 }, () => ({ ms: 20, rowsProcessed: 0, projections: 0 })) }));
test('sidebar aggregation accepts measured rows alongside supported interaction receipts', () => {
  const rows = [...sidebarReceipt(), ...['listContext', 'groupHeading', 'availability', 'titleOnly'].map(key => ({ [key]: true }))];
  assert.deepEqual(sidebarEvidence('sidebar-menu', rows).map(row => row.id), ['sidebar-menu-30', 'sidebar-menu-200']);
  assert.equal(sidebarEvidence('sidebar-update', sidebarReceipt()).length, 2);
});
test('sidebar aggregation rejects missing, duplicate, unknown and reconstructing evidence', () => {
  for (const mutate of [rows => rows.pop(), rows => rows.push(rows[0]), rows => rows[0].rows = 999,
    rows => rows.push({ unknown: true }), rows => rows.push({ listContext: false }),
    rows => rows[0].samples[0].rowsProcessed = 1, rows => rows[0].samples[0].projections = 1,
    rows => delete rows[0].samples[0].projections]) {
    const rows = sidebarReceipt(); mutate(rows); assert.throws(() => sidebarEvidence('sidebar-menu', rows));
  }
  assert.throws(() => sidebarEvidence('sidebar-update', [...sidebarReceipt(), { listContext: true }]));
});
test('normal noise passes, quantiles retain the slow tail, improvements pass', () => {
  const rows = evidence(); const summary = summarize(rows);
  assert.deepEqual(summary['catalog-desktop'].metrics.firstPaintMs, { p50: 100, p95: 200 });
  assert.equal(compare(summary, baseline(), workload).passed, true);
  rows.forEach(row => row.samples.forEach(sample => Object.keys(sample).forEach(key => sample[key] /= 2)));
  assert.equal(compare(summarize(rows), baseline(), workload).passed, true);
});
for (const [id, metric] of [['catalog-desktop', 'firstPaintMs'], ['catalog-narrow', 'completePaintMs'], ['session-desktop', 'readyMs'], ['session-warm-narrow', 'firstPaintMs'], ['session-navigation-cached-desktop', 'firstPaintMs'], ['session-navigation-cold-narrow', 'firstPaintMs'], ['sidebar-menu-200', 'ms'], ['sidebar-update-30', 'ms']]) {
  test(`blocks a slow ${id}/${metric}, including tail-only regressions`, () => {
    const rows = evidence(); rows.find(row => row.id === id).samples[9][metric] = 2000;
    const result = compare(summarize(rows), baseline(), workload);
    assert.equal(result.passed, false);
    assert.ok(result.comparisons.some(row => row.scenario === id && row.metric === metric && row.quantile === 'p95' && !row.passed));
  });
}
test('missing, duplicate, incomplete and invalid evidence fails closed', () => {
  for (const mutate of [rows => rows.pop(), rows => rows.push(rows[0]), rows => rows[0].samples.pop(), rows => delete rows[0].samples[0].firstPaintMs,
    rows => rows[0].samples[0].firstPaintMs = NaN, rows => rows[0].samples[0].firstPaintMs = -1, rows => rows[0].samples[0].firstPaintMs = '100']) {
    const rows = evidence(); mutate(rows); assert.throws(() => summarize(rows));
  }
});
test('incompatible or incomplete baselines cannot silently approve a release', () => {
  for (const mutate of [b => b.unit = 'seconds', b => b.workload.sha256 = 'different-workload', b => delete b.scenarios['session-desktop'],
    b => delete b.scenarios['catalog-desktop'].firstPaintMs, b => b.scenarios['catalog-desktop'].firstPaintMs.p95 = null,
    b => b.scenarios['catalog-desktop'].firstPaintMs.relativeTolerance = Infinity]) {
    const b = structuredClone(baseline()); mutate(b); assert.throws(() => compare(summarize(evidence()), b, workload));
  }
});
test('formal release gate is unconditional, before packaging, with retained failure evidence', () => {
  const source = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const preflight = source.split('\n  preflight:')[1].split('\n  publish:')[0];
  const step = preflight.match(/      - name: Gate formal releases on performance regressions\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(step); assert.match(step, /run: npm run gate:performance -- --output/);
  assert.match(step, /if: \$\{\{ inputs\.oidc_probe != true \}\}/);
  assert.doesNotMatch(step, /continue-on-error/);
  assert.match(preflight, /name: Test website updates\n        if: \$\{\{ inputs\.oidc_probe != true \}\}/);
  assert.match(preflight, /name: Build and test website updates in the browser\n        if: \$\{\{ inputs\.oidc_probe != true \}\}/);
  assert.match(preflight, /name: Test the release kit\n        if: \$\{\{ inputs\.oidc_probe != true \}\}/);
  assert.ok(preflight.indexOf('Gate formal releases') < preflight.indexOf('Package once'));
  assert.match(preflight, /name: Retain performance samples and failure evidence\n        if: \$\{\{ always\(\) && inputs\.oidc_probe != true \}\}/);
  assert.ok(preflight.includes('name: performance-${{ needs.request.outputs.tag }}-${{ github.run_attempt }}'), 'Failed preflight reruns retain a distinct artifact for every attempt');
  assert.match(source, /needs: \[request, preflight\]/);
  const publish = source.split('\n  publish:')[1].split('\n  github-release:')[0];
  assert.match(publish, /environment:\n      name: npm-release/);
  assert.match(publish, /permissions:\n      contents: read\n      id-token: write/);
  assert.match(publish, /name: Check out the exact release tag\n[\s\S]*ref: refs\/tags\/\$\{\{ needs\.request\.outputs\.tag \}\}/);
  assert.doesNotMatch(publish.split('\n      - name: Native npm OIDC dry-run probe')[0], /ref: \$\{github\.(sha|ref|head_ref)\}|ref: main|ref: refs\/heads\//);
  const probeCheckout = publish.match(/name: Check out the workflow kit for the OIDC probe\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(probeCheckout);
  assert.match(probeCheckout, /if: \$\{\{ inputs\.oidc_probe == true \}\}/);
  assert.match(probeCheckout, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(probeCheckout, /path: workflow-kit/);
  assert.doesNotMatch(probeCheckout, /github\.sha|origin\/main|refs\/heads\/main/);
  const probe = publish.match(/name: Native npm OIDC dry-run probe \(temporary diagnosis\)\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(probe);
  assert.match(probe, /if: \$\{\{ inputs\.oidc_probe == true \}\}/);
  assert.match(probe, /WORKFLOW_KIT: workflow-kit\/\.github\/secure-release\/v1\/secure_release\.py/);
  assert.match(probe, /python3 "\$WORKFLOW_KIT" oidc-dry-run --artifact "\$TARBALL"/);
  assert.match(probe, /--provenance true --userconfig "\$NPM_CONFIG_USERCONFIG"/);
  assert.match(probe, /handwritten oidc-probe is contrast-only and is not the native CLI/);
  assert.doesNotMatch(probe, /python3 "\$KIT" oidc-probe/);
  assert.doesNotMatch(probe, /python3 "\$WORKFLOW_KIT" oidc-probe/);
  assert.doesNotMatch(probe, /python3 "\$KIT" npm-publish/);
  assert.doesNotMatch(probe, /oidc-dry-run[^\n]*--dry-run/);
  const npmPublish = publish.match(/name: Reverify and publish exact bytes\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(npmPublish);
  assert.match(npmPublish, /if: \$\{\{ inputs\.oidc_probe != true \}\}/);
  assert.match(npmPublish, /python3 "\$KIT" npm-publish/);
  assert.doesNotMatch(npmPublish, /WORKFLOW_KIT|workflow-kit/);
  const smoke = publish.match(/name: Verify public metadata and clean npm installation\n([\s\S]*?)(?=\n  github-release:|$)/)?.[1];
  assert.ok(smoke);
  assert.match(smoke, /if: \$\{\{ inputs\.oidc_probe != true \}\}/);
  assert.match(source, /\n  github-release:\n    needs: \[request, publish\]\n    if: \$\{\{ inputs\.oidc_probe != true \}\}/);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(pkg.scripts.gate, /gate:performance/);
  assert.doesNotMatch(readFileSync(new URL('../../.github/workflows/build-matrix.yml', import.meta.url), 'utf8'), /gate:performance/);
});
test('CLI fails on incompatible evidence and never reuses an existing output directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opencraft performance test-'));
  try {
    writeFileSync(path.join(dir, 'run.lock'), 'previous invocation');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/performance/run.mjs', import.meta.url)), '--output', dir], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /EEXIST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formal runner dispatches existing source files through both sidebar receipt stages', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opencraft performance dispatch-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../support/performance-runner-probe.mjs', import.meta.url)),
      '--output', dir, '--record-baseline', path.join(dir, 'candidate.json')], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
    assert.equal(report.passed, true);
    assert.ok(report.checks.some(row => row.id === 'sidebar-update' && row.passed));
    assert.ok(report.checks.some(row => row.id === 'sidebar-menu' && row.passed));
    const invocations = readFileSync(path.join(dir, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(invocations.length, report.checks.length, 'Every stage resolved a real entrypoint');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('navigation regressions name the metric, budget and delta in release notifications', () => {
  const rows = evidence(); rows.find(row => row.id === 'session-navigation-cached-desktop').samples[9].firstPaintMs = 3000;
  const report = compare(summarize(rows), baseline(), workload);
  assert.equal(report.passed, false);
  const text = markdown(report), alerts = annotations(report);
  assert.match(text, /session-navigation-cached-desktop.*1400.0%.*2800.0ms.*FAIL/);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /::error title=Performance regression::session-navigation-cached-desktop\/firstPaintMs\/p95/);
  assert.match(alerts[0], /3000.0ms vs baseline 200.0ms.*budget 360.0ms/);
  assert.deepEqual(annotations({ passed: true }), []);
  assert.match(annotations({ error: 'Cached paint failed\nfixture%trace' })[0], /%0Afixture%25trace/);
});
test('formal runner builds this source and requires navigation evidence in the same report', () => {
  const source = readFileSync(new URL('../../scripts/performance/run.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf("run('cold-open-build'") < source.indexOf("run('session-navigation'"));
  assert.match(source, /OPENCRAFT_COLD_OPEN_WEB_ROOT: path.join\(root, 'apps\/workbench-web\/dist'\)/);
  assert.match(source, /report.evidence.push\(\.\.\.navigation.evidence\)/);
  assert.match(source, /appendFile\(process.env.GITHUB_STEP_SUMMARY, md\)/);
  assert.match(source, /annotations\(report\)/);
  for (const id of ['cold-desktop', 'cached-desktop', 'cold-narrow', 'cached-narrow']) assert.ok(Object.hasOwn(scenarios, `session-navigation-${id}`));
});
