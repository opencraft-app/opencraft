import assert from 'node:assert/strict';import test from 'node:test';
import{forwardChannelMessage,messageFile,canForwardMessage,copyChannelImage}from'../../plugins/im/src/channel-message-transfer';
import{FORWARDED_RECORD_MIME}from'@opencraft/appserver-protocol';
const message:any={sequence:4,messageId:'m',author:'Other',text:'caption',at:1,status:'received',attachment:{name:'report.pdf',type:'application/pdf',size:3}};
test('forwarding transfers original file bytes and metadata, not source paths or a reference label',async()=>{
 const calls:any[]=[],blob=new Blob([new Uint8Array([9,8,7])],{type:'application/pdf'}),client:any={attachment:async(...p:any[])=>{calls.push(['read',...p.slice(0,2)]);return blob;},sendChannelAttachment:async(...p:any[])=>{calls.push(['send',...p]);return{receipt:{status:'sending'}};}};
 await forwardChannelMessage(client,'source',message,'target','stable',new AbortController().signal);assert.deepEqual(calls[0],['read','source',4]);assert.equal(calls[1][1],'target');assert.equal(calls[1][2],'stable');assert.equal(calls[1][3].name,'report.pdf');assert.deepEqual(new Uint8Array(await calls[1][3].arrayBuffer()),new Uint8Array([9,8,7]));assert.equal(calls[1].length,5);
});
test('text forward does not copy source reply IDs, mentions, or implicit bot wake grants',async()=>{
 const calls:any[]=[],client:any={sendText:async(...p:any[])=>calls.push(p)};await forwardChannelMessage(client,'s',{...message,attachment:undefined,mentions:[{actorId:'secret'}],replyToMessageId:'private'},'t','key',new AbortController().signal);assert.equal(calls[0].length,4);assert.deepEqual(calls[0].slice(0,3),['t','key','caption']);
});
test('access failure or identity cancellation during download cannot hand an attachment to another conversation',async()=>{
 let sent=0;const owner=new AbortController(),client:any={attachment:async()=>{owner.abort();return new Blob(['data']);},sendChannelAttachment:async()=>{sent++;}};await assert.rejects(forwardChannelMessage(client,'s',message,'t','key',owner.signal));assert.equal(sent,0);
});
test('archives with scoped resources cannot be forwarded as a misleading detached JSON file',async()=>{const record={...message,attachment:{...message.attachment,type:FORWARDED_RECORD_MIME}};assert.equal(canForwardMessage(record),false);await assert.rejects(forwardChannelMessage({}as any,'s',record,'t','k',new AbortController().signal),/unavailable/);});
test('files above the existing WeCom 20MB bound fail before destination admission',async()=>{let sent=0;const client:any={attachment:async()=>new Blob([new Uint8Array(20*1024*1024+1)]),sendChannelAttachment:async()=>{sent++;}};await assert.rejects(forwardChannelMessage(client,'s',message,'t','k',new AbortController().signal),/too_large/);assert.equal(sent,0);});

test('image clipboard feature detection keeps the original user-gesture promise and fails truthfully when unsupported',async t=>{
 const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:globalThis});
 const originalClipboardItem=Object.getOwnPropertyDescriptor(globalThis,'ClipboardItem'),originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 t.after(()=>{for(const [key,descriptor] of [['ClipboardItem',originalClipboardItem],['navigator',originalNavigator],['window',originalWindow]] as const){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
 let data:any,loaded=0;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{write:async(items:any[])=>{assert.equal(items.length,1);data=items[0].data;}}}});
 Object.defineProperty(globalThis,'ClipboardItem',{configurable:true,value:class{constructor(readonly data:unknown){}}});
 const png=new Blob(['original-png'],{type:'image/png'}),signal=new AbortController().signal;
 await copyChannelImage(()=>{loaded++;return Promise.resolve(png);},signal);assert.equal(loaded,1);assert.equal(await data['image/png'],png);
 Object.defineProperty(globalThis,'ClipboardItem',{configurable:true,value:undefined});assert.throws(()=>copyChannelImage(()=>Promise.resolve(png),signal),/clipboard_unavailable/);
});
