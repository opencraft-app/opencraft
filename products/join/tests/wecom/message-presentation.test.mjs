import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {messagePresentation} from '../../plugins/wecom/message-presentation.mjs';
import {wecomAuthorPrefix,wecomAttributedText} from '../../plugins/wecom/message-attribution.mjs';
import {createWeComChannelTransport} from '../../plugins/wecom/channel-transport.mjs';
import {MirrorService} from '../../plugins/wecom/mirror/service.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
const serverId='hub-d00bd6f39112a3c11a62656c397b9515c5a1f2e2';
const metadata=(name,role='human',format='text')=>({version:1,sender:{id:'native-actor',displayName:name,role},format});
function fixture(){
 const sent=[];
 const t=createWeComChannelTransport({corpId:'wxfixture',corpSecret:'fixture',serviceId:'fwfixture',token:'fixture',relayIngress:true,enableImages:true,aesKey:Buffer.alloc(32,1).toString('base64').replace(/=$/,''),fetcher:async(url,init)=>{
  if(url.pathname.endsWith('gettoken'))return Response.json({errcode:0,access_token:'token',expires_in:3600});
  sent.push(JSON.parse(init.body));return Response.json({errcode:0});
 }});
 const svc=new MirrorService({corpId:'wxfixture',servers:[{id:serverId,name:'Join',credential:'x'.repeat(43)}],store:{snapshot:async()=>({binding:{serverId}})},transport:t});
 async function post(input){const res={writeHead(s){this.status=s;},end(body){this.body=JSON.parse(body);}};
  await svc.handle(Object.assign(Readable.from([Buffer.from(JSON.stringify({source,requestId:'native-uuid',...input}))]),{url:'/__opencraft_wecom_mirror/send',method:'POST',headers:{'x-opencraft-mirror-server':serverId,authorization:'Bearer '+'x'.repeat(43)},socket:{encrypted:true}}),res);return res;
 }
 return {svc,t,sent,post};
}

test('screenshot regression: ordinary RUI/MIA messages and Markdown use the same trusted short origin',async()=>{
 const f=fixture();
 for(const text of ['RUI','MIA'])assert.equal((await f.post({author:'skipzhang',text,serverId:'forged',serverName:'forged',origin:{displayName:'forged'}})).body.status,'delivered');
 assert.deepEqual(f.sent.map(m=>[m.msgtype,m.text.content]),[['text','💬 skipzhang · Join\nRUI'],['text','💬 skipzhang · Join\nMIA']]);
 await f.post({author:'管家',text:'**完成**',presentation:metadata('管家','assistant','markdown')});
 assert.equal(f.sent[2].msgtype,'markdown');assert.equal(f.sent[2].markdown.content,'**🤖 管家 · Join**\n\n**完成**');
 assert.equal(f.svc.servers.get(serverId).id,serverId);
});

test('role, body format and stream capability are independent; no name-based classifier',async()=>{
 const f=fixture();
 for(const [author,role,format,replyTo]of [['我的助理','human','text','M1'],['管家','assistant','markdown',undefined],['同事','human','markdown',undefined],['管家','assistant','text','M1']]){
  const r=await f.post({author,text:'**正文**',replyTo,presentation:metadata(author,role,format)});assert.equal(r.body.status,'delivered');
  const icon=role==='assistant'?'🤖':'💬';
  const m=f.sent.at(-1);assert.equal(m.msgtype,format);assert.equal(format==='markdown'?m.markdown.content:m.text.content,format==='markdown'?`**${icon} ${author} · Join**\n\n**正文**`:`${icon} ${author} · Join\n**正文**`);
 }
 await f.post({author:'alice的助理',text:'**只是名字**'});assert.equal(f.sent.at(-1).msgtype,'text');
});

test('old Gateway compatibility uses immutable native assistant IDs, never author suffix or replyTo',async()=>{
 const f=fixture();
 await f.post({author:'管家',text:'**回答**',requestId:'wecom-assistant:'+'a'.repeat(64)});
 assert.equal(f.sent.at(-1).msgtype,'markdown');
 await f.post({author:'任何人的助理',text:'**普通正文**',replyTo:'M1'});assert.equal(f.sent.at(-1).msgtype,'text');
 assert.equal(messagePresentation({author:'同名的助理'}).sender.role,'unknown');
});

test('malformed or contradictory v1 metadata never falls back to name/content guessing',async()=>{
 const f=fixture(),valid=metadata('Alice');
 for(const presentation of [null,{...valid,version:2},{...valid,format:'html'},{...valid,origin:{displayName:'forged'}},{...valid,sender:{...valid.sender,role:'admin'}},{...valid,sender:{...valid.sender,displayName:'Mallory'}},{...valid,sender:{...valid.sender,id:''}}]){
  assert.equal((await f.post({author:'Alice',text:'**不得发出**',presentation})).status,503);
 }
 assert.equal(f.sent.length,0);
});

test('local direct transport consumes the same format metadata without Relay',async()=>{
 const f=fixture();
 await f.t.send({source,requestId:'direct',author:'管家',text:'**完成**',presentation:metadata('管家','assistant','markdown')},AbortSignal.timeout(1000));
 assert.equal(f.sent[0].msgtype,'markdown');assert.equal(f.sent[0].markdown.content,'**🤖 管家**\n\n**完成**');
});

test('all encoders share attribution; short labels never mutate full origins or body offsets',()=>{
 const m={author:'Alice',serverId,text:'Hi @Bob'};
 const prefix=wecomAuthorPrefix(m);assert.equal(prefix,'💬 Alice · hub-d00bd6f3\n');assert.equal(wecomAttributedText(m),prefix+m.text);
 assert.equal(wecomAttributedText(m,true),'**💬 Alice · hub-d00bd6f3**\n\nHi @Bob');
 assert.equal(m.serverId,serverId);assert.equal(m.text.indexOf('@Bob'),3);
 assert.equal(wecomAuthorPrefix({...m,serverName:'Join\n\u202e'}),'💬 Alice · Join\n');
 assert.equal(wecomAuthorPrefix({...m,serverName:serverId}),'💬 Alice · hub-d00bd6f3\n');
 assert.ok(wecomAuthorPrefix({...m,serverName:'中'.repeat(100)}).length<60);
});

test('native image attribution shares the same icon and does not change image delivery',async()=>{
 const f=fixture(),message={source,author:'管家',presentation:metadata('管家','assistant','markdown')};
 assert.equal(await f.t.images.attribute(message,AbortSignal.timeout(1000)),'delivered');
 assert.equal(f.sent[0].msgtype,'text');assert.equal(f.sent[0].text.content,'🤖 管家\n发送了一张图片');
 assert.equal(await f.t.images.send(source,'media-fixture',AbortSignal.timeout(1000)),'delivered');
 assert.deepEqual(f.sent[1].image,{media_id:'media-fixture'});
});
test('long human messages remain literal text; emoji header is counted in every UTF8 frame',async()=>{
 const f=fixture(),text=('**原文** [a](b) 中🧪\n').repeat(600),prefix='💬 同事\n';
 assert.equal(await f.t.send({source,author:'同事',text,presentation:metadata('同事')},AbortSignal.timeout(1000)),'delivered');
 assert.ok(f.sent.length>1);
 assert.ok(f.sent.every(m=>m.msgtype==='text'&&m.text.content.startsWith(prefix)&&Buffer.byteLength(m.text.content)<=5000));
 assert.equal(f.sent.map(m=>m.text.content.slice(prefix.length)).join(''),text);
});
