import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '@opencraft/access-control/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {groupCreateOptions,groupCreateOptionValues,installCommunicationExtension} from '../../packages/access-control/src/communication-extension';
import {communicationExtension} from '../fixtures/group-create-option-extension.mjs';
installCommunicationExtension(communicationExtension,new URL('../fixtures/group-create-option-extension.mjs',import.meta.url).href);

async function fixture(t:test.TestContext){
  // The IM service needs an execution port to open; this fixture never executes.
  const execution={hostId:'fixture',serverId:'server:fixture',async validate(){throw Error('unexpected execution');},async receipt(){return null;},
    async add(){throw Error('unexpected execution');},async steer(){throw Error('unexpected execution');},async cancel(){return false;}};
  const dir=await mkdtemp(join(tmpdir(),'group-create-options-')),storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors,execution as never);
  t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
  storage.database.exec('CREATE TABLE fixture_group_options(channel_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, options TEXT NOT NULL) STRICT');
  const human=actors.resolveHuman({provider:'local',subject:'fixture',displayName:'Fixture',expiresAt:Date.now()+60000})!;
  // node:sqlite rows have a null prototype; copy them for structural comparison.
  const recorded=(id:string)=>{const row=storage.database.prepare('SELECT actor_id, options FROM fixture_group_options WHERE channel_id=?').get(id);return row&&{...row};};
  const count=(table:string)=>Number(storage.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return {service,human,recorded,count,actors,directory:dir};
}

test('declared options are resolved to explicit booleans for the installation',()=>{
  assert.deepEqual(groupCreateOptions().map(option=>option.id),['linked-group']);
  assert.deepEqual(groupCreateOptionValues(undefined),{'linked-group':false});
  assert.deepEqual(groupCreateOptionValues({'linked-group':true}),{'linked-group':true});
  for(const value of [null,[],'linked-group',{'linked-group':'yes'},{other:true},{['__proto__']:true}])
    assert.equal(groupCreateOptionValues(value),undefined);
});

test('submitted options reach groupCreated inside the creating transaction; omitted options are false',async t=>{
  const f=await fixture(t);
  const linked=await f.service.communicate(f.human,'opencraft/channels/group/create',{title:'Linked',memberActorIds:[],clientRequestId:'linked',options:{'linked-group':true}}) as {id:string};
  assert.deepEqual(f.recorded(linked.id),{actor_id:f.human.actorId,options:JSON.stringify({'linked-group':true})});
  // defaultSelected is presentation only: a client that sends nothing has not opted in.
  const plain=await f.service.communicate(f.human,'opencraft/channels/group/create',{title:'Plain',memberActorIds:[],clientRequestId:'plain'}) as {id:string};
  assert.deepEqual(f.recorded(plain.id),{actor_id:f.human.actorId,options:JSON.stringify({'linked-group':false})});
  const replay=await f.service.communicate(f.human,'opencraft/channels/group/create',{title:'Linked',memberActorIds:[],clientRequestId:'linked',options:{'linked-group':true}}) as {id:string};
  assert.equal(replay.id,linked.id);
  assert.equal(f.count('fixture_group_options'),2,'a replayed request must not run the installation hook again');
});

test('capabilities advertise declared options only to humans with native channels',async t=>{
  const f=await fixture(t);
  const {ImChannelService}=await import('../../apps/headless-server/src/im-channel-service.mjs');
  let context:unknown=f.human;
  const service=await ImChannelService.open([],{dataDirectory:f.directory,actors:f.actors,collaboration:f.service,actorAccess:{authenticate:()=>context}});
  t.after(()=>service.close());
  const capabilities=async()=>{
    let status=0,body='';
    const response={writeHead(code:number){status=code;},end(value?:string){body=value??'';}};
    assert.equal(await service.handle({url:'/__opencraft_im/capabilities',method:'GET',headers:{}} as never,response as never,true),true);
    return {status,body:JSON.parse(body)};
  };
  const granted=await capabilities();
  assert.equal(granted.status,200);
  assert.deepEqual(granted.body.groupCreateOptions,groupCreateOptions());
  context=null;
  const anonymous=await capabilities();
  assert.equal(anonymous.body.nativeChannels,undefined);
  assert.equal(anonymous.body.groupCreateOptions,undefined);
});

test('undeclared or malformed options are rejected before any group exists',async t=>{
  const f=await fixture(t),before=f.count('actor_channels');
  for(const options of [{other:true},{'linked-group':1},['linked-group'],null])
    await assert.rejects(f.service.communicate(f.human,'opencraft/channels/group/create',{title:'Denied',memberActorIds:[],clientRequestId:'denied',options}),/invalid_input/);
  assert.equal(f.count('actor_channels'),before);
  assert.equal(f.count('fixture_group_options'),0);
});
