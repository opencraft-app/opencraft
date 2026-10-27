import test from 'node:test';
import assert from 'node:assert/strict';
import { CreditWindow } from '@opencraft/remote-interaction';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';

test('real input timeout retains credits and requests reattachment without replaying the write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: { OPEN: 1 } });
  const sent: unknown[] = [], closes: unknown[] = [];
  const host: any = Object.create(RemoteBrowserSurfaceHost.prototype);
  const page: any = { closed: false, connection: 1, control: {}, pending: new Map(), inputAcknowledgements: true,
    inputCredits: new CreditWindow({ maxItems: 2, maxBytes: 65536 }),
    socket: { readyState: 1, send(payload: string) { sent.push(JSON.parse(payload)); },
      close(code: number, reason: string) { closes.push({ code, reason }); } } };
  try {
    const first = host.rawCall(page, 'input', { type: 'mouseDown' });
    const second = host.rawCall(page, 'input', { type: 'mouseUp' });
    const results = Promise.allSettled([first, second]);
    assert.equal(sent.length, 2); assert.equal(page.inputCredits.size, 2);
    t.mock.timers.tick(25000); assert((await results).every(result => result.status === 'rejected'));
    assert.equal(page.pending.size, 0);
    assert.equal(page.inputCredits.size, 2, 'caller settlement does not free transport capacity');
    await assert.rejects(host.rawCall(page, 'input', { type: 'mouseDown' }), /waiting for confirmation/);
    assert.equal(sent.length, 2, 'no new or replayed write enters the uncertain stream');
    assert(closes.length > 0); assert.equal((closes[0] as any).code, 1013);
  } finally {
    if (old) Object.defineProperty(globalThis, 'WebSocket', old); else delete (globalThis as any).WebSocket;
  }
});
