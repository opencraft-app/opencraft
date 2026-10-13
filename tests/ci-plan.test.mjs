import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { changedPaths, planChanges, portableTargets } from '../scripts/ci-plan.mjs';

const renderers = ['web-browser', 'electron-renderer'];
test('selected targets exist in the build artifact contract', () => {
  const matrix = JSON.parse(readFileSync(new URL('../config/build-matrix.json', import.meta.url), 'utf8'));
  for (const target of portableTargets) assert(matrix.targets.some(entry => entry.id === target), target);
});
test('visual-only changes build both Web renderers without native packaging or update E2E', () => {
  assert.deepEqual(planChanges(['apps/workbench-web/src/components/sidebar.tsx', 'packages/design-system/src/tokens.web.scss']), {
    targets: renderers, audits: [], managedWeb: false, native: false,
  });
});
test('docs-only and empty diffs need no build; main and weekly runs still audit unchanged dependencies', () => {
  for (const paths of [[], ['docs/build-matrix.md', 'README.md', 'design/invariants.md']]) {
    assert.deepEqual(planChanges(paths), { targets: [], audits: [], managedWeb: false, native: false });
  }
  for (const event of ['push', 'schedule']) {
    assert.deepEqual(planChanges([], { event }).audits, ['.', 'runtime/dsh', 'hemesclient']);
    assert.equal(planChanges([], { event }).managedWeb, false);
  }
});
test('Expo source selects only Expo; host and macOS changes select their runtime', () => {
  assert.deepEqual(planChanges(['apps/workbench-expo/src/app.tsx']).targets, ['expo-web', 'expo-ios-bundle']);
  assert.deepEqual(planChanges(['apps/local-agent-host/src/main.ts']).targets, ['electron-host']);
  const native = planChanges(['apps/workbench-electron/native/speech.swift']);
  assert.deepEqual(native.targets, ['electron-host']);
  assert.equal(native.native, true);
});
test('shared contracts and unknown build inputs retain broad platform coverage', () => {
  for (const path of ['packages/chat-core/src/index.ts', 'plugins/new-plugin/src/index.ts', 'new-build-tool.config.js', 'packages/prompt-core/system-prompt.md']) {
    const plan = planChanges([path]);
    assert.deepEqual(plan.targets, portableTargets, path);
    assert.equal(plan.managedWeb, true, path);
  }
});
test('root toolchain, lockfile, workflow and selector changes validate all targets and audits', () => {
  for (const path of ['package.json', 'package-lock.json', '.nvmrc', '.npmrc', 'tsconfig.base.json',
    'config/build-matrix.json', '.github/workflows/ci-plan.yml', 'scripts/ci-plan.mjs', 'tests/ci-plan.test.mjs']) {
    const plan = planChanges([path]);
    assert.deepEqual(plan.targets, portableTargets, path);
    assert.deepEqual(plan.audits, ['.', 'runtime/dsh', 'hemesclient'], path);
    assert.equal(plan.native, true, path);
  }
});
test('isolated lockfiles audit their own install roots and workspace manifests audit the root', () => {
  assert.deepEqual(planChanges(['runtime/dsh/package-lock.json']).audits, ['runtime/dsh']);
  assert.deepEqual(planChanges(['hemesclient/package-lock.json']).audits, ['hemesclient']);
  assert.deepEqual(planChanges(['apps/workbench-web/package.json']).audits, ['.']);
  assert.deepEqual(planChanges(['plugins/voice-input/package.json']).audits, ['.']);
});
test('managed Web is selected for update UI, deployment, protocol and Vite changes', () => {
  for (const path of ['apps/workbench-web/src/components/web-updates-settings.tsx',
    'apps/workbench-web/vite.config.ts', 'apps/workbench-web/public/opencraft-host-proxy-sw.js',
    'scripts/web-deployment/server.mjs', 'scripts/server-deployment/gateway.mjs',
    'packages/web-update-protocol/src/index.mjs', 'tests/web-deployment-source.test.mjs',
    'playwright.web-updates.config.mjs', 'packaging/web-server/package.json']) {
    assert.equal(planChanges([path]).managedWeb, true, path);
  }
});
test('manual requests and unavailable diffs restore the full validation baseline', () => {
  for (const options of [{ event: 'workflow_dispatch' }, { unknownDiff: true }]) {
    assert.deepEqual(planChanges([], options), {
      targets: portableTargets, audits: ['.', 'runtime/dsh', 'hemesclient'], managedWeb: true, native: true,
    });
  }
});
test('real Git diff covers merge-base semantics, deletions, renames, and more than 300 paths', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opencraft-ci-plan-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text); };
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'CI test'); git('config', 'user.email', 'ci@example.invalid');
    put('apps/workbench-web/old.ts', 'old'); git('add', '.'); git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'feature');
    put('apps/workbench-expo/new.ts', 'new');
    renameSync(join(cwd, 'apps/workbench-web/old.ts'), join(cwd, 'apps/workbench-expo/moved.ts'));
    for (let i = 0; i < 350; i++) put(`docs/file-${i}.md`, 'docs');
    git('add', '.'); git('commit', '-m', 'changes'); const head = git('rev-parse', 'HEAD');
    git('checkout', 'main'); put('unrelated.config.js', 'base advanced'); git('add', '.'); git('commit', '-m', 'advance main');
    const advanced = git('rev-parse', 'HEAD');
    const paths = changedPaths('pull_request', { pull_request: { base: { sha: advanced }, head: { sha: head } } }, cwd);
    assert.equal(paths.length, 353);
    assert(paths.includes('apps/workbench-web/old.ts'));
    assert(paths.includes('apps/workbench-expo/moved.ts'));
    assert(!paths.includes('unrelated.config.js'));
    assert.deepEqual(planChanges(paths).targets, [...renderers, 'expo-web', 'expo-ios-bundle']);
    assert.deepEqual(new Set(changedPaths('push', { before: base, after: head }, cwd)), new Set(paths));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('CLI writes machine-readable outputs and falls back when a base commit is unavailable', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opencraft-ci-output-'));
  try {
    const eventPath = join(cwd, 'event.json'), output = join(cwd, 'output'), summary = join(cwd, 'summary');
    writeFileSync(eventPath, JSON.stringify({ before: '0'.repeat(40), after: 'a'.repeat(40) }));
    execFileSync(process.execPath, [resolve('scripts/ci-plan.mjs')], { cwd,
      env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      stdio: 'pipe',
    });
    const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
      const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
    }));
    assert.equal(values['has-builds'], 'true'); assert.equal(values['has-audits'], 'true');
    assert.deepEqual(JSON.parse(values.targets), portableTargets);
    assert.match(readFileSync(summary, 'utf8'), /Full fallback: true/);
    assert.throws(() => changedPaths('push', { before: '--bad', after: 'a'.repeat(40) }, cwd));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
