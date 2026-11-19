import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAutomationError } from '@opencraft/browser-core';
import { WebBrowserDynamicToolHost } from '../../apps/workbench-web/src/browser/web-browser-tool-host';

test('tool fill preserves empty strings and whitespace, and carries unknown native outcomes', async () => {
  const values: string[] = [];
  const host = new WebBrowserDynamicToolHost({ fillElement(_page: string, _ref: string, _revision: number, value: string) {
    if (value === 'fail') throw new BrowserAutomationError('CDP_TIMEOUT', 'Unconfirmed input', false, 'unknown');
    values.push(value);
  } } as never, { scopeForThread: () => 'scope', requireOwnedTab(scope: string, tab: string) {
    assert.equal(scope, 'scope'); assert.equal(tab, 'tab'); return { page: { id: 'page' } };
  } } as never);
  const context = { hostId: 'host', threadId: 'thread', turnId: 'turn', callId: 'call' };
  const fill = (value: unknown) => host.browserUse(context, { action: 'fill', tab_id: 'tab', ref: 'ref', expected_revision: 1, value });
  await fill('  draft\n '); await fill('');
  assert.deepEqual(values, ['  draft\n ', '']);
  await assert.rejects(async () => fill(42), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(async () => fill('fail'), { code: 'CDP_TIMEOUT', retryable: false, outcome: 'unknown' });
});
