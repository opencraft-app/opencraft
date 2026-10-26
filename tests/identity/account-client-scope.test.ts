import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanClientScope, discoverLocalAccountProduct } from '../../plugins/local-account/src/client-scope';

const human = (id: string, authority = 'one') => ({ authority, actor: { id: `human://${authority}/${id}` }, native: false, desktopOwner: false });
test('client cache is scoped by verified Human and authority; only the original native owner retains legacy local drafts', () => {
  const a = new HumanClientScope(human('a'), async () => human('a'), () => {});
  const b = new HumanClientScope(human('a', 'two'), async () => human('a', 'two'), () => {});
  assert.notEqual(a.getSnapshot().namespace, b.getSnapshot().namespace);
  const native = new HumanClientScope({ ...human('owner'), native: true, desktopOwner: true }, async () => human('owner'), () => {}, 'existing-local-drafts');
  assert.equal(native.getSnapshot().namespace, 'existing-local-drafts');
  a.dispose(); b.dispose(); native.dispose();
});
test('out-of-order identity refresh and disposal cannot restore another Human; scope listeners run before reload', async () => {
  const reads: ((value: unknown) => void)[] = [], events: string[] = [];
  const scope = new HumanClientScope(human('a'), () => new Promise(resolve => reads.push(resolve)), () => events.push('reload'));
  scope.subscribe(() => events.push('revoke-old-cache'));
  const first = scope.refresh(), second = scope.refresh();
  reads[1]!(human('b')); await second; reads[0]!(human('a')); await first;
  assert.match(scope.getSnapshot().namespace, /human:\/\/one\/b/);
  assert.deepEqual(events, ['revoke-old-cache', 'reload']);
  const late = scope.refresh(); scope.dispose(); reads[2]!(human('c')); await late;
  assert.match(scope.getSnapshot().namespace, /human:\/\/one\/b/);
});
test('temporary network failure does not switch to anonymous cache; an absent plugin preserves standalone clients', async () => {
  const scope = new HumanClientScope(human('a'), async () => { throw new Error('offline'); }, () => assert.fail('must not reload'));
  const before = scope.getSnapshot(); await scope.refresh(); assert.equal(scope.getSnapshot(), before); scope.dispose();
  assert.equal(await discoverLocalAccountProduct(async () => new Response('{}', { status: 404 }) as any), undefined);
});

test('offline bootstrap restores local input partition without verified dispatch authority', async () => {
  const values = new Map<string, string>(), listeners = new Map<string, Set<() => unknown>>();
  const cache = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const events = { addEventListener(type: string, callback: () => unknown) { const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set); },
    removeEventListener(type: string, callback: () => unknown) { listeners.get(type)?.delete(callback); } } as any;
  let offline = false, current = human('a'), changes = 0;
  const fetcher = async () => { if (offline) throw new Error('offline'); return Response.json(current); };
  const options = { capabilityCache: cache, capabilityCacheKey: 'server:one:account-capability', events, changed: () => { changes++; } };
  const first = await discoverLocalAccountProduct(fetcher as typeof fetch, options), owner = await first!.create({ platform: 'web' });
  const ownerScope = owner.persistenceScope!.getSnapshot().namespace;
  assert.equal(values.get(options.capabilityCacheKey), 'one'); assert.equal(owner.persistenceScope!.isVerified?.(), true); await owner.dispose();
  offline = true;
  const boot = await discoverLocalAccountProduct(fetcher as typeof fetch, options), unverified = await boot!.create({ platform: 'web' });
  assert.equal(unverified.persistenceScope!.getSnapshot().namespace, ownerScope);
  assert.equal(unverified.persistenceScope!.isVerified?.(), false);
  assert.notEqual(unverified.persistenceScope!.getSnapshot().namespace, 'local');
  assert.equal(listeners.get('online')?.size, 1);
  offline = false; current = human('b'); await unverified.preflight?.();
  assert.match(unverified.persistenceScope!.getSnapshot().namespace, /human:\/\/one\/b/);
  assert.equal(changes, 1); await unverified.dispose(); assert.equal(listeners.get('online')?.size, 0);
  assert.equal(await discoverLocalAccountProduct(async () => { throw new Error('offline'); }, { capabilityCache: cache, capabilityCacheKey: 'other-server' }), undefined);
});

test('an admitted anonymous account status cannot select the original desktop owner namespace', async () => {
  const product = await discoverLocalAccountProduct(async () => Response.json({ authority: 'one', actor: null, native: true, desktopOwner: false }),
    { events: { addEventListener() {}, removeEventListener() {} } as any });
  const session = await product!.create({ platform: 'electron' });
  assert.equal(session.persistenceScope!.getSnapshot().namespace, JSON.stringify(['human', 'one', null])); await session.dispose();
});
