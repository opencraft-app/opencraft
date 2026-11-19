import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {parsePrincipal} from '../../packages/identity-core/src/index';
import {Collaboration, type ConversationExecutionPort, type ExecutionReceipt} from '../../packages/access-control/src/collaboration';
import {updateExecutionRequest} from '../../packages/access-control/src/execution-request-state';

test('shutdown before native handoff keeps accepted work recoverable, without admitting under a retired owner', async () => {
  const root=await mkdtemp(join(tmpdir(),'bot-handoff-'));
  const storage=await openServerDatabase(root), actors=new ActorStore(storage);
  const human=actors.resolveHuman(parsePrincipal({provider:'local',subject:'owner',displayName:'Owner',expiresAt:Date.now()+60000})!)!;
  const bot=actors.createSession('Assistant',human.actorId);
  for (const action of ['message.send','execution.queue']) actors.setGrant(human.actorId,bot.id,action,true,human.actorId);
  const receipts=new Map<string,ExecutionReceipt>();
  let calls=0;
  const execution:ConversationExecutionPort={hostId:'test',async validate(){}, async receipt(_binding,id){return receipts.get(id)??null;},
    async add(_binding,id,_input,canAdmit){assert.equal(canAdmit?.(),true);calls++;const row={id,state:'queued',targetTurnId:null};receipts.set(id,row);return row;},
    async steer(){assert.fail('steer');},async cancel(){return true;}};
  const reached=Promise.withResolvers<void>(), resume=Promise.withResolvers<void>();
  let service=new Collaboration(storage,actors,execution,Date.now,()=>true,{async updateExecution(value){
    updateExecutionRequest(storage.database,value);
    if(value.state==='transferring'){reached.resolve();await resume.promise;}
  }});
  try {
    await service.bind(bot.id,'thread',0,()=>{});
    const sent=service.send(human,{targetActorId:bot.id,content:'do work',idempotencyKey:'one',execution:{mode:'queue'}});
    const pumping=service.pump();await reached.promise;
    const closing=service.close();resume.resolve();await pumping;await closing;
    assert.equal(calls,0);
    service=new Collaboration(storage,actors,execution);
    assert.equal(service.getRequest(human,sent.requestId!).state,'accepted');
    await service.pump();assert.equal(calls,1);
    assert.equal(service.getRequest(human,sent.requestId!).state,'queued');
  }finally{resume.resolve();await service.close();actors.close();await storage.close();await rm(root,{recursive:true,force:true});}
});
