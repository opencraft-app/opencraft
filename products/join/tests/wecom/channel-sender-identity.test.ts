import '../../plugins/wecom/assistant-install.mjs';
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../../../packages/access-control/src/actors';
import {Collaboration} from '../../../../packages/access-control/src/collaboration';
import {NativeChannels} from '../../../../packages/access-control/src/native-channels';
import {avatarProfiles} from '../../plugins/tencentoa/src/avatar-profiles.mjs';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'channel-sender-'));
  const storage = await openServerDatabase(dir), actors = new ActorStore(storage), service = new Collaboration(storage, actors);
  const principal = (subject: string) => ({provider:'local', subject, displayName:subject, expiresAt:Date.now()+60000});
  const alice = actors.resolveHuman(principal('alice'))!, bob = actors.resolveHuman(principal('bob'))!, outsider = actors.resolveHuman(principal('outsider'))!;
  const call = (c: typeof alice, method: string, params = {}) => service.communicate(c, 'opencraft/channels/'+method, params);
  const group = await call(alice, 'group/create', {title:'Native group', memberActorIds:[bob.actorId], clientRequestId:'group'});
  const other = await call(alice, 'group/create', {title:'Other corporation', memberActorIds:[bob.actorId], clientRequestId:'other'});
  const source = JSON.stringify(['wecom-customer-service','wxcorp','fwservice','wrgroup']);
  const otherSource = JSON.stringify(['wecom-customer-service','wxother','fwservice','wrgroup']);
  const sync = (method: string, params = {}) => service.synchronizeChannels({method,params:{incarnation:'fixture',...params}});
  await sync('configure', {bindings:[{source,channelId:group.id},{source:otherSource,channelId:other.id}],images:false});
  const ingest = (id: string, raw = 'T123A', label = 'Alice', from = source) => sync('ingest', {
    source:from, arrival:{source:from,id,author:raw,sender:{id:raw,displayName:label},text:'identity message '+id,at:1000,mentioned:false},
  });
  const link = (c = alice, raw = 'T123A') => sync('mirrorLink', {actorId:c.actorId,generation:c.generation,corpId:'wxcorp',userId:raw});
  t.after(async () => {await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
  return {dir,storage,actors,service,principal,alice,bob,outsider,call,group,other,source,otherSource,sync,ingest,link};
}

test('real storage Worker projects each linked human as self only to that human, preserving native authorship and delivery', async t => {
  const f = await fixture(t);
  await f.link();await f.link(f.bob,'T456B');
  const own = await f.ingest('alice'), peer = await f.ingest('bob','T456B','Bob');
  const a = await f.call(f.alice,'messages/list',{channelId:f.group.id}), b = await f.call(f.bob,'messages/list',{channelId:f.group.id});
  assert.deepEqual(a.messages.map((m:any)=>m.sender.isSelf),[true,false]);
  assert.deepEqual(b.messages.map((m:any)=>m.sender.isSelf),[false,true]);
  assert.equal(a.messages[0].sender.kind,'external');assert.equal(a.messages[0].status,'received');
  assert.equal(a.messages[0].sender.id,b.messages[0].sender.id);
  assert.match(a.messages[0].sender.id,/^external:/);assert.equal(a.messages[0].sender.actorKind,undefined);
  const record = () => f.storage.database.prepare('SELECT * FROM actor_messages WHERE id=?').get(own.messageId);
  const original = record();assert.equal(original?.author_id,a.messages[0].sender.id);
  assert.equal((await f.ingest('alice')).messageId,own.messageId,'identity projection cannot break ingest deduplication');
  for (const method of ['messages/list','messages/search','messages/around','sync']) {
    const params = method==='messages/search'?{query:'identity'}:method==='messages/around'?{sequence:a.messages[0].sequence}:{};
    const page = await f.call(f.alice,method,{channelId:f.group.id,...params});
    assert.equal(page.messages.find((m:any)=>m.messageId===own.messageId).sender.isSelf,true,method);
  }
  const search = await f.call(f.alice,'search',{query:'identity'});
  assert.equal(search.matches.find((m:any)=>m.message.messageId===own.messageId).message.sender.isSelf,true);
  assert.deepEqual(record(),original,'reads do not rewrite historical messages');
  await assert.rejects(f.call(f.outsider,'messages/list',{channelId:f.group.id}),/channel_denied/);
  const native = await f.call(f.alice,'messages/send',{channelId:f.group.id,clientMessageId:'native',parts:[{type:'text',text:'native message'}]});
  assert.equal(native.receipt.sender.isSelf,true);assert.equal(native.receipt.sender.kind,'opencraft');
  assert.equal(f.storage.database.prepare('SELECT COUNT(*) AS n FROM actor_channel_outbox').get()?.n,1,'imported self messages never gain an outbound send');
  assert.notEqual(own.messageId,peer.messageId);
});

test('link wakes existing readers and changes their sync scope; unlink fences old auth and refreshes historical self projection', async t => {
  const f = await fixture(t);await f.ingest('historical');
  const before = await f.call(f.alice,'sync',{channelId:f.group.id});assert.equal(before.messages[0].sender.isSelf,false);
  const changes:any[]=[];const stop=f.service.channels.onChange(change=>changes.push(change));t.after(stop);
  let published:string|undefined;
  const stopObserver=f.actors.onIdentityChanged(()=>{
    published=f.actors.findHuman({provider:'wecom.wxcorp',subject:'T123A'})?.id;
    throw Error('observer failure must not undo the committed link');
  });t.after(stopObserver);
  await f.link();assert.equal(published,f.alice.actorId);assert.ok(changes.some(change=>change.channelId===f.group.id));
  const after = await f.call(f.alice,'sync',{channelId:f.group.id,cursor:before.cursor});
  assert.equal(after.kind,'snapshot');assert.notEqual(after.cursor,before.cursor);assert.equal(after.messages[0].sender.isSelf,true);
  assert.equal((await f.call(f.alice,'sync',{channelId:f.group.id,cursor:after.cursor})).kind,'delta');
  changes.length=0;await f.link();assert.equal(changes.length,0,'idempotent link does not notify');
  await assert.rejects(f.link(f.bob),/already belongs/);assert.equal(changes.length,0,'failed link does not notify');
  f.actors.unbindHuman(f.alice,{provider:'wecom.wxcorp',subject:'T123A'});
  assert.ok(changes.some(change=>change.channelId===f.group.id));
  await assert.rejects(f.call(f.alice,'sync',{channelId:f.group.id,cursor:after.cursor}),/authentication|denied/);
  const current = f.actors.resolveHuman(f.principal('alice'))!;
  const revoked = await f.call(current,'sync',{channelId:f.group.id,cursor:after.cursor});
  assert.equal(revoked.kind,'snapshot');assert.equal(revoked.messages[0].sender.isSelf,false);
  await f.link(f.bob);
  assert.equal((await f.call(f.bob,'messages/list',{channelId:f.group.id})).messages[0].sender.isSelf,true);
  assert.equal((await f.call(current,'messages/list',{channelId:f.group.id})).messages[0].sender.isSelf,false);
});

test('same labels, raw IDs in another corporation, unbound robots and directory photos cannot establish self', async t => {
  const f = await fixture(t);await f.link();
  await f.ingest('impostor','T999A','alice');await f.ingest('robot','wbbot','alice');
  await f.ingest('foreign','T123A','alice',f.otherSource);
  avatarProfiles(f.dir).observeDirectory(f.source,'T999A','alice');
  const a=await f.call(f.alice,'messages/list',{channelId:f.group.id});
  assert.deepEqual(a.messages.map((m:any)=>m.sender.isSelf),[false,false]);
  assert.deepEqual(a.messages[0].sender.avatar,{kind:'employee',name:'alice'},'a photo hint is allowed, but is not verified authorship');
  const foreign=await f.call(f.alice,'messages/list',{channelId:f.other.id});assert.equal(foreign.messages[0].sender.isSelf,false);
});

test('native channels accept a generic trusted source resolver, and fail closed without granting group membership', async t => {
  const f=await fixture(t), denied=new Set<string>();
  const channels=new NativeChannels(f.storage.database,f.actors,id=>!denied.has(id));
  const source='fixture/non-wecom-source';
  const group=await f.call(f.alice,'group/create',{title:'Generic source',memberActorIds:[],clientRequestId:'generic-group'});
  await f.sync('configure',{bindings:[{source,channelId:group.id}],images:false});
  // This read seam uses existing archival rows, not a client-selected actor ID.
  const own=await f.ingest('generic','raw','alice',source);
  const realRow=f.storage.database.prepare('SELECT * FROM actor_messages WHERE id=?').get(own.messageId)!;
  assert.equal(channels.message(f.alice,realRow).sender?.isSelf,false);
  channels.humanForExternalSender=subject=>{assert.equal(subject.source,source);return f.alice.actorId;};
  assert.equal(channels.message(f.alice,realRow).sender?.isSelf,true);
  channels.humanForExternalSender=()=>{throw Error('adapter unavailable');};assert.equal(channels.message(f.alice,realRow).sender?.isSelf,false);
  const bot=f.actors.createSession('robot','test');channels.humanForExternalSender=()=>bot.id;
  assert.equal(channels.message(f.alice,realRow).sender?.isSelf,false);
  channels.humanForExternalSender=()=>f.alice.actorId;denied.add(f.alice.actorId);
  assert.equal(channels.message(f.alice,realRow).sender?.isSelf,false);
  denied.clear();f.actors.setEnabled(f.alice.actorId,false,'test');
  assert.equal(channels.message(f.alice,realRow).sender?.isSelf,false);
  channels.humanForExternalSender=()=>f.outsider.actorId;
  assert.equal(channels.isMember(f.group.id,f.outsider.actorId),false);
  assert.throws(()=>channels.history(f.outsider,f.group.id),/channel_denied/);
});
