import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SwitchboardStore, switchboardMigrations } from "../../plugins/im/src/store.js";
import { ImPlugin, type ImExecutionPort } from "../../plugins/im/src/server.js";
import { openManagedDatabase } from "@opencraft/sqlite-node";
const ref={serverId:"server",threadId:"thread"};
async function fixture(t:test.TestContext,send:(text:string)=>Promise<void>=async()=>{}){
 const dir=await mkdtemp(join(tmpdir(),"im-tools-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new SwitchboardStore(join(dir,"im.sqlite"));let current=true,results=0,submitted="";
 const execution:ImExecutionPort={human:actorId=>({actorId,generation:1,credentialId:null,expiresAt:Number.MAX_SAFE_INTEGER}),authorize(){if(!current)throw Error("denied");},async create(){return ref;},async validate(){},async submit(_c,_r,_id,text){submitted=text;return "request";},async result(){results++;return "must not send";}};
 const im=new ImPlugin(store,execution,1024,true);im.register({id:"bot",ownerId:"owner",senders:{sender:"human"},groupScope:"chat"});
 im.setDelivery(async(_id,address,text)=>{assert.equal(address.chat,"original");await send(text);});t.after(()=>im.close());
 const receive=(id="message",expiresAt=Date.now()+60_000)=>im.receive("bot",{id,source:{chatId:"original",chatType:"direct",senderId:"sender"},text:"hello",replyAddress:{chat:"original",expiresAt},async accepted(){throw Error("stream feedback must not run");},async reply(){throw Error("auto final must not run");}});
 return {im,store,receive,revoke:()=>{current=false;},results:()=>results,submitted:()=>submitted};
}
test("explicit reply pins target, suppresses final and deduplicates concurrent/repeated sends",async t=>{
 let calls=0,finish!:()=>void;const wait=new Promise<void>(r=>{finish=r;});const f=await fixture(t,async()=>{calls++;await wait;});await f.receive();
 const m=f.store.messages("bot")[0];assert.equal(m.reply_mode,"tool");assert.match(f.submitted(),new RegExp(m.reply_ref!));assert.equal(f.results(),0);
 assert.equal(f.im.replyAvailable(ref),true);assert.equal(f.im.replyAvailable({...ref,threadId:"other"}),false);const args={replyRef:m.reply_ref!,text:"complete answer"};
 await assert.rejects(f.im.reply({...ref,threadId:"other"},args,new AbortController().signal),/denied/);
 await assert.rejects(f.im.reply(ref,{...args,chat:"redirect"},new AbortController().signal),/invalid_message/);
 const first=f.im.reply(ref,args,new AbortController().signal);await assert.rejects(f.im.reply(ref,args,new AbortController().signal),/in progress/);finish();
 const receipt=await first;assert.deepEqual(await f.im.reply(ref,args,new AbortController().signal),receipt);await f.receive();assert.equal(calls,1);assert.equal(f.results(),0);assert.equal(f.store.message(m.id)?.state,"delivered");
 await assert.rejects(f.im.reply(ref,{...args,text:"another"},new AbortController().signal),/different text/);f.revoke();await assert.rejects(f.im.reply(ref,args,new AbortController().signal),/denied/);
});
test("uncertain/expired replies never resend automatically",async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;throw Error("unknown transport");});await f.receive();const m=f.store.messages("bot")[0],args={replyRef:m.reply_ref!,text:"hello"};
 await assert.rejects(f.im.reply(ref,args,new AbortController().signal),/unknown transport/);await f.im.recover(["bot"]);await assert.rejects(f.im.reply(ref,args,new AbortController().signal),/uncertain/);assert.equal(calls,1);
 await f.receive("expired",Date.now()-1);const expired=f.store.messages("bot").find(x=>x.id!==m.id)!;await assert.rejects(f.im.reply(ref,{replyRef:expired.reply_ref,text:"late"},new AbortController().signal),/expired/);f.store.prune();assert.equal(f.store.message(expired.id)?.error,"reply_expired");assert.equal(calls,1);
});
test("v2 upgrade keeps automatic in-flight mode and rejects checksum drift",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"im-tools-upgrade-"));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,"im.sqlite");const old=openManagedDatabase({path,legacyPolicy:"reject",migrations:switchboardMigrations.slice(0,2)});
 old.database.prepare("INSERT INTO im_messages(id,channel_id,fingerprint,actor_id,source,text,route_revision,state,created_at,updated_at) VALUES('old','c','f','a','{}','old',1,'submitted',1,1)").run();old.database.close();
 const store=new SwitchboardStore(path);assert.equal(store.message("old")?.reply_mode,"final");assert.equal(store.outcome.appliedVersion,3);store.close();
 assert.throws(()=>openManagedDatabase({path,legacyPolicy:"reject",migrations:[...switchboardMigrations.slice(0,2),{...switchboardMigrations[2],sql:switchboardMigrations[2].sql+" -- drift"}]}));
});
