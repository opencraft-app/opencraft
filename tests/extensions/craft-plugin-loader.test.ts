import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { ExtensionSupervisor, ExtensionManager, MemoryExtensionInstallationPersistence, provideExtensionInstallationRepository } from '@opencraft/extension-runtime';
import { serverInstalledBuiltins, parseServerInstalledExtensions, readServerInstalledExtensions } from '../../apps/workbench-web/src/runtime/server-installed-extensions';

const manifest = { manifestVersion: 1, id: 'user.crafted', name: 'Crafted', version: '1.0.0', apiVersion: 1,
  trust: 'trusted', platforms: ['web'], activationEvents: ['onStartupFinished'] };
const code = `export default {manifest:${JSON.stringify(manifest)},activate(api){if('internal' in api)throw Error('Internal API leaked');api.commands.register({id:'user.crafted.test',title:'Craft'},()=>42)}};`;
const plugin = { manifest, entry: 'user.crafted/' + 'a'.repeat(64) + '/plugin.mjs', sha256: createHash('sha256').update(code).digest('hex'), replaces: [], access: 'public' };

test('versioned craft descriptor preserves public access and rejects internal replacement', () => {
  assert.equal(parseServerInstalledExtensions([plugin])[0]!.access, 'public');
  assert.throws(() => parseServerInstalledExtensions([{ ...plugin, replaces: ['opencraft.account'] }]));
  assert.throws(() => parseServerInstalledExtensions([{ ...plugin, entry: 'user.crafted/../plugin.mjs' }]));
  assert.throws(() => parseServerInstalledExtensions([{ ...plugin, access: 'internal' }]));
});

test('crafted code uses original manager, starts disabled, receives public facade, and preserves enable intent', async () => {
  const supervisor = new ExtensionSupervisor({ platform: 'web' });
  const context = new Context();
  const fiber = context.plugin(provideExtensionInstallationRepository(new MemoryExtensionInstallationPersistence()));
  await fiber;
  let imports = 0;
  const builtins = serverInstalledBuiltins(parseServerInstalledExtensions([plugin]), {
    fetch: async () => new Response(code),
    importModule: async source => { imports++; return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')); },
  });
  const manager = new ExtensionManager({ installations: context.extensionInstallations, supervisor, builtins,
    loader: { async load() { throw new Error('Unexpected URL installation'); } } });
  try {
    await manager.restore();
    assert.equal(imports, 0);
    assert.equal(manager.getSnapshot().extensions[0]!.status, 'disabled');
    await manager.setEnabled('user.crafted', true);
    assert.equal(manager.getSnapshot().extensions[0]!.status, 'active');
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 1);
    await manager.setEnabled('user.crafted', false);
    assert.equal(supervisor.contributions.getSnapshot().commands.length, 0);
    await manager.setEnabled('user.crafted', true);
    assert.equal(manager.getSnapshot().extensions[0]!.status, 'active');
  } finally { await manager.dispose(); await supervisor.dispose(); await fiber.dispose(); }
});


test('browser bootstrap isolates malformed descriptors and JSON without changing strict validation', () => {
  const root = (value: string) => ({ getElementById: () => ({ textContent: value }) }) as unknown as Document;
  assert.deepEqual(readServerInstalledExtensions([], root('{bad')), []);
  assert.deepEqual(readServerInstalledExtensions([], root('null')), []);
  assert.deepEqual(readServerInstalledExtensions([], root(JSON.stringify([null, {bad:true}, plugin]))), parseServerInstalledExtensions([plugin]));
  assert.deepEqual(readServerInstalledExtensions([], root(JSON.stringify([plugin, plugin]))), []);
  const invalid = {...plugin, replaces:['opencraft.account']};
  assert.deepEqual(readServerInstalledExtensions([], root(JSON.stringify([invalid]))), []);
});

test('failed installed activation is isolated by the existing manager', async () => {
  const context = new Context();
  const fiber = context.plugin(provideExtensionInstallationRepository(new MemoryExtensionInstallationPersistence())); await fiber;
  const supervisor = new ExtensionSupervisor({ platform:'web' });
  const healthy = {...manifest, id:'user.healthy'};
  const failing = {...manifest, id:'user.failing'};
  const manager = new ExtensionManager({ installations:context.extensionInstallations, supervisor,
    builtins:[
      {origin:'user',manifest:failing,defaultEnabled:true,load:async()=>({manifest:failing,activate(){throw Error('fixture failure');}})},
      {origin:'user',manifest:healthy,defaultEnabled:true,load:async()=>({manifest:healthy,activate(api){api.commands.register({id:'user.healthy.hello',title:'Healthy'},()=>42);}})},
    ],loader:{load(){throw Error('Unexpected URL install');}} });
  await manager.restore();
  assert.ok(supervisor.getSnapshot().extensions.some(row=>row.id==='user.healthy' && row.status==='active'));
  await manager.dispose(); await supervisor.dispose(); await fiber.dispose();
});


test('trusted native renderers cannot be requested by public craft descriptors', () => {
  assert.throws(()=>parseServerInstalledExtensions([{...plugin,renderer:'trusted-react-v1'}]));
  const operator={...plugin,access:undefined,renderer:'trusted-react-v1',configuration:{label:'Vela'}};
  assert.equal(parseServerInstalledExtensions([operator])[0]!.renderer,'trusted-react-v1');
  assert.throws(()=>parseServerInstalledExtensions([{...operator,renderer:'unknown'}]));
});


test('a never-settling optional activation times out without blocking healthy installed code', async () => {
  const context=new Context(),fiber=context.plugin(provideExtensionInstallationRepository(new MemoryExtensionInstallationPersistence()));await fiber;
  const supervisor=new ExtensionSupervisor({platform:'web',activationTimeoutMs:40});
  const hanging={...manifest,id:'user.hanging'},healthy={...manifest,id:'user.healthy'};
  const manager=new ExtensionManager({installations:context.extensionInstallations,supervisor,builtins:[
    {origin:'user',manifest:hanging,defaultEnabled:true,load:async()=>({manifest:hanging,activate:()=>new Promise(()=>{})})},
    {origin:'user',manifest:healthy,defaultEnabled:true,load:async()=>({manifest:healthy,activate(){}})},
  ],loader:{load(){throw Error('Unexpected URL install');}}});
  try { await manager.restore();
    assert.ok(supervisor.getSnapshot().extensions.some(row=>row.id==='user.healthy'&&row.status==='active'));
    assert.equal(manager.getSnapshot().extensions.find(row=>row.installation.extensionId==='user.hanging')?.status,'failed');
  } finally {await manager.dispose();await supervisor.dispose();await fiber.dispose();}
});
