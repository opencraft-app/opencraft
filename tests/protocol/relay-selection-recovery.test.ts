import assert from 'node:assert/strict';
import test from 'node:test';
import { selectorFixture } from '../fixtures/server-selector';

const state = (html: string) => JSON.parse(/<script id="server-selection-state" type="application\/json">([^<]*)<\/script>/u.exec(html)![1]!);
test('server discovery distinguishes transient target failure from explicit denied admission', async t => {
  let fault: number | undefined = 503;
  const fixture = await selectorFixture({ admissionFault: id => id === 'join' ? fault : undefined });
  t.after(() => fixture.close());
  const cookie = await fixture.login('alice');
  const get = () => fixture.get('/servers', {cookie,accept:'text/html'}).then(r => r.text());
  let html = await get();
  assert.equal(state(html).pending, true);
  assert.doesNotMatch(html, /data-server="join"/u);
  assert.match(html, /data-server="lighthouse"/u);
  fault = undefined;
  html = await get();
  assert.equal(state(html).pending, false);
  assert.match(html, /data-server="join"/u);
  fixture.stores[0]!.set(fixture.principals.alice!, 'admin', false, 'fixture-administrator');
  html = await get();
  assert.equal(state(html).pending, false, 'explicit membership denial has no retry loop');
  assert.doesNotMatch(html, /data-server="join"/u);
  for (const status of [401,403]) {
    fault = status;
    assert.equal(state(await get()).pending, false);
  }
  for (const status of [500,502,503]) {
    fault = status;
    assert.equal(state(await get()).pending, true);
  }
  const other = await fixture.login('carol');
  fault = undefined;
  const otherHtml = await fixture.get('/servers', {cookie:other,accept:'text/html'}).then(r => r.text());
  assert.notEqual(state(otherHtml).key, state(html).key);
  assert.doesNotMatch(otherHtml, /data-server="join"/u);
});
