import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverRemoteBrowserForStartup } from '../../apps/workbench-web/src/browser/remote-browser-capabilities';

function fixture(t: any, online: boolean) {
  const data = new Map<string, string>();
  const window = new EventTarget();
  const navigator = { onLine: online };
  let build = 'fixture-build', reads = 0;
  const globals = { window, navigator, document: { querySelector: (selector: string) => selector.includes('opencraft-build-id') ? { content: build } : null, getElementById: () => null },
    localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) },
    fetch: async () => { reads++; return Response.json({ available: false }); } };
  for (const [key, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : delete (globalThis as any)[key]);
  }
  return { data, navigator, window, get reads() { return reads; }, nextBuild() { build = 'another-build'; } };
}

test('only offline bootstrap uses its same-build backend hint, online startup probes again', async t => {
  const f = fixture(t, true);
  assert.equal(await discoverRemoteBrowserForStartup(), false); assert.equal(f.reads, 1);
  f.navigator.onLine = false;
  assert.equal(await discoverRemoteBrowserForStartup(), false); assert.equal(f.reads, 1);
  f.nextBuild();
  assert.equal(await discoverRemoteBrowserForStartup(), true, 'unknown never silently chooses iframe');
  f.navigator.onLine = true;
  assert.equal(await discoverRemoteBrowserForStartup(), false); assert.equal(f.reads, 2);
});

test('disconnect during a pending capability request releases shell admission and aborts that request', async t => {
  const f = fixture(t, true); let request: AbortSignal | undefined;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: (_: unknown, input: RequestInit) => { request = input.signal!; return new Promise(() => {}); } });
  const pending = discoverRemoteBrowserForStartup();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  f.navigator.onLine = false; f.window.dispatchEvent(new Event('offline'));
  assert.equal(await pending, true); assert.equal(request?.aborted, true);
});
