#!/usr/bin/env node
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

export const portableTargets = ['web-browser', 'electron-renderer', 'electron-host', 'expo-web', 'expo-ios-bundle'];
const auditDirectories = ['.', 'runtime/dsh', 'apps/bridges/hermes'];
const websiteLogo = 'apps/workbench-web/public/opencraft-icon.svg';
const isWebsitePath = path => path.startsWith('website/');
/**
 * Release and workflow tooling that builds no product. Every PR validates it
 * without the Web/server matrix: ci-plan.yml runs these tooling tests, and
 * workflow-lint checks every workflow change. build-matrix.yml and ci-plan.yml
 * themselves still run the matrix they define.
 */
export function releaseToolingOnly(path) {
  return /^\.github\/workflows\/(?!build-matrix\.yml$|ci-plan\.yml$)[^/]+\.ya?ml$/.test(path)
    || /^scripts\/release\/(?!publish-workbench-web\.mjs$)[^/]+\.(?:mjs|sh)$/.test(path)
    || /^tests\/tooling\/(?:android-release|ios-release|ios-testflight|app-release|container-release|product-version|dev-build)\.test\.mjs$/.test(path);
}
/** Automatic checks stay on Linux/Web. Other platforms require an explicit manual request. */
export function planChanges(paths, { event = 'pull_request', unknownDiff = false, fullMatrix = false } = {}) {
  const websiteOnly = !unknownDiff && ['pull_request', 'merge_group'].includes(event)
    && paths.length > 0 && paths.every(isWebsitePath);
  const website = unknownDiff || event === 'workflow_dispatch'
    || paths.some(path => isWebsitePath(path) || path === websiteLogo);
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
    if (isWebsitePath(path)) continue;
    if (/^examples\/extensions\//.test(path) || path === 'tests/extensions/extension-example.test.ts'
      || path === 'docs/develop/extension-development.md' || path === 'docs/architecture/extensions/plugin-architecture.md'
      || path.startsWith('docs/architecture/extensions/')
      || path === 'CONTRIBUTING.md') {
      extensions = true;
      continue;
    }
    if (/^packages\/extension-(contract|runtime)\//.test(path)
      || /^tests\/extensions\/extension-.*\.test\.ts$/.test(path)
      || path === 'apps/workbench-web/src/runtime/module-url-extension-loader.ts') extensions = true;
    if (/^(docs|design|\.agents)\//.test(path) || /^[^/]+\.md$/i.test(path) || /(?:^|\/)(?:README|AGENTS)\.md$/i.test(path) || /^(LICENSE|NOTICE)(\.|$)/.test(path)) continue;
    if (/^(deploy\/web-server\/|scripts\/server-deployment\/|apps\/headless-server\/src\/server-deployment\/|apps\/headless-server\/src\/headless-web-release\.mjs$)/.test(path)
      || /^(scripts\/(packaging\/(package-headless-linux\.mjs|install-headless-linux\.sh|headless-(codex-launcher|server-launcher)\.sh|headless-web-build\.mjs)|smoke\/server\/(smoke-headless-(package|release-upgrade)|headless-smoke-process)\.mjs)|config\/build-matrix\.json)$/.test(path)
      || /^(packages\/(sqlite-node|storage-node)\/|\.github\/actions\/headless-upgrade\/)/.test(path)
      || /^tests\/server\/(headless-installer|server-deployment)\.test\.mjs$/.test(path)) {
      headlessTests = true;
      headlessPackage = true;
    }
    if (releaseToolingOnly(path)) continue;
    if (/^\.github\//.test(path) || /^(package(?:-lock)?\.json|\.npmrc|\.nvmrc|tsconfig[^/]*|config\/build-matrix\.json)$/.test(path)
      || path === 'scripts/ci/ci-plan.mjs' || path === 'tests/tooling/ci-plan.test.mjs') { automaticChecks(); continue; }
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
    if (/^apps\/(desktop|opencraft-daemon|local-agent-host)\//.test(path) || path.startsWith('runtime/dsh/')) {
      headlessTests = true;
      continue;
    }
    // Web styles cannot be consumed by Metro or the Node host.
    if (/^(packages|plugins)\/.*\.(scss|css)$/.test(path)) {
      web(); continue;
    }
    if (/^(packages|plugins)\//.test(path)) { web(); managedWeb = true; headlessTests = true; continue; }
    if (/^(scripts\/(web-deployment|server-deployment)\/|apps\/headless-server\/src\/(web-deployment|server-deployment)\/|deploy\/web-server\/)/.test(path)
      || /^(scripts|tests)\/(.*web-(updates|deployment|release)|.*server-(updates|deployment)|.*public-release)/.test(path)
      || /^config\/playwright\.web-updates/.test(path)) { web(); managedWeb = true; headlessTests = true; continue; }
    // Unknown inputs retain Web and server coverage, not the opt-in platform matrix.
    web(); managedWeb = true; headlessTests = true;
  }
  return {
    targets: portableTargets.filter(target => builds.has(target)),
    audits: auditDirectories.filter(dir => audits.has(dir)),
    managedWeb, native, headlessTests, headlessPackage, extensions, website, websiteOnly,
  };
}

function isInternalMainPullRequest(eventName, event) {
  const repository = event?.repository;
  const pull = event?.pull_request;
  return eventName === 'pull_request'
    && repository?.full_name === 'opencraft-app/opencraft'
    && Number.isSafeInteger(repository.id)
    && repository.id > 0
    && pull?.base?.ref === 'main'
    && pull.base.repo?.id === repository.id
    && pull.head?.repo?.id === repository.id
    && ['OWNER', 'MEMBER'].includes(pull.author_association);
}

function affectsValidation(path) {
  return /^(?:\.github|config|deploy|scripts\/(?:ci|check|packaging|release)|tests\/(?:support|tooling))\//.test(path)
    || /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|\.npmrc|\.nvmrc|\.gitleaks\.toml)$/.test(path);
}

export function planRun(paths, { eventName, event, unknownDiff = false, fullMatrix = false }) {
  const plan = planChanges(paths, { event: eventName, unknownDiff, fullMatrix });
  const fastPr = !unknownDiff && isInternalMainPullRequest(eventName, event)
    && !plan.website && !plan.headlessPackage && !plan.audits.length && !paths.some(affectsValidation);
  if (!fastPr) return { ...plan, fastPr, quickTests: [] };

  const quickTests = [];
  if (plan.targets.includes('web-browser')) quickTests.push('chat');
  if (plan.headlessTests) quickTests.push('appserver-client');
  if (plan.managedWeb || paths.some(path => /^apps\/(?:desktop|mobile)\//.test(path))) quickTests.push('startup');
  if (plan.extensions) quickTests.push('extensions');
  return {
    ...plan,
    targets: [],
    managedWeb: false,
    headlessTests: false,
    extensions: false,
    fastPr,
    quickTests,
  };
}

export function changedPaths(eventName, event, cwd = process.cwd()) {
  if (eventName === 'workflow_dispatch' || eventName === 'schedule') return [];
  const [base, head] = eventName === 'pull_request' ? [event.pull_request?.base?.sha, event.pull_request?.head?.sha]
    : eventName === 'merge_group' ? [event.merge_group?.base_sha, event.merge_group?.head_sha]
    : [event.before, event.after];
  if (![base, head].every(sha => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha))) {
    throw new Error('No usable diff endpoints');
  }
  // PRs compare against their merge base; pushes and merge queue groups cover
  // everything on top of their base (a group holds every PR queued ahead of it).
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
  const plan = planRun(paths, { eventName, event, unknownDiff, fullMatrix });
  const outputs = {
    'fast-pr': plan.fastPr, 'quick-tests': JSON.stringify(plan.quickTests),
    targets: JSON.stringify(plan.targets), audits: JSON.stringify(plan.audits),
    website: plan.website, 'website-only': plan.websiteOnly,
    'has-builds': plan.targets.length > 0, 'has-audits': plan.audits.length > 0,
    'managed-web': plan.managedWeb, native: plan.native,
    'headless-tests': plan.headlessTests, 'headless-package': plan.headlessPackage, extensions: plan.extensions,
  };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Selected CI work\n\n- Internal PR fast checks: ${plan.fastPr}\n- Quick test suites: ${plan.quickTests.join(', ') || 'none'}\n- Portable builds: ${plan.targets.join(', ') || 'none'}\n- Website: ${plan.website}\n- Dependency audits: ${plan.audits.join(', ') || 'none'}\n- Managed Web: ${plan.managedWeb}\n- Extension contracts: ${plan.extensions}\n- Server tests: ${plan.headlessTests}\n- Server archive: ${plan.headlessPackage}\n- macOS native compile: ${plan.native}\n- Full matrix requested: ${eventName === 'workflow_dispatch' && fullMatrix}\n- Diff unavailable: ${unknownDiff}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) main();
