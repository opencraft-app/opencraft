import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileShellTransition } from '../apps/workbench-expo/src/runtime/mobile-shell-model.ts';
test('account returns to its existing Bot surface; browser journeys do not own Shell navigation', () => {
  assert.equal(mobileShellTransition('agents', { type: 'open-account' }), 'account');
  assert.equal(mobileShellTransition('account', { type: 'back' }), 'agents');
  assert.equal(mobileShellTransition('account', { type: 'close-overlay' }), 'agents');
});
