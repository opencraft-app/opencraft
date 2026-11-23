import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/build-matrix.yml', import.meta.url), 'utf8');
function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job: ${name}`);
  return match[1];
}
const gate = job('build-checks').match(/        run: \|\n([\s\S]*)/)[1].replace(/^          /gm, '');
const selected = {
  EXTENSIONS_SELECTED: 'false', EXTENSIONS_RESULT: 'skipped',
  HOVER_RESULT: 'success',
  PLAN_RESULT: 'success', BUILD_SELECTED: 'true', BUILD_RESULT: 'success',
  NATIVE_SELECTED: 'false', NATIVE_RESULT: 'skipped', PACKAGE_SELECTED: 'false', PACKAGE_RESULT: 'skipped',
  HEADLESS_SELECTED: 'true', HEADLESS_RESULT: 'success', ARCHIVE_SELECTED: 'true', ARCHIVE_RESULT: 'success',
  CORE_SELECTED: 'true', CORE_RESULT: 'success', GATE_RESULT: 'success',
};
function check(env) {
  return spawnSync('bash', ['-e', '-c', gate], { env: { ...process.env, ...selected, ...env }, encoding: 'utf8' }).status;
}

test('the real aggregate script accepts Web/server and documentation-only plans', () => {
  assert.equal(check({}), 0);
  assert.equal(check({ BUILD_SELECTED: 'false', BUILD_RESULT: 'skipped', HEADLESS_SELECTED: 'false', HEADLESS_RESULT: 'skipped', ARCHIVE_SELECTED: 'false', ARCHIVE_RESULT: 'skipped', CORE_SELECTED: 'false', CORE_RESULT: 'skipped', GATE_RESULT: 'skipped' }), 0);
  assert.equal(check({ EXTENSIONS_SELECTED: 'true', EXTENSIONS_RESULT: 'success' }), 0);
  assert.equal(check({ NATIVE_SELECTED: 'true', NATIVE_RESULT: 'success' }), 0);
  assert.equal(check({ PACKAGE_SELECTED: 'true', PACKAGE_RESULT: 'success' }), 0);
});
test('a selected build cannot pass by failing, cancelling, or being skipped', () => {
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(check({ PLAN_RESULT: result }), 0, `plan: ${result}`);
    assert.notEqual(check({ HOVER_RESULT: result }), 0, `hover: ${result}`);
    for (const name of ['BUILD', 'NATIVE', 'PACKAGE', 'HEADLESS', 'ARCHIVE', 'EXTENSIONS', 'CORE']) {
      assert.notEqual(check({ [`${name}_SELECTED`]: 'true', [`${name}_RESULT`]: result }), 0, `${name}: ${result}`);
    }
  }
  assert.notEqual(check({ BUILD_SELECTED: '', BUILD_RESULT: 'skipped' }), 0, 'missing selector output');
});
test('the aggregate rejects an unexpected job execution instead of accepting a mismatched plan', () => {
  for (const name of ['BUILD', 'NATIVE', 'PACKAGE', 'HEADLESS', 'ARCHIVE', 'EXTENSIONS', 'CORE']) {
    assert.notEqual(check({ [`${name}_SELECTED`]: 'false', [`${name}_RESULT`]: 'success' }), 0, name);
  }
});
test('server regressions and the server archive run as parallel jobs', () => {
  const server = job('linux-headless');
  assert.match(server, /if: needs\.plan\.outputs\.headless-tests == 'true'/);
  const steps = server.split(/      - /);
  const tests = steps.find(step => step.startsWith('run: npm run test:headless-server\n'));
  assert.ok(tests);
  assert.doesNotMatch(tests, /\bif:/);
  assert.doesNotMatch(server, /matrix:build|smoke:headless:linux|upload-artifact/, 'the archive is not on the regressions path');
  const archive = job('headless-package');
  assert.match(archive, /^    needs: plan\n    if: needs\.plan\.outputs\.headless-package == 'true'\n/);
  for (const step of ['run: npm run matrix:build -- headless-linux-amd64-tar', 'run: npm run smoke:headless:linux', 'name: headless-linux-amd64-tar']) {
    assert.ok(archive.includes(step), step);
  }
  assert.ok(archive.indexOf('matrix:build') < archive.indexOf('smoke:headless:linux'), 'smoke the archive it built');
  assert.match(job('build-checks'), /needs: \[[^\]]*\bheadless-package\b[^\]]*\]/);
});

test('hover checks run independently of the build plan and scan failures', () => {
  const hover = job('hover-policy');
  assert.doesNotMatch(hover, /needs: plan|if: needs\.plan/);
  assert.match(hover, /run: npm run check:hover/);
  assert.match(hover, /run: npm run test:hover-policy\n\s+if: always\(\) && steps\.dependencies\.outcome == 'success'/);
  assert.match(hover, /run: npm run smoke:touch-hover\n\s+if: always\(\) && steps\.browser\.outcome == 'success'/);
  assert.match(job('build-checks'), /needs: \[[^\]]*hover-policy\]/);
});

test('core tests run the full typecheck and every npm test suite as independent steps', () => {
  const core = job('core-tests');
  assert.match(core, /if: needs\.plan\.outputs\.has-builds == 'true' \|\| needs\.plan\.outputs\.headless-tests == 'true'/);
  const steps = core.split(/      - /);
  const runs = steps.map(step => step.match(/^(?:id: \S+\n\s+)?run: npm run (\S+)\n/)?.[1]).filter(Boolean);
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const suites = manifest.scripts.test.split(' && ').map(part => part.replace(/^npm run /, ''));
  for (const name of ['typecheck', 'check:boundaries', ...suites]) assert.ok(runs.includes(name), `core-tests misses ${name}`);
  for (const step of steps.filter(step => /run: npm run (typecheck|check:|test:)/.test(step))) {
    assert.match(step, /if: always\(\) && steps\.(dependencies|dsh)\.outcome == 'success'/, step);
  }
  assert.match(job('build-checks'), /needs: \[[^\]]*\bcore-tests\b[^\]]*\]/);
  // Static checks and test suites run as two parallel halves; each step belongs to one.
  assert.match(core, /part: \[static, tests\]/);
  assert.match(core, /fail-fast: false/);
  for (const step of steps.filter(step => /run: npm run (typecheck|check:|test:)/.test(step))) {
    const part = step.match(/matrix\.part == '(static|tests)'/)?.[1];
    assert.ok(part, `step not assigned to a core-tests part: ${step}`);
    assert.equal(part, /run: npm run (typecheck|check:)/.test(step) ? 'static' : 'tests', step);
  }
  // Only files a pull request adds are format-checked, against the merge commit's base parent.
  assert.match(core, /fetch-depth: 2/);
  assert.match(core, /run: npm run check:format -- --base HEAD\^1\n\s+if: always\(\) && steps\.dependencies\.outcome == 'success' && github\.event_name == 'pull_request' && matrix\.part == 'static'\n/);
  assert.match(core, /run: npm run lint:changed -- --base HEAD\^1\n\s+if: always\(\) && steps\.dependencies\.outcome == 'success' && github\.event_name == 'pull_request' && matrix\.part == 'static'\n/);
  // Test files run with a private HOME/TMPDIR and fail on processes they leave behind.
  // The runner forbids NODE_OPTIONS in GITHUB_ENV; source it in subsequent Bash steps instead.
  for (const isolatedJob of [core, job('gate-tests')]) {
    assert.doesNotMatch(isolatedJob, /^    env:[\s\S]*?NODE_OPTIONS/m);
    assert.doesNotMatch(isolatedJob, /echo "NODE_OPTIONS=.*\$GITHUB_ENV/);
    assert.match(isolatedJob, /isolation_env="\$\(mktemp "\$RUNNER_TEMP\/opencraft-isolation\.XXXXXX"\)"/);
    assert.match(isolatedJob, /printf 'export NODE_OPTIONS=%q\\n'.*test-isolation\.mjs.*test-isolation-global\.mjs/);
    assert.match(isolatedJob, /echo "BASH_ENV=\$isolation_env" >> "\$GITHUB_ENV"/);
  }
});

test('isolation setup supplies NODE_OPTIONS to subsequent Bash steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencraft-ci-isolation-'));
  try {
    const script = job('core-tests').match(/- name: Enable test isolation\n        run: \|\n((?:          [^\n]*\n)+)/)[1].replace(/^          /gm, '');
    const envFile = join(dir, 'github-env');
    const env = { ...process.env, GITHUB_WORKSPACE: process.cwd(), RUNNER_TEMP: dir, GITHUB_ENV: envFile };
    delete env.BASH_ENV;
    delete env.NODE_OPTIONS;
    const setup = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], { env, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const match = readFileSync(envFile, 'utf8').match(/^BASH_ENV=(.+)$/m);
    assert.ok(match);
    const next = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', 'printf "%s" "$NODE_OPTIONS"'], { env: { ...env, BASH_ENV: match[1] }, encoding: 'utf8' });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout, `--import ${process.cwd()}/tests/support/test-isolation.mjs --test-global-setup=${process.cwd()}/tests/support/test-isolation-global.mjs`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every main commit runs build-matrix in its own run', () => {
  assert.match(workflow, /^on:\n  pull_request:\n  merge_group:\n(?:  #[^\n]*\n)*  push:\n    branches: \[main\]\n/m);
  // A PR commit supersedes its predecessor; main commits are never grouped or cancelled.
  assert.match(workflow, /group: build-matrix-\$\{\{ github\.event\.pull_request\.number \|\| \(github\.event_name == 'push' && github\.sha\) \|\| github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('gate-tests shares core-tests selection and build-checks requires it', () => {
  for (const result of ['failure', 'cancelled', 'skipped', '']) assert.notEqual(check({ GATE_RESULT: result }), 0, `gate: ${result}`);
  assert.notEqual(check({ CORE_SELECTED: 'false', CORE_RESULT: 'skipped', GATE_RESULT: 'success' }), 0, 'unexpected gate run');
  assert.match(job('gate-tests'), /if: needs\.plan\.outputs\.has-builds == 'true' \|\| needs\.plan\.outputs\.headless-tests == 'true'/);
  assert.match(job('build-checks'), /needs: \[[^\]]*\bgate-tests\b[^\]]*\]/);
});

// Scripts npm run gate requires that CI does not run, each with the reason.
const GATE_ONLY_EXCEPTIONS = new Map([
  ['build:web', 'covered by the portable web-browser build'],
  ['build:expo:web', 'Expo builds are opt-in platform validation'],
  ['build:expo:ios', 'requires macOS with Xcode'],
]);

test('every npm run gate script runs in CI unless it is a recorded exception', () => {
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
  const gateScripts = [...scripts.gate.matchAll(/npm run ([\w:.-]+)/g)].map(match => match[1]);
  const testScripts = [...scripts.test.matchAll(/npm run ([\w:.-]+)/g)].map(match => match[1]);
  const directory = new URL('../../.github/workflows/', import.meta.url);
  const workflows = readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');
  const ran = new Set([...workflows.matchAll(/npm run ([\w:.-]+)/g)].map(match => match[1]));
  for (const name of testScripts) ran.add(name);
  const missing = gateScripts.filter(name => !ran.has(name) && !GATE_ONLY_EXCEPTIONS.has(name));
  assert.deepEqual(missing, [], 'add these gate scripts to a CI job or record why they are excluded');
  for (const name of GATE_ONLY_EXCEPTIONS.keys()) assert.ok(gateScripts.includes(name), `${name} is no longer in gate; drop its exception`);
});

test('CI and Claude Code cloud sessions share one Linux toolchain setup', () => {
  // Both test jobs install system packages through the shared script, never apt directly.
  for (const name of ['core-tests', 'gate-tests']) {
    assert.match(job(name), /run: bash scripts\/ci\/setup-toolchain\.sh system\n/, name);
  }
  const workflows = readdirSync(new URL('../../.github/workflows/', import.meta.url)).filter(file => /\.ya?ml$/.test(file));
  for (const file of workflows) {
    const text = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /apt-get install[^\n]*\b(?:acl|openssh-client)\b/, `${file} installs toolchain packages outside setup-toolchain.sh`);
  }
  // Cloud sessions run the hook at startup and resume.
  const settings = JSON.parse(readFileSync(new URL('../../.claude/settings.json', import.meta.url), 'utf8'));
  const start = settings.hooks.SessionStart.find(entry => entry.matcher === 'startup|resume');
  assert.equal(start?.hooks[0]?.command, 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start.sh');
  // The hook enables exactly the test isolation CI enables.
  const hook = readFileSync(new URL('../../.claude/hooks/session-start.sh', import.meta.url), 'utf8');
  assert.match(hook, /setup-toolchain\.sh" all/);
  const ci = workflow.match(/printf 'export NODE_OPTIONS=%q\\n' "([^"]+)"/)[1].replaceAll('$GITHUB_WORKSPACE', '$root');
  assert.ok(hook.includes(`export NODE_OPTIONS=\\"${ci}\\"`), 'session-start.sh NODE_OPTIONS differs from CI');
});

test('the cloud session hook does nothing outside Claude Code cloud sessions', () => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() };
  delete env.CLAUDE_CODE_REMOTE;
  const result = spawnSync('bash', ['.claude/hooks/session-start.sh'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('managed-web runs every suite exactly once across its parallel groups', () => {
  const security = readFileSync(new URL('../../.github/workflows/security.yml', import.meta.url), 'utf8');
  const managed = security.match(/^  managed-web:\n([\s\S]*?)(?=^  [a-z][a-z-]*:)/m)[1];
  const suites = managed.match(/suite: \[([^\]]+)\]/)[1].split(',').map(name => name.trim());
  assert.deepEqual(suites, ['release', 'browser-e2e', 'browser-smoke']);
  assert.match(managed, /fail-fast: false/);
  const expected = [
    'typecheck --workspace @opencraft/workbench-web', 'test:web-release', 'test:web-updates', 'test:web-updates:e2e',
    'smoke:attachment-upload-recovery', 'smoke:image-metadata-preview', 'smoke:offline-startup-continuity',
    'test:queue-delivery-retry', 'smoke:queue-delivery-retry',
  ];
  const steps = [...managed.matchAll(/- run: npm run (.+)\n\s+if: (.+)\n/g)].map(([, command, condition]) => ({ command, condition }));
  assert.deepEqual(steps.map(step => step.command).sort(), [...expected].sort());
  for (const { command, condition } of steps) {
    const suite = condition.match(/matrix\.suite == '([^']+)'/)?.[1];
    assert.ok(suites.includes(suite), `${command} is not assigned to a matrix suite`);
    assert.match(condition, /^always\(\) && steps\.(dependencies|browser)\.outcome == 'success' && /, command);
  }
  assert.match(security, /needs: \[plan, secrets, dependency-audit, managed-web\]/);
});

test('electron-fork cancels superseded PR runs but never main commits', () => {
  const fork = readFileSync(new URL('../../.github/workflows/electron-fork.yml', import.meta.url), 'utf8');
  assert.match(fork, /group: electron-fork-\$\{\{ github\.event\.pull_request\.number \|\| \(github\.event_name == 'push' && github\.sha\) \|\| github\.ref \}\}/);
  assert.match(fork, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

const workflowFiles = readdirSync(new URL('../../.github/workflows/', import.meta.url)).filter(file => /\.ya?ml$/.test(file))
  .map(file => [file, readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8')]);

test('every external action is pinned to a full commit SHA', () => {
  for (const [file, text] of workflowFiles) {
    for (const [, action] of text.matchAll(/^\s*-?\s*uses: (\S+)/gm)) {
      if (action.startsWith('./')) continue;
      assert.match(action, /@[0-9a-f]{40}$/, `${file}: ${action} is not pinned to a commit SHA`);
    }
  }
});

test('every job has a timeout instead of the six-hour default', () => {
  for (const [file, text] of workflowFiles) {
    const jobs = text.slice(text.search(/^jobs:\n/m));
    for (const [, name, body] of jobs.matchAll(/^  ([a-z][a-z0-9-]*):\n((?:(?: {4}.*)?\n)*)/gm)) {
      if (/^ {4}uses: /m.test(body)) continue; // reusable workflow call
      assert.match(body, /^ {4}timeout-minutes: \d+/m, `${file}: job ${name} has no timeout-minutes`);
    }
  }
});

test('portable web validation runs subagent disclosure browser smoke', () => {
  const portable = job('portable');
  assert.match(portable, /if: matrix\.target == 'web-browser'[\s\S]*?install-playwright-chromium\.sh[\s\S]*?npm run smoke:subagent-activity/);
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
  assert.match(scripts['smoke:subagent-activity'], /scripts\/smoke\/conversation\/smoke-subagent-activity\.ts/);
});

test('web-browser matrix exercises queue Markdown preview', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/build-matrix.yml', import.meta.url), 'utf8');
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
  assert.match(workflow, /if: matrix\.target == 'web-browser'[\s\S]*?install-playwright-chromium\.sh[\s\S]*?npm run smoke:queue-markdown/);
  assert.match(scripts['smoke:queue-markdown'], /scripts\/smoke\/composer\/smoke-queue-markdown\.ts/);
});

test('workflow-lint checks every workflow change with pinned actionlint and zizmor', () => {
  const lint = readFileSync(new URL('../../.github/workflows/workflow-lint.yml', import.meta.url), 'utf8');
  assert.match(lint, /pull_request:\n    paths:\n      - \.github\/\*\*\n(?:  #[^\n]*\n)*  merge_group:\n  push:\n    branches: \[main\]\n    paths:\n      - \.github\/\*\*/);
  assert.match(lint, /run: go run github\.com\/rhysd\/actionlint\/cmd\/actionlint@v\d+\.\d+\.\d+ -pyflakes=\n/);
  assert.match(lint, /run: pipx run zizmor==\d+\.\d+\.\d+ --offline --min-severity low --config \.github\/zizmor\.yml \.github\/workflows\/\n/);
});


test('gate-tests shards every suite into exactly one parallel part', () => {
  const gate = job('gate-tests');
  const parts = gate.match(/matrix:\n\s+part: \[([^\]]+)\]/)[1].split(',').map(part => part.trim());
  assert.deepEqual(parts, ['runtime', 'convergence', 'platform']);
  const steps = [...gate.matchAll(/- (?:name: [^\n]+\n\s+)?run: (npm run [^\n]+)\n\s+if: ([^\n]+)/g)];
  assert.ok(steps.length > 20);
  const used = new Set();
  for (const [, command, condition] of steps) {
    const owners = [...condition.matchAll(/matrix\.part == '([\w-]+)'/g)].map(match => match[1]);
    assert.equal(owners.length, 1, `${command} must run in exactly one gate part`);
    assert.ok(parts.includes(owners[0]), command);
    used.add(owners[0]);
  }
  assert.deepEqual([...used].sort(), [...parts].sort(), 'every gate part runs at least one suite');
});

test('generic convergence and assistant runtime remain mandatory gate steps', () => {
  for (const name of ['test:assistant-runtime', 'test:convergence']) {
    assert.ok(job('gate-tests').includes('run: npm run ' + name));
    assert.ok(!GATE_ONLY_EXCEPTIONS.has(name));
  }
});

test('container browser-owner regressions use the TypeScript workspace loader', () => {
  const container = readFileSync(new URL('../../.github/workflows/container.yml', import.meta.url), 'utf8');
  assert.match(container, /node --import tsx --test [^\n]*tests\/browser\/remote-browser-owner\.test\.mjs/);
});
