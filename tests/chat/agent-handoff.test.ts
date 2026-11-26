import assert from 'node:assert/strict';
import test from 'node:test';
import {QueryClient} from '@tanstack/react-query';
import {asHostId} from '@opencraft/chat-core';
import {createConversationBindingStore,createConversationScopeLeaseRegistry,createConversationScopeRegistry,createConversationViewRegistry,createConversationActivationCoordinator,createWorkbenchCoordinator,createWorkbenchDraftLocation,createWorkbenchThreadLocation,HostRuntimeRegistry,resolveConversationAgentId} from '@opencraft/workbench-runtime';
import {createWorkbenchNavigationTransaction} from '../../apps/workbench-web/src/runtime/workbench-navigation-transaction';
Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{href:'http://localhost/'},history:{state:null},localStorage:{setItem(){},removeItem(){}}}});
const {createWebWorkbenchCommands}=await import('../../apps/workbench-web/src/runtime/workbench-application-services');

async function fixture(t:test.TestContext) {
  let fail=false;let creationGate:Promise<void>|undefined;const creations:any[]=[];
  const registry=new HostRuntimeRegistry([{descriptor:{hostId:'local',label:'Local',kind:'local',transportEndpoint:null,executionLocation:null,workspaceBrowseRoots:['/workspace']},createRuntime:()=>({
    async connect(){},async dispose(){},async acquireThread(threadId:string){return {threadId,release(){}};},
    async createThread(intent:any){creations.push(intent);await creationGate;if(fail)throw Error('creation refused');return {commandId:intent.commandId,clientMessageId:intent.clientMessageId,hostId:'local',threadId:'destination',turnId:'first',acceptedAt:1,replayed:false};},
    resources:{protocol:{async request(_method:string,params:any){return params.action==='reference'?{reference:'opencraft://conversation/v1/server/source'}:{cwd:'/workspace',projectId:'project'};}},threads:{getUnavailableReason(){return null;}}},
  })}]);
  const scopes=createConversationScopeRegistry({initialDraft:{draftId:'seed',execution:{hostId:asHostId('local'),workspace:{cwd:'/workspace',runtimeWorkspaceRoots:['/workspace']}}}});
  const location=createWorkbenchDraftLocation('local','seed'),coordinator=createWorkbenchCoordinator(registry,location),bindings=createConversationBindingStore(),leases=createConversationScopeLeaseRegistry({});
  const views=createConversationViewRegistry({scopeLeases:leases,composerServices:{now:Date.now,createId:()=>crypto.randomUUID()}});
  const activation=createConversationActivationCoordinator(coordinator,bindings,scopes,leases,views);
  const navigation=createWorkbenchNavigationTransaction(location,activation,scopes,{mode:'memory'});activation.mountInitial(location,navigation.getSnapshot().routeScopeId);
  const commands=createWebWorkbenchCommands({registry,coordinator,activation,scopes,views,navigation,queryClient:new QueryClient(),displayContinuity:{getScope:()=> 'account',retainSubmission(){}},hostProfiles:{getSnapshot:()=>({profiles:[]})},connectionProviders:{}} as any);
  await commands.navigate(createWorkbenchThreadLocation('local','source'));
  const source=views.get(coordinator.getSnapshot().viewId!)!.composer;
  source.dispatch({type:'set-document',document:{version:1,blocks:[{type:'paragraph',children:[{type:'text',text:'keep my words'}]}]}});
  source.dispatch({type:'set-selections',patch:{model:'pi-model',effort:'low'}});
  t.after(async()=>{navigation.dispose();activation.dispose();views.dispose();leases.dispose();scopes.dispose();coordinator.dispose();bindings.dispose();await registry.dispose();});
  return {commands,source,navigation,creations,setFailure(value:boolean){fail=value;},holdCreation(gate:Promise<void>|undefined){creationGate=gate;}};
}
const selection={hostId:'local',threadId:'source',historyTitle:'History',agentId:'codex',model:'codex-model',effort:'low',permissionProfile:'full'};

test('a Bridge conversation and its Codex models share the Agent identity', () => {
  const extensions = {
    'opencraft/agent-bridge': { version: 1, providerId: 'codex', threadPrefix: 'bridge:codex:' },
    'opencraft/execution-engines': { defaultEngine: 'codex', providers: [
      { id: 'codex-bridge', threadPrefix: 'bridge:codex:' }, { id: 'pi', threadPrefix: 'pi_' },
    ] },
  };
  const models = [{ id: 'custom-codex', model: 'custom-codex', agentId: 'codex' }];
  assert.equal(resolveConversationAgentId('bridge:codex:source', undefined, extensions, models), models[0]!.agentId);
  assert.equal(resolveConversationAgentId('native-codex', 'custom-codex', extensions, models), 'codex');
  assert.equal(resolveConversationAgentId('pi_source', undefined, extensions, models), 'pi');
  assert.equal(resolveConversationAgentId(null, undefined, extensions, models), null);
});

test('handoff stays on source until send, preserves a failed draft, then PUSH/POP returns to source',async t=>{
  const f=await fixture(t),original=f.source.getSnapshot().draft;
  await f.commands.continueWithAgent(selection);
  assert.equal(f.navigation.getSnapshot().location.kind,'thread');
  assert.equal((f.navigation.getSnapshot().location as any).key.threadId,'source');assert.equal(f.creations.length,0);
  const pending=f.source.getSnapshot().draft;assert.equal(pending.document,original.document);assert.ok(pending.handoff);
  const intent=f.source.createSubmitIntent();f.setFailure(true);
  await assert.rejects(f.commands.submit(intent),/creation refused/);
  assert.equal(f.source.getSnapshot().draft.document,original.document);assert.equal((f.navigation.getSnapshot().location as any).key.threadId,'source');
  f.setFailure(false);await f.commands.submit(intent);
  assert.equal((f.navigation.getSnapshot().location as any).key.threadId,'destination');
  assert.equal(f.creations.at(-1).selections.agentId,'codex');assert.equal(f.creations.at(-1).target.type,'new-thread');
  f.navigation.back();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal((f.navigation.getSnapshot().location as any).key.threadId,'source');
});

test('canceling handoff restores the source selection and keeps edited text',async t=>{
  const f=await fixture(t),original=f.source.getSnapshot().draft;
  await f.commands.continueWithAgent(selection);
  f.source.dispatch({type:'cancel-agent-handoff'});
  assert.equal(f.source.getSnapshot().draft.handoff,undefined);assert.deepEqual(f.source.getSnapshot().draft.selections,original.selections);
  assert.equal(f.source.getSnapshot().draft.document,original.document);assert.equal(f.creations.length,0);
});


test('explicit retry after leaving and returning reuses an accepted handoff receipt without stealing navigation',async t=>{
  const f=await fixture(t);await f.commands.continueWithAgent(selection);
  const intent=f.source.createSubmitIntent();let resolve!:()=>void;
  f.holdCreation(new Promise<void>(done=>{resolve=done;}));
  const sending=f.commands.submit(intent);
  while(!f.creations.length)await new Promise(done=>setImmediate(done));
  await f.commands.navigate(createWorkbenchThreadLocation('local','elsewhere'));
  resolve();await assert.rejects(sending,/superseded/);
  assert.equal((f.navigation.getSnapshot().location as any).key.threadId,'elsewhere');
  await f.commands.navigate(createWorkbenchThreadLocation('local','source'));
  await f.commands.submit(intent);
  assert.equal(f.creations.length,1,'accepted creation is not replayed');
  assert.equal((f.navigation.getSnapshot().location as any).key.threadId,'destination');
});
