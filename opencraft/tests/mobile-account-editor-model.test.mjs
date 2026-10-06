import assert from 'node:assert/strict';
import test from 'node:test';

const { createAccountEditorState, accountEditorTransition: next } = await import('../apps/workbench-expo/src/runtime/mobile-account-editor-model.ts');

test('server refresh updates untouched name but preserves a local draft', () => {
  const fresh = next(createAccountEditorState('Old'), { type: 'server-name', name: 'Server' });
  assert.equal(fresh.name, 'Server');
  const editing = next(fresh, { type: 'name', value: 'My draft' });
  const refreshed = next(editing, { type: 'server-name', name: 'New server name' });
  assert.equal(refreshed.name, 'My draft');
  assert.equal(refreshed.baselineName, 'New server name');
});

test('late request results cannot replace the current request or phone draft', () => {
  let state = next(createAccountEditorState('Name'), { type: 'phone', value: '13199678880' });
  state = next(state, { type: 'request-start', id: 1, kind: 'code', input: state.phone });
  state = next(state, { type: 'phone', value: '13199678881' });
  state = next(state, { type: 'request-success', id: 1, cooldown: 60 });
  assert.equal(state.cooldown, 0);
  state = next(state, { type: 'request-start', id: 2, kind: 'code', input: state.phone });
  assert.equal(next(state, { type: 'request-failure', id: 1, error: 'old failure' }), state);
  assert.equal(next(state, { type: 'request-success', id: 2, cooldown: 60 }).cooldown, 60);
});
