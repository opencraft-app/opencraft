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
