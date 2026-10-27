#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only vulnerability findings may be advisory. Registry/tool failures must fail CI.
export function auditOutcome({ status, report, reportOnly = false }) {
  const counts = report?.metadata?.vulnerabilities;
  const valid = report?.auditReportVersion === 2 && !report.error
    && report.vulnerabilities && typeof report.vulnerabilities === 'object'
    && !Array.isArray(report.vulnerabilities)
    && ['info', 'low', 'moderate', 'high', 'critical', 'total'].every(
      key => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0);
  if (!valid || ![0, 1].includes(status)) return 'error';
  if (status === 0) return 'pass';
  if (counts.high + counts.critical === 0) return 'error';
  return reportOnly ? 'reported' : 'blocked';
}

function main() {
  const result = spawnSync('npm', ['audit', '--json', '--audit-level=high'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const raw = result.stdout || '';
  process.stdout.write(raw);
  process.stderr.write(result.stderr || '');
  if (process.env.NPM_AUDIT_REPORT) writeFileSync(process.env.NPM_AUDIT_REPORT, raw);
  let report;
  try { report = JSON.parse(raw); } catch { /* Invalid reports fail below. */ }
  const outcome = auditOutcome({ status: result.status, report,
    reportOnly: process.env.NPM_AUDIT_REPORT_ONLY === 'true' });
  const message = outcome === 'reported'
    ? 'Dependency findings retained as advisory under the upstream CI policy; not remediated.'
    : `Dependency audit: ${outcome}.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n### Dependency audit (${process.cwd().split('/').pop()})\n\n${message}\n\n`
    + `\`\`\`json\n${JSON.stringify(report?.metadata?.vulnerabilities ?? null, null, 2)}\n\`\`\`\n`);
  process.exitCode = ['pass', 'reported'].includes(outcome) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
