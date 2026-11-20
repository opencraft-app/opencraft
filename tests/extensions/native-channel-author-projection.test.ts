import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {parsePrincipal} from '@opencraft/identity-core';
import {ActorStore} from '../../packages/access-control/src/actors';
import {NativeChannels} from '../../packages/access-control/src/native-channels';

async function fixture(t:test.TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'native-author-'));
  const storage=await openServerDatabase(dir),actors=new ActorStore(storage),denied=new Set<string>();
  const channels=new NativeChannels(storage.database,actors,id=>!denied.has(id));
  const human=(subject:string)=>actors.resolveHuman(parsePrincipal({provider:'local',subject,displayName:subject,expiresAt:Date.now()+60000})!)!;
  const alice=human('Alice'),bob=human('Bob'),outsider=human('Outsider');
  const group=channels.createGroup(alice,'Fixture',[bob.actorId],'group');
  const source='fixture/provider/group';let seq=0;
  function arrive(text:string,label='raw-user') {
    const id='message-'+ ++seq;
    const sender='external:'+createHash('sha256').update(JSON.stringify([source,'raw-user'])).digest('hex');
    storage.database.prepare("INSERT INTO actor_messages(id,seq,channel_id,author_id,target_id,content,created_at,target_kind,author_display_name) VALUES(?,?,?,?,?,?,?,'channel',?)")
      .run(id,seq,group.id,sender,group.id,text,1000,label);
    storage.database.prepare('INSERT INTO actor_channel_external_messages VALUES(?,?,?,?,?)').run(id,source,id,sender,'fingerprint');
    return id;
  }
  t.after(async()=>{actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
  const history=()=>channels.history(bob,group.id).messages;
  return {storage,actors,channels,denied,alice,bob,outsider,group,source,arrive,history};
}

test('trusted generic association projects raw names without rewriting authorship or granting history access',async t=>{
  const f=await fixture(t);f.arrive('raw');
  const original=f.history()[0];
  assert.equal(original.sender.displayName,'raw-user');
  f.channels.humanForExternalSender=subject=>subject.source===f.source?f.alice.actorId:null;
  const projected=f.history()[0];
  assert.equal(projected.sender.displayName,'Alice');
  assert.equal(projected.author,'Alice');
  assert.equal(projected.sender.id,original.sender.id);
  assert.equal(projected.sender.kind,'external');
  assert.equal(projected.sender.isSelf,false);
  assert.equal(f.storage.database.prepare('SELECT author_display_name n FROM actor_messages WHERE id=?').get(projected.messageId)!.n,'raw-user');
  assert.throws(()=>f.channels.history(f.outsider,f.group.id),/channel_denied/);
  f.denied.add(f.alice.actorId);
  assert.equal(f.history()[0].sender.displayName,'raw-user');
  f.denied.clear();
  f.actors.setEnabled(f.alice.actorId,false,f.bob.actorId);
  assert.equal(f.history()[0].sender.displayName,'raw-user');
});

test('resolved labels and missing, unknown or failed associations retain their stored names',async t=>{
  const f=await fixture(t);f.arrive('resolved','Provider label');f.arrive('raw');
  f.channels.humanForExternalSender=()=>f.alice.actorId;
  assert.equal(f.history().find(m=>m.text==='resolved')!.sender.displayName,'Provider label');
  for(const association of [undefined,()=>null,()=> 'missing-actor',()=>{throw Error('unavailable');}]) {
    f.channels.humanForExternalSender=association;
    assert.equal(f.history().find(m=>m.text==='raw')!.sender.displayName,'raw-user');
  }
});
