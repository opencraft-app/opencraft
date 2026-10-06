import assert from 'node:assert/strict';
import test from 'node:test';

const { mobileShellTransition } = await import('../apps/workbench-expo/src/runtime/mobile-shell-model.ts');

test('account and site pages return through the native account surface', () => {
  let surface = 'agents';
  surface = mobileShellTransition(surface, { type: 'open-account' });
  surface = mobileShellTransition(surface, { type: 'open-account-web' });
  assert.equal(mobileShellTransition(surface, { type: 'back' }), 'account');
  surface = mobileShellTransition(surface, { type: 'open-billing' });
  assert.equal(mobileShellTransition(surface, { type: 'back' }), 'account');
  assert.equal(mobileShellTransition('account', { type: 'close-overlay' }), 'agents');
});

test('late site navigation cannot steal the native account or Bot surface', () => {
  const action = { type: 'site-navigation', destination: 'billing' };
  assert.equal(mobileShellTransition('agents', action), 'agents');
  assert.equal(mobileShellTransition('account', action), 'account');
  assert.equal(mobileShellTransition('account-web', action), 'billing');
});
