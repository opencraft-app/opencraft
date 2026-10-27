import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserHeadlessConnectors } from '../../apps/workbench-web/src/runtime/headless-connectors';
import { ManagedConnectorController } from '../../packages/workbench-runtime/src/connectors/managed-controller';
import type { ConnectorManager } from '../../packages/workbench-runtime/src/connectors/manager';

const state = { protocolVersion: 1, supportedDefinitions: [], instances: [], connections: [], selections: [], approvals: [] };
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

for (const status of [401, 403]) test(`denied browser connector reads (${status}) do not recursively reload the managed list`, async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { 'fixture-host': 'fixture' } });
    requests++;
    // Bound the broken implementation's feedback loop so the regression fails
    // deterministically without starving the test runner's event loop.
    if (requests <= 3) return Response.json({}, { status });
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const remote = await BrowserHeadlessConnectors.open();
  const controller = new ManagedConnectorController({} as ConnectorManager, async hostId => remote.client(hostId));
  t.after(() => { controller.dispose(); remote.dispose(); });
  await controller.load('fixture-host');
  await settled();
  assert.equal(requests, 1, 'authentication failure must settle without another automatic list request');
  assert.equal(controller.snapshot('fixture-host').phase, 'error');
  assert.equal(remote.owns('fixture-host'), true, 'failure never transfers execution ownership to the browser');
});

test('expired browser connector state clears once without change notifications and can recover', async t => {
  let status = 200, calls = 0, notifications = 0, stateChanges = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { 'fixture-host': 'fixture' } });
    calls++;
    return Response.json(state, { status });
  });
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  remote.client('fixture-host').subscribeNotification(event => { if (event.method === 'connectors/managed/changed') notifications++; });
  remote.subscribe(() => stateChanges++);
  await remote.refresh('fixture-host');
  assert.deepEqual(remote.state('fixture-host'), state);
  assert.equal(notifications, 1);
  status = 401;
  await assert.rejects(remote.refresh('fixture-host'));
  assert.equal(remote.state('fixture-host'), null, 'expired data is removed from the presentation');
  assert.ok(stateChanges > 1, 'presentation subscribers learn that state was cleared');
  assert.equal(notifications, 1, 'a failed read cannot announce a managed configuration change');
  await settled(); assert.equal(calls, 2);
  status = 200;
  await remote.refresh('fixture-host');
  assert.deepEqual(remote.state('fixture-host'), state);
  assert.equal(notifications, 2, 'successful refreshes still notify management consumers');
});

test('expired authentication clears cached managed lists without issuing a replacement read', async t => {
  let status = 200, calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture', second: 'fixture' } });
    calls++; return Response.json(state, { status });
  });
  const remote = await BrowserHeadlessConnectors.open();
  const controller = new ManagedConnectorController({} as ConnectorManager, async hostId => remote.client(hostId));
  t.after(() => { controller.dispose(); remote.dispose(); });
  await controller.load('first'); await controller.load('second');
  assert.notEqual(controller.snapshot('first').data, null);
  assert.notEqual(controller.snapshot('second').data, null);
  const before = calls; status = 401;
  await assert.rejects(remote.refresh('first')); await settled();
  assert.equal(calls, before + 1, 'retiring authenticated state does not fetch another list');
  for (const hostId of ['first', 'second']) {
    assert.equal(controller.snapshot(hostId).data, null, 'cached account data is removed');
    assert.equal(controller.snapshot(hostId).phase, 'error');
  }
});

test('successful browser connector refreshes notify only consumers of that Host', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => Response.json(init?.method ? state : {
    protocolVersion: 1, hosts: { first: 'fixture-first', second: 'fixture-second' },
  }));
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  const seen: string[] = [];
  const stop = remote.client('first').subscribeNotification(() => seen.push('first'));
  remote.client('second').subscribeNotification(() => seen.push('second'));
  await remote.refresh('first'); assert.deepEqual(seen, ['first']);
  await remote.command('second', 'connect', { id: 'fixture' }); assert.deepEqual(seen, ['first', 'second']);
  stop(); await remote.refresh('first'); assert.deepEqual(seen, ['first', 'second']);
});

for (const method of ['state', 'connect']) test(`revocation retires delayed ${method} across Hosts`, async t => {
  let finish!: (r: Response) => void;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture', second: 'fixture' } });
    if (JSON.parse(init.body as string).hostId === 'second') return new Promise<Response>(r => { finish = r; });
    return Response.json({}, { status: 401 });
  });
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  const pending = method === 'state' ? remote.refresh('second') : remote.command('second', method, {});
  const rejected = assert.rejects(pending);
  await assert.rejects(remote.refresh('first')); finish(Response.json(state)); await rejected;
  assert.equal(remote.state('second'), null);
});

test('late 401 cannot clear a newer successful read', async t => {
  let finish!: (r: Response) => void, count = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture' } });
    return ++count === 1 ? new Promise<Response>(r => { finish = r; }) : Response.json(state);
  });
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  const rejected = assert.rejects(remote.refresh('first'));
  await remote.refresh('first'); finish(Response.json({}, { status: 401 })); await rejected;
  assert.deepEqual(remote.state('first'), state);
});

test('403 invalidates only its Host and retires that Host delayed writes', async t => {
  let finish!: (r: Response) => void, denied = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture', second: 'fixture' } });
    const { hostId, method } = JSON.parse(init.body as string);
    if (method === 'connect') return new Promise<Response>(r => { finish = r; });
    return denied && hostId === 'first' ? Response.json({ error: 'same_origin_json_required' }, { status: 403 }) : Response.json(state);
  });
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  await remote.refresh('second');
  const rejected = assert.rejects(remote.command('first', 'connect', {}));
  denied = true; await assert.rejects(remote.refresh('first'));
  finish(Response.json(state)); await rejected;
  assert.equal(remote.state('first'), null); assert.deepEqual(remote.state('second'), state);
});

test('unchanged state does not reload lists and releasing a view stops idle polling', async t => {
  let tick!: () => void; const calls: string[] = [];
  t.mock.method(globalThis, 'setInterval', (fn: () => void) => { tick = fn; return 1 as any; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture' } });
    calls.push(JSON.parse(init.body as string).method); return Response.json(state);
  });
  const remote = await BrowserHeadlessConnectors.open();
  const controller = new ManagedConnectorController({} as ConnectorManager, async id => remote.client(id));
  t.after(() => { controller.dispose(); remote.dispose(); });
  const stop = controller.observe('first'); await settled();
  await remote.refresh('first'); await settled(); calls.length = 0;
  for (let i = 0; i < 5; i++) { tick(); await settled(); }
  assert.deepEqual(calls, Array(5).fill('state'));
  stop(); calls.length = 0; tick(); await settled(); assert.deepEqual(calls, []);
});

test('authentication recovery backs off and still allows explicit retry', async t => {
  let tick!: () => void, now = 0, denied = true, calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (fn: () => void) => { tick = fn; return 1 as any; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture' } });
    calls++; return Response.json(state, { status: denied ? 401 : 200 });
  });
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  remote.client('first').subscribeNotification(() => {});
  tick(); await settled(); assert.equal(calls, 1);
  now = 2000; tick(); await settled(); assert.equal(calls, 1);
  now = 5000; tick(); await settled(); assert.equal(calls, 2);
  now = 10000; tick(); await settled(); assert.equal(calls, 2);
  denied = false; await remote.refresh('first'); assert.deepEqual(remote.state('first'), state);
});

test('transient HTTP failures advance the recovery backoff once per request', async t => {
  let tick!: () => void, now = 0, calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (fn: () => void) => { tick = fn; return 1 as any; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture' } });
    calls++; return Response.json({}, { status: 503 });
  });
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  remote.client('first').subscribeNotification(() => {});
  for (const [at, expected] of [[0, 1], [1999, 1], [2000, 2], [5999, 2], [6000, 3], [13999, 3], [14000, 4]]) {
    now = at; tick(); await settled(); assert.equal(calls, expected, `at ${at}ms`);
  }
});

test('slow lists coalesce and releasing the view cancels its read', async t => {
  let listCalls = 0, signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture' } });
    if (JSON.parse(init.body as string).method === 'state') return Response.json(state);
    listCalls++; signal = init.signal!;
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const remote = await BrowserHeadlessConnectors.open();
  const controller = new ManagedConnectorController({} as ConnectorManager, async id => remote.client(id));
  t.after(() => { controller.dispose(); remote.dispose(); });
  const stop = controller.observe('first'); await settled();
  const pending = Array.from({ length: 10 }, () => controller.load('first'));
  await settled(); assert.equal(listCalls, 1);
  stop(); await Promise.all(pending); assert.equal(signal?.aborted, true);
});

test('pending session selections retain background synchronization without a view', async t => {
  let tick!: () => void, calls = 0;
  t.mock.method(globalThis, 'setInterval', (fn: () => void) => { tick = fn; return 1 as any; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.method) return Response.json({ protocolVersion: 1, hosts: { first: 'fixture' } });
    calls++; return Response.json({ ...state, selections: [{ threadId: 'synthetic', connectorIds: ['fixture'] }] });
  });
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  await remote.refresh('first'); tick(); await settled(); assert.equal(calls, 2);
});

test('discovery and state use the selected server context', async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => ({ textContent: JSON.stringify({ id: 'second', name: 'Second', basePath: '/servers/second', selectorPath: '/servers' }) }) } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'document', prior); else delete (globalThis as any).document; });
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => { paths.push(String(input)); return Response.json(init?.method ? state : { protocolVersion: 1, hosts: { first: 'fixture' } }); });
  const remote = await BrowserHeadlessConnectors.open(); t.after(() => remote.dispose());
  await remote.refresh('first'); assert.deepEqual(paths, Array(2).fill('/servers/second/__opencraft_connectors'));
});
