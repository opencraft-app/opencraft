import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  HEADLESS_SELECTED: 'true', HEADLESS_RESULT: 'success',
};
function check(env) {
  return spawnSync('bash', ['-e', '-c', gate], { env: { ...process.env, ...selected, ...env }, encoding: 'utf8' }).status;
}

test('the real aggregate script accepts Web/server and documentation-only plans', () => {
  assert.equal(check({}), 0);
  assert.equal(check({ BUILD_SELECTED: 'false', BUILD_RESULT: 'skipped', HEADLESS_SELECTED: 'false', HEADLESS_RESULT: 'skipped' }), 0);
  assert.equal(check({ EXTENSIONS_SELECTED: 'true', EXTENSIONS_RESULT: 'success' }), 0);
  assert.equal(check({ NATIVE_SELECTED: 'true', NATIVE_RESULT: 'success' }), 0);
  assert.equal(check({ PACKAGE_SELECTED: 'true', PACKAGE_RESULT: 'success' }), 0);
});
test('a selected build cannot pass by failing, cancelling, or being skipped', () => {
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(check({ PLAN_RESULT: result }), 0, `plan: ${result}`);
    assert.notEqual(check({ HOVER_RESULT: result }), 0, `hover: ${result}`);
    for (const name of ['BUILD', 'NATIVE', 'PACKAGE', 'HEADLESS', 'EXTENSIONS']) {
      assert.notEqual(check({ [`${name}_SELECTED`]: 'true', [`${name}_RESULT`]: result }), 0, `${name}: ${result}`);
    }
  }
  assert.notEqual(check({ BUILD_SELECTED: '', BUILD_RESULT: 'skipped' }), 0, 'missing selector output');
});
test('the aggregate rejects an unexpected job execution instead of accepting a mismatched plan', () => {
  for (const name of ['BUILD', 'NATIVE', 'PACKAGE', 'HEADLESS', 'EXTENSIONS']) {
    assert.notEqual(check({ [`${name}_SELECTED`]: 'false', [`${name}_RESULT`]: 'success' }), 0, name);
  }
});
test('server regressions run independently of archive build, smoke and upload', () => {
  const server = job('linux-headless');
  assert.match(server, /if: needs\.plan\.outputs\.headless-tests == 'true'/);
  const steps = server.split(/      - /);
  const tests = steps.find(step => step.startsWith('run: npm run test:headless-server\n'));
  assert.ok(tests);
  assert.doesNotMatch(tests, /\bif:/);
  for (const start of ['run: npm run matrix:build -- headless-linux-amd64-tar', 'run: npm run smoke:headless:linux', 'uses: actions/upload-artifact@']) {
    const step = steps.find(step => step.startsWith(start));
    assert.ok(step, start);
    assert.match(step, /if: needs\.plan\.outputs\.headless-package == 'true'/, start);
  }
});

test('hover checks run independently of the build plan and scan failures', () => {
  const hover = job('hover-policy');
  assert.doesNotMatch(hover, /needs: plan|if: needs\.plan/);
  assert.match(hover, /run: npm run check:hover/);
  assert.match(hover, /run: npm run test:hover-policy\n\s+if: always\(\) && steps\.dependencies\.outcome == 'success'/);
  assert.match(hover, /run: npm run smoke:touch-hover\n\s+if: always\(\) && steps\.browser\.outcome == 'success'/);
  assert.match(job('build-checks'), /needs: \[[^\]]*hover-policy\]/);
});
