import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { discoverRemoteBrowser } from '../../apps/workbench-web/src/browser/remote-browser-capabilities';

const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function wire(t: TestContext, respond: (number: number, init: RequestInit) => Response | Promise<Response>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const requests: { url: string; signal: AbortSignal }[] = [];
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: (url: string, init: RequestInit) => {
    assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'manual');
    requests.push({ url, signal: init.signal! }); return respond(requests.length, init);
  } });
  t.after(() => { if (old) Object.defineProperty(globalThis, 'fetch', old); else delete (globalThis as any).fetch; });
  return requests;
}

test('transient capability failures never expose iframe fallback, keep capped backoff and eventually admit remote', async t => {
  const requests = wire(t, number => {
    if (number % 3 === 1 && number <= 18) throw new TypeError('network');
    return number <= 18 ? new Response('', { status: [408, 429, 503, 504][number % 4]! }) : Response.json({ available: true });
  });
  let exposed: boolean | undefined;
  const pending = discoverRemoteBrowser().then(value => { exposed = value; return value; }); await flush();
  for (let attempt = 0; attempt < 18; attempt++) {
    assert.equal(requests.length, attempt + 1); assert.equal(exposed, undefined);
    assert(requests.every(request => request.signal.aborted), 'completed attempts are retired before backoff');
    const delay = Math.min(30000, 250 * 2 ** Math.min(attempt, 7));
    t.mock.timers.tick(delay - 1); await flush(); assert.equal(requests.length, attempt + 1);
    t.mock.timers.tick(1); await flush();
  }
  assert.equal(await pending, true); assert.equal(requests.length, 19);
  t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 19);
});

test('only a well-formed successful negative capability selects iframe once', async t => {
  const requests = wire(t, () => Response.json({ available: false, codec: 'avc1.42E028' }));
  assert.equal(await discoverRemoteBrowser(), false); assert.equal(requests.length, 1);
  assert(requests[0]!.signal.aborted); t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 1);
});

for (const status of [301, 302, 303, 307, 308, 401, 403]) {
  test(`HTTP ${status} is terminal authorization, never iframe or retry`, async t => {
    const requests = wire(t, () => new Response('', { status }));
    await assert.rejects(discoverRemoteBrowser(), { code: 'AUTHORIZATION_REQUIRED' });
    t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 1);
  });
}

test('an opaque login redirect is terminal and is never followed', async t => {
  const requests = wire(t, () => ({ type: 'opaqueredirect', status: 0, body: null } as Response));
  await assert.rejects(discoverRemoteBrowser(), { code: 'AUTHORIZATION_REQUIRED' });
  t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 1);
});

for (const status of [201, 202, 204, 400, 404, 405, 422]) {
  test(`HTTP ${status} is a protocol failure rather than a negative capability`, async t => {
    const requests = wire(t, () => new Response(null, { status }));
    await assert.rejects(discoverRemoteBrowser(), { code: 'PROTOCOL_ERROR' });
    t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 1);
  });
}

for (const body of ['{}', 'null', '[]', 'true', '{"available":"true"}', '<html>login</html>', '{']) {
  test(`invalid availability envelope ${JSON.stringify(body)} fails without fallback or retry`, async t => {
    const requests = wire(t, () => new Response(body));
    await assert.rejects(discoverRemoteBrowser(), { code: 'PROTOCOL_ERROR' });
    t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 1);
  });
}

test('capability body is bounded to four KiB and its reader is cancelled without waiting for EOF', async t => {
  let cancelled = 0;
  const requests = wire(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4097)); }, cancel() { cancelled++; },
  })));
  await assert.rejects(discoverRemoteBrowser(), { code: 'PROTOCOL_ERROR' }); assert.equal(cancelled, 1);
  t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 1);
});

test('invalid UTF-8 is a terminal protocol error without echoing response contents', async t => {
  const requests = wire(t, () => new Response(new Uint8Array([0xc3])));
  await assert.rejects(discoverRemoteBrowser(), { code: 'PROTOCOL_ERROR', message: 'Invalid browser capability response' });
  t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 1);
});

test('a transport failure while reading the body retries rather than admitting a negative capability', async t => {
  const requests = wire(t, number => number === 1 ? new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('body transport disconnected')); },
  })) : Response.json({ available: true }));
  const pending = discoverRemoteBrowser(); await flush(); assert.equal(requests.length, 1); assert(requests[0]!.signal.aborted);
  t.mock.timers.tick(250); await flush(); assert.equal(await pending, true); assert.equal(requests.length, 2);
});

test('headers blackhole is retired at deadline and late negative availability cannot replace a later admission', async t => {
  let release: (response: Response) => void = () => {}, lateCancelled = 0;
  const requests = wire(t, number => number === 1 ? new Promise(resolve => { release = resolve; }) : Response.json({ available: true }));
  const pending = discoverRemoteBrowser(); await flush(); assert.equal(requests.length, 1);
  t.mock.timers.tick(1999); await flush(); assert.equal(requests[0]!.signal.aborted, false);
  t.mock.timers.tick(1); await flush(); assert.equal(requests[0]!.signal.aborted, true);
  t.mock.timers.tick(250); await flush(); assert.equal(await pending, true); assert.equal(requests.length, 2);
  release(new Response(new ReadableStream({ cancel() { lateCancelled++; } }))); await flush();
  assert.equal(lateCancelled, 1); t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, 2);
});

test('a stalled response body is cancelled at the same attempt deadline and recovery can continue', async t => {
  let cancelled = 0;
  const requests = wire(t, number => number === 1 ? new Response(new ReadableStream({ cancel() { cancelled++; } })) : Response.json({ available: true }));
  const pending = discoverRemoteBrowser(); await flush(); t.mock.timers.tick(2000); await flush();
  assert.equal(cancelled, 1); assert.equal(requests[0]!.signal.aborted, true);
  t.mock.timers.tick(250); await flush(); assert.equal(await pending, true); assert.equal(requests.length, 2);
});

for (const phase of ['before', 'headers', 'body', 'backoff']) {
  test(`startup cancellation during ${phase} releases admission and never creates a retry`, async t => {
    let cancelled = 0;
    const requests = wire(t, () => phase === 'headers' ? new Promise(() => {}) : phase === 'body'
      ? new Response(new ReadableStream({ cancel() { cancelled++; } })) : new Response('', { status: 503 }));
    const owner = new AbortController(); if (phase === 'before') owner.abort();
    const pending = discoverRemoteBrowser(owner.signal); await flush(); owner.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const expected = phase === 'before' ? 0 : 1; assert.equal(requests.length, expected);
    assert(requests.every(request => request.signal.aborted)); assert.equal(cancelled, phase === 'body' ? 1 : 0);
    t.mock.timers.tick(120000); await flush(); assert.equal(requests.length, expected);
  });
}

test('discovery retains the selected server scope and same-origin request policy', async t => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: (id: string) => id === 'opencraft-server-context'
    ? { textContent: JSON.stringify({ id: 'fixture-target', name: 'Fixture', basePath: '/servers/fixture-target', selectorPath: '/servers' }) } : null } });
  t.after(() => { if (old) Object.defineProperty(globalThis, 'document', old); else delete (globalThis as any).document; });
  const requests = wire(t, () => Response.json({ available: true })); assert.equal(await discoverRemoteBrowser(), true);
  assert.equal(requests[0]!.url, '/servers/fixture-target/__opencraft_browser/capabilities');
});
