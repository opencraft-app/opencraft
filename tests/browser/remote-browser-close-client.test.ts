import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';
import type { BrowserPageId } from '@opencraft/browser-core';

test('explicit close validates acknowledgement and retries after the logical mapping is forgotten', async t => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void;
    sent: any[] = []; closed = false;
    constructor(_url: URL) { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() { if (this.closed) return; this.closed = true; this.onclose?.(); }
    result(error?: object, id = this.sent[0].id) { this.onmessage?.({ data: JSON.stringify({ type: 'result', id, error }) }); }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')!;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://example.test/' } });
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const host = new RemoteBrowserSurfaceHost(storage, 'proof');
  try {
    const id = 'page-owned' as BrowserPageId;
    host.bindStorageId(id, 'browser-12345678901234567890');
    host.close(id); host.close(id); host.forget(id);
    assert.equal(sockets.length, 1);
    sockets[0].onopen?.(); sockets[0].onmessage?.({ data: JSON.stringify({ type: 'navigation' }) });
    sockets[0].result(undefined, 'unrelated'); assert.equal(sockets[0].closed, false);
    sockets[0].close(); t.mock.timers.tick(250);
    assert.equal(sockets.length, 2, 'lost reply retries after forget');
    sockets[1].onopen?.(); sockets[1].result({ message: 'native unavailable' }); t.mock.timers.tick(500);
    assert.equal(sockets.length, 3, 'error is not an acknowledgement');
    sockets[2].onopen?.(); sockets[2].result(); t.mock.timers.tick(60000);
    assert.equal(sockets.length, 3, 'matching success stops retries');
  } finally {
    host.dispose(); Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as any).window;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete (globalThis as any).location;
  }
});
