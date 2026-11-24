import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { ModelGatewayStore } from "../../packages/account-pool-host/src/model-gateway-store.js";
import { bindModelGatewaySponsor } from "../../packages/account-pool-host/src/model-gateway-sponsor.js";
import { meteredModelRequest, ModelGatewayUsageReceipt } from "../../packages/account-pool-host/src/model-gateway-meter.js";
import { modelGatewayHttp, MODEL_GATEWAY_PATH } from "../../packages/account-pool-host/src/model-gateway-http.js";
import { gatewayContributions } from "../../apps/local-agent-host/src/model-config/gateway-contributions.js";
import { createEngineModelSource } from "../../apps/local-agent-host/src/model-config/engine-models.js";
import { AccountPoolStore, CodexAccountPoolProxy } from "../../packages/account-pool-host/src/index.js";
import { createAssistantModelGateway } from "../../apps/local-agent-host/src/model-config/assistant-gateway.js";
import { assertModelPolicy } from "../../packages/model-usage-policy/src/native.mjs";
import { ModelConfigurationRepository } from "../../apps/local-agent-host/src/model-config/repository.js";
import { ModelPolicyStore } from "../../packages/model-usage-policy/src/index.js";
import {serveNodeHttpExchange} from '@opencraft/http-exchange/node';

function environment(t: test.TestContext, path: string) {
  const previous = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = path;
  t.after(() => { if (previous === undefined) delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE; else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = previous; });
}
async function fixture(t: test.TestContext, limit = { monthlyTokens: 1000, requestTokens: 100, concurrency: 2 }) {
  const root = await mkdtemp(join(tmpdir(), "model-gateway-")), path = join(root, "gateway.sqlite");
  const store = new ModelGatewayStore(path);
  store.configure("human-a", limit, 0, "admin"); store.bind("thread-a", "human-a");
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, path, store };
}
const response = (input = 10, output = 5) => ({ id: "resp-test", status: "completed", usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } });
const terminal = (input = 10, output = 5) => `data: ${JSON.stringify({type:"response.completed",response:response(input,output)})}\n\n`;

test("independent processes cannot overbook the human budget", async t => {
  const { path, store } = await fixture(t, { monthlyTokens: 200, requestTokens: 100, concurrency: 10 });
  const module = resolve("packages/account-pool-host/src/model-gateway-store.ts");
  const script = `import {ModelGatewayStore} from ${JSON.stringify(module)};const s=new ModelGatewayStore(process.argv[1]);try{s.reserve('thread-a','model');console.log('admitted')}catch(e){console.log(e.kind)}finally{s.close()}`;
  const results = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path])));
  assert.equal(results.filter(r => r.stdout.trim() === "admitted").length, 2);
  assert.equal(results.filter(r => r.stdout.trim() === "gateway_budget_exhausted").length, 4);
  assert.equal(store.summary("human-a").heldTokens, 200);
});

test("sponsor is stable, descendants inherit, missing/cyclic ancestry fails closed", async t => {
  const { path, store } = await fixture(t);
  assert.equal(bindModelGatewaySponsor("thread-a", "human-b", undefined, path), "human-a");
  assert.equal(bindModelGatewaySponsor("grandchild", null, id => id === "grandchild" ? "child" : id === "child" ? "thread-a" : null, path), "human-a");
  assert.throws(() => bindModelGatewaySponsor("other", null, undefined, path), /sponsor_required/);
  assert.throws(() => bindModelGatewaySponsor("x", "human-a", id => id === "x" ? "y" : "x", path), /sponsor_cycle/);
  assert.equal(store.sponsor("grandchild"), "human-a");
});

test("CAS policy edits, idempotent settlement, unknown restart recovery and reconciliation", async t => {
  const { path, store } = await fixture(t);
  assert.throws(() => store.configure("human-a", { monthlyTokens: 1, requestTokens: 1, concurrency: 1 }, 0, "admin"), /revision_conflict/);
  const first = store.reserve("thread-a", "model"); store.dispatched(first.id, "key-ref"); store.finish(first.id, 15); store.finish(first.id, 15);
  assert.throws(() => store.finish(first.id, 16), /settlement_conflict/);
  const unknown = store.reserve("thread-a", "model"); store.dispatched(unknown.id); store.finish(unknown.id, null);
  const reopened = new ModelGatewayStore(path);
  try {
    assert.equal(reopened.summary("human-a").usedTokens, 15);
    assert.equal(reopened.summary("human-a").heldTokens, 100);
    reopened.reconcile(unknown.id, 20, "admin", "Matched provider receipt");
    assert.equal(reopened.summary("human-a").usedTokens, 35);
    assert.equal(reopened.summary("human-a").heldTokens, 0);
    assert.throws(() => reopened.reconcile(unknown.id, 20, "admin", "repeat"), /conflict/);
  } finally { reopened.close(); }
});

test("streaming forwards bytes and settles a split CRLF terminal before HTTP EOF", async t => {
  const { path, store } = await fixture(t);
  const wire = terminal().replaceAll("\n", "\r\n"), bytes = new TextEncoder().encode(wire);
  let cancelled = false;
  const result = await meteredModelRequest({path,thread:"thread-a",model:"model",signal:new AbortController().signal,
    send: async dispatch => { dispatch("provider-key"); let i=0; return new Response(new ReadableStream({pull(controller){if(i<bytes.length)controller.enqueue(bytes.slice(i,i+=1));},cancel(){cancelled=true;}}),{headers:{"content-type":"text/event-stream"}}); }});
  const reader = result.body!.getReader(); let seen="";
  while(seen.length<wire.length) { const next=await reader.read();seen+=new TextDecoder().decode(next.value); }
  assert.equal(seen,wire); assert.equal(store.summary("human-a").usedTokens,15);
  assert.equal(store.summary("human-a").heldTokens,0);
  assert.equal(store.requests("human-a")[0]?.credential,"provider-key");
  await reader.cancel(); assert.equal(cancelled,true);
});

test("pre-dispatch validation releases; EOF, cancellation and network ambiguity keep a hold", async t => {
  const { path, store } = await fixture(t, { monthlyTokens: 1000, requestTokens: 100, concurrency: 10 });
  const call = (send: Parameters<typeof meteredModelRequest>[0]["send"]) => meteredModelRequest({path,thread:"thread-a",model:"model",signal:new AbortController().signal,send});
  await call(async () => new Response(null,{status:400}));
  assert.equal(store.summary("human-a").heldTokens,0);
  const truncated = await call(async dispatch => {dispatch();return new Response('data: {"type":"response.completed"}\n\n',{headers:{"content-type":"text/event-stream"}});});
  await truncated.text(); assert.equal(store.summary("human-a").heldTokens,100);
  await assert.rejects(call(async dispatch => {dispatch();throw Error("network unknown");}),/network unknown/);
  assert.equal(store.summary("human-a").heldTokens,200);
  const pending = await call(async dispatch => {dispatch();return new Response(new ReadableStream());});
  await pending.body!.cancel(); assert.equal(store.summary("human-a").heldTokens,300);
});

test("receipt observer ignores generated text, negative usage, giant events and partial records", () => {
  for(const wire of [JSON.stringify(response()), 'data: '+JSON.stringify({type:'response.output_text.delta',delta:terminal()})+'\n\n', terminal(-1,5),terminal().trimEnd()]) {
    const receipt=new ModelGatewayUsageReceipt(true);receipt.push(new TextEncoder().encode(wire));receipt.end();assert.equal(receipt.actual,null);
  }
  const receipt=new ModelGatewayUsageReceipt(true);
  receipt.push(new TextEncoder().encode('data: '+ 'x'.repeat(1024*1024+2)+'\n\n'+terminal()));
  assert.equal(receipt.actual,15);
  const mislabeled=new ModelGatewayUsageReceipt(false);
  mislabeled.push(new TextEncoder().encode(terminal()));assert.equal(mislabeled.actual,15);
});

test("actual over-reservation is recorded honestly and stops further admission", async t => {
  const {path,store}=await fixture(t,{monthlyTokens:100,requestTokens:100,concurrency:2});
  const result=await meteredModelRequest({path,thread:'thread-a',model:'model',signal:new AbortController().signal,send:async dispatch=>{dispatch();return Response.json(response(110,10));}});
  await result.json();assert.equal(store.summary('human-a').usedTokens,120);
  assert.throws(()=>store.reserve('thread-a','model'),/budget_exhausted/);
});

test("Codex proxy authenticates, requires trusted sponsor, meters configured models and rejects before fetch", async t => {
  const {root,path,store}=await fixture(t,{monthlyTokens:100,requestTokens:100,concurrency:1});
  environment(t,path);
  const accounts=new AccountPoolStore({databasePath:join(root,'pool.sqlite'),secretsDirectory:join(root,'secrets')});
  t.after(()=>accounts.close());
  store.prepareContribution('test','human-a','approved','team');store.contributionState('test','human-a','shared');
  const token=accounts.issueHostToken('host');let calls=0;
  const proxy=new CodexAccountPoolProxy({store:accounts,upstreamBaseUrl:'https://unused.invalid',configuredResponses:{catalog:async()=>[],resolve:async()=>({baseUrl:'https://model.invalid/v1',model:'real-model',apiKey:'fake-key'})},
    fetch:async (_url,init)=>{calls++;assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fake-key');return Response.json(response());}});
  const request=(thread='thread-a',auth=token)=>new Request('http://local/v1/responses',{method:'POST',headers:{'x-opencraft-account-pool-token':auth,'thread-id':thread,'content-type':'application/json'},body:JSON.stringify({model:'configured/test/model',input:'hello'})});
  assert.equal((await proxy.handle(request('thread-a','invalid'))).status,401);
  assert.equal((await proxy.handle(request('unbound'))).status,403);assert.equal(calls,0);
  const ok=await proxy.handle(request());assert.equal(ok.status,200);await ok.json();assert.equal(store.summary('human-a').usedTokens,15);
  assert.equal((await proxy.handle(request())).status,429);assert.equal(calls,1);
});

test("HTTP rejects forged payer, cross-origin changes and non-admin configuration", async t => {
  const {path}=await fixture(t);let admin=false;let origin='';
  const handler=modelGatewayHttp({path,authority:req=>req.headers.authorization==='Bearer human'?{actor:'human-a',administrator:admin,origin}:null});
  const server=createServer((req,res)=>{void serveNodeHttpExchange(req,res,handler);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const send=(body:unknown,requestOrigin=origin)=>fetch(origin+MODEL_GATEWAY_PATH,{method:'POST',headers:{authorization:'Bearer human',origin:requestOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(origin+MODEL_GATEWAY_PATH)).status,403);
  assert.equal((await fetch(origin+MODEL_GATEWAY_PATH+'?actor=human-b',{headers:{authorization:'Bearer human'}})).status,403);
  const body={action:'configure',actor:'human-a',monthlyTokens:200,requestTokens:50,concurrency:1,revision:1};
  assert.equal((await send(body)).status,403);admin=true;
  assert.equal((await send(body,'https://other.invalid')).status,403);
  assert.equal((await send(body)).status,200);
  assert.equal((await send(body)).status,409);
});

test("human contributions reuse the credential repository, require consent, and revoke without sharing secrets", async t => {
  const {path,root,store}=await fixture(t);environment(t,path);
  const directory=join(root,'models'),contributions=gatewayContributions(directory,path);
  const input={name:'My shared model',baseUrl:'https://provider.invalid/v1',protocol:'openai-responses',model:'model',apiKey:'synthetic-secret',shareWithTeam:true};
  const repository=new ModelConfigurationRepository(fileStateDocumentStore(directory));
  await repository.update(0,draft=>draft.providers.push({id:'approved-service',name:'Approved service',baseUrl:input.baseUrl,protocol:input.protocol,credentialRef:null,enabled:false,models:[{id:'model',enabled:false}]}));
  await assert.rejects(contributions.contribute('human-a',{...input,scope:'team',shareWithTeam:false}),/invalid_gateway_contribution/);
  await assert.rejects(contributions.contribute('human-a',{...input,baseUrl:'https://unapproved.invalid/v1'}),/not_approved/);
  const result=await contributions.contribute('human-a',input);
  assert.equal(JSON.stringify(result).includes(input.apiKey),false);
  assert.equal(JSON.stringify(store.contributions('human-a')).includes(input.apiKey),false);
  assert.equal((await readFile(join(directory,'models.json'),'utf8')).includes(input.apiKey),false);
  await assert.rejects(createEngineModelSource(directory,{protocols:['openai-responses']}).resolve(result));
  const source=createEngineModelSource(directory,{protocols:['openai-responses'],meteredContributions:true});
  assert.equal((await source.resolve(result)).apiKey,input.apiKey);
  const policyPath=join(root,'policy.sqlite'),policy=new ModelPolicyStore(policyPath);
  try {
    policy.write(0,[{engine:'codex',model:'configured/approved-service/model'}],'admin');
    assert.throws(()=>assertModelPolicy(policyPath,'codex','configured/'+result.providerId+'/model','none'),/Contact your administrator/);
  } finally {policy.close();}
  await assert.rejects(contributions.withdraw('human-b',result.providerId),/forbidden/);
  await contributions.withdraw('human-a',result.providerId);
  await assert.rejects(source.resolve(result));
  assert.equal(store.contribution(result.providerId)?.state,'withdrawn');
});

test("assistant reception and background execution share their verified human's budget", async t => {
  const {path,store}=await fixture(t,{monthlyTokens:115,requestTokens:100,concurrency:2});environment(t,path);
  store.prepareContribution('provider','human-a','approved');store.contributionState('provider','human-a','shared');
  let calls=0;
  const gateway=createAssistantModelGateway(async()=>({baseUrl:'https://provider.invalid/v1',model:'model',apiKey:'test-secret'}),{
    fetch:async()=>{calls++;return Response.json(response());},maxAttempts:1,
  });t.after(()=>gateway.close());
  const reference={providerId:'provider',modelId:'model'};
  const reception=await gateway.connection(reference,{scope:'assistant-a',purpose:'reception',humanActorId:'human-a',authorize:async()=>{}});
  const background=await gateway.connection(reference,{scope:'assistant-a',purpose:'execution',humanActorId:'human-a',authorize:async()=>{}});
  const unowned=await gateway.connection(reference,{scope:'unowned'});
  const post=(connection:{baseUrl:string;apiKey:string})=>fetch(connection.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+connection.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'model',input:'hello'})});
  assert.equal((await post(unowned)).status,403);assert.equal(calls,0);
  const first=await post(reception);assert.equal(first.status,200);await first.json();
  const second=await post(background);assert.equal(second.status,200);await second.json();
  assert.equal(store.summary('human-a').usedTokens,30);
  assert.equal((await post(reception)).status,429);assert.equal(calls,2);
});

test("platform native engines remain available while personal gateway mode is enabled", async t => {
  const {path}=await fixture(t);environment(t,path);
  for(const engine of ['pi','dsh','acp','dsh-acp','claude-code']) assert.equal(assertModelPolicy(undefined,engine,'model'),0);
  assert.equal(assertModelPolicy(undefined,'codex','model'),0);
});


test("personal keys default to owner-only across Codex, descendants and assistant HTTP", async t => {
  const {path,root,store}=await fixture(t); environment(t,path);
  store.configure('human-b',{monthlyTokens:1000,requestTokens:100,concurrency:2},0,'admin');
  store.bind('thread-b','human-b'); store.bind('child-a',null,'thread-a');
  const directory=join(root,'models'),contributions=gatewayContributions(directory,path);
  const input={name:'Personal',baseUrl:'https://provider.invalid/v1',protocol:'openai-responses',model:'model',apiKey:'synthetic-personal-key'};
  const repository=new ModelConfigurationRepository(fileStateDocumentStore(directory));
  await repository.update(0,d=>d.providers.push({id:'approved',name:'Approved',baseUrl:input.baseUrl,protocol:input.protocol,credentialRef:null,enabled:false,models:[{id:'model',enabled:false}]}));
  let origin='';
  const handler=modelGatewayHttp({path,authority:()=>({actor:'human-a',administrator:false,origin}),...contributions});
  const server=createServer((req,res)=>{void serveNodeHttpExchange(req,res,handler);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const create=(extra:Record<string,unknown>={})=>fetch(origin+MODEL_GATEWAY_PATH,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action:'contribute',...input,...extra})});
  assert.equal((await create({scope:'team'})).status,400);
  assert.equal((await create({scope:'personal',shareWithTeam:true})).status,400);
  assert.equal((await create({actor:'human-b'})).status,400);
  const created=await create();assert.equal(created.status,200);
  const personal=await created.json() as {providerId:string;modelId:string;scope:string;shared:boolean};
  assert.equal(personal.scope,'personal'); assert.equal(personal.shared,false);
  assert.equal(store.contribution(personal.providerId)?.scope,'personal');
  const source=createEngineModelSource(directory,{protocols:['openai-responses'],meteredContributions:true});
  const resolveRoute=async()=>{const r=await source.resolve(personal);return {baseUrl:r.baseUrl,model:r.model.id,apiKey:r.apiKey!};};
  let calls=0; const upstream:typeof fetch=async()=>{calls++;return Response.json(response());};
  const accounts=new AccountPoolStore({databasePath:join(root,'pool.sqlite'),secretsDirectory:join(root,'secrets')}); t.after(()=>accounts.close());
  const token=accounts.issueHostToken('host');
  const proxy=new CodexAccountPoolProxy({store:accounts,upstreamBaseUrl:'https://unused.invalid',configuredResponses:{catalog:async()=>[],resolve:resolveRoute},fetch:upstream});
  const post=(thread:string)=>proxy.handle(new Request('http://local/v1/responses',{method:'POST',headers:{'x-opencraft-account-pool-token':token,'thread-id':thread,'content-type':'application/json'},body:JSON.stringify({model:'configured/'+personal.providerId+'/model',actorId:'human-a',input:'hello'})}));
  assert.equal((await post('thread-b')).status,403); assert.equal(calls,0);
  assert.equal(store.summary('human-b').heldTokens,0);
  for(const thread of ['thread-a','child-a']) {const result=await post(thread);assert.equal(result.status,200);await result.json();}
  assert.equal(calls,2); assert.equal(store.summary('human-a').usedTokens,30);
  assert.throws(()=>bindModelGatewaySponsor('thread-a','human-b'),/personal_key_forbidden/);
  assert.throws(()=>bindModelGatewaySponsor('child-a','human-b'),/personal_key_forbidden/);
  assert.throws(()=>bindModelGatewaySponsor('new-child','human-b',id=>id==='new-child'?'thread-a':null),/personal_key_forbidden/);
  store.bind('mixed','human-a');bindModelGatewaySponsor('mixed','human-b');
  assert.equal((await post('mixed')).status,403);assert.equal(calls,2);
  const assistant=createAssistantModelGateway(resolveRoute,{fetch:upstream,maxAttempts:1});t.after(()=>assistant.close());
  const own=await assistant.connection(personal,{scope:'personal-a',humanActorId:'human-a',authorize:async()=>{}});
  const other=await assistant.connection(personal,{scope:'personal-b',humanActorId:'human-b',authorize:async()=>{}});
  const send=(c:{baseUrl:string;apiKey:string})=>fetch(c.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+c.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'model',input:'hello',actorId:'human-a'})});
  assert.equal((await send(other)).status,403);assert.equal(calls,2);
  const accepted=await send(own);assert.equal(accepted.status,200);await accepted.json();assert.equal(calls,3);
  await contributions.withdraw('human-a',personal.providerId);
  assert.notEqual((await post('thread-a')).status,200);assert.equal(calls,3);
});

test("team consent is explicit and dispatch rechecks withdrawal", async t => {
  const {store,path}=await fixture(t);
  store.prepareContribution('personal','human-b','approved');store.contributionState('personal','human-b','shared');
  store.prepareContribution('team','human-b','approved','team');store.contributionState('team','human-b','shared');
  let calls=0;
  const send=(provider:string,withdraw=false)=>meteredModelRequest({path,thread:'thread-a',model:'model',signal:new AbortController().signal,send:async dispatch=>{
    if(withdraw)store.contributionState(provider,'human-b','withdrawn');
    dispatch(provider);calls++;return Response.json(response());
  }});
  await assert.rejects(send('personal'),/personal_key_forbidden/);assert.equal(calls,0);
  await (await send('team')).json();assert.equal(calls,1);
  await assert.rejects(send('team',true),/personal_key_forbidden/);assert.equal(calls,1);
  assert.equal(store.summary('human-a').heldTokens,0);
});


test("v1 databases migrate existing explicit shares without widening new private keys", async t => {
  const root=await mkdtemp(join(tmpdir(),'gateway-upgrade-')),path=join(root,'gateway.sqlite');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const sql=await readFile(new URL('./fixtures/model-gateway-v1.sql',import.meta.url),'utf8');
  const old=openManagedDatabase({path,migrations:[{version:1,name:'model-gateway',sql}],legacyPolicy:'reject'});
  old.database.prepare("INSERT INTO gateway_contributions VALUES(?,?,?,'shared',?)").run('old-share','human-a','approved',1);
  old.database.close();
  const upgraded=new ModelGatewayStore(path);
  try {
    assert.equal(upgraded.contribution('old-share')?.scope,'team');
    upgraded.prepareContribution('new-private','human-a','approved');
    assert.equal(upgraded.contribution('new-private')?.scope,'personal');
  } finally {upgraded.close();}
  const reopened=new ModelGatewayStore(path);try {assert.equal(reopened.contribution('new-private')?.scope,'personal');} finally {reopened.close();}
});

test('personal task authority is scoped to one execution, model and authorizer, not the first person in a Thread',async t=>{
  const {store,path}=await fixture(t,{monthlyTokens:2000,requestTokens:100,concurrency:4});
  store.configure('human-b',{monthlyTokens:2000,requestTokens:100,concurrency:4},0,'admin');
  store.prepareContribution('mine','human-a','approved');store.contributionState('mine','human-a','shared');
  const model='configured/mine/model',expiresAt=Date.now()+60000;
  store.beginExecution('shared-thread',{id:'alice-task',authorizer:'human-a',executor:'assistant-a',model,expiresAt,authorityId:'root-delegation'});
  assert.equal(store.executionForAuthority('root-delegation'),'alice-task');
  assert.throws(()=>store.beginExecution('changed-child',{id:'changed-child',authorizer:'human-a',executor:null,model:'other-model',expiresAt,parent:'alice-task'}),/delegation_forbidden/);
  assert.throws(()=>store.steerExecution('shared-thread','human-b'),/owner_required/);
  assert.throws(()=>store.beginExecution('shared-thread',{id:'bob-task',authorizer:'human-b',executor:'assistant-a',model:'platform-model',expiresAt}),/busy/);
  assert.throws(()=>store.reserve('shared-thread','another-model'),/model_forbidden/);
  const first=store.reserve('shared-thread',model);store.dispatched(first.id,model);store.finish(first.id,15);
  assert.equal(store.summary('human-a').usedTokens,15);
  assert.equal(bindModelGatewaySponsor('child-task',null,id=>id==='child-task'?'shared-thread':null,path),'human-a');
  assert.equal(store.execution('child-task')?.parent,'alice-task');
  store.startedExecution('shared-thread','alice-turn');store.finishedExecution('shared-thread','alice-turn');
  assert.throws(()=>store.reserve('shared-thread',model),/execution_expired/);
  store.beginExecution('shared-thread',{id:'bob-task',authorizer:'human-b',executor:'assistant-a',model:'platform-model',expiresAt});
  // A late terminal for the old turn cannot retire Bob's new authorization.
  store.finishedExecution('shared-thread','alice-turn');
  const second=store.reserve('shared-thread','platform-model');store.dispatched(second.id);store.finish(second.id,20);
  assert.equal(store.summary('human-b').usedTokens,20);
  assert.throws(()=>store.beginExecution('other-thread',{id:'borrow-key',authorizer:'human-b',executor:'assistant-a',model,expiresAt}),/personal_key_forbidden/);
  // Children share the root payer; revoking their ancestor prevents further dispatch.
  const child=store.reserve('child-task',model);store.endExecution('shared-thread','alice-task',true);
  assert.throws(()=>store.dispatched(child.id,model),/execution_expired/);store.finish(child.id,null);
});

test('scope changes are owned, revision-checked and rechecked at dispatch; personal caps include shared-key spending',async t=>{
 const {store}=await fixture(t,{monthlyTokens:2000,requestTokens:100,concurrency:4});
 store.configure('human-b',{monthlyTokens:2000,requestTokens:100,concurrency:4},0,'admin');store.bind('bob','human-b');
 store.prepareContribution('mine','human-a','approved');store.contributionState('mine','human-a','shared');
 assert.equal(store.canUse('mine','human-b'),false);
 assert.throws(()=>store.setScope('mine','human-b','team',0),/contribution_forbidden/);
 store.setScope('mine','human-a','team',0);assert.equal(store.canUse('mine','human-b'),true);
 assert.throws(()=>store.setScope('mine','human-a','personal',0),/revision_conflict/);
 store.setPersonalLimit('human-a',110,0);
 const model='configured/mine/model',request=store.reserve('bob',model);store.dispatched(request.id,model);store.finish(request.id,20);
 assert.equal(store.summary('human-a').usedTokens,20);assert.equal(store.summary('human-b').usedTokens,20);
 assert.throws(()=>store.reserve('bob',model),/budget_exhausted/);
 store.setPersonalLimit('human-a',1000,1);const queued=store.reserve('bob',model);
 store.setScope('mine','human-a','personal',1);
 assert.throws(()=>store.dispatched(queued.id,model),/personal_key_forbidden/);store.finish(queued.id,null);
 assert.equal(store.summary('human-a').heldTokens,0);
 assert.throws(()=>store.setPersonalLimit('human-a',500,1),/revision_conflict/);
});

test('task expiry survives restart and revocation does not discard an upstream receipt',async t=>{
 const {root}=await fixture(t);let now=Date.now();const path=join(root,'expiry.sqlite');
 const ledger=new ModelGatewayStore(path,()=>now);
 ledger.configure('alice',{monthlyTokens:1000,requestTokens:100,concurrency:2},0,'admin');
 ledger.beginExecution('t',{id:'task',authorizer:'alice',executor:'bot',model:'m',expiresAt:now+1000});
 const request=ledger.reserve('t','m');ledger.dispatched(request.id);ledger.close();now+=1001;
 const reopened=new ModelGatewayStore(path,()=>now);try{
  assert.throws(()=>reopened.reserve('t','m'),/execution_expired/);
  reopened.finish(request.id,12);assert.equal(reopened.summary('alice').usedTokens,12);
 }finally{reopened.close();}
});

test('native turn binding prevents a late request from charging the next user of the same Thread',async t=>{
 const {root,path,store}=await fixture(t);environment(t,path);
 store.configure('human-b',{monthlyTokens:1000,requestTokens:100,concurrency:2},0,'admin');
 store.prepareContribution('shared','human-a','approved','team');store.contributionState('shared','human-a','shared');
 const model='configured/shared/model';
 store.beginExecution('shared',{id:'alice',authorizer:'human-a',executor:null,model,expiresAt:Date.now()+60000});
 const pool=new AccountPoolStore({databasePath:join(root,'pool.sqlite'),secretsDirectory:join(root,'secrets')});t.after(()=>pool.close());
 const token=pool.issueHostToken('host');let dispatched=0;
 const proxy=new CodexAccountPoolProxy({store:pool,upstreamBaseUrl:'https://unused.invalid',configuredResponses:{catalog:async()=>[],resolve:async()=>({baseUrl:'https://model.invalid',model:'m',apiKey:'synthetic'})},fetch:async()=>{dispatched++;return Response.json(response());}});
 const request=(turn?:string)=>new Request('http://proxy/v1/responses',{method:'POST',headers:{'x-opencraft-account-pool-token':token,'thread-id':'shared','content-type':'application/json',...(turn?{'x-codex-turn-metadata':JSON.stringify({turn_id:turn})}:{})},body:JSON.stringify({model,input:'hello'})});
 assert.equal((await proxy.handle(request())).status,403);
 // First physical request can bind before the turn-start notification arrives.
 const first=await proxy.handle(request('turn-alice'));assert.equal(first.status,200);await first.json();
 store.finishedExecution('shared','turn-alice');
 store.beginExecution('shared',{id:'bob',authorizer:'human-b',executor:null,model,expiresAt:Date.now()+60000});
 assert.equal((await proxy.handle(request('turn-alice'))).status,403);assert.equal(dispatched,1);
 const second=await proxy.handle(request('turn-bob'));assert.equal(second.status,200);await second.json();
 // Both requests use human-a's shared connection; its owner cap includes both.
 assert.equal(store.summary('human-a').usedTokens,30);assert.equal(store.summary('human-b').usedTokens,15);
});

test('platform configured inference keeps working without personal execution authority or budget',async t=>{
 const {root,path,store}=await fixture(t);environment(t,path);
 const accounts=new AccountPoolStore({databasePath:join(root,'platform.sqlite'),secretsDirectory:join(root,'secrets')});t.after(()=>accounts.close());
 const token=accounts.issueHostToken('platform-host');let calls=0;
 const proxy=new CodexAccountPoolProxy({store:accounts,upstreamBaseUrl:'https://unused.invalid',configuredResponses:{catalog:async()=>[],resolve:async()=>({baseUrl:'https://platform.invalid',model:'platform-model',apiKey:'platform-secret'})},fetch:async()=>{calls++;return Response.json(response());}});
 const result=await proxy.handle(new Request('http://proxy/v1/responses',{method:'POST',headers:{'x-opencraft-account-pool-token':token,'content-type':'application/json'},body:JSON.stringify({model:'configured/platform/model',input:'hello'})}));
 assert.equal(result.status,200);await result.json();assert.equal(calls,1);
 assert.equal(store.summary('human-a').usedTokens,0);assert.equal(store.summary('human-a').heldTokens,0);
});


test('trusted shared input continues only its exact live execution without transferring model sponsorship', async t => {
  const {store} = await fixture(t);
  store.beginExecution('shared-input', { id: 'alice-input', authorizer: 'human-a', executor: null, model: 'fixture-model', expiresAt: Date.now()+60000 });
  const before = store.execution('shared-input');
  assert.throws(() => store.steerExecution('shared-input', 'human-b'), /owner_required/);
  store.steerSharedExecution('shared-input', 'alice-input');
  assert.deepEqual(store.execution('shared-input'), before);
  assert.throws(() => store.steerSharedExecution('shared-input', 'another-input'), /execution_changed/);
  store.endExecution('shared-input', 'alice-input', true);
  assert.throws(() => store.steerSharedExecution('shared-input', 'alice-input'), /execution_expired/);
});
