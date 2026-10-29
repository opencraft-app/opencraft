import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';
import type { BrowserPageId } from '@opencraft/browser-core';

const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function fixture(t: any) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => oldWindow ? Object.defineProperty(globalThis, 'window', oldWindow) : delete (globalThis as any).window);
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const element = () => ({ style: {}, dataset: {}, append() {}, setAttribute() {}, remove() {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: element } });
  t.after(() => old ? Object.defineProperty(globalThis, 'document', old) : delete (globalThis as any).document);
  let ready = false, admit!: () => void, deny!: (error: Error) => void;
  const admission = new Promise<void>((resolve, reject) => { admit = () => { ready = true; resolve(); }; deny = reject; });
  const writes: string[] = [], connections: string[] = [], errors: string[] = [];
  const storage = {
    getItem: () => ready ? JSON.stringify({ page: 'browser-retained' }) : null,
    setItem(_key: string, value: string) { assert(ready); writes.push(value); },
    async flush() { assert(ready); },
  };
  const host: any = new RemoteBrowserSurfaceHost(storage, 'fixture', () => ready, () => admission);
  host.bindInput = () => () => {};
  host.connectTransport = async (p: any) => { connections.push(p.lease); p.serverInitialNavigation = true; };
  const id = 'page' as BrowserPageId;
  const events = { onLoaded() {}, onError(message: string) { errors.push(message); } };
  return { host, id, events, writes, connections, errors, admit, deny };
}

test('restored presentation mounts before authentication and resumes the retained lease only after metadata admission', async t => {
  const f = fixture(t);
  assert.equal(f.host.navigate(f.id, '', null, f.events), true);
  const port = f.host.presentationPort(f.id);
  assert(port.container); assert.equal(f.connections.length, 0); assert.equal(f.writes.length, 0);
  f.admit(); await port.ready; await tick();
  assert.deepEqual(f.connections, ['browser-retained']); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.errors, []);
});

test('late authentication cannot revive a retired pending presentation', async t => {
  const f = fixture(t);
  f.host.navigate(f.id, '', null, f.events);
  const p = f.host.pages.get(f.id); p.closed = true;
  f.admit(); await assert.rejects(p.ready, /Browser tab closed/); await tick();
  assert.deepEqual(f.connections, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
});

test('authentication failure stays on the browser surface without throwing during presentation mount', async t => {
  const f = fixture(t);
  assert.doesNotThrow(() => f.host.navigate(f.id, '', null, f.events));
  const port = f.host.presentationPort(f.id);
  f.deny(new Error('Authorization expired'));
  await assert.rejects(port.ready, /Authorization expired/); await tick();
  assert.deepEqual(f.connections, []); assert(f.errors.includes('Authorization expired'));
});
