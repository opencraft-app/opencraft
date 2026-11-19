import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openServerDatabase } from '@opencraft/storage-node/server';
import { ActorStore } from '../../packages/access-control/src/actors';
import { NativeChannels } from '../../packages/access-control/src/native-channels';
import { avatarProfiles, communicationAvatar } from '../../products/join/plugins/tencentoa/src/avatar-profiles.mjs';
import { CHANNEL_AVATAR_PARTICIPANT_LIMIT } from '@opencraft/appserver-protocol';


async function fixture(t: TestContext, permissionProjection = true) {
  const dir = await mkdtemp(join(tmpdir(), 'channel-avatar-'));
  const storage = await openServerDatabase(dir);
  const actors = new ActorStore(storage,Date.now,{permissionProjection});
  const principal = (provider: string, subject: string, displayName = 'alice') => ({ provider, subject, displayName, expiresAt: Date.now() + 60000 });
  const owner = actors.resolveHuman(principal('local', 'owner', 'Owner'))!;
  const alice = actors.resolveHuman(principal('tencentoa', '12345'))!;
  const profiles = avatarProfiles(dir);
  profiles.observePrincipal({...principal('tencentoa','12345'), attributes:{loginName:'alice'}});
  const impostor = actors.resolveHuman(principal('local', 'impostor'))!;
  const denied = new Set<string>();
  const channels = new NativeChannels(storage.database, actors, id => !denied.has(id));
  channels.avatarForSender = (subject,scope) => communicationAvatar({actors,admittedActor:(id:string)=>!denied.has(id)},storage.database,subject,scope);
  const group = channels.createGroup(owner, 'Group', [], 'group');
  let seq = 0;
  const source = JSON.stringify(['wecom-customer-service', 'wxcorp1', 'fwservice', 'wrgroup']);
  function add(actorId: string, label = 'alice', external?: { source: string; subject: string }) {
    const sequence = ++seq, id = 'message-' + sequence;
    const author = external ? 'external:' + createHash('sha256').update(JSON.stringify([external.source, external.subject])).digest('hex') : actorId;
    storage.database.prepare("INSERT INTO actor_messages(id,seq,channel_id,author_id,target_id,content,created_at,target_kind,author_display_name) VALUES(?,?,?,?,?,?,?,'channel',?)")
      .run(id, sequence, group.id, author, group.id, 'message ' + sequence, 1000, label);
    if (external) storage.database.prepare('INSERT INTO actor_channel_external_messages VALUES(?,?,?,?,?)').run(id, external.source, id, author, 'fingerprint');
    return id;
  }
  const history = () => channels.history(owner, group.id).messages;
  t.after(async () => { actors.close(); await storage.close(); await rm(dir, { recursive: true, force: true }); });
  return { actors, owner, alice, impostor, principal, channels, group, add, source, history, storage, denied, profiles };
}

test('only a verified, unique OA login binding lends an employee avatar', async t => {
  const f = await fixture(t);
  f.add(f.alice.actorId);
  f.add(f.impostor.actorId);
  assert.deepEqual(f.history()[0].sender?.avatar, { kind: 'employee', name: 'alice' });
  assert.equal(f.history()[1].sender?.avatar, undefined, 'same local displayName is not an OA identity');
  f.actors.bindHuman(f.alice, f.principal('tencentoa', '99999'));
  f.profiles.observePrincipal({...f.principal('tencentoa','99999'), attributes:{loginName:'someone-else'}});
  assert.equal(f.history()[0].sender?.avatar, undefined, 'ambiguous login keys fail closed');
  f.actors.unbindHuman(f.alice, { provider: 'tencentoa', subject: '99999' });
  assert.deepEqual(f.history()[0].sender?.avatar, { kind: 'employee', name: 'alice' });
  const current = f.actors.resolveHuman(f.principal('tencentoa', '12345'))!;
  f.actors.bindHuman(current, f.principal('local','backup'));
  f.actors.unbindHuman(current, { provider: 'tencentoa', subject: '12345' });
  assert.equal(f.history()[0].sender?.avatar, undefined, 'removing the login key revokes the photo');
});

test('numeric OA subjects do not become photo accounts', async t => {
  const f = await fixture(t);
  const actor = f.actors.resolveHuman(f.principal('tencentoa', '67890'))!;
  f.add(actor.actorId);
  assert.equal(f.history()[0].sender?.avatar, undefined);
});

test('external association uses source and verified binding subject even after label enrichment', async t => {
  const f = await fixture(t);
  f.actors.bindHuman(f.alice, f.principal('wecom.wxcorp1', 'T123456A'));
  f.add('', 'completely-different-provider-label', { source: f.source, subject: 'T123456A' });
  f.add('', 'alice', { source: f.source, subject: 'unbound' });
  f.add('', 'alice', { source: JSON.stringify(['wecom-customer-service', 'wxother', 'fwservice', 'wrgroup']), subject: 'T123456A' });
  const [bound, unbound, otherCorp] = f.history();
  assert.deepEqual(bound.sender?.avatar, { kind: 'employee', name: 'alice' });
  assert.equal(bound.sender?.kind, 'external');
  assert.equal(bound.sender?.isSelf, false);
  assert.equal(bound.sender?.actorKind, undefined);
  assert.equal(bound.sender?.displayName, 'completely-different-provider-label');
  assert.equal(unbound.sender?.avatar, undefined);
  assert.equal(otherCorp.sender?.avatar, undefined);
  assert.deepEqual(f.channels.search(f.owner, f.group.id, 'message').messages[0]?.sender?.avatar, bound.sender?.avatar);
  assert.deepEqual(f.channels.around(f.owner, f.group.id, 1).messages[0].sender?.avatar, bound.sender?.avatar);
  assert.deepEqual(f.channels.searchAll(f.owner, 'message').matches.at(-1)?.message.sender?.avatar, bound.sender?.avatar);
  assert.deepEqual(f.channels.sync(f.owner, f.group.id).messages[0]?.sender?.avatar, bound.sender?.avatar);
  f.actors.unbindHuman(f.alice, { provider: 'wecom.wxcorp1', subject: 'T123456A' });
  assert.equal(f.history()[0].sender?.avatar, undefined, 'old reads cannot retain an unlinked association');
});

test('disabled and unadmitted humans cannot lend avatars and re-enabling is observed on the next read', async t => {
  const f = await fixture(t);
  f.actors.bindHuman(f.alice, f.principal('wecom.wxcorp1', 'T1'));
  f.add(f.alice.actorId);
  f.add('', 'provider label', { source: f.source, subject: 'T1' });
  f.actors.setEnabled(f.alice.actorId, false, f.owner.actorId);
  assert.ok(f.history().every(message => !message.sender?.avatar));
  f.actors.setEnabled(f.alice.actorId, true, f.owner.actorId);
  assert.ok(f.history().every(message => message.sender?.avatar?.name === 'alice'));
  f.denied.add(f.alice.actorId);
  assert.ok(f.history().every(message => !message.sender?.avatar));
});

test('one source binding scan per page and no stale cross-page association cache', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) f.add('', 'provider label', { source: f.source, subject: 'T2' });
  const db = f.storage.database;
  const prepare = db.prepare.bind(db);
  let scans = 0;
  db.prepare = ((sql: string) => {
    if (sql.includes("json_extract(binding,'$[0]')")) scans++;
    return prepare(sql);
  }) as typeof db.prepare;
  assert.ok(f.history().every(message => !message.sender?.avatar));
  assert.equal(scans, 1);
  f.actors.bindHuman(f.alice, f.principal('wecom.wxcorp1', 'T2'));
  assert.ok(f.history().every(message => message.sender?.avatar?.name === 'alice'));
  assert.equal(scans, 2, 'new binding becomes visible on the next page');
  f.channels.avatarForSender = undefined;
  assert.ok(f.history().every(message => !message.sender?.avatar));
  assert.equal(scans, 2, 'the default core does no avatar binding scan');
});

test('avatar adapter failures and malformed values leave channel history available', async t => {
  const f = await fixture(t);
  f.add(f.alice.actorId);
  f.channels.avatarForSender = () => { throw Error('unavailable'); };
  assert.equal(f.history()[0].sender?.avatar, undefined);
  f.channels.avatarForSender = () => ({ kind: 'employee', name: '\ninvalid' });
  assert.equal(f.history()[0].sender?.avatar, undefined);
});

test('members, candidates, directory and empty-chat summaries share verified identity photos, never names', async t => {
  const f=await fixture(t);
  const candidate=f.channels.inviteCandidates(f.owner,'alice',f.group.id);
  assert.deepEqual(candidate.find(p=>p.actorId===f.alice.actorId)?.avatar,{kind:'employee',name:'alice'});
  assert.equal(candidate.find(p=>p.actorId===f.impostor.actorId)?.avatar,undefined);
  assert.deepEqual(f.channels.people(f.owner).people.find(p=>p.actorId===f.alice.actorId)?.avatar,{kind:'employee',name:'alice'});
  f.channels.setMember(f.owner,f.group.id,f.alice.actorId,true);
  assert.deepEqual(f.channels.members(f.owner,f.group.id).find(p=>p.actorId===f.alice.actorId)?.avatar,{kind:'employee',name:'alice'});
  const group=f.channels.get(f.owner,f.group.id);
  assert.deepEqual(group.participants?.find(p=>p.actorId===f.alice.actorId)?.avatar,{kind:'employee',name:'alice'});
  assert.equal(f.history().length,0,'header photo does not require a recent message');
  const dm='dm:'+'d'.repeat(64);f.channels.registerDirect(dm,f.owner.actorId,f.alice.actorId);
  assert.deepEqual(f.channels.get(f.owner,dm).participants,[{actorId:f.alice.actorId,displayName:'alice',actorKind:'human',avatar:{kind:'employee',name:'alice'}}]);
  assert.ok(!f.channels.inviteCandidates(f.owner,'alice',f.group.id).some(p=>p.actorId===f.alice.actorId),'roster photos do not change invite filtering');
  f.actors.bindHuman(f.alice,f.principal('local','backup'));
  f.actors.unbindHuman(f.alice,{provider:'tencentoa',subject:'12345'});
  assert.equal(f.channels.get(f.owner,dm).participants?.[0]?.avatar,undefined);
  assert.equal(f.channels.members(f.owner,f.group.id).find(p=>p.actorId===f.alice.actorId)?.avatar,undefined);
  assert.equal(f.channels.people(f.owner).people.find(p=>p.actorId===f.alice.actorId)?.avatar,undefined);
});

test('group avatar preview is bounded, actor-stable and independent of the latest speaker',async t=>{
  const f=await fixture(t);
  for(let i=0;i<7;i++){
    const principal=f.principal('tencentoa',String(20000+i),'Person '+i);
    const human=f.actors.resolveHuman(principal)!;
    f.profiles.observePrincipal({...principal,attributes:{loginName:'verified-'+i}});
    f.channels.setMember(f.owner,f.group.id,human.actorId,true);
  }
  const first=f.channels.get(f.owner,f.group.id).participants!;
  assert.equal(first.length,CHANNEL_AVATAR_PARTICIPANT_LIMIT);
  assert.deepEqual(first.map(p=>p.actorId),[...first.map(p=>p.actorId)].sort());
  f.add(f.alice.actorId,'A different last speaker');
  assert.deepEqual(f.channels.get(f.owner,f.group.id).participants,first);
  const removed=first.find(p=>p.actorId!==f.owner.actorId)!;
  f.channels.setMember(f.owner,f.group.id,removed.actorId,false);
  assert.equal(f.channels.get(f.owner,f.group.id).participants?.length,CHANNEL_AVATAR_PARTICIPANT_LIMIT);
  assert.ok(!f.channels.get(f.owner,f.group.id).participants?.some(p=>p.actorId===removed.actorId));
  const denied=f.actors.resolveHuman(f.principal('local','outsider','Outsider'))!;
  assert.throws(()=>f.channels.get(denied,f.group.id),/channel_denied/);
  assert.throws(()=>f.channels.members(denied,f.group.id),/channel_denied/);
  assert.throws(()=>f.channels.inviteCandidates(denied,'',f.group.id),/channel_denied/);
});

test('pending trusted OA reservations lend only roster photos, never login, sender identity or new permissions',async t=>{
  const f=await fixture(t,false);
  const actor=f.actors.reserveHuman({binding:{provider:'wecom.wxcorp1',subject:'T-reserved'},loginProvider:'tencentoa',alias:'verified-reservation'});
  f.storage.database.prepare('INSERT INTO actor_channel_members VALUES(?,?,?)').run(f.group.id,actor.id,'reserved-epoch');
  f.storage.database.prepare('UPDATE actors SET display_name=? WHERE id=?').run('spoofed.display',actor.id);
  const photo={kind:'employee',name:'verified-reservation'};
  assert.deepEqual(f.channels.members(f.owner,f.group.id).find(p=>p.actorId===actor.id)?.avatar,photo);
  assert.deepEqual(f.channels.get(f.owner,f.group.id).participants?.find(p=>p.actorId===actor.id)?.avatar,photo);
  assert.ok(!f.channels.inviteCandidates(f.owner,'').some(p=>p.actorId===actor.id));
  assert.ok(!f.channels.people(f.owner).people.some(p=>p.actorId===actor.id));
  f.add(actor.id);assert.equal(f.history().at(-1)?.sender?.avatar,undefined);
  assert.equal(f.actors.get(actor.id)?.enabled,false);assert.deepEqual(f.actors.bindings(actor.id),[]);
  assert.equal(f.channels.memberEpoch(f.group.id,actor.id),null);
  f.storage.database.prepare('DELETE FROM actor_human_reservations WHERE actor_id=?').run(actor.id);
  assert.ok(!f.channels.members(f.owner,f.group.id).some(p=>p.actorId===actor.id),'retired reservations cannot retain roster photos');
});

test('a directory read deduplicates shared avatar lookups but rechecks identities on the next read',async t=>{
  const f=await fixture(t);let calls=0;
  const provider=f.channels.avatarForSender!;f.channels.avatarForSender=(subject,scope)=>{calls++;return provider(subject,scope);};
  f.channels.setMember(f.owner,f.group.id,f.alice.actorId,true);
  const second=f.channels.createGroup(f.owner,'Second',[f.alice.actorId],'second');
  f.channels.list(f.owner);assert.equal(calls,2,'same two humans across groups have one lookup each');
  calls=0;f.channels.list(f.owner);assert.equal(calls,2,'no persistent photo identity cache');
  f.denied.add(f.alice.actorId);
  assert.ok(f.channels.list(f.owner).every(g=>!g.participants?.some(p=>p.actorId===f.alice.actorId)));
  f.channels.avatarForSender=()=>({kind:'employee',name:'\ninvalid'});
  assert.ok(f.channels.get(f.owner,second.id).participants?.every(p=>p.avatar===undefined));
});
