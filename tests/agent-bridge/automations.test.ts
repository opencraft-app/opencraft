import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openServerDatabase, SERVER_MIGRATIONS } from '../../packages/storage-node/src/server/index';
import { openManagedDatabase } from '../../packages/sqlite-node/src/index';
import { ActorStore } from '../../packages/access-control/src/actors';
import { OrchestrationRuntimeWorker } from '../../packages/access-control/src/orchestration-runtime-store';
import { ProjectAutomations, type AutomationExecution } from '../../packages/access-control/src/automation-runtime';
import { automationOccurrence, automationRunKey, parseAutomationSchedule } from '../../packages/access-control/src/automation';

const instant=Date.parse('2026-11-10T12:00:00Z');
const target={kind:'cron',threadId:'thread',environment:'host',prompt:'Say OK'};
async function fixture(t:any, execution?:Partial<AutomationExecution>) {
  const root=await mkdtemp(join(tmpdir(),'oc-project-automation-'));
  const owner=await openServerDatabase(root),actors=new ActorStore(owner);
  let now=instant;
  // ActorStore checks expiry against the wall clock; keep the fixture valid after the fake instant.
  const context=actors.resolveHuman({provider:'local',subject:'automation-owner',displayName:'Owner',expiresAt:Math.max(Date.now(),instant)+86_400_000})!;
  let worker=new OrchestrationRuntimeWorker(join(root,'opencraft-server.sqlite'));await worker.start();
  let calls=0;
  const port:AutomationExecution={async validate(){return 'permission-snapshot';},async dispatch(){calls++;return {state:'completed'};},async inspect(){return {state:'running'};},...execution};
  let service=new ProjectAutomations(worker,port,()=>now);await service.start();
  const caller={context};
  const grant=await service.grant(caller,'create',{serverId:'server',projectId:'project',target,permissionProfile:'read-only'},'grant-one') as any;
  const create=async(schedule:any={kind:'cron',expression:'* * * * *',timezone:'UTC'},key='create-one')=>service.command(caller,'create',{grantId:grant.id,schedule},key) as Promise<any>;
  t.after(async()=>{await service.close();await worker.close();actors.close();await owner.close();await rm(root,{recursive:true,force:true});});
  return {owner,actors,context,caller,grant,create,get service(){return service;},get worker(){return worker;},calls:()=>calls,advance(ms:number){now+=ms;},now:()=>now,
    async flush(){
      for(let attempt=0;attempt<500;attempt++){
        const pending=owner.database.prepare("SELECT count(*) AS n FROM automation_runs WHERE state='admitted'").get()!;
        if(pending.n===0)return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail('Automation dispatch did not settle its admission');
    },
    async restart(){await service.close();await worker.close();worker=new OrchestrationRuntimeWorker(join(root,'opencraft-server.sqlite'));await worker.start();service=new ProjectAutomations(worker,port,()=>now);await service.start();},
  };
}

test('cron timezone and DST use a fake UTC clock, skip gaps and second folds',()=>{
  const cron=(expression:string,timezone:string)=>parseAutomationSchedule({kind:'cron',expression,timezone});
  assert.equal(automationOccurrence(cron('30 2 * * *','America/New_York'),Date.parse('2026-03-08T07:30:00Z')),null);
  assert.equal(automationOccurrence(cron('30 1 * * *','America/New_York'),Date.parse('2026-11-01T05:30:00Z')),'utc-'+Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(automationOccurrence(cron('30 1 * * *','America/New_York'),Date.parse('2026-11-01T06:30:00Z')),null);
  assert.equal(automationOccurrence(cron('0 20 * * *','Asia/Shanghai'),instant),'utc-'+instant);
  assert.equal(automationOccurrence({kind:'once',at:instant},instant+60_000),null);
  assert.throws(()=>cron('61 * * * *','UTC'));
  assert.throws(()=>cron('* * * * *','invalid-zone'));
});

test('durable occurrence executes once across duplicate tick and restart; mutation conflict and pagination',async t=>{
  const f=await fixture(t),automation=await f.create();
  await f.service.tick();await f.flush();await f.service.tick();await f.flush();assert.equal(f.calls(),1);
  await f.restart();await f.service.tick();await f.flush();assert.equal(f.calls(),1);
  const view=await f.service.command(f.caller,'runs',{id:automation.id}) as any;
  assert.equal(view.items.length,1);assert.equal(view.items[0].state,'completed');
  await assert.rejects(f.create({kind:'cron',expression:'0 0 * * *',timezone:'UTC'}),{code:'automation_idempotency_conflict'});
  await f.create(undefined,'create-two');
  const page=await f.service.command(f.caller,'list',{projectId:'project',limit:1}) as any;
  assert.equal(page.items.length,1);assert.ok(page.nextCursor);
  const next=await f.service.command(f.caller,'list',{projectId:'project',limit:1,cursor:page.nextCursor}) as any;
  assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,page.items[0].id);assert.equal(next.nextCursor,null);
});

test('three consecutive definite failures pause; unknown immediately fences following ticks',async t=>{
  const f=await fixture(t,{async dispatch(){return {state:'failed'};}}),automation=await f.create();
  for(let n=0;n<3;n++){await f.service.tick();await f.flush();f.advance(60_000);}
  const show=await f.service.command(f.caller,'show',{id:automation.id}) as any;
  assert.equal(show.enabled,false);
  const runs=await f.service.command(f.caller,'runs',{id:automation.id}) as any;
  assert.equal(runs.items.length,3);assert.ok(runs.items.every((run:any)=>run.state==='failed'));
  const g=await fixture(t,{async dispatch(){return {state:'unknown'};}}),other=await g.create();
  await g.service.tick();await g.flush();g.advance(60_000);await g.service.tick();await g.flush();
  const unknown=await g.service.command(g.caller,'runs',{id:other.id}) as any;
  assert.deepEqual(unknown.items.map((run:any)=>run.state),['unknown','skipped']);
  assert.equal(unknown.items[1].result.reason,'reconciliation_required');
});

test('running overlap is skipped; restart creates unknown without replay',async t=>{
  const f=await fixture(t,{async dispatch(){return {state:'running'};}}),automation=await f.create();
  await f.service.tick();await f.flush();f.advance(60_000);await f.service.tick();await f.flush();
  let runs=await f.service.command(f.caller,'runs',{id:automation.id}) as any;
  assert.deepEqual(runs.items.map((run:any)=>run.state),['running','skipped']);
  await f.restart();f.advance(60_000);await f.service.tick();await f.flush();
  runs=await f.service.command(f.caller,'runs',{id:automation.id}) as any;
  assert.deepEqual(runs.items.map((run:any)=>run.state),['unknown','skipped','skipped']);
});

test('grant revoke refuses trigger; manual occurrence requires full key and remains single',async t=>{
  const f=await fixture(t),automation=await f.create();
  await assert.rejects(f.service.command(f.caller,'run',{id:automation.id,occurrenceId:'manual-1'},'manual-key'),{code:'automation_run_key_required'});
  const args={id:automation.id,occurrenceId:'manual-1',runKey:automationRunKey(automation.id,1,'manual-1')};
  await f.service.command(f.caller,'run',args,'manual-key');await f.flush();
  await f.service.command(f.caller,'run',args,'manual-key');await f.flush();assert.equal(f.calls(),1);
  await f.service.grant(f.caller,'revoke',{id:f.grant.id},'revoke-key');
  f.advance(60_000);await f.service.tick();await f.flush();assert.equal(f.calls(),1);
  const runs=await f.service.command(f.caller,'runs',{id:automation.id}) as any;
  assert.ok(runs.items.some((run:any)=>run.result?.reason==='grant_revoked'));
});

test('automation delegation cannot create another automation and revocation invalidates descendant root',async t=>{
  const f=await fixture(t,{async dispatch(){return {state:'running'};}}),automation=await f.create();
  const claim=await f.worker.automation('claim',{id:automation.id,revision:1,occurrenceId:'manual-derive'},f.now());
  const delegation=await f.worker.automation('delegation',{key:claim.run.key,sourceThreadId:'thread'},f.now());
  await assert.rejects(f.service.command({context:f.context,authorityId:delegation.id},'create',{grantId:f.grant.id,schedule:automation.schedule},'recursive-key'),{code:'automation_recursive_creation_denied'});
  assert.equal((await f.service.checkDelegation(delegation.id)).valid,true);
  await f.service.grant(f.caller,'revoke',{id:f.grant.id},'revoke-key');
  assert.equal((await f.service.checkDelegation(delegation.id)).valid,false);
});

test('Server migration upgrades previous version with business data and rejects altered checksum',async t=>{
  const root=await mkdtemp(join(tmpdir(),'oc-automation-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'server.sqlite'),old=openManagedDatabase({path,migrations:SERVER_MIGRATIONS.slice(0,-1),legacyPolicy:'reject'});
  old.database.prepare("INSERT INTO thread_notes VALUES('server','thread',X'0102',1)").run();old.database.close();
  const upgraded=openManagedDatabase({path,migrations:SERVER_MIGRATIONS,legacyPolicy:'reject'});
  assert.equal(upgraded.database.prepare('SELECT count(*) AS n FROM thread_notes').get()!.n,1);
  assert.ok(upgraded.database.prepare("SELECT name FROM sqlite_master WHERE name='automation_runs'").get());
  upgraded.database.close();
  const changed=SERVER_MIGRATIONS.map((migration,index)=>index===SERVER_MIGRATIONS.length-1?{...migration,sql:migration.sql+'\n-- changed'}:migration);
  assert.throws(()=>openManagedDatabase({path,migrations:changed,legacyPolicy:'reject'}));
});

test('Host scripts execute once through the selected sandbox pool and retain bounded output',async t=>{
  const {BridgeHost,attachGateway}=await import('../../apps/agent-bridge-host/src/index');
  const {localTestBackend}=await import('./fixtures/local-backend');
  const root=await mkdtemp(join(tmpdir(),'oc-script-authority-'));
  const options={path:join(root,'host.sqlite'),policy:{id:'test',capacity:{cpuMillis:4000,memoryBytes:8*1024**3}},backend:localTestBackend(),automation:{hostId:'host',environment:'environment'}};
  let host=await BridgeHost.open(options);let gateway=await attachGateway(host,'x'.repeat(32));
  t.after(async()=>{await gateway.close();await host.close();await rm(root,{recursive:true,force:true});});
  const body={key:'automation:1:manual-1',hostId:'host',environment:'environment',permissionProfile:'sandbox-policy:test',cwd:root,
    argv:[process.execPath,'-e',"require('node:fs').appendFileSync('effect','one');process.stdout.write('OK');process.stderr.write('diagnostic')"]};
  const run=()=>fetch(gateway.url+'/script/run',{method:'POST',headers:{authorization:'Bearer '+'x'.repeat(32),'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await run()).status,200);
  let receipt:any;
  for(let attempt=0;attempt<100;attempt++){
    receipt=await host.scriptResult(body.key);if(receipt.state==='completed')break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(receipt.state,'completed');assert.equal(receipt.result.stdout,'OK');assert.equal(receipt.result.stderr,'diagnostic');assert.equal(receipt.result.exit.code,0);
  await gateway.close();await host.close();host=await BridgeHost.open({...options,backend:localTestBackend()});gateway=await attachGateway(host,'x'.repeat(32));
  assert.equal((await run()).status,200);
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(root,'effect'),'utf8'),'one');
  await assert.rejects(host.script({...body,argv:[process.execPath,'-e','process.exit(1)']}));
  await assert.rejects(host.script({...body,key:'automation:1:manual-2',environment:'foreign'}));
  const missing={...body,key:'automation:1:missing',argv:['/nonexistent-opencraft-script']};
  await host.script(missing);
  for(let n=0;n<100;n++){receipt=await host.scriptResult(missing.key);if(['completed','failed','unknown'].includes(receipt.state))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(receipt.state,'failed');
});

test('all automation CLI commands use the execution launcher, JSON, help, pagination and explicit mutation keys',async t=>{
  const {createServer}=await import('node:http');
  const {issueThreadCli}=await import('../../packages/session-capabilities/src/thread-cli-provider');
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'oc-automation-cli-')),requests:any[]=[];
  const server=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;
    requests.push(JSON.parse(body));response.setHeader('content-type','application/json');response.end(JSON.stringify({result:{items:[],nextCursor:'next-page'}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as any;
  const launcher=await issueThreadCli(root,{serverId:'server',threadId:'thread',execution:{inputId:'input'}} as any,{url:`http://127.0.0.1:${address.port}/thread-cli`,token:'test'});
  t.after(async()=>{await launcher.revoke();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  const commands:Record<string,string[]>={list:['--project-id','project','--cursor','cursor','--limit','2'],show:['id'],create:['--grant-id','grant','--schedule','{"kind":"once","at":1}'],update:['id','--revision','1','--schedule','{"kind":"once","at":2}'],pause:['id'],resume:['id'],delete:['id'],run:['id','--occurrence-id','manual-1','--run-key','id:1:manual-1'],runs:['id','--limit','2']};
  for(const [command,args] of Object.entries(commands)) {
    const help=await exec(launcher.launcher,['automation',command,'--help','--json']);assert.match(JSON.parse(help.stdout).help,/automation/);
    const mutation=!['list','show','runs'].includes(command);
    if(mutation)await assert.rejects(exec(launcher.launcher,['automation',command,...args,'--json']));
    const reply=await exec(launcher.launcher,['automation',command,...args,...(mutation?['--idempotency-key','key-'+command]:[]),'--json']);
    assert.equal(JSON.parse(reply.stdout).nextCursor,'next-page');assert.equal(requests.at(-1).command,'automation.'+command);
    if(mutation)assert.equal(requests.at(-1).idempotencyKey,'key-'+command);
  }
  assert.equal(requests.length,9);
});

test('Server assembly drives once through Broker and cron through input ledger with current project grant',async t=>{
  const {Collaboration}=await import('../../packages/access-control/src/collaboration');
  const {ThreadOrchestrationBroker}=await import('../../packages/access-control/src/thread-orchestration-broker');
  const {createProjectAutomations}=await import('../../scripts/project-automations.mjs');
  const root=await mkdtemp(join(tmpdir(),'oc-automation-broker-')),owner=await openServerDatabase(root),actors=new ActorStore(owner);
  const context=actors.resolveHuman({provider:'local',subject:'owner',displayName:'Owner',expiresAt:Date.now()+86_400_000})!;
  const receipts=new Map<string,any>();let creates=0,submissions=0;
  const collaboration=new Collaboration(owner,actors,{serverId:'server',hostId:'host',async validate(){},async receipt(_binding,id){return receipts.get(id)??null;},
    async add(_binding,id){
      const link=owner.database.prepare('SELECT authority_id FROM opencraft_input_authorities WHERE thread_id=? AND input_id=?').get(_binding.threadId,'actor-input:'+id);
      if(_binding.threadId==='thread')assert.ok(link,'cron must commit input authority before native admission');
      collaboration.executionStarted(_binding.threadId,'actor-input:'+id,'turn');
      const delegated=collaboration.executionSource(_binding.threadId,{inputId:'actor-input:'+id});
      assert.equal((await worker.automation('checkDelegation',{id:delegated.delegation.id},Date.now())).derived,true);
      submissions++;const receipt={id,state:'delivered',targetTurnId:'turn'};receipts.set(id,receipt);return receipt;},async steer(){},async cancel(){return true;},
    async metadata(ref){return {ref,projectId:'project',cwd:root,runtime:'idle',currentTurnId:null,recovery:null,attention:null,observedAt:Date.now()};}},Date.now);
  const worker=new OrchestrationRuntimeWorker(join(root,'opencraft-server.sqlite'));await worker.start();
  const broker=new ThreadOrchestrationBroker(collaboration,{async prepare(_id,_thread,args){return {cwd:root,permissions:'read-only',...args};},async create(){creates++;return {threadId:'child'};},async snapshot(threadId){return {threadId,turnId:'turn',rootTurnId:'turn',state:'completed'};}},Date.now,worker);
  let legacyActive=false;broker.legacySchedule=async()=>legacyActive?{status:'active'}:null;
  const runtime=createProjectAutomations(worker,broker,collaboration,undefined);await runtime.start();
  t.after(async()=>{await runtime.close();await broker.close();await collaboration.close();await worker.close();actors.close();await owner.close();await rm(root,{recursive:true,force:true});});
  const caller={context};
  for(const kind of ['once','cron'] as const) {
    const task=kind==='once'?{kind,sourceThreadId:'parent',driver:'codex',model:'fixture',environment:'host',prompt:'OK'}:target;
    const grant=await runtime.grant(caller,'create',{serverId:'server',projectId:'project',target:task,permissionProfile:'read-only'},'grant-'+kind) as any;
    const schedule=kind==='once'?{kind,at:Date.now()}:{kind,expression:'* * * * *',timezone:'UTC'};
    const automation=await runtime.command(caller,'create',{grantId:grant.id,schedule},'create-'+kind) as any;
    await runtime.command(caller,'run',{id:automation.id,occurrenceId:'manual',runKey:automationRunKey(automation.id,1,'manual')},'run-'+kind);
    for(let n=0;n<50;n++) {
      await new Promise(resolve=>setTimeout(resolve,10));await collaboration.pump();await runtime.tick();
      const runs=await runtime.command(caller,'runs',{id:automation.id}) as any;
      if(runs.items.find((run:any)=>run.occurrenceId==='manual')?.state==='completed')break;
    }
    const runs=await runtime.command(caller,'runs',{id:automation.id}) as any;
    assert.equal(runs.items.find((run:any)=>run.occurrenceId==='manual').state,'completed',JSON.stringify(runs));
  }
  assert.equal(creates,1);assert.ok(submissions>=2);
  const spoofGrant=await runtime.grant(caller,'create',{serverId:'server',projectId:'project',target,permissionProfile:'read-only'},'spoof-grant') as any;
  const spoofAutomation=await runtime.command(caller,'create',{grantId:spoofGrant.id,schedule:{kind:'cron',expression:'0 0 1 1 *',timezone:'UTC'}},'spoof-automation') as any;
  const spoofKey=automationRunKey(spoofAutomation.id,1,'future');
  collaboration.sendConversation(context,{reference:{serverId:'server',threadId:'thread'},content:'Ordinary human message',idempotencyKey:spoofKey});
  const spoof=await worker.automation('claim',{id:spoofAutomation.id,revision:1,occurrenceId:'future'},Date.now());
  await worker.automation('settle',{key:spoofKey,state:'unknown'},Date.now());
  assert.equal((await broker.inspectAutomation({...spoof.run,state:'unknown'})).state,'unknown','a same-key human message must not prove an automation run');
  legacyActive=true;
  await assert.rejects(runtime.grant(caller,'create',{serverId:'server',projectId:'project',target,permissionProfile:'read-only'},'legacy-conflict'),{code:'legacy_schedule_conflict'});
  await assert.rejects(runtime.grant(caller,'create',{serverId:'server',projectId:'foreign',target,permissionProfile:'read-only'},'wrong-project'));
});

test('restart unknown reconciles only from inspect proof, without replaying dispatch',async t=>{
  let outcome:'running'|'completed'='running',dispatches=0;
  const f=await fixture(t,{async dispatch(){dispatches++;return {state:'running',result:{nativeId:'retained'}};},async inspect(run){assert.equal((run.result as any).nativeId,'retained');return {state:outcome,result:run.result};}});
  const automation=await f.create();await f.service.tick();await f.flush();await f.restart();
  outcome='completed';
  const proof=await f.service.reconcile(f.caller,automation.id) as any;
  assert.equal(proof.items[0].state,'completed');assert.equal(dispatches,1);
  await assert.rejects(f.service.reconcile({context:{...f.context,actorId:'foreign'}},automation.id));
});

test('grant creation replay returns its immutable receipt after revoke',async t=>{
  const f=await fixture(t);
  await f.service.grant(f.caller,'revoke',{id:f.grant.id},'revoke-key');
  const replay=await f.service.grant(f.caller,'create',{serverId:'server',projectId:'project',target,permissionProfile:'read-only'},'grant-one') as any;
  assert.equal(replay.id,f.grant.id);assert.equal(replay.revokedAt,null);
});

test('resume resets the consecutive failure streak',async t=>{
  const f=await fixture(t,{async dispatch(){return {state:'failed'};}}),automation=await f.create();
  for(let n=0;n<3;n++){await f.service.tick();await f.flush();f.advance(60_000);}
  assert.equal((await f.service.command(f.caller,'show',{id:automation.id}) as any).enabled,false);
  await f.service.command(f.caller,'resume',{id:automation.id},'resume-key');
  await f.service.tick();await f.flush();
  assert.equal((await f.service.command(f.caller,'show',{id:automation.id}) as any).enabled,true);
});

test('live projection renews an unclaimed durable automation input and excludes terminal history',async t=>{
  const f=await fixture(t),automation=await f.create();
  const claim=await f.worker.automation('claim',{id:automation.id,revision:1,occurrenceId:'queued'},f.now());
  const delegation=await f.worker.automation('delegation',{key:claim.run.key,sourceThreadId:'thread'},f.now());
  const queued=await f.worker.automation('enqueue',{key:claim.run.key,id:delegation.id,threadId:'thread'},f.now());
  f.advance(2*3_600_000);
  const projection=await f.worker.automation('projection',{},f.now());assert.equal(projection.length,1);assert.equal(projection[0].valid,true);
  const row=f.owner.database.prepare('SELECT expires_at FROM actor_execution_requests WHERE id=?').get(queued.requestId)!;
  assert.ok(Number(row.expires_at)>f.now());
  await f.worker.automation('settle',{key:claim.run.key,state:'completed'},f.now());
  assert.equal((await f.worker.automation('projection',{},f.now())).length,0);
});
