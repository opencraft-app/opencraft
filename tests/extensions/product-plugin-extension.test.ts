import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionSupervisor } from '@opencraft/extension-runtime';
import { createProductPluginExtension } from '../../apps/workbench-web/src/runtime/product-plugin-extension';
const descriptor = { id: 'fixture.app', version: '0.1.0', manifest: '/__opencraft_product_plugins/release/fixture.app/manifest.json',
  locales: [{ locale: 'zh-CN', label: '中文', messages: { greeting: '你好' } }] };
function fixture(t: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://fixture.invalid/' } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : Reflect.deleteProperty(globalThis, 'document'));
  let fetches = 0, activated = 0, released = 0, disposed = 0, context: unknown;
  const extension = { id: descriptor.id, localeCatalogs: [{ locale: 'zh-CN', label: '中文', load: async () => ({ greeting: '你好' }) }], load: async (input: unknown) => {
    context = input;
    return { manifest: { manifestVersion: 1 as const, id: descriptor.id, name: 'Fixture', version: '0.1.0', apiVersion: 1, trust: 'trusted' as const,
      platforms: ['web' as const], activationEvents: ['onStartupFinished' as const] }, activate(api: any) {
      activated++; api.commands.register({ id: 'fixture.app.command', title: 'Fixture' }, () => undefined); return () => { disposed++; };
    } };
  } };
  const ports = {
    async fetch() { fetches++; return new Response(JSON.stringify({ schemaVersion: 1, id: descriptor.id, version: descriptor.version,
      entry: '__opencraft_product_plugins/release/fixture.app/entry-hash.js', css: ['assets/style-hash.css'] })); },
    async importModule() { return { default: extension }; },
    async acquireStyles() { return () => { released++; }; },
  };
  return { ports, get observed() { return { fetches, activated, released, disposed, context }; } };
}
test('product factory shares context, locale and existing activation/disposal ownership', async t => {
  const f = fixture(t), registration = createProductPluginExtension(descriptor, f.ports);
  assert.deepEqual(await registration.localeCatalogs![0]!.load(), { greeting: '你好' });
  const context = { fetcher: fetch, getClient: () => undefined }, definition = await registration.load(context);
  const supervisor = new ExtensionSupervisor({ platform: 'web' }); t.after(() => supervisor.dispose());
  await supervisor.activate(definition);
  assert.equal(f.observed.context, context); assert.equal(f.observed.fetches, 1);
  assert.equal(supervisor.contributions.getSnapshot().commands.length, 1);
  await supervisor.deactivate(descriptor.id);
  assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
  assert.equal(f.observed.disposed, 1); assert.equal(f.observed.released, 1);
});
test('wrong package and stylesheet failure cannot activate or publish a contribution', async t => {
  const f = fixture(t), supervisor = new ExtensionSupervisor({ platform: 'web' }); t.after(() => supervisor.dispose());
  const registration = createProductPluginExtension(descriptor, { ...f.ports, acquireStyles: async () => { throw new Error('CSS unavailable'); } });
  await assert.rejects(supervisor.activate(await registration.load({ fetcher: fetch, getClient: () => undefined })), /CSS unavailable/);
  assert.equal(f.observed.activated, 0); assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
  const wrong = createProductPluginExtension(descriptor, { ...f.ports, fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, id: 'wrong' })) });
  await assert.rejects(wrong.load({ fetcher: fetch, getClient: () => undefined }), /mismatch/);
});
test('core language initialization needs no plugin download even when its factory is unavailable', async t => {
  fixture(t); let downloads = 0;
  const extension = createProductPluginExtension(descriptor, {
    fetch: async () => { downloads++; throw new Error('offline'); }, importModule: async () => { throw new Error('unreachable'); },
    acquireStyles: async () => { throw new Error('unreachable'); },
  });
  assert.deepEqual(await extension.localeCatalogs![0]!.load(), { greeting: '你好' });
  assert.equal(downloads, 0);
  await assert.rejects(extension.load({ fetcher: fetch, getClient: () => undefined }), /offline/);
});


test('preparation shares the code request without acquiring context, styles or activation authority', async t => {
 const f=fixture(t),registration=createProductPluginExtension(descriptor,f.ports);
 await Promise.all([registration.preload!(),registration.preload!()]);
 assert.equal(f.observed.fetches,1);
 assert.equal(f.observed.activated,0);assert.equal(f.observed.context,undefined);assert.equal(f.observed.released,0);
 const context={fetcher:fetch,getClient:()=>undefined};
 await registration.load(context);
 assert.equal(f.observed.fetches,1);assert.equal(f.observed.context,context);assert.equal(f.observed.activated,0);
});
