import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {storeInboundFile,materializeInboundFiles,readGroupFile,inboundFileId} from '../../plugins/wecom/inbound-files.mjs';
import {stageGroupFileChunk,stageGroupFile,dropGroupFile} from '../../plugins/wecom/outbound-files.mjs';
import {createInboundJournal} from '../../plugins/wecom/mirror/inbound-journal.mjs';
import {createMirrorTarget} from '../../plugins/wecom/mirror/target.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
function fixture(t) {
 const dir=fs.mkdtempSync(join(os.tmpdir(),'wecom-reliability-'));
 process.env.OPENCRAFT_DATA_DIR=dir;process.env.OPENCRAFT_WORKSPACE_DIR=dir+'-ws';
 t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(dir+'-ws',{recursive:true,force:true});});
 return {dir,root:join(dir,'files'),originals:join(dir,'originals')};
}
const wait=async condition=>{const deadline=Date.now()+6000;while(!condition()){if(Date.now()>deadline)throw Error('condition timeout');await new Promise(r=>setTimeout(r,20));}};
test('pasting a known file id into another group grants no access, including old copied materials',async t=>{
 const {dir,root,originals}=fixture(t),id=inboundFileId('secret',source,'private');
 await storeInboundFile(id,'secret.txt',async()=>Buffer.from('PRIVATE-A'),{source,root,originals});
 const a=join(dir,'a'),b=join(dir,'b'),other=source.replace('room','other');
 await materializeInboundFiles('资料编号 '+id,a,{source,root});assert.equal(fs.readFileSync(readGroupFile(a,id,undefined,{source}).original,'utf8'),'PRIVATE-A');assert.throws(()=>readGroupFile(a,id,'1',{source}),/共 0 段/u);
 fs.mkdirSync(join(b,id),{recursive:true});fs.writeFileSync(join(b,id,'README.md'),'old leaked cache');fs.writeFileSync(join(b,id,'part1.txt'),'PRIVATE-A');fs.writeFileSync(join(b,id,'image.bin'),'old preview');
 assert.throws(()=>readGroupFile(b,id,'1',{source:other}),/不属于本群/u);
 assert.deepEqual(await materializeInboundFiles('资料编号 '+id,b,{source:other,root,waitMs:0}),[]);
 assert.equal(fs.existsSync(join(b,id)),false);assert.throws(()=>readGroupFile(b,id,'1',{source:other}),/不属于本群/u);
 await assert.rejects(storeInboundFile(id,'secret.txt',async()=>Buffer.from('changed'),{source:other,root,originals}),/source conflict/u);
 const legacy='f'+'b'.repeat(32);fs.mkdirSync(join(root,legacy));fs.writeFileSync(join(root,legacy,'meta.json'),JSON.stringify({name:'legacy.txt',status:'ready',parts:1}));fs.writeFileSync(join(root,legacy,'part1.txt'),'legacy private data');
 assert.deepEqual(await materializeInboundFiles('资料编号 '+legacy,b,{source:other,root,waitMs:0}),[]);
});
test('temporary file failure can recover and refresh an already-materialized failure notice',async t=>{
 const {dir,root,originals}=fixture(t),id='f'+'c'.repeat(32),folder=join(dir,'materials');let downloads=0;
 await storeInboundFile(id,'report.txt',async()=>{downloads++;throw Error('temporary');},{source,root,originals});
 await materializeInboundFiles('资料编号 '+id,folder,{source,root,waitMs:0});assert.equal(readGroupFile(folder,id,undefined,{source}).parts,0);
 const meta=await storeInboundFile(id,'report.txt',async()=>{downloads++;return Buffer.from('RECOVERED');},{source,root,originals});assert.equal(meta.status,'original_only');assert.equal(downloads,2);
 await materializeInboundFiles('资料编号 '+id,folder,{source,root,waitMs:0});assert.equal(fs.readFileSync(readGroupFile(folder,id,undefined,{source}).original,'utf8'),'RECOVERED');assert.throws(()=>readGroupFile(folder,id,'1',{source}),/共 0 段/u);
});
test('derived admission and raw identity survive a journal restart; changed raw messages are rejected',async t=>{
 const {dir}=fixture(t),root=join(dir,'journal'),raw={source,id:'voice',text:'[语音]',at:1,voice:{mediaId:'m',format:'amr'}};
 let builds=0;const first=createInboundJournal('one',{root});await first.prepare(raw,async()=>{builds++;return {event:{source,id:'voice',text:'frozen transcript'}};});
 const second=createInboundJournal('one',{root});const row=await second.prepare({...raw},async()=>{builds++;throw Error('must not transcribe again');});assert.equal(row.event.text,'frozen transcript');assert.equal(builds,1);
 await assert.rejects(second.prepare({...raw,text:'changed'},async()=>({})),/raw_idempotency_conflict/u);
 const image={source,id:'image',at:1,text:'',mediaId:'old-reference',mediaIdentity:'provider-image'};
 await first.prepare(image,async()=>({event:image}));await second.prepare({...image,mediaId:'new-reference'},()=>{throw Error('immutable image identity should dedupe');});
});
test('ACKed file download resumes after shutdown without a Relay redelivery',async t=>{
 const {dir}=fixture(t),credential='c'.repeat(43),config={relayOrigin:'https://relay.example/',serverId:'one',credential,corpId:'wxfixture'};
 let pending=true,fetches=0,admissions=0;const event={source,id:'file-stop',author:'WA',text:'[文件] report.txt',at:1,file:{mediaId:'media',name:'report.txt'}};
 const fetcher=async(url,options)=>{
  const action=String(url).split('/').pop();
  if(action==='link-poll')return Response.json({links:[]});
  if(action==='poll')return Response.json({deliveries:pending?[{binding:{serverId:'one',source},event,token:'t'}]:[]});
  if(action==='ack')pending=false;
  if(action==='file'){
   fetches++;
   if(fetches===1)return new Promise((_,reject)=>{if(options.signal.aborted)reject(Error('stopped'));else options.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true});});
   return new Response('RESUMED');
  }
  return Response.json({});
 };
 const collab={synchronizeChannels:async()=>[]};
 const first=await createMirrorTarget(config,{collaboration:collab},fetcher);first.subscribe(async()=>{admissions++;const ref=inboundFileId(credential,source,event.id);assert.equal(JSON.parse(fs.readFileSync(join(dir,'join-wecom-inbound-files',ref,'source.json'))).source,source,'reserve source before native admission and ACK');return {messageId:'native'};});await wait(()=>fetches===1);await first.close();assert.equal(pending,false);
 const second=await createMirrorTarget(config,{collaboration:collab},fetcher);second.subscribe(async()=>{throw Error('must not require redelivery');});
 const id=inboundFileId(credential,source,event.id),meta=join(dir,'join-wecom-inbound-files',id,'meta.json');
 try {await wait(()=>fs.existsSync(meta)&&JSON.parse(fs.readFileSync(meta)).status==='original_only');assert.equal(fetches,2);assert.equal(admissions,1);assert.equal(fs.readFileSync(JSON.parse(fs.readFileSync(meta)).original,'utf8'),'RESUMED');assert.equal(fs.existsSync(join(dir,'join-wecom-inbound-files',id,'part1.txt')),false);}finally{await second.close();}
});
test('temporary background download failure is retried automatically without another user message',async t=>{
 const {dir}=fixture(t),credential='d'.repeat(43),config={relayOrigin:'https://relay.example/',serverId:'one',credential,corpId:'wxfixture'};let pending=true,fetches=0;
 const event={source,id:'file-network',author:'WA',text:'[文件] report.txt',at:1,file:{mediaId:'media',name:'report.txt'}};
 const fetcher=async url=>{const action=String(url).split('/').pop();if(action==='link-poll')return Response.json({links:[]});if(action==='poll')return Response.json({deliveries:pending?[{binding:{serverId:'one',source},event,token:'t'}]:[]});if(action==='ack')pending=false;if(action==='file')return ++fetches===1?new Response('retry',{status:503}):new Response('RECOVERED');return Response.json({});};
 const target=await createMirrorTarget(config,{collaboration:{synchronizeChannels:async()=>[]}},fetcher);target.subscribe(async()=>({messageId:'native'}));
 const id=inboundFileId(credential,source,event.id),meta=join(dir,'join-wecom-inbound-files',id,'meta.json');try{await wait(()=>fs.existsSync(meta)&&JSON.parse(fs.readFileSync(meta)).status==='original_only');assert.equal(fetches,2);}finally{await target.close();}
});
test('more than 256 successfully sent files free their chunks and preserve exact replay receipts',t=>{
 const {dir}=fixture(t);
 for(let n=0;n<300;n++){
  const uploadId='upload-'+n,messageId='message-'+n,bytes=stageGroupFileChunk(uploadId,'report.txt',Buffer.from('OK'),0,2);
  stageGroupFile(messageId,'report.txt',bytes,{uploadId});dropGroupFile(messageId);
 }
 const root=join(dir,'join-wecom-outbound-files');assert.equal(fs.readdirSync(join(root,'uploads')).length,0);
 assert.equal(fs.readdirSync(join(root,'receipts')).length,300);
 assert.deepEqual(stageGroupFileChunk('upload-0','report.txt',Buffer.from('OK'),0,2),{deliveredMessageId:'message-0'});
 assert.throws(()=>stageGroupFileChunk('upload-0','report.txt',Buffer.from('NO'),0,2),/changed/u);
 assert.throws(()=>stageGroupFileChunk('upload-0','other.txt',Buffer.from('OK'),0,2),/changed/u);
 // Pre-upgrade completed leftovers must not exhaust the limit immediately after upgrade.
 for(let n=0;n<256;n++){fs.writeFileSync(join(root,'uploads','legacy-'+n+'.json'),JSON.stringify({name:'old.txt',size:1}));fs.writeFileSync(join(root,'uploads','legacy-'+n+'.bin'),'x');}
 assert.deepEqual(stageGroupFileChunk('new-after-upgrade','report.txt',Buffer.from('OK'),0,2),Buffer.from('OK'));
});
test('a forwarded file that failed during first admission recovers after ACK without changing the frozen text',async t=>{
 const {dir}=fixture(t),credential='f'.repeat(43),config={relayOrigin:'https://relay.example/',serverId:'one',credential,corpId:'wxfixture'};let pending=true,fetches=0;const texts=[];
 const event={source,id:'nested-network',author:'WA',text:'转发文件',at:1,nestedMedia:[{type:'file',path:'1',name:'report.txt',mediaId:'nested-media'}]};
 const fetcher=async url=>{const action=String(url).split('/').pop();if(action==='link-poll')return Response.json({links:[]});if(action==='poll')return Response.json({deliveries:pending?[{binding:{serverId:'one',source},event,token:'t'}]:[]});if(action==='ack')pending=false;if(action==='file')return ++fetches===1?new Response('retry',{status:503}):new Response('NESTED RECOVERED');return Response.json({});};
 const target=await createMirrorTarget(config,{collaboration:{synchronizeChannels:async()=>[]}},fetcher);target.subscribe(async e=>{texts.push(e.text);return {messageId:'native'};});const id=inboundFileId(credential,source,event.id+':nested:0'),meta=join(dir,'join-wecom-inbound-files',id,'meta.json');
 try{await wait(()=>fs.existsSync(meta)&&JSON.parse(fs.readFileSync(meta)).status==='original_only');assert.equal(fetches,2);assert.equal(texts.length,1);assert.ok(texts[0].includes('资料编号 '+id));}finally{await target.close();}
});
test('forwarded originals survive gateway enrichment as scoped agent materials and native structure, not a truncated preview',async t=>{
 const {dir}=fixture(t),credential='g'.repeat(43),config={relayOrigin:'https://relay.example/',serverId:'one',credential,corpId:'wxfixture'};let pending=true,accepted;
 const record={version:1,title:'讨论',entries:[{path:'1',sender:{id:'WA',name:'张三'},parts:[{kind:'text',text:'**原始正文**\n'.repeat(3000)},{kind:'file',name:'报告.pdf',resource:'1.2'}]}]},event={source,id:'structured-record',author:'WA',text:'[聊天记录] 讨论\n'+('长预览'.repeat(6000)),at:1,forwardedRecord:record,nestedMedia:[{type:'file',path:'1.2',name:'报告.pdf',mediaId:'nested-media'}]};
 const fetcher=async url=>{const action=String(url).split('/').pop();if(action==='link-poll')return Response.json({links:[]});if(action==='poll')return Response.json({deliveries:pending?[{binding:{serverId:'one',source},event,token:'t'}]:[]});if(action==='ack')pending=false;if(action==='file')return new Response('PDF RAW');return Response.json({});};
 const target=await createMirrorTarget(config,{collaboration:{synchronizeChannels:async()=>[]}},fetcher);t.after(()=>target.close());target.subscribe(async value=>{accepted=value;return{messageId:'native'};});await wait(()=>!pending);
 const id=inboundFileId(credential,source,event.id+':chat-record'),meta=JSON.parse(fs.readFileSync(join(dir,'join-wecom-inbound-files',id,'meta.json'))),saved=JSON.parse(fs.readFileSync(meta.original));
 assert.equal(meta.source,source);assert.equal(saved.entries[0].parts[0].text,record.entries[0].parts[0].text);assert.deepEqual(saved,accepted.forwardedRecord);assert.deepEqual(saved.resources,[{path:'1.2',id:inboundFileId(credential,source,event.id+':nested:0')}]);assert.ok(accepted.text.includes('资料编号 '+id));assert.ok(accepted.text.length<16384);assert.ok(accepted.text.includes('预览已截短'));
});
