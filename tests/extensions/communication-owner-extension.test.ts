import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {installCommunicationExtension} from '../../packages/access-control/src/communication-extension';
let calls=0,expected:Collaboration;
installCommunicationExtension({synchronizeOwner(service,command){
  calls++;assert.equal(service,expected);
  if(command.method==='fixture/owner')return {result:command.params.value};
}});
test('trusted owner hook handles null and false without falling through; client RPC cannot select it',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'owner-extension-'));
  const storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors);expected=service;
  t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
  for(const value of [null,false,0])assert.equal(await service.synchronizeChannels({method:'fixture/owner',params:{value}}),value);
  const before=calls;
  const human=actors.resolveHuman({provider:'local',subject:'fixture',displayName:'Fixture',expiresAt:Date.now()+60000})!;
  await assert.rejects(service.communicate(human,'fixture/owner',{value:true}));
  assert.equal(calls,before);
  await assert.rejects(service.synchronizeChannels({method:'fixture/unhandled',params:{}}));
  await service.close();const closedCalls=calls;
  await assert.rejects(service.synchronizeChannels({method:'fixture/owner',params:{value:true}}),/channel_sync_closed/);
  assert.equal(calls,closedCalls);
});
