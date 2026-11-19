import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{importConversationImages}from'../../plugins/wecom/assistant-images.mjs';
const bytes=Buffer.alloc(150000);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);const digest=createHash('sha256').update(bytes).digest('hex');
const ready=(id,sequence)=>({messageId:id,sequence,image:{state:'ready'}});
const chunk=offset=>({type:'image/png',size:bytes.length,sha256:digest,base64:bytes.subarray(offset,offset+65536).toString('base64'),nextOffset:Math.min(bytes.length,offset+65536)});
test('image followed by bare mention imports original bytes as a model attachment, not a history placeholder',async()=>{
 const calls=[],imports=[];const v=await importConversationImages({row:{id:'mention',seq:11},history:{messages:[ready('screenshot',9),{messageId:'text',sequence:10}]},call:async(op,p)=>{calls.push([op,p]);return chunk(p.offset);},store:{importBytes(name,data){imports.push({name,data});return{attachmentId:'attachment'};}}});assert.equal(v.attached[0].messageId,'screenshot');assert.deepEqual(calls.map(c=>c[1].offset),[0,65536,131072]);assert.deepEqual(imports[0].data,bytes);assert.equal(v.attached[0].attachmentId,'attachment');assert.equal(v.unavailable.length,0);
});
test('current message images are included once, newest first, and rejected/changing images never enter attachments',async()=>{
 const imported=[];const v=await importConversationImages({row:{id:'now',seq:12,image:{state:'ready'}},history:{messages:[ready('now',12),ready('stale',10),ready('ok',9)]},limit:2,call:async(op,p)=>p.messageId==='stale'?{...chunk(p.offset),sha256:'f'.repeat(64)}:chunk(p.offset),store:{importBytes(name){imported.push(name);return{attachmentId:name};}}});assert.deepEqual(v.attached.map(x=>x.messageId),['now','ok']);assert.deepEqual(v.unavailable,['stale']);assert.equal(imported.length,2);
});
test('invalid sizes, oversized frames, changing facts and revoked reads fail closed; abort is not swallowed',async()=>{
 for(const get of [()=>null,offset=>({...chunk(offset),size:2097153}),offset=>({...chunk(offset),base64:'a'.repeat(90000)}),offset=>({...chunk(offset),sha256:offset?'f'.repeat(64):digest}),()=>{throw Error('revoked');}]){let imports=0;const v=await importConversationImages({row:{id:'mention',seq:2},history:{messages:[ready('img',1)]},call:async(op,p)=>get(p.offset),store:{importBytes(){imports++;}}});assert.equal(imports,0);assert.deepEqual(v.unavailable,['img']);}
 const ctl=new AbortController();ctl.abort();await assert.rejects(importConversationImages({row:{id:'mention',seq:2},history:{messages:[ready('img',1)]},call:async()=>chunk(0),store:{},signal:ctl.signal}));
});

test('old image is exported as verified original bytes in a private bounded cache, never OCR',async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),{join}=await import('node:path'),{materializeConversationImage}=await import('../../plugins/wecom/assistant-images.mjs');
 const root=fs.mkdtempSync(join(os.tmpdir(),'wecom-image-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const directory=join(root,'scope','images'),calls=[];
 const read=()=>materializeConversationImage({messageId:'historical-id',directory,call:async(op,p)=>{calls.push(op);return op==='image'?chunk(p.offset):{};}});
 const value=await read();assert.deepEqual(fs.readFileSync(value.original),bytes);assert.equal(value.sha256,digest);assert.match(value.contentProcessing,/not OCR/u);assert.equal(fs.statSync(directory).mode&0o077,0);assert.equal(calls.filter(op=>op==='authorize').length,2);
 for(let i=0;i<20;i++)fs.writeFileSync(join(directory,i.toString(16).padStart(64,'0')+'.png'),'cached');await read();assert.equal(fs.readdirSync(directory).length,16);
 fs.chmodSync(directory,0o755);await assert.rejects(read(),/Unsafe/u);fs.chmodSync(directory,0o700);
 const denied=join(root,'denied');await assert.rejects(materializeConversationImage({messageId:'foreign',directory:denied,call:async()=>{throw Error('denied');}}),/denied/u);assert.equal(fs.existsSync(denied),false);
 let revoked=false;await assert.rejects(materializeConversationImage({messageId:'old',directory:join(root,'revoked'),call:async(op,p)=>{if(op==='authorize'){revoked=true;throw Error('revoked');}return chunk(p.offset);}}),/revoked/u);assert.equal(revoked,true);assert.equal(fs.existsSync(join(root,'revoked')),false);
});
