import assert from 'node:assert/strict';
import test from 'node:test';
import { readHostModelReadiness } from '../../plugins/builtin-agents/src/model-readiness';
import type { HostProtocolRequest } from '../../plugins/builtin-agents/src/local-agent-settings-service';
function fixture({ configured = false, active = true, enabled = true, models = true, oauth = false, noAuth = false } = {}) {
  const calls: string[] = [];
  const request = (async (host: string, method: string) => {
    assert.equal(host, 'target-host'); calls.push(method);
    if (method === 'runtime/providers/list') return { providers: [{ provider: 'fixture', active, enabled, settingsNs: 'llm', settingsPath: [] }] };
    if (method === 'runtime/settings/describe') return { namespaces: [{ ns: 'llm', value: noAuth ? {authentication:"none",apiKeyEnv:"MUST_NOT_RESOLVE"} : oauth ? {} : { apiKeyEnv: 'FIXTURE_API_KEY' } }] };
    if (method === 'runtime/models/list') return { groups: models ? [{ id: 'fixture', models: [{ id: 'fixture-model' }] }] : [] };
    if (method === 'runtime/credentials/describe') return { credentials: { FIXTURE_API_KEY: { configured } } };
    throw new Error(`Unexpected ${method}`);
  }) as HostProtocolRequest;
  return { request, calls };
}
test('active catalog metadata without a configured key still needs setup', async () => {
  const f = fixture(); assert.equal(await readHostModelReadiness(f.request, 'target-host'), false);
  assert.ok(f.calls.includes('runtime/credentials/describe'));
  assert.equal(f.calls.some(method => /\/(mutate|apply|setEnabled|set|probe|check)$/.test(method)), false);
});
test('configured credentials and live models permit chatting; disabled/offline/empty do not', async () => {
  for (const options of [{ configured: true }, { configured: true, active: false }, { configured: true, enabled: false }, { configured: true, models: false }]) {
    const f = fixture(options); assert.equal(await readHostModelReadiness(f.request, 'target-host'), options.active !== false && options.enabled !== false && options.models !== false);
  }
});
test('native providers without a key reference keep their own auth semantics', async () => {
  const f = fixture({ oauth: true }); assert.equal(await readHostModelReadiness(f.request, 'target-host'), true);
  assert.equal(f.calls.includes('runtime/credentials/describe'), false);
});
test('read errors stay errors rather than becoming empty installations', async () => {
  await assert.rejects(readHostModelReadiness((async () => { throw new Error('offline'); }) as HostProtocolRequest, 'target-host'), /offline/);
});


test('explicit no-auth readiness never resolves an inherited credential reference',async()=>{
 const f=fixture({noAuth:true});assert.equal(await readHostModelReadiness(f.request,'target-host'),true);
 assert.equal(f.calls.includes('runtime/credentials/describe'),false);
});


test('another configured provider cannot make the selected unconfigured model ready',async()=>{
 const f=fixture();
 const request=(async(host:string,method:string,params:unknown)=>{
  const result:any=await (f.request as any)(host,method,params);
  if(method==='runtime/providers/list')result.providers.push({provider:'ready-other',active:true,settingsNs:'other',settingsPath:[]});
  if(method==='runtime/settings/describe')result.namespaces.push({ns:'other',value:{authentication:'none'}});
  if(method==='runtime/models/list')result.groups.push({id:'ready-other',models:[{id:'working'}]});
  return result;
 }) as HostProtocolRequest;
 assert.equal(await readHostModelReadiness(request,'target-host'),true);
 assert.equal(await readHostModelReadiness(request,'target-host','dsh-model:fixture:fixture-model'),false);
 assert.equal(await readHostModelReadiness(request,'target-host','dsh-model:ready-other:working'),true);
 assert.equal(await readHostModelReadiness(request,'target-host','pi:ready-other:working'),true);
 assert.equal(await readHostModelReadiness(request,'target-host','dsh-model:ready-other:removed'),false);
});
