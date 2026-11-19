import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { markdownMessageFrames, sendMarkdownMessage } from '../../plugins/wecom/message-markdown.mjs';
import { wecomAttributedText } from '../../plugins/wecom/message-attribution.mjs';
import { MirrorService } from '../../plugins/wecom/mirror/service.mjs';
import { createWeComChannelTransport } from '../../plugins/wecom/channel-transport.mjs';

const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
const serverId='hub-d00bd6f39112a3c11a62656c397b9515c5a1f2e2';
const base={source,author:'skipzhang的助理',serverId,serverName:'Join',requestId:'r',presentation:{version:1,sender:{id:'assistant-actor',role:'assistant',displayName:'skipzhang的助理'},format:'markdown'}};
const signal=()=>AbortSignal.timeout(3000);
const header=wecomAttributedText({...base,text:''},true);

function fixture({streamReplies=false,respond=async()=>0}={}) {
  const calls={text:[],markdown:[],file:[],stream:[]};
  const service=new MirrorService({corpId:'wxfixture',streamReplies,servers:[{id:serverId,name:'Join',credential:'x'.repeat(43)}],
    store:{snapshot:async()=>({binding:{serverId}}),claimStream:async()=>true},
    transport:{subscribe:()=>()=>{},send:async m=>{calls.text.push(m);return 'delivered';},
      sendMarkdown:async m=>{calls.markdown.push(m);return 'delivered';},
      sendFile:async(...args)=>{calls.file.push(args);return 'delivered';},
      respond:async(...args)=>{calls.stream.push(args);return respond(...args);}}});
  async function send(input,credential='x'.repeat(43)) {
    const res={writeHead(s){this.status=s;},end(s){this.body=JSON.parse(s);}};
    await service.handle(Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]),{method:'POST',url:'/__opencraft_wecom_mirror/send',
      headers:{'x-opencraft-mirror-server':serverId,authorization:'Bearer '+credential},socket:{encrypted:true}}),res);
    await Promise.allSettled([...service.pending]);
    return res;
  }
  return {service,calls,send};
}

test('standalone assistant Markdown works with streams disabled or no reply anchor; origin cannot be spoofed',async()=>{
  for(const streamReplies of [false,true])for(const replyTo of [undefined,'M1']) {
    const f=fixture({streamReplies});
    const res=await f.send({...base,serverId:'spoofed',text:'# 结论\n\n**已完成**',...(replyTo?{replyTo}:{})});
    assert.equal(res.status,200);assert.equal(res.body.status,'delivered');
    const body=streamReplies&&replyTo?f.calls.stream[0][2]:f.calls.markdown[0].text;
    assert.equal(body,header+'# 结论\n\n**已完成**');assert.ok(!body.includes('spoofed'));
    assert.equal(f.calls.text.length,0);
  }
});

test('normal member text and native mentions retain their original transport',async()=>{
  const f=fixture({streamReplies:true});
  await f.send({...base,author:'Alice',text:'**原文**',presentation:{version:1,sender:{id:'alice',role:'human',displayName:'Alice'},format:'text'}});
  await f.send({...base,text:'Hi @Bob',replyTo:'M1',mentions:[{start:3,end:7,recipient:'bob'}]});
  assert.equal(f.calls.text.length,2);assert.equal(f.calls.text[0].text,'**原文**');
  assert.equal(f.calls.text[1].mentions[0].recipient,'bob');
  assert.equal(f.calls.markdown.length,0);assert.equal(f.calls.stream.length,0);
});

test('expired stream falls back to Markdown, while uncertain stream sends never fall back',async()=>{
  const refused=fixture({streamReplies:true,respond:async()=>780013});
  const res=await refused.send({...base,text:'**今天**是星期一。',replyTo:'M1'});
  assert.equal(res.body.status,'delivered');assert.equal(refused.calls.markdown[0].text,header+'**今天**是星期一。');
  assert.equal(refused.calls.text.length,0);
  const unknown=fixture({streamReplies:true,respond:async()=>{throw Error('timeout');}});
  assert.equal((await unknown.send({...base,text:'答案',replyTo:'M1'})).status,503);
  assert.equal(unknown.calls.markdown.length,0);assert.equal(unknown.calls.file.length,0);assert.equal(unknown.calls.text.length,0);
});

test('authentication and room binding are still required before any outbound message',async()=>{
  const f=fixture();assert.equal((await f.send({...base,text:'x'},'wrong')).status,403);
  f.service.store.snapshot=async()=>({binding:{serverId:'different'}});
  assert.equal((await f.send({...base,text:'x'})).status,403);
  assert.ok(Object.values(f.calls).every(a=>!a.length));
});

test('UTF8 limits include repeated attribution; Chinese and emoji are preserved exactly',()=>{
  const text='中文🧪👨‍👩‍👧‍👦'.repeat(900),frames=markdownMessageFrames({...base,text});
  assert.ok(frames.length>1);assert.equal(frames.map(s=>s.slice(header.length)).join(''),text);
  assert.ok(frames.every(s=>s.startsWith(header)&&s.isWellFormed()&&Buffer.byteLength(s)<=4096));
});

test('headings, links, code fences and tables remain whole across Markdown frames',()=>{
  const block='# 说明\n\n**加粗**与[文档](https://example.com/a)\n\n```js\nconst a = "中🧪";\n```\n\n|字段|值|\n|---|---|\n|状态|通过|\n\n';
  const text=block.repeat(70),frames=markdownMessageFrames({...base,text});
  assert.ok(frames.length>1);assert.equal(frames.map(s=>s.slice(header.length)).join(''),text);
  for(const frame of frames){assert.ok(Buffer.byteLength(frame)<=4096);assert.equal((frame.match(/^```/gm)||[]).length%2,0);}
});

test('oversize indivisible blocks and cross-frame references use one lossless Markdown file before any sends',async()=>{
  const texts=['```js\n'+('const a="中🧪";\n'.repeat(400))+'```','**'+('中'.repeat(2000))+'**',
    '[说明][doc]\n\n'+'正文\n\n'.repeat(1000)+'[doc]: https://example.com',
    '|字段|值|\n|---|---|\n'+('|中|🧪|\n'.repeat(800)),
    '<div>\n内容\n\n'+('正文\n\n'.repeat(1000))+'</div>',
    ('正文\r\n\r\n'.repeat(1000))];
  for(const text of texts){
    assert.equal(markdownMessageFrames({...base,text}),null);
    const calls=[];const t={sendMarkdown:async()=>assert.fail('no partial sends'),sendFile:async(...args)=>{calls.push(args);return 'delivered';}};
    assert.equal(await sendMarkdownMessage(t,{...base,text},signal()),'delivered');
    assert.equal(calls.length,1);assert.equal(calls[0][0],source);assert.equal(calls[0][1],'聊天消息.md');
    assert.equal(calls[0][2].toString(),header+text);
  }
});

test('a definitive Markdown rejection does not downgrade; partial or uncertain sends stop immediately',async()=>{
  const message={...base,text:'中文🧪'.repeat(3000)};
  for(const outcome of ['rejected','unknown','throw']){
    let sends=0;
    const t={sendMarkdown:async()=>{sends++;if(sends===1)return 'delivered';if(outcome==='throw')throw Error('network');return outcome;},sendFile:async()=>assert.fail('no second route'),send:async()=>assert.fail('no plain text')};
    await assert.rejects(sendMarkdownMessage(t,message,signal()),/partial|network/);assert.equal(sends,2);
  }
  let sends=0;assert.equal(await sendMarkdownMessage({sendMarkdown:async()=>{sends++;return 'rejected';}},message,signal()),'rejected');assert.equal(sends,1);
});

test('short Markdown boundary, invalid Unicode and abort are checked without dropping content',async()=>{
  const budget=4096-Buffer.byteLength(header);
  assert.equal(Buffer.byteLength(markdownMessageFrames({...base,text:'a'.repeat(budget)})[0]),4096);
  assert.equal(markdownMessageFrames({...base,text:'a'.repeat(budget+1)}).length,2);
  assert.throws(()=>markdownMessageFrames({...base,text:'\ud800'}),/Invalid/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(sendMarkdownMessage({sendMarkdown:async()=>assert.fail('aborted')},{...base,text:'hi'},controller.signal),/abort/i);
});

test('real transport emits msgtype markdown rather than literal markers in text',async()=>{
  const sent=[];
  const t=createWeComChannelTransport({corpId:'wxfixture',corpSecret:'fixture',serviceId:'fwfixture',token:'fixture',relayIngress:true,aesKey:Buffer.alloc(32,1).toString('base64').replace(/=$/,''),
    fetcher:async(url,init)=>{if(url.pathname.endsWith('gettoken'))return Response.json({errcode:0,access_token:'token',expires_in:3600});sent.push(JSON.parse(init.body));return Response.json({errcode:0});}});
  assert.equal(await sendMarkdownMessage(t,{...base,text:'**完成**\n\n- 一\n- 二'},signal()),'delivered');
  assert.equal(sent.length,1);assert.equal(sent[0].msgtype,'markdown');assert.equal(sent[0].markdown.content,header+'**完成**\n\n- 一\n- 二');
  assert.equal(sent[0].text,undefined);
});


test('missing Markdown support never silently sends raw syntax as text',async()=>{
  assert.equal(await sendMarkdownMessage({send:async()=>assert.fail('no plain fallback')},{...base,text:'**完成**'},signal()),'rejected');
  assert.equal(await sendMarkdownMessage({sendMarkdown:async()=>assert.fail('oversize code must remain intact')},{...base,text:'```\n'+'中'.repeat(2000)+'\n```'},signal()),'rejected');
});
