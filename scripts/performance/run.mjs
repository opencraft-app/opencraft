import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, open, appendFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { cpus, arch, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios, summarize, compare, candidate, markdown, annotations, sidebarEvidence } from './report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const options = { output: path.join(root, '.local/performance', new Date().toISOString().replaceAll(':', '-')), baseline: path.join(root, 'config/performance-baseline.json') };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = { '--output': 'output', '--baseline': 'baseline', '--record-baseline': 'record', '--control': 'control' }[process.argv[i]];
  assert.ok(key && process.argv[i + 1], `Unknown or incomplete argument: ${process.argv[i]}`);
  options[key] = key === 'control' ? process.argv[i + 1] : path.resolve(process.argv[i + 1]);
}
assert.ok(!options.control || options.control === 'legacy', 'Only the legacy catalog negative control is supported');
assert.ok(!(options.control && options.record), 'A negative control cannot create a baseline');
await mkdir(options.output, { recursive: true });
// Every invocation uses fresh evidence; stale or concurrent output must never pass.
const marker = await open(path.join(options.output, 'run.lock'), 'wx'); await marker.close();
const hash = createHash('sha256');
for (const file of ['scripts/performance/benchmark-workbench.ts', 'scripts/smoke/conversation/smoke-session-cold-open.ts', 'scripts/performance/build-cold-open.mjs', 'scripts/performance/run.mjs', 'scripts/performance/report.mjs', 'scripts/smoke/shell/smoke-sidebar-menu-latency.ts', 'scripts/smoke/shell/smoke-sidebar-conversation-latency.ts', 'tests/fixtures/catalog-entry-browser.tsx', 'tests/fixtures/session-loading-browser.tsx']) {
  hash.update(file); hash.update(await readFile(path.join(root, file)));
}
const workload = { version: 3, sha256: hash.digest('hex'), scenarios, samples: 10, warmupWorkbench: 1, navigation: { workloadVersion: 5, rpcDelayMs: 40, cachedResources: 'cold', initialize: 'held-until-cached-paint', serve: 'compressed-release', warmup: 1 }, profiles: { desktop: { width: 1100, cpuRate: 1 }, narrow: { width: 390, cpuRate: 4 }, sidebar: { width: 1000, cpuRate: 4 } } };
const git = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'unavailable'; } };
const environment = { timestamp: new Date().toISOString(), sourceRevision: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--', '.']) !== '', node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cpuCount: cpus().length };
const started = performance.now();
const report = { schemaVersion: 1, passed: false, workload, environment, checks: [], evidence: [] };
async function run(id, args, env = {}) {
  console.log(`Performance gate: ${id}`);
  const log = await open(path.join(options.output, `${id}.log`), 'wx');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, OPENCRAFT_PLAYWRIGHT_MODULE: '@playwright/test', OPENCRAFT_PERFORMANCE_SAMPLES: '10', ...env }, stdio: ['ignore', log.fd, log.fd], timeout: 600_000 });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`${id} failed (${signal ?? code}); see ${id}.log`)));
    });
    report.checks.push({ id, passed: true });
  } catch (error) { report.checks.push({ id, passed: false }); throw error; }
  finally { await log.close(); }
}
try {
  await run('gate-tests', ['--test', 'tests/tooling/performance-gate.test.mjs']);
  await run('cold-open-build', ['scripts/performance/build-cold-open.mjs']);
  await run('session-navigation', ['--import', 'tsx', 'scripts/smoke/conversation/smoke-session-cold-open.ts'], {
    OPENCRAFT_COLD_OPEN_WEB_ROOT: path.join(root, 'apps/workbench-web/dist'),
    OPENCRAFT_COLD_OPEN_SAMPLES: '10', OPENCRAFT_COLD_OPEN_EVIDENCE: path.join(options.output, 'session-navigation'),
  });
  const navigation = JSON.parse(await readFile(path.join(options.output, 'session-navigation/receipt.json'), 'utf8'));
  assert.equal(navigation.workloadVersion, workload.navigation.workloadVersion, 'Navigation evidence workload version mismatch'); report.evidence.push(...navigation.evidence);
  environment.navigationBuild = navigation.build; environment.navigationBrowser = navigation.browser;
  await run('catalog-behavior', ['--import', 'tsx', 'scripts/smoke/extensions/smoke-catalog-entry.ts'], { OPENCRAFT_CATALOG_ENTRY_OUTPUT: path.join(options.output, 'catalog-behavior') });
  await run('workbench', ['--import', 'tsx', 'scripts/performance/benchmark-workbench.ts'], { OPENCRAFT_PERFORMANCE_OUTPUT: path.join(options.output, 'workbench'), OPENCRAFT_PERFORMANCE_CATALOG_MODE: options.control ?? '' });
  const workbench = JSON.parse(await readFile(path.join(options.output, 'workbench/workbench.json'), 'utf8'));
  assert.equal(workbench.workloadVersion, 1); environment.browser = workbench.browser;
  report.evidence.push(...workbench.evidence);
  for (const [id, script, variable, filename] of [
    ['sidebar-update', 'smoke/shell/smoke-sidebar-conversation-latency.ts', 'OPENCRAFT_SIDEBAR_UPDATE_OUTPUT', 'results.json'],
    ['sidebar-menu', 'smoke/shell/smoke-sidebar-menu-latency.ts', 'OPENCRAFT_MENU_LATENCY_OUTPUT', 'result.json'],
  ]) {
    await run(id, ['--import', 'tsx', `scripts/${script}`], { [variable]: path.join(options.output, id) });
    const rows = JSON.parse(await readFile(path.join(options.output, id, filename), 'utf8'));
    report.evidence.push(...sidebarEvidence(id, rows));
  }
  report.summary = summarize(report.evidence);
  if (options.record) {
    await writeFile(options.record, JSON.stringify(candidate(report.summary, workload, environment), null, 2) + '\n', { flag: 'wx' });
    report.passed = true; report.baselineCandidate = options.record;
  } else {
    const bytes = await readFile(options.baseline);
    report.baselineSha256 = createHash('sha256').update(bytes).digest('hex');
    Object.assign(report, compare(report.summary, JSON.parse(bytes), workload));
  }
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  report.elapsedMs = performance.now() - started;
  await writeFile(path.join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const md = markdown(report); await writeFile(path.join(options.output, 'report.md'), md); console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  if (process.env.GITHUB_ACTIONS === 'true') for (const annotation of annotations(report)) console.log(annotation);
  process.exitCode = report.passed ? 0 : 1;
}
