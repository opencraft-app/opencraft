#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const portableTargets = ['web-browser', 'electron-renderer', 'electron-host', 'expo-web', 'expo-ios-bundle'];
const auditDirectories = ['.', 'runtime/dsh', 'hemesclient'];
const renderers = ['web-browser', 'electron-renderer'];
const expo = ['expo-web', 'expo-ios-bundle'];

/** Conservative fallback for new paths; documentation is the only general exclusion. */
export function planChanges(paths, { event = 'pull_request', unknownDiff = false } = {}) {
  const builds = new Set();
  const audits = new Set();
  let managedWeb = false;
  let native = false;
  const allBuilds = () => { portableTargets.forEach(target => builds.add(target)); };
  const allChecks = () => { allBuilds(); auditDirectories.forEach(dir => audits.add(dir)); managedWeb = true; native = true; };
  if (unknownDiff || event === 'workflow_dispatch') allChecks();
  // Advisory databases change even when lockfiles do not.
  if (event === 'push' || event === 'schedule') auditDirectories.forEach(dir => audits.add(dir));
  for (const path of paths) {
    if (/^(docs|design|\.agents)\//.test(path) || /^[^/]+\.md$/i.test(path) || /(?:^|\/)(?:README|AGENTS)\.md$/i.test(path) || /^(LICENSE|NOTICE)(\.|$)/.test(path)) continue;
    if (/^\.github\//.test(path) || /^(package(?:-lock)?\.json|\.npmrc|\.nvmrc|tsconfig[^/]*|config\/build-matrix\.json)$/.test(path)
      || path === 'scripts/ci-plan.mjs' || path === 'tests/ci-plan.test.mjs') { allChecks(); continue; }
    if (path === '.gitleaks.toml') continue; // Secrets scan always runs.
    if (/^(runtime\/dsh|hemesclient)\/(package(?:-lock)?\.json|\.npmrc)$/.test(path)) {
      audits.add(path.startsWith('runtime/') ? 'runtime/dsh' : 'hemesclient');
    } else if (/^(apps|packages|plugins)\/[^/]+\/package\.json$/.test(path)) audits.add('.');
    if (/^apps\/workbench-web\//.test(path)) {
      renderers.forEach(target => builds.add(target));
      if (!path.startsWith('apps/workbench-web/src/') || /\/web-updates[^/]*\./.test(path)) managedWeb = true;
      continue;
    }
    if (/^apps\/workbench-expo\//.test(path)) { expo.forEach(target => builds.add(target)); continue; }
    if (/^apps\/(workbench-electron|opencraft-daemon|local-agent-host)\//.test(path) || path.startsWith('runtime/dsh/')) {
      builds.add('electron-host');
      if (path.startsWith('apps/workbench-electron/')) native = true;
      continue;
    }
    // Web styles cannot be consumed by Metro or the Node host.
    if (/^(packages|plugins)\/.*\.(scss|css)$/.test(path)) {
      renderers.forEach(target => builds.add(target)); continue;
    }
    if (/^(packages|plugins)\//.test(path)) { allBuilds(); managedWeb = true; continue; }
    if (/^(scripts\/(web-deployment|server-deployment)\/|packaging\/web-server\/)/.test(path)
      || /^(scripts|tests)\/(.*web-(updates|deployment|release)|.*server-(updates|deployment)|.*public-release)/.test(path)
      || /^playwright\.web-updates/.test(path)) { managedWeb = true; continue; }
    // Unknown build inputs and new top-level areas retain the broad baseline.
    allBuilds(); managedWeb = true; native = true;
  }
  return {
    targets: portableTargets.filter(target => builds.has(target)),
    audits: auditDirectories.filter(dir => audits.has(dir)),
    managedWeb, native,
  };
}

export function changedPaths(eventName, event, cwd = process.cwd()) {
  if (eventName === 'workflow_dispatch' || eventName === 'schedule') return [];
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  const head = eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after;
  if (![base, head].every(sha => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha))) {
    throw new Error('No usable diff endpoints');
  }
  // PRs compare against their merge base; pushes cover the entire pushed range.
  // No rename detection: both old and new paths must participate in selection.
  const range = `${base}${eventName === 'pull_request' ? '...' : '..'}${head}`;
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let paths = [], unknownDiff = false;
  try { paths = changedPaths(eventName, event); }
  catch { unknownDiff = true; console.warn('Diff unavailable; selecting the full validation baseline.'); }
  const plan = planChanges(paths, { event: eventName, unknownDiff });
  const outputs = {
    targets: JSON.stringify(plan.targets), audits: JSON.stringify(plan.audits),
    'has-builds': plan.targets.length > 0, 'has-audits': plan.audits.length > 0,
    'managed-web': plan.managedWeb, native: plan.native,
  };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Selected CI work\n\n- Portable builds: ${plan.targets.join(', ') || 'none'}\n- Dependency audits: ${plan.audits.join(', ') || 'none'}\n- Managed Web: ${plan.managedWeb}\n- macOS native compile: ${plan.native}\n- Full fallback: ${unknownDiff}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
