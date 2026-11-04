#!/usr/bin/env node
// Summarize retained Node test output; baseline matches never turn a failure green.
import {readFile} from 'node:fs/promises';

export function summarize(text, baseline = '') {
  const clean = value => value.replace(/\u001b\[[0-9;]*m/g, '');
  const failures = value => [...new Set(clean(value).split('\n').flatMap(line => {
    const match = line.match(/^\s*(?:not ok \d+ - |[✖×] )(.+?)(?: \([\d.]+m?s\))?$/);
    return match && match[1] !== 'failing tests:' ? [match[1]] : [];
  }))];
  const previous = new Set(failures(baseline));
  const counts = {};
  for (const line of clean(text).split('\n')) {
    const match = line.match(/^(?:# |ℹ )(tests|pass|fail|cancelled|skipped|duration_ms) ([\d.]+)/);
    if (match) counts[match[1]] = Number(match[2]);
  }
  return {complete: counts.tests !== undefined && counts.fail !== undefined,
    counts, failures: failures(text).map(name => ({name, baseline: previous.has(name)}))};
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [log, baselineFlag, baseline] = process.argv.slice(2);
  if (!log || (baselineFlag && (baselineFlag !== '--baseline' || !baseline))) {
    console.error('Usage: node scripts/test-summary.mjs <log> [--baseline <baseline-log>]');
    process.exitCode = 2;
  } else {
    const result = summarize(await readFile(log, 'utf8'), baseline ? await readFile(baseline, 'utf8') : '');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = !result.complete ? 2 : result.counts.fail || result.counts.cancelled || result.failures.length ? 1 : 0;
  }
}
