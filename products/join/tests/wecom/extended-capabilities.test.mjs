import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {randomBytes} from 'node:crypto';
import {parseRichAction,sendRichAction,shortcutEvent} from '../../plugins/wecom/rich-outbound.mjs';
import {senderIdentity} from '../../plugins/wecom/external-identity.mjs';
import {emotionURL,downloadEmotion} from '../../plugins/wecom/emotion-media.mjs';
import {nativePicture} from '../../plugins/wecom/picture-codec.mjs';
import {parseInteractionAction} from '../../plugins/wecom/interaction-actions.mjs';
import {interactionTiming,interactionCSV,tickInteractions} from '../../plugins/wecom/mirror/interaction-lifecycle.mjs';
import {describeMessage,forwardedSenders,nestedMedia} from '../../plugins/wecom/rich-inbound.mjs';
import {resolveNestedMedia} from '../../plugins/wecom/nested-media.mjs';
const node=(name,text='',children=[])=>({name,text,children});

test('deadline/reminder input is explicit, timezone-aware and bounded to provider interaction window',()=>{
 const deadline='2026-11-14T10:00:00Z',now=Date.parse(deadline)-3600000;
 const p=parseInteractionAction('/投票 '+JSON.stringify({title:'午餐',options:['面','饭'],deadline,remindBeforeMinutes:10}));
 assert.equal(interactionTiming(p.definition,now).reminderAt,Date.parse(deadline)-600000);
 assert.throws(()=>interactionTiming(p.definition,Date.parse(deadline)),/24 hours/);
 assert.throws(()=>interactionTiming(p.definition,Date.parse(deadline)-2*86400000),/24 hours/);
 assert.throws(()=>interactionTiming({...p.definition,remindBeforeMinutes:90},now),/future/);
 assert.throws(()=>parseInteractionAction('/投票 {"title":"t","options":["a","b"],"remindBeforeMinutes":10}'));
 assert.throws(()=>parseInteractionAction('/投票 {"title":"t","options":["a","b"],"deadline":"2026-11-14T10:00:00"}'));
});
test('Excel-compatible CSV quotes commas, line breaks and protects formula injection',()=>{
 const card={main_title:{title:'选择'},checkbox:{question_key:'q0',option_list:[{id:'o0',text:'=2+2'}]}};
 const csv=interactionCSV(card,[{actor:'=HYPERLINK("x")',author:'alice',selected:[{questionKey:'q0',optionIds:['o0']}]}]).toString('utf8');
 assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/'=HYPERLINK/u);assert.match(csv,/'=2\+2/u);assert.match(csv,/\r\n/u);
});
test('scheduler only reminds eligible current non-submitters, closes once, and fences retired binding',async()=>{
 const binding={serverId:'one',humanKey:'owner',generation:'g'},seen=new Set(),sent=[],finished=[],card={multi:true,deliveryStatus:'delivered',owner:'owner',task_id:'poll',binding,participants:['alice','bob','gone','wbBot'],main_title:{title:'午餐'},checkbox:{question_key:'q0',option_list:[{id:'o0',text:'面'}]}};
 let current=binding,closed=false,kind='remind';
 const svc={abort:new AbortController(),store:{dueInteractions:async()=>[{source:'s',taskId:'poll',kind,member:kind}],claimOnce:async k=>seen.has(k)?false:(seen.add(k),true),card:async()=>card,snapshot:async()=>({binding:current}),finishInteractionSchedule:async x=>finished.push(x),
 submitCard:async(s,t,a,b,close)=>({answers:[{author:'alice',actor:'alice',choice:'面',selected:[{questionKey:'q0',optionIds:['o0']}]}],closed:(closed||=close),accepted:false}),ingest:async()=>{}},transport:{chatMembers:async()=>['owner','alice','bob','wbBot'],mentionMembers:async(s,ids)=>sent.push(ids),sendMarkdown:async m=>sent.push(m.text)}};
 await tickInteractions(svc,100);await tickInteractions(svc,100);assert.deepEqual(sent,[['bob']]);
 kind='close';await tickInteractions(svc,200);assert.equal(closed,true);assert.match(sent[1],/已结束/u);
 current={...binding,generation:'new'};seen.clear();await tickInteractions(svc,300);assert.equal(sent.length,2);assert.equal(finished.length,3);
});
test('custom buttons persist scoped prompts; clicker uses own identity and stale/foreign clicks cannot run',async()=>{
 const map=new Map(),sent=[],arrivals=[],binding={serverId:'s',humanKey:'o',generation:'g'};
 const svc={abort:new AbortController(),store:{rememberShortcut:async(s,k,a)=>map.set(k,a),shortcut:async(s,k)=>map.get(k),snapshot:async()=>({binding})},transport:{sendRichText:async(s,w)=>{sent.push(w);return 'delivered';},chatMembers:async()=>['owner','bob']},ingest:async e=>{arrivals.push(e);return 'stored';}};
 const input={...parseRichAction('/富文本 {"parts":[{"type":"text","text":"部署通过"},{"type":"link","title":"日志","url":"https://example.com/log"},{"type":"button","title":"重查","prompt":"查询我的部署"}]}'),source:'room',owner:'owner',requestId:'r'};
 assert.equal(await sendRichAction(svc,input,binding,AbortSignal.timeout(1000)),'delivered');
 const event={source:'room',author:'bob',id:'e',eventKey:sent[0].find(p=>p.link?.type==='click').link.key,at:10};
 assert.equal(await shortcutEvent(svc,event),'stored');assert.equal(arrivals[0].author,'bob');assert.equal(arrivals[0].text,'查询我的部署');
 assert.equal(await shortcutEvent(svc,{...event,author:'mallory'}),'not_member');
 assert.equal(await shortcutEvent(svc,{...event,author:'external:abc'}),'ignored');
 binding.generation='next';map.get(event.eventKey).binding={...binding,generation:'old'};assert.equal(await shortcutEvent(svc,event),'retired');
 assert.throws(()=>parseRichAction('/富文本 {"parts":[{"type":"image","url":"http://example.com/p.png"}]}'),/消息卡片/);
 assert.throws(()=>parseRichAction('/富文本 {"parts":[{"type":"mention","members":["@all"]}]}'));
 assert.throws(()=>parseRichAction('/富文本 {"parts":[{"type":"link","title":"x","url":"javascript:alert(1)"}]}'));
});
test('pictured card keeps text, sections, real links and scoped menu in one provider message',async()=>{
 const action=parseRichAction('/消息卡片 '+JSON.stringify({title:'构建',summary:'通过',url:'https://example.com/build',imageUrl:'https://example.com/p.png',sections:[{title:'测试',text:'全部通过'}],links:[{title:'日志',url:'https://example.com/log'}],buttons:[{title:'重查',prompt:'查询构建'}]}));
 let wire;const svc={store:{rememberShortcut:async()=>{}},transport:{sendCard:async(s,c)=>{wire=c;return 'delivered';}}};
 await sendRichAction(svc,{...action,source:'s',owner:'o',requestId:'r'},{generation:'g'},AbortSignal.timeout(1000));
 assert.equal(wire.card_type,'news_notice');assert.equal(wire.vertical_content_list[0].desc,'全部通过');assert.match(wire.action_menu.action_list[0].key,/^oc-x-/);assert.equal(wire.card_image.url,'https://example.com/p.png');
});
test('foreign corporation namespaces both live and forwarded account identities without directory lookups',()=>{
 const local=senderIdentity('alice','wxlocal','wxlocal'),a=senderIdentity('alice','wxone','wxlocal'),b=senderIdentity('alice','wxtwo','wxlocal');
 assert.equal(local.id,'alice');assert.notEqual(a.id,b.id);assert.ok(a.external);
 const msg=node('Msg','',[node('MsgType','forward'),node('ForwardMessage','',[node('MsgItemList','',[
 node('MsgItem','',[node('Sender','alice'),node('SenderCorpId','wxone'),node('MsgType','text'),node('Content','外部内容')]),node('MsgItem','',[node('Sender','alice'),node('MsgType','text'),node('Content','本地内容')])])])]);
 assert.deepEqual(forwardedSenders(msg,'wxlocal'),['alice']);const text=describeMessage(msg,new Map([['alice','LocalAlice']]),0,'wxlocal');
 assert.match(text,/alice（外部企业 wxone）: 外部内容/u);assert.match(text,/LocalAlice: 本地内容/u);
});
test('large PNG and WebP become bounded native JPEG without overwriting original; vectors/corruption refused',async()=>{
 const original=await sharp(randomBytes(1100*1100*3),{raw:{width:1100,height:1100,channels:3}}).png().toBuffer();
 assert.ok(original.length>2*1024*1024);const copy=Buffer.from(original),picture=await nativePicture(original);
 assert.equal(picture.type,'image/jpeg');assert.ok(picture.bytes.length<2*1024*1024);assert.deepEqual(original,copy);
 const webp=await sharp({create:{width:40,height:30,channels:3,background:'red'}}).webp().toBuffer();assert.equal((await nativePicture(webp)).type,'image/jpeg');
 assert.equal(await nativePicture(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')),null);
 assert.equal(await nativePicture(Buffer.alloc(20*1024*1024+1)),null);
});
test('emotion CDN rejects arbitrary/private URLs, bounds bytes, and normalizes first frame for assistant context',async()=>{
 assert.equal(emotionURL('http://p.qpic.cn/pic_wework/1/0'),'https://p.qpic.cn/pic_wework/1/0');
 for(const u of ['http://127.0.0.1/x','https://p.qpic.cn.evil.test/x','https://u:p@p.qpic.cn/x','https://p.qpic.cn:8443/x','file:///etc/passwd'])assert.throws(()=>emotionURL(u));
 let called=0;await assert.rejects(downloadEmotion('http://localhost/x',AbortSignal.timeout(1000),async()=>{called++;}),/Untrusted/);assert.equal(called,0);
 await assert.rejects(downloadEmotion('https://p.qpic.cn/x',AbortSignal.timeout(1000),async()=>new Response('x',{headers:{'content-length':String(9*1024*1024)}})),/unavailable/i);
 const msg=node('Msg','',[node('MsgType','emotion'),node('PicUrl','https://p.qpic.cn/pic_wework/1/0')]),refs=nestedMedia(msg);assert.equal(refs[0].type,'emotion');
 const gif=await sharp({create:{width:8,height:8,channels:3,background:'blue'}}).gif().toBuffer();let stored;
 const out=await resolveNestedMedia({source:'s',id:'m',text:'[表情]',nestedMedia:refs},{secret:'secret',signal:AbortSignal.timeout(5000),downloadEmotion:async()=>gif,store:async(id,name,get)=>{stored=await get();}});
 assert.equal((await sharp(stored).metadata()).format,'jpeg');assert.match(out.text,/资料编号 f/u);assert.match(out.text,/首帧/u);
});
