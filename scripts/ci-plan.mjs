#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const portableTargets = ['web-browser', 'electron-renderer', 'electron-host', 'expo-web', 'expo-ios-bundle'];
const auditDirectories = ['.', 'runtime/dsh', 'apps/bridges/hermes'];
/** Automatic checks stay on Linux/Web. Other platforms require an explicit manual request. */
export function planChanges(paths, { event = 'pull_request', unknownDiff = false, fullMatrix = false } = {}) {
  const builds = new Set();
  const audits = new Set();
  let managedWeb = false;
  let native = false;
  let headlessTests = false;
  let headlessPackage = false;
  let extensions = false;
  const web = () => builds.add('web-browser');
  const automaticChecks = () => { extensions = true; web(); auditDirectories.forEach(dir => audits.add(dir)); managedWeb = true; headlessTests = true; };
  if (unknownDiff || event === 'workflow_dispatch') automaticChecks();
  // An unreadable diff must still exercise the server archive, without starting macOS/Expo.
  if (unknownDiff) headlessPackage = true;
  if (event === 'workflow_dispatch' && fullMatrix) {
    portableTargets.forEach(target => builds.add(target));
    native = true;
    headlessPackage = true;
  }
  // Advisory databases change even when lockfiles do not.
  if (event === 'push' || event === 'schedule') auditDirectories.forEach(dir => audits.add(dir));
  for (const path of paths) {
    if (/^examples\/extensions\//.test(path) || path === 'tests/extensions/extension-example.test.ts'
      || path === 'docs/extension-development.md' || path === 'docs/plugin-architecture.md'
      || path.startsWith('docs/architecture/extensions/')
      || path === 'CONTRIBUTING.md') {
      extensions = true;
      continue;
    }
    if (/^packages\/extension-(contract|runtime)\//.test(path)
      || /^tests\/extensions\/extension-.*\.test\.ts$/.test(path)
      || path === 'apps/workbench-web/src/runtime/module-url-extension-loader.ts') extensions = true;
    if (/^(docs|design|\.agents)\//.test(path) || /^[^/]+\.md$/i.test(path) || /(?:^|\/)(?:README|AGENTS)\.md$/i.test(path) || /^(LICENSE|NOTICE)(\.|$)/.test(path)) continue;
    if (/^(packaging\/web-server\/|scripts\/server-deployment\/)/.test(path)
      || /^(scripts\/(package-headless-linux\.mjs|install-headless-linux\.sh|headless-(codex-launcher|server-launcher)\.sh|smoke\/server\/smoke-headless-package\.mjs|headless-web-release\.mjs)|config\/build-matrix\.json)$/.test(path)
      || /^tests\/server\/(headless-installer|server-deployment)\.test\.mjs$/.test(path)) {
      headlessTests = true;
      headlessPackage = true;
    }
    if (/^\.github\//.test(path) || /^(package(?:-lock)?\.json|\.npmrc|\.nvmrc|tsconfig[^/]*|config\/build-matrix\.json)$/.test(path)
      || path === 'scripts/ci-plan.mjs' || path === 'tests/tooling/ci-plan.test.mjs') { automaticChecks(); continue; }
    if (path === '.gitleaks.toml') continue; // Secrets scan always runs.
    if (/^(runtime\/dsh|apps\/bridges\/hermes)\/(package(?:-lock)?\.json|\.npmrc)$/.test(path)) {
      audits.add(path.startsWith('runtime/') ? 'runtime/dsh' : 'apps/bridges/hermes');
    } else if (/^(apps|packages|plugins)\/[^/]+\/package\.json$/.test(path)) audits.add('.');
    if (/^apps\/workbench-web\//.test(path)) {
      web();
      if (!path.startsWith('apps/workbench-web/src/') || /\/web-updates[^/]*\./.test(path)) managedWeb = true;
      continue;
    }
    if (/^apps\/mobile\//.test(path)) { web(); continue; }
    if (/^apps\/(workbench-electron|opencraft-daemon|local-agent-host)\//.test(path) || path.startsWith('runtime/dsh/')) {
      headlessTests = true;
      continue;
    }
    // Web styles cannot be consumed by Metro or the Node host.
    if (/^(packages|plugins)\/.*\.(scss|css)$/.test(path)) {
      web(); continue;
    }
    if (/^(packages|plugins)\//.test(path)) { web(); managedWeb = true; headlessTests = true; continue; }
    if (/^(scripts\/(web-deployment|server-deployment)\/|packaging\/web-server\/)/.test(path)
      || /^(scripts|tests)\/(.*web-(updates|deployment|release)|.*server-(updates|deployment)|.*public-release)/.test(path)
      || /^config\/playwright\.web-updates/.test(path)) { web(); managedWeb = true; headlessTests = true; continue; }
    // Unknown inputs retain Web and server coverage, not the opt-in platform matrix.
    web(); managedWeb = true; headlessTests = true;
  }
  return {
    targets: portableTargets.filter(target => builds.has(target)),
    audits: auditDirectories.filter(dir => audits.has(dir)),
    managedWeb, native, headlessTests, headlessPackage, extensions,
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
  catch { unknownDiff = true; console.warn('Diff unavailable; selecting Web and server validation.'); }
  const fullMatrix = process.env.CI_FULL_MATRIX === 'true';
  const plan = planChanges(paths, { event: eventName, unknownDiff, fullMatrix });
  const outputs = {
    targets: JSON.stringify(plan.targets), audits: JSON.stringify(plan.audits),
    'has-builds': plan.targets.length > 0, 'has-audits': plan.audits.length > 0,
    'managed-web': plan.managedWeb, native: plan.native,
    'headless-tests': plan.headlessTests, 'headless-package': plan.headlessPackage, extensions: plan.extensions,
  };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Selected CI work\n\n- Portable builds: ${plan.targets.join(', ') || 'none'}\n- Dependency audits: ${plan.audits.join(', ') || 'none'}\n- Managed Web: ${plan.managedWeb}\n- Extension contracts: ${plan.extensions}\n- Server tests: ${plan.headlessTests}\n- Server archive: ${plan.headlessPackage}\n- macOS native compile: ${plan.native}\n- Full matrix requested: ${eventName === 'workflow_dispatch' && fullMatrix}\n- Diff unavailable: ${unknownDiff}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
