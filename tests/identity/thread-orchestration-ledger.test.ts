import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openManagedDatabase } from '../../packages/sqlite-node/src/index';
import { COLLABORATION_MIGRATIONS } from '../../packages/access-control/src/collaboration';
import { ThreadOrchestrationLedger, type ThreadRelation } from '../../packages/access-control/src/orchestration-ledger';

function fixture(t: any) {
  const root=mkdtempSync(join(tmpdir(),'orchestration-')), path=join(root,'actor-collaboration.sqlite');
  let clock=1000, db=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}).database;
  let ledger=new ThreadOrchestrationLedger(db,()=>clock);
  t.after(()=>{ db.close();rmSync(root,{recursive:true,force:true}); });
  return {path, get db(){return db;},get ledger(){return ledger;}, at(value:number){clock=value;}, restart(){db.close();db=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}).database;ledger=new ThreadOrchestrationLedger(db,()=>clock);} };
}
const relation=(threadId:string,parentThreadId:string|null=null):ThreadRelation=>({threadId,serverId:'server',driverKind:'codex',ownerActorId:'human://local/a',
  parentThreadId,lifecycleOwnerThreadId:parentThreadId,forkedFromId:null,visibility:'visible',engineHostGeneration:'generation-1',nativeSessionId:threadId,
  runtimeStatus:'active',rootTurnId:'root',turnId:'root',delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:false,userInputExcerpt:null});
const invocation={toolCallKey:'parent:turn:call',delegationId:'delegation',issuerActorId:'human://local/a',kind:'spawn',senderThreadId:'parent',targetThreadId:null,
  clientMessageId:null,mode:'start',arguments:{prompt:'Review the change'}};
const notice=(childThreadId:string)=>({parentThreadId:'parent',childThreadId,childRootTurnId:'root',outcomeKind:'completed' as const,hasDirectUserInput:false,userInputExcerpt:null,summary:{text:'Done'}});

test('v2 upgrade preserves existing communication, delegations and migration checksums',t=>{
  const root=mkdtempSync(join(tmpdir(),'orchestration-v2-')),path=join(root,'collaboration.sqlite');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const before=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS.slice(0,2)}).database;
  before.exec("INSERT INTO actor_messages(id,seq,channel_id,author_id,target_id,content,created_at) VALUES('m',1,'dm','a','b','preserve me',123)");
  before.exec("INSERT INTO conversation_authorities VALUES('delegation','thread','turn','input','human',1,NULL,999999,100)");
  const history=before.prepare('SELECT * FROM schema_migrations ORDER BY version').all();before.close();
  const after=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}).database;
  assert.equal(after.prepare("SELECT content FROM actor_messages WHERE id='m'").get()?.content,'preserve me');
  assert.equal(after.prepare("SELECT actor_id FROM conversation_authorities WHERE id='delegation'").get()?.actor_id,'human');
  assert.deepEqual(after.prepare('SELECT * FROM schema_migrations WHERE version<3 ORDER BY version').all(),history);
  assert.equal(after.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v,3);after.close();
  const corrupt=new DatabaseSync(path);corrupt.exec("UPDATE schema_migrations SET checksum='drift' WHERE version=3");corrupt.close();
  assert.throws(()=>openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}));
  const read=new DatabaseSync(path,{readOnly:true});assert.equal(read.prepare("SELECT content FROM actor_messages WHERE id='m'").get()?.content,'preserve me');read.close();
});

test('topology, lifecycle owner, recovery projection and direct human input survive gateway restart',t=>{
  const f=fixture(t);f.ledger.createThread(relation('parent'));f.ledger.createThread(relation('child','parent'));
  f.ledger.runtime('child',{runtimeStatus:'recovering',rootTurnId:'root',turnId:'continuation'});
  f.ledger.directUserInput('child','New user instructions');f.restart();
  assert.deepEqual(f.ledger.relation('child'),{...relation('child','parent'),runtimeStatus:'recovering',turnId:'continuation',hasDirectUserInput:true,userInputExcerpt:'New user instructions'});
  assert.throws(()=>f.ledger.createThread({...relation('child','parent'),ownerActorId:'human://local/b'}));
  assert.throws(()=>f.ledger.createThread(relation('self','self')));
  assert.equal(f.ledger.relation('child')?.ownerActorId,'human://local/a');
  f.ledger.runtime('child',{runtimeStatus:'active',rootTurnId:'new-root',turnId:'new-root'});
  assert.equal(f.ledger.relation('child')?.hasDirectUserInput,false);
  assert.equal(f.ledger.relation('child')?.userInputExcerpt,null);
  f.ledger.createThread({...relation('life-one'),lifecycleOwnerThreadId:'life-two'});
  assert.throws(()=>f.ledger.createThread({...relation('life-two'),lifecycleOwnerThreadId:'life-one'}));
});

test('gateway restart before and after a tool receipt returns the same operation and immutable result',t=>{
  const f=fixture(t),accepted=f.ledger.accept(invocation);f.restart();
  assert.equal(f.ledger.accept(invocation).operationId,accepted.operationId);
  assert.equal(f.ledger.pendingOperations().length,1);
  f.ledger.finish(invocation.toolCallKey,{threadId:'child',status:'starting'},'completed','child','input');f.restart();
  assert.deepEqual(f.ledger.accept(invocation).result,{threadId:'child',status:'starting'});
  assert.equal(f.ledger.pendingOperations().length,0);
  assert.throws(()=>f.ledger.accept({...invocation,arguments:{prompt:'Changed'}}));
  assert.throws(()=>f.ledger.accept({...invocation,issuerActorId:'human://local/other'}));
  assert.throws(()=>f.ledger.finish(invocation.toolCallKey,{threadId:'duplicate'}));
});

test('explicit idempotency keys have source scope and reject conflicting aliases',t=>{
  const f=fixture(t),first=f.ledger.accept({...invocation,idempotencyKey:'key',arguments:{x:1,y:2}});
  const replay=f.ledger.accept({...invocation,toolCallKey:'parent:turn:second',idempotencyKey:'key',arguments:{y:2,x:1}});
  assert.equal(replay.operationId,first.operationId);
  f.restart();
  assert.equal(f.ledger.operation('parent:turn:second')?.operationId,first.operationId);
  f.ledger.finish('parent:turn:second',{threadId:'child'});
  assert.deepEqual(f.ledger.operation(invocation.toolCallKey)?.result,{threadId:'child'});
  assert.throws(()=>f.ledger.accept({...invocation,toolCallKey:'parent:turn:second',arguments:{different:true}}));
  assert.throws(()=>f.ledger.accept({...invocation,idempotencyKey:'different',arguments:{x:1,y:2}}));
  assert.notEqual(f.ledger.accept({...invocation,toolCallKey:'other:turn:call',senderThreadId:'other',idempotencyKey:'key'}).operationId,first.operationId);
  assert.throws(()=>f.ledger.accept({...invocation,idempotencyKey:'key',arguments:{x:3}}));
});

test('a failed control transaction rolls back both topology and tool intent',t=>{
  const f=fixture(t);
  assert.throws(()=>f.ledger.transaction(()=>{f.ledger.createThread(relation('child'));f.ledger.accept(invocation);throw Error('failure');}));
  f.restart();assert.equal(f.ledger.relation('child'),null);assert.equal(f.ledger.operation(invocation.toolCallKey),null);
});

test('persistent wait subscriptions survive restart and expire without restarting the polling call',t=>{
  const f=fixture(t),wait={waitTicketId:'wait',callerThreadId:'parent',callerTurnId:'turn',targetThreadIds:['one','two'],waitFor:'all_settled' as const,expiresAtMs:20_000};
  f.ledger.createWait(wait);f.restart();
  assert.deepEqual(f.ledger.activeWaits(),[{...wait,state:'active'}]);
  assert.throws(()=>f.ledger.createWait({...wait,targetThreadIds:['another']}));
  f.ledger.settleWait('wait','satisfied');f.restart();assert.equal(f.ledger.activeWaits().length,0);assert.equal(f.ledger.wait('wait')?.state,'satisfied');
  f.ledger.createWait({...wait,waitTicketId:'expired'});f.at(20_000);assert.equal(f.ledger.activeWaits().length,0);assert.equal(f.ledger.wait('expired')?.state,'expired');
});

test('notifications debounce for two seconds, cap at five seconds and do not redeliver after restart',t=>{
  const f=fixture(t),first=f.ledger.queueNotification(notice('one'));f.restart();
  assert.equal(f.ledger.queueNotification(notice('one')).batchId,first.batchId);
  f.at(2500);f.ledger.queueNotification(notice('two'));f.at(3100);assert.equal(f.ledger.dueNotifications().length,0);
  f.at(4400);f.ledger.queueNotification(notice('three'));f.at(5900);assert.equal(f.ledger.dueNotifications().length,0);
  f.at(6000);f.restart();const due=f.ledger.dueNotifications();assert.equal(due.length,3);assert.ok(due.every(n=>n.maxDeadlineMs===6000));
  f.ledger.markNotificationsDelivered(due.map(n=>n.batchId),'notice-input');f.restart();
  assert.equal(f.ledger.dueNotifications().length,0);assert.equal(f.ledger.queueNotification(notice('one')).batchId,first.batchId);
  assert.equal(f.ledger.dueNotifications().length,0);
});
