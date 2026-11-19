import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserAutomationIpc } from '../../apps/desktop/src/browser-automation-ipc';

test('Main rejects foreign callers, unowned guests and arbitrary protocol commands before invocation', async () => {
  const handlers = new Map<string, Function>(); let trusted = false, calls = 0;
  installBrowserAutomationIpc({ handle: (channel: string, listener: Function) => { handlers.set(channel, listener); } } as never, {
    trusted: () => trusted,
    guests: () => ({ require(id: number) {
      assert.equal(id, 7);
      return { automation: { connect: () => { calls++; }, invoke: () => { calls++; }, release: () => {} } };
    } }) as never,
  });
  const connect = handlers.get('opencraft:browser-automation-connect')!;
  assert.equal((await connect({}, 7)).error.code, 'INVALID_CALLER');
  trusted = true;
  assert.equal((await connect({}, -1)).error.code, 'INVALID_CALLER');
  const invoke = handlers.get('opencraft:browser-automation-invoke')!;
  assert.equal((await invoke({}, 7, 'a'.repeat(36), 'b'.repeat(36), 'Runtime.evaluate', {})).error.code, 'INVALID_ARGUMENT');
  assert.equal((await invoke({}, 7, 'wrong', 'b'.repeat(36), 'inspect', {})).error.code, 'INVALID_ARGUMENT');
  assert.equal(calls, 0);
});

test('IPC preserves unknown native outcomes in the structured reply', async () => {
  const handlers = new Map<string, Function>();
  installBrowserAutomationIpc({ handle: (channel: string, listener: Function) => { handlers.set(channel, listener); } } as never, {
    trusted: () => true,
    guests: () => ({ require: () => ({ automation: { invoke: () => { throw Object.assign(new Error('Timed out'), { code: 'CDP_TIMEOUT', outcome: 'unknown' }); } } }) }) as never,
  });
  const reply = await handlers.get('opencraft:browser-automation-invoke')!({}, 7, 'a'.repeat(36), 'b'.repeat(36), 'click', {});
  assert.deepEqual(reply, { ok: false, error: { code: 'CDP_TIMEOUT', message: 'Timed out', retryable: false, outcome: 'unknown' } });
});
