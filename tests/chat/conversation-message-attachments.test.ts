import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {OpenCraftMessageAttachments,OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS} from '../../apps/opencraft-daemon/src/opencraft-message-attachments';
import {DatabaseSync} from 'node:sqlite';
import {parseMessageAttachmentQuery,projectMessageAttachmentPage} from '@opencraft/appserver-protocol';
const ref={serverId:'server',threadId:'thread'},secret='PRIVATE_LOCATION_AND_URL_NOT_METADATA';
const scope=()=>({ref,actorId:'human',generation:1,expiresAt:Date.now()+3600000});
const attachment=(id:string,name=id)=>({id,name,mimeType:'application/octet-stream',size:3,location:{kind:'host-file' as const,path:'/synthetic/'+secret},payload:secret});
async function fixture(t:test.TestContext){const root=await mkdtemp('/tmp/attachment-metadata-');let store=new OpenCraftMessageAttachments(root);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return{get store(){return store;},reopen(){store.close();store=new OpenCraftMessageAttachments(root);}};}
test('original owner pages recorded Thread metadata and exact client message without file/Native reads',async t=>{
 const f=await fixture(t);for(let n=0;n<30;n++)f.store.record('thread','message-'+String(n).padStart(2,'0'),[attachment('b'),attachment('a')]);
 f.store.record('other','other-message',[attachment('hidden')]);let cursor:string|undefined,all:any[]=[];let pages=0;
 do{const page=await f.store.readMetadata(scope(),{limit:7,...(cursor?{cursor}:{})},()=>{});assert.equal(page.source,'opencraft-message-attachments');assert.equal(page.consistency,'live-pages');assert.ok(page.entries.length<=7);all.push(...page.entries);cursor=page.nextCursor??undefined;pages++;assert.equal(JSON.stringify(page).includes(secret),false);}while(cursor);
 assert.equal(all.length,60);assert.equal(new Set(all.map(e=>e.clientMessageId+':'+e.id)).size,60);assert.equal(pages,9);assert.ok(all.every(e=>e.contentAvailable==='unknown'&&e.declaredSize===3));
 const one=await f.store.readMetadata(scope(),{clientMessageId:'message-00'},()=>{});assert.deepEqual(one.entries.map(e=>e.id),['a','b']);assert.equal(one.entries[0]!.clientMessageId,'message-00');
 assert.deepEqual((await f.store.readMetadata(scope(),{clientMessageId:'native-item-not-a-client-id'},()=>{})).entries,[]);
 assert.deepEqual((await f.store.readMetadata({...scope(),ref:{...ref,threadId:'empty'}},{},()=>{})).entries,[]);
});
test('authenticated cursor binds query, actor/generation/ref/lifetime and original source owner',async t=>{
 const f=await fixture(t),s=scope();f.store.record('thread','message',[attachment('a'),attachment('b')]);const cursor=(await f.store.readMetadata(s,{limit:1},()=>{})).nextCursor!;
 for(const changed of [{...s,actorId:'peer'},{...s,generation:2},{...s,ref:{...ref,serverId:'other'}},{...s,ref:{...ref,threadId:'other'}}])await assert.rejects(f.store.readMetadata(changed,{limit:1,cursor},()=>{}),{code:'attachment_cursor_invalid'});
 for(const query of [{limit:2,cursor},{limit:1,cursor,clientMessageId:'message'},{limit:1,cursor:cursor.slice(0,-2)+'AA'}])await assert.rejects(f.store.readMetadata(s,query,()=>{}),{code:'attachment_cursor_invalid'});
 const now=Date.now();t.mock.method(Date,'now',()=>now+300001);await assert.rejects(f.store.readMetadata(s,{limit:1,cursor},()=>{}),{code:'attachment_cursor_invalid'});t.mock.restoreAll();
 f.reopen();await assert.rejects(f.store.readMetadata(s,{limit:1,cursor},()=>{}),{code:'attachment_cursor_invalid'});
});
test('rows are live observations, not a frozen revision or exact total',async t=>{
 const f=await fixture(t),s=scope();f.store.record('thread','message',[attachment('b'),attachment('d')]);const first=await f.store.readMetadata(s,{limit:1},()=>{});
 f.store.record('thread','next-message',[attachment('e')]);const second=await f.store.readMetadata(s,{limit:1,cursor:first.nextCursor!},()=>{});assert.equal(second.entries[0]!.id,'d');assert.ok(second.nextCursor);assert.equal('count' in second,false);assert.equal('revision' in second,false);
});
test('corrupt/oversized records and output budget fail explicitly; no skipped successful empty page',async t=>{
 for(const [message,items] of [['empty-id',[attachment('')]],['large',[attachment('large','x'.repeat(9000))]],['invalid',[{...attachment('invalid'),size:-1}]],['bytes',Array.from({length:50},(_,i)=>attachment(String(i),'🙂'.repeat(255)))]] as [string,any[]][]){
  const root=await mkdtemp('/tmp/attachment-invalid-'),store=new OpenCraftMessageAttachments(root);try{store.record('thread',message,items);await assert.rejects(store.readMetadata(scope(),{clientMessageId:message,limit:50},()=>{}),{code:'attachment_metadata_unavailable'});}finally{store.close();await rm(root,{recursive:true,force:true});}
 }
});
test('cancellation and revocation before return never expose a page',async t=>{
 const f=await fixture(t);f.store.record('thread','message',[attachment('a')]);const c=new AbortController();c.abort();await assert.rejects(f.store.readMetadata(scope(),{},()=>{},c.signal));
 let current=true;const promise=f.store.readMetadata(scope(),{},()=>{if(!current)throw Error('revoked');});current=false;await assert.rejects(promise,/revoked/);
 let checks=0;await assert.rejects(f.store.readMetadata({...scope(),expiresAt:Date.now()-1},{},()=>{checks++;}),{code:'attachment_metadata_unavailable'});assert.ok(checks>0);
});
test('queries reject spoof fields and public projection never copies location or arbitrary payload',()=>{
 for(const query of [{actorId:'spoof'},{source:'spoof'},{clientMessageId:'x'.repeat(513)},{cursor:'x'.repeat(4097)},{limit:51},{limit:0}])assert.throws(()=>parseMessageAttachmentQuery(query));
 const entry={clientMessageId:'client-message',id:'a',name:'file',mimeType:'text/plain',declaredSize:1,kind:'object-url',contentAvailable:'unknown',path:secret,url:secret,payload:secret};
 const page=projectMessageAttachmentPage({ref,source:'opencraft-message-attachments',observedAt:Date.now(),consistency:'live-pages',entries:[entry],nextCursor:null,complete:true,body:secret},ref);assert.equal(JSON.stringify(page).includes(secret),false);
});
test('existing primary key supports bounded Thread and message windows without sorting or table scan',()=>{
 const db=new DatabaseSync(':memory:');try{for(const migration of OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS)db.exec(migration.sql);
  for(const sql of ['SELECT ref_json FROM opencraft_message_attachments WHERE thread_id=? ORDER BY client_message_id,attachment_id LIMIT 26','SELECT ref_json FROM opencraft_message_attachments WHERE thread_id=? AND (client_message_id,attachment_id)>(?,?) ORDER BY client_message_id,attachment_id LIMIT 26','SELECT ref_json FROM opencraft_message_attachments WHERE thread_id=? AND client_message_id=? AND attachment_id>? ORDER BY attachment_id LIMIT 26']){
   const args=Array.from({length:(sql.match(/\?/g)||[]).length},()=> 'fixture');const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>String(r.detail)).join(' ');assert.match(plan,/SEARCH.*INDEX/);assert.doesNotMatch(plan,/SCAN|TEMP B-TREE/);
  }
 }finally{db.close();}
});

test('owner deadline expires before reading records and never returns partial success',async t=>{
 const f=await fixture(t);f.store.record('thread','message',[attachment('a')]);let ticks=0;
 t.mock.method(performance,'now',()=>++ticks===1?0:251);
 await assert.rejects(f.store.readMetadata(scope(),{},()=>{}),{code:'attachment_metadata_unavailable'});
});
