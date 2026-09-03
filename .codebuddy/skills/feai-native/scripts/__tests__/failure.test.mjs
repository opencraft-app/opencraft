// skills/feai-native/scripts/__tests__/failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordFailure, failureVerdict } from '../engine.mjs';

const limits = { warnAt: 2, stopAt: 3, hardStopAtTotal: 12, allowOverridePerSignature: true };
const mk = () => ({ last_signature: null, consecutive_same: 0, total: 0, overrides_used: [] });

test('同签名连续计数，异签名重置', () => {
  const f = mk();
  recordFailure(f, 'a');
  recordFailure(f, 'a');
  assert.equal(f.consecutive_same, 2);
  recordFailure(f, 'b');
  assert.deepEqual([f.last_signature, f.consecutive_same, f.total], ['b', 1, 3]);
});

test('1 次放行，2 次警告，3 次停止', () => {
  const f = mk();
  recordFailure(f, 'a');
  assert.equal(failureVerdict(f, limits, false).verdict, 'proceed');
  recordFailure(f, 'a');
  assert.equal(failureVerdict(f, limits, false).verdict, 'warn');
  recordFailure(f, 'a');
  assert.equal(failureVerdict(f, limits, false).verdict, 'stop');
});

test('停止后同签名一次性 override，用后即耗', () => {
  const f = mk();
  recordFailure(f, 'a'); recordFailure(f, 'a'); recordFailure(f, 'a');
  const v1 = failureVerdict(f, limits, true);
  assert.equal(v1.verdict, 'override');
  f.consecutive_same = 0; // override 放行后由调用方清零
  f.overrides_used.push('a');
  recordFailure(f, 'a'); recordFailure(f, 'a'); recordFailure(f, 'a');
  assert.equal(failureVerdict(f, limits, true).verdict, 'stop');
});

test('累计硬顶无视签名差异', () => {
  const f = mk();
  for (let i = 0; i < 12; i += 1) recordFailure(f, `s${i}`);
  assert.equal(failureVerdict(f, limits, false).verdict, 'hard-stop');
});
