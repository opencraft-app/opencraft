import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditOutcome } from '../../scripts/dependency-audit.mjs';

const report = (high = 1, critical = 0) => ({ auditReportVersion: 2, vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical, total: high + critical } } });

test('strict remains the default, including critical findings', () => {
  for (const value of [report(), report(0, 1)])
    assert.equal(auditOutcome({ status: 1, report: value }), 'blocked');
});
test('explicit advisory mode reports findings without calling them fixed', () => {
  assert.equal(auditOutcome({ status: 1, report: report(), reportOnly: true }), 'reported');
});
test('clean audit passes in both modes', () => {
  for (const reportOnly of [false, true])
    assert.equal(auditOutcome({ status: 0, report: report(0), reportOnly }), 'pass');
});
test('registry errors, process failures and malformed reports fail even in report-only mode', () => {
  for (const value of [undefined, {}, { ...report(), error: { code: 'E503' } },
    { ...report(), metadata: { vulnerabilities: { high: 1 } } }])
    assert.equal(auditOutcome({ status: 1, report: value, reportOnly: true }), 'error');
  for (const status of [null, 2, 127])
    assert.equal(auditOutcome({ status, report: report(), reportOnly: true }), 'error');
  assert.equal(auditOutcome({ status: 1, report: report(0), reportOnly: true }), 'error');
});
test('upstream policy preserves advisory findings across repository visibility changes', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/security.yml', import.meta.url), 'utf8');
  assert.match(workflow, /NPM_AUDIT_REPORT_ONLY: 'true'/);
  assert.doesNotMatch(workflow, /PRIVATE_MIGRATION_AUDIT_REPORT_ONLY|github\.event\.repository\.private/);
  assert.match(workflow, /node "\$GITHUB_WORKSPACE\/scripts\/dependency-audit\.mjs"/);
  assert.doesNotMatch(workflow, /continue-on-error|npm audit.*\|\| true/);
  assert.match(workflow, /SECRETS_RESULT: \$\{\{ needs\.secrets\.result \}\}/);
});
