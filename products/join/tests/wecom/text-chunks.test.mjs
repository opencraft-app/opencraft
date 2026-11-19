import test from'node:test';import assert from'node:assert/strict';
import{utf8Chunks}from'../../plugins/wecom/text-chunks.mjs';
import{createWeComChannelTransport}from'../../plugins/wecom/channel-transport.mjs';
import{MirrorService}from'../../plugins/wecom/mirror/service.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
test('UTF8 frames preserve all Chinese, emoji and markdown, never splitting a surrogate pair',()=>{
 const text=('# 说明\n中文🧪👨‍👩‍👧‍👦\\n```js\n const a=1;\n```\n').repeat(1000),chunks=utf8Chunks(text);assert.equal(chunks.join(''),text);assert.ok(chunks.every(c=>c.isWellFormed()&&Buffer.byteLength(c)<=3000));assert.throws(()=>utf8Chunks('\ud800'));assert.throws(()=>utf8Chunks('x',1));
});
test('stream refusal uses byte-safe fallback even for old 3500-character queued content; uncertainty stops further sends',async()=>{
 let sends=[],uncertain=false;const t=createWeComChannelTransport({corpId:'wxfixture',corpSecret:'fixture',serviceId:'fwfixture',token:'fixture',relayIngress:true,aesKey:Buffer.alloc(32,1).toString('base64').replace(/=$/,''),fetcher:async(url,init)=>{if(url.pathname.endsWith('gettoken'))return Response.json({errcode:0,access_token:'token',expires_in:3600});const body=JSON.parse(init.body);sends.push(body);if(uncertain&&sends.length===2)throw Error('unknown send');return Response.json({errcode:0});}});
 const service=new MirrorService({corpId:'wxfixture',servers:[],store:{claimStream:async()=>true},transport:{subscribe:()=>()=>{},respond:async()=>780011,send:t.send,sendMarkdown:t.sendMarkdown}}),text='中🧪'.repeat(2000),author='主人的助理';
 assert.equal(await service.reply({source,requestId:'old',replyTo:'expired',text,author},AbortSignal.timeout(2000)),'delivered');
 assert.equal(sends.map(s=>s.markdown.content.slice(('**💬 '+author+'**\n\n').length)).join(''),text);assert.ok(sends.every(s=>s.msgtype==='markdown'&&s.markdown.content.startsWith('**💬 '+author+'**\n\n')&&Buffer.byteLength(s.markdown.content)<=4096));
 sends=[];uncertain=true;await assert.rejects(service.reply({source,requestId:'unknown',replyTo:'expired',text,author},AbortSignal.timeout(2000)),/unknown send/);assert.equal(sends.length,2);
});
