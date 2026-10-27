import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { changedPaths, planChanges, portableTargets } from "../../scripts/ci-plan.mjs";

const webTargets = ['web-browser'];
const emptyPlan = { targets: [], audits: [], managedWeb: false, native: false, headlessTests: false, headlessPackage: false, extensions: false };
test('selected targets exist in the build artifact contract', () => {
  const matrix = JSON.parse(readFileSync(new URL("../../config/build-matrix.json", import.meta.url), 'utf8'));
  for (const target of portableTargets) assert(matrix.targets.some(entry => entry.id === target), target);
});
test('visual-only changes build Web without native packaging, server tests or update E2E', () => {
  assert.deepEqual(planChanges(['apps/workbench-web/src/components/sidebar.tsx', 'packages/design-system/src/tokens.web.scss']), {
    ...emptyPlan, targets: webTargets,
  });
});
test('docs-only and empty diffs need no build; main and weekly runs still audit unchanged dependencies', () => {
  for (const paths of [[], ['docs/build-matrix.md', 'README.md', 'design/invariants.md']]) {
    assert.deepEqual(planChanges(paths), emptyPlan);
  }
  for (const event of ['push', 'schedule']) {
    assert.deepEqual(planChanges([], { event }).audits, ['.', 'runtime/dsh', 'apps/bridges/hermes']);
    assert.equal(planChanges([], { event }).managedWeb, false);
  }
});
test('platform source never starts Electron, Expo or macOS builds automatically', () => {
  assert.deepEqual(planChanges(['apps/mobile/src/app.tsx']), { ...emptyPlan, targets: webTargets });
  for (const path of ['apps/local-agent-host/src/main.ts', 'apps/opencraft-daemon/src/index.ts',
    'runtime/dsh/src/index.ts', 'apps/workbench-electron/native/speech.swift']) {
    assert.deepEqual(planChanges([path]), { ...emptyPlan, headlessTests: true }, path);
  }
});
test('shared contracts and unknown build inputs retain Web and server coverage', () => {
  for (const path of ['packages/chat-core/src/index.ts', 'plugins/new-plugin/src/index.ts',
    'new-build-tool.config.js', 'packages/prompt-core/system-prompt.md', 'tests/sync.test.mjs']) {
    assert.deepEqual(planChanges([path]), {
      ...emptyPlan, targets: webTargets, managedWeb: true, headlessTests: true,
    }, path);
  }
});
test('root toolchain, lockfile, workflow and selector changes stay on Web/Linux', () => {
  for (const path of ['package.json', 'package-lock.json', '.nvmrc', '.npmrc', 'tsconfig.base.json',
    'config/build-matrix.json', '.github/workflows/ci-plan.yml', 'scripts/ci-plan.mjs', 'tests/tooling/ci-plan.test.mjs']) {
    const plan = planChanges([path]);
    assert.deepEqual(plan.targets, webTargets, path);
    assert.deepEqual(plan.audits, ['.', 'runtime/dsh', 'apps/bridges/hermes'], path);
    assert.equal(plan.native, false, path);
    assert.equal(plan.headlessTests, true, path);
    assert.equal(plan.headlessPackage, path === 'config/build-matrix.json', path);
  }
});
test('server runtime changes test without packaging; archive inputs also build and smoke the archive', () => {
  for (const path of ['scripts/headless-server.mjs', 'scripts/headless-identity.mjs', 'tests/server/headless-server.test.mjs']) {
    const plan = planChanges([path]);
    assert.equal(plan.headlessTests, true, path);
    assert.equal(plan.headlessPackage, false, path);
  }
  for (const path of ['scripts/package-headless-linux.mjs', 'scripts/install-headless-linux.sh',
    'scripts/headless-codex-launcher.sh', 'scripts/headless-server-launcher.sh', 'scripts/headless-web-release.mjs',
    'scripts/smoke/server/smoke-headless-package.mjs', 'scripts/server-deployment/service.mjs',
    'tests/server/headless-installer.test.mjs', 'tests/server/server-deployment.test.mjs', 'packaging/web-server/package.json']) {
    const plan = planChanges([path]);
    assert.equal(plan.headlessTests, true, path);
    assert.equal(plan.headlessPackage, true, path);
    assert.equal(plan.native, false, path);
    assert.deepEqual(plan.targets, webTargets, path);
  }
});
test('isolated lockfiles audit their own install roots and workspace manifests audit the root', () => {
  assert.deepEqual(planChanges(['runtime/dsh/package-lock.json']).audits, ['runtime/dsh']);
  assert.deepEqual(planChanges(['apps/bridges/hermes/package-lock.json']).audits, ['apps/bridges/hermes']);
  assert.deepEqual(planChanges(['apps/workbench-web/package.json']).audits, ['.']);
  assert.deepEqual(planChanges(['plugins/voice-input/package.json']).audits, ['.']);
});
test('managed Web is selected for update UI, deployment, protocol and Vite changes', () => {
  for (const path of ['apps/workbench-web/src/components/web-updates-settings.tsx',
    'apps/workbench-web/vite.config.ts', 'apps/workbench-web/public/opencraft-host-proxy-sw.js',
    'scripts/web-deployment/server.mjs', 'scripts/server-deployment/gateway.mjs',
    'packages/web-update-protocol/src/index.mjs', 'tests/server/web-deployment-source.test.mjs',
    'config/playwright.web-updates.config.mjs', 'config/playwright.web-updates.live.config.mjs', 'packaging/web-server/package.json']) {
    assert.equal(planChanges([path]).managedWeb, true, path);
  }
});
test('manual Web is the default, and missing diffs conservatively validate the Linux server archive', () => {
  const automatic = { ...emptyPlan, targets: webTargets, audits: ['.', 'runtime/dsh', 'apps/bridges/hermes'],
    managedWeb: true, headlessTests: true, extensions: true };
  assert.deepEqual(planChanges([], { event: 'workflow_dispatch' }), automatic);
  assert.deepEqual(planChanges([], { unknownDiff: true }), { ...automatic, headlessPackage: true });
});
test('only explicit manual full requests restore other platforms and macOS', () => {
  assert.deepEqual(planChanges([], { event: 'workflow_dispatch', fullMatrix: true }), {
    targets: portableTargets, audits: ['.', 'runtime/dsh', 'apps/bridges/hermes'], managedWeb: true,
    native: true, headlessTests: true, headlessPackage: true, extensions: true,
  });
  for (const event of ['pull_request', 'push', 'schedule']) {
    assert.equal(planChanges(['package-lock.json'], { event, fullMatrix: true }).native, false);
    assert.deepEqual(planChanges(['package-lock.json'], { event, fullMatrix: true }).targets, webTargets);
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
    put('apps/mobile/new.ts', 'new');
    renameSync(join(cwd, 'apps/workbench-web/old.ts'), join(cwd, 'apps/mobile/moved.ts'));
    for (let i = 0; i < 350; i++) put(`docs/file-${i}.md`, 'docs');
    git('add', '.'); git('commit', '-m', 'changes'); const head = git('rev-parse', 'HEAD');
    git('checkout', 'main'); put('unrelated.config.js', 'base advanced'); git('add', '.'); git('commit', '-m', 'advance main');
    const advanced = git('rev-parse', 'HEAD');
    const paths = changedPaths('pull_request', { pull_request: { base: { sha: advanced }, head: { sha: head } } }, cwd);
    assert.equal(paths.length, 353);
    assert(paths.includes('apps/workbench-web/old.ts'));
    assert(paths.includes('apps/mobile/moved.ts'));
    assert(!paths.includes('unrelated.config.js'));
    assert.deepEqual(planChanges(paths).targets, webTargets);
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
    assert.deepEqual(JSON.parse(values.targets), webTargets);
    assert.equal(values.native, 'false');
    assert.equal(values['headless-tests'], 'true');
    assert.equal(values['headless-package'], 'true');
    assert.match(readFileSync(summary, 'utf8'), /Diff unavailable: true/);
    assert.throws(() => changedPaths('push', { before: '--bad', after: 'a'.repeat(40) }, cwd));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('CLI propagates explicit manual full-matrix requests without widening PRs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opencraft-ci-manual-'));
  try {
    const eventPath = join(cwd, 'event.json');
    writeFileSync(eventPath, '{}');
    for (const [event, full, expectedTargets, expectedNative] of [
      ['workflow_dispatch', 'false', webTargets, 'false'],
      ['workflow_dispatch', 'true', portableTargets, 'true'],
      ['pull_request', 'true', webTargets, 'false'],
    ]) {
      const output = join(cwd, `output-${event}-${full}`);
      execFileSync(process.execPath, [resolve('scripts/ci-plan.mjs')], { cwd,
        env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath,
          CI_FULL_MATRIX: full, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' }, stdio: 'pipe' });
      const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
        const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
      }));
      assert.deepEqual(JSON.parse(values.targets), expectedTargets);
      assert.equal(values.native, expectedNative);
      assert.equal(values['headless-tests'], 'true');
      assert.equal(values['headless-package'], String(full === 'true'));
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});


test('extension guide and example select contract tests without platform builds', () => {
  for (const path of ['CONTRIBUTING.md', 'docs/extension-development.md', 'docs/plugin-architecture.md',
    'docs/architecture/extensions/architecture-and-lifecycle.md',
    'docs/architecture/extensions/manifest-and-contributions.md',
    'docs/architecture/extensions/identity-and-execution.md',
    'docs/architecture/extensions/product-composition.md',
    'docs/architecture/extensions/implementation-and-acceptance.md',
    'examples/extensions/README.md', 'examples/extensions/hello.mjs', 'examples/extensions/serve.mjs', 'tests/extensions/extension-example.test.ts']) {
    assert.deepEqual(planChanges([path]), { ...emptyPlan, extensions: true }, path);
  }
});
test('contract, runtime, loader and regression changes retain builds and add extension tests', () => {
  for (const path of ['packages/extension-contract/src/index.ts', 'packages/extension-runtime/src/manager.ts',
    'apps/workbench-web/src/runtime/module-url-extension-loader.ts', 'tests/extensions/extension-installations.test.ts']) {
    const plan = planChanges([path]);
    assert.equal(plan.extensions, true, path);
    assert.deepEqual(plan.targets, webTargets, path);
  }
  assert.equal(planChanges(['README.md']).extensions, false);
  assert.equal(planChanges(['docs/architecture/browser/overview-and-ownership.md']).extensions, false);
  assert.equal(planChanges(['docs/architecture/extensions-guide.md']).extensions, false);
  assert.equal(planChanges(['package-lock.json']).extensions, true);
});
