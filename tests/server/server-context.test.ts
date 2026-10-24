import test from 'node:test';
import assert from 'node:assert/strict';
import { serverAdmissionOrigin, parseServerContext, serverUrl, serverPath, serverStorageKey, serverFetch, serverEndpointNeedsRefresh } from '../../apps/workbench-web/src/runtime/server-context';

test('browser context scopes network and persistent state while leaving external destinations alone',async t=>{
  const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),originalFetch=globalThis.fetch;
  t.after(()=>{for(const [key,value] of [['document',originalDocument],['window',originalWindow]] as const){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}globalThis.fetch=originalFetch;});
  let id='one';const context=()=>({id,name:id,basePath:'/servers/'+id,selectorPath:'/servers'});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:()=>({textContent:JSON.stringify(context())})}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{origin:'https://entry.test'}}});
  assert.equal(serverAdmissionOrigin(),'https://entry.test');
  const scoped={...context(),targetOrigin:'https://target.test'};
  assert.equal(parseServerContext(JSON.stringify(scoped))?.targetOrigin,'https://target.test');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:()=>({textContent:JSON.stringify(scoped)})}});
  assert.equal(serverAdmissionOrigin(),'https://target.test');
  for(const targetOrigin of ['javascript:alert(1)','https://target.test/path','https://user:pass@target.test','//target.test']) assert.throws(()=>parseServerContext(JSON.stringify({...scoped,targetOrigin})));
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:()=>({textContent:JSON.stringify(context())})}});
  const calls:unknown[][]=[];globalThis.fetch=async(...args)=>{calls.push(args);return new Response('{}');};
  assert.equal(serverUrl('/apphost'),'/servers/one/apphost');assert.equal(serverUrl('/servers/one/apphost'),'/servers/one/apphost');
  assert.equal(serverUrl('https://external.test/a'),'https://external.test/a');assert.equal(serverUrl('//external.test/a'),'//external.test/a');
  assert.equal(serverPath('/servers/one/chat/42'),'/chat/42');assert.equal(serverStorageKey('drafts'),'server:one:drafts');
  assert.equal(serverPath('/servers/one'),'/');
  await serverFetch('/api',{method:'POST',body:'payload'});assert.equal(calls[0]![0],'/servers/one/api');
  await serverFetch(new Request('https://entry.test/api',{method:'POST',body:'payload'}));const request=calls[1]![0] as Request;
  assert.equal(request.url,'https://entry.test/servers/one/api');assert.equal(await request.text(),'payload');
  await serverFetch('https://entry.test/ssh/catalog');assert.equal(String(calls[2]![0]),'https://entry.test/servers/one/ssh/catalog');
  id='two';assert.equal(serverStorageKey('drafts'),'server:two:drafts');assert.equal(serverUrl('/apphost'),'/servers/two/apphost');
  assert.throws(()=>parseServerContext(JSON.stringify({...context(),basePath:'//external.test'})),/Invalid server context/u);
  const legacy={...context(),basePath:'/__opencraft_servers/two',selectorPath:'/__opencraft_servers'};
  assert.equal(parseServerContext(JSON.stringify(legacy))?.basePath,legacy.basePath);
  assert.throws(()=>parseServerContext(JSON.stringify({...legacy,selectorPath:'/servers'})),/Invalid server context/u);
});


test('only saved AppServer endpoints for the selected instance are refreshed', t => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    for (const [key, value] of [['document', originalDocument], ['window', originalWindow]] as const) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  let basePath = '/servers/lighthouse';
  let enabled = true;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://entry.test/servers/lighthouse/' } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    getElementById: () => enabled ? { textContent: JSON.stringify({ id: 'stable-instance', name: 'Server', basePath, selectorPath: '/servers' }) } : null,
  } });
  const current = 'wss://entry.test/servers/lighthouse/appserver';
  for (const prefix of ['/__opencraft_servers/', '/servers/']) {
    assert.equal(serverEndpointNeedsRefresh('wss://entry.test' + prefix + 'stable-instance/appserver', current), true);
  }
  for (const previous of [
    current, 'wss://entry.test/__opencraft_servers/another-instance/appserver',
    'wss://other.test/__opencraft_servers/stable-instance/appserver',
    'ws://entry.test/__opencraft_servers/stable-instance/appserver',
    'wss://entry.test/custom/appserver', 'bad-url',
    'wss://entry.test/__opencraft_servers/stable-instance/appserver?token=custom',
    'wss://entry.test/__opencraft_servers/stable-instance/appserver#custom',
    'wss://user:pass@entry.test/__opencraft_servers/stable-instance/appserver',
  ]) assert.equal(serverEndpointNeedsRefresh(previous, current), false, previous);
  assert.equal(serverEndpointNeedsRefresh('wss://entry.test/__opencraft_servers/stable-instance/appserver', 'wss://other.test/servers/lighthouse/appserver'), false);
  basePath = '';
  assert.equal(serverEndpointNeedsRefresh('wss://entry.test/servers/stable-instance/appserver', 'wss://entry.test/appserver'), true);
  enabled = false;
  assert.equal(serverEndpointNeedsRefresh('wss://entry.test/servers/stable-instance/appserver', 'wss://entry.test/appserver'), false);
});
