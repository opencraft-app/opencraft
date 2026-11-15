import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActorStore} from '../../packages/access-control/src/actors';
import {ThreadAccessStore, ThreadAccessSession} from '../../packages/access-control/src/thread-access';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {deploymentOperator} from '../../packages/access-control/src/deployment-operator';
import {AgentDriverSession} from '../../apps/opencraft-daemon/src/agent-driver-transport';

async function fixture(t: any, anonymous = true) {
  const root = await mkdtemp(join(tmpdir(), 'anonymous-handoff-'));
  const actors = new ActorStore(join(root,'actors.sqlite'));
  const policy = new ThreadAccessStore(join(root,'policy.sqlite'), actors);
  let spaces = false;
  const operator = deploymentOperator(actors, anonymous, () => !spaces);
  const service = new Collaboration(join(root,'collaboration.sqlite'), actors, {
    hostId:'host', serverId:'server', async validate(){}, async receipt(){return null;},
    async add(){return null;}, async steer(){}, async cancel(){return false;},
    async read(){return {entries:[{role:'user',text:'OLD-THREAD-ONLY-724'}],nextCursor:null};},
  }, Date.now, id => operator.owns(id) ? !!operator.context() : true, undefined,
  (context, ref) => policy.allows(ref.serverId,ref.threadId,operator.owns(context.actorId) ? undefined : context));
  const frames: any[] = [], signed: any[] = [];
  const driver = new AgentDriverSession(service, () => 'server', frame => frames.push(JSON.parse(frame)),
    scope => {signed.push(scope);return 'signed';}, operator.context);
  const access = new ThreadAccessSession(policy, () => 'server', undefined, () => {}, undefined, undefined, undefined, false, () => !!operator.context());
  t.after(async () => {access.close();driver.close();await service.close();policy.close();actors.close();await rm(root,{recursive:true,force:true});});
  const command = (action: string, threadId = 'source', context: any = {sender:null}) => driver.prepare(JSON.stringify({id:1,method:'opencraft/collaboration',params:{action,threadId}}), context);
  return {actors,policy,operator,service,driver,access,frames,signed,command,initializeSpaces(){spaces=true;}};
}

test('anonymous deployment advertises handoff, references shared history and delegates only an admitted execution', async t => {
  const f = await fixture(t);
  await f.access.receive(JSON.stringify({id:1,method:'initialize'}));
  assert.equal(JSON.parse(f.access.project(JSON.stringify({id:1,result:{}}))!).result.capabilities.extensions['opencraft/thread-access'].agentHandoff,true);
  assert.equal(await f.access.receive(JSON.stringify({id:2,method:'thread/start',params:{handoffSource:{threadId:'source'}}})),false);
  f.access.project(JSON.stringify({id:2,result:{thread:{id:'target'}}}));
  assert.equal(f.policy.read('server','target').creatorActorId,null,'browser remains anonymous');
  await f.command('reference');assert.ok(f.frames.at(-1).result.reference);
  const raw = await f.driver.prepare(JSON.stringify({id:3,method:'turn/start',params:{threadId:'target',input:[],__opencraftExecutionCli:'forged'}}),{sender:null});
  const inputId = JSON.parse(raw!).params.clientUserMessageId;
  assert.equal(JSON.parse(raw!).params.__opencraftExecutionCli,'signed');
  assert.equal(f.signed[0].threadId,'target');assert.equal(f.signed[0].execution.inputId,inputId);assert.ok(f.signed[0].execution.executionId);
  assert.throws(() => f.service.delegation('target','forged-turn'),/execution_delegation_required/);
  f.driver.project(JSON.stringify({id:3,result:{turn:{id:'actual-turn'}}}));
  const delegation = f.service.delegation('target','actual-turn');
  const history = await f.service.readConversation(delegation.context,{serverId:'server',threadId:'source'});
  assert.ok(JSON.stringify(history).includes('OLD-THREAD-ONLY-724'));
  assert.throws(() => f.service.delegation('other-thread','actual-turn'),/execution_delegation_required/);
  await f.command('servers');assert.equal(f.frames.at(-1).error.data.code,'actor_authentication_required','anonymous RPC grants only reference');
  f.initializeSpaces();
  assert.throws(() => f.service.delegation('target','actual-turn'),/execution_delegation_revoked/);
  await f.command('reference');assert.equal(f.frames.at(-1).error.data.code,'actor_authentication_required');
});

test('identity deployment anonymous requests cannot borrow operator authority or forge it on the wire', async t => {
  const f = await fixture(t,false);
  assert.equal(await f.access.receive(JSON.stringify({id:1,method:'thread/start',params:{handoffSource:{threadId:'source'},anonymousOperator:true}})),true);
  await f.command('reference');assert.equal(f.frames.at(-1).error.data.code,'actor_authentication_required');
  const result = await f.driver.prepare(JSON.stringify({id:2,method:'turn/start',params:{threadId:'source',input:[],actorContext:{actorId:'operator'},__opencraftExecutionCli:'forged'}}),{sender:null});
  assert.equal(JSON.parse(result!).params.__opencraftExecutionCli,undefined);assert.equal(f.signed.length,0);
});

test('operator never expands anonymous ACL; authenticated private access still follows its actual actor', async t => {
  const f = await fixture(t);
  const human = (subject:string) => f.actors.resolveHuman({provider:'fixture',subject,displayName:subject,expiresAt:Date.now()+60000})!;
  const alice = human('alice'), bob = human('bob');
  f.policy.created('server','private',alice,'private');
  await f.command('reference','private');assert.equal(f.frames.at(-1).error.data.status,403);
  await f.command('reference','private',{sender:null,actorContext:bob});assert.equal(f.frames.at(-1).error.data.status,403);
  await f.command('reference','private',{sender:null,actorContext:alice});assert.ok(f.frames.at(-1).result.reference);
  assert.equal(await f.access.receive(JSON.stringify({id:1,method:'thread/start',params:{handoffSource:{threadId:'private'}}})),true);
});

test('server restart and enabling identity fence all prior operator delegations', async t => {
  const f = await fixture(t), old = f.operator.context()!;
  f.service.authorizeExecution(old,'target','input');f.service.executionStarted('target','input','turn');
  assert.ok(f.service.delegation('target','turn'));
  const next = deploymentOperator(f.actors,true,()=>true);
  assert.equal(f.actors.isCurrent(old),false);assert.ok(next.context());
  assert.throws(() => f.service.delegation('target','turn'),/execution_delegation_revoked/);
  const current = next.context()!;
  const disabled = deploymentOperator(f.actors,false,()=>true);
  assert.equal(disabled.context(),undefined);assert.equal(f.actors.isCurrent(current),false);
});
