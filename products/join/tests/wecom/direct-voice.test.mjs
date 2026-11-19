import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createWeComChannelTransport, DIRECT_MENU } from '../../plugins/wecom/channel-transport.mjs';
import { MirrorService } from '../../plugins/wecom/mirror/service.mjs';
import { transcribeVoice } from '../../plugins/wecom/voice-text.mjs';

const aesKey = Buffer.alloc(32, 1).toString('base64').replace(/=$/, '');
function encrypt(xml) {
  const key = Buffer.from(aesKey + '=', 'base64'), body = Buffer.from(xml), length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  let plain = Buffer.concat([randomBytes(16), length, body, Buffer.from('fwfixture')]); const pad = 32 - (plain.length % 32);
  plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); c.setAutoPadding(false);
  return Buffer.concat([c.update(plain), c.final()]).toString('base64');
}
function transport(extra = {}) {
  const sent = [], arrivals = [], entered = [];
  const fetcher = async (url, init = {}) => {
    if (url.pathname.endsWith('/gettoken')) return Response.json({ errcode: 0, access_token: 't', expires_in: 7200 });
    sent.push([url.pathname, init.body && JSON.parse(init.body)]); return Response.json({ errcode: 0 });
  };
  const t = createWeComChannelTransport({ corpId: 'wxfixture', corpSecret: 's', serviceId: 'fwfixture', token: 'fixture', aesKey, relayIngress: true,
    enableImages: true, directChats: true, onDirectEnter: async id => { entered.push(id); }, fetcher, ...extra });
  t.subscribe(async a => { arrivals.push(a); });
  const deliver = async (type, inner, senderCorpId='') => {
    const now = Math.floor(Date.now() / 1000);
    const enc = encrypt(`<xml><ToUserName>wxfixture</ToUserName><ServiceId>fwfixture</ServiceId><AgentType>chat</AgentType><Msg>
      <From><Type>${type}</Type><Id>${type === 'single' ? 'T1A' : 'room'}</Id>${type === 'group' ? '<Sender>T1A</Sender>' : ''}${senderCorpId?'<SenderCorpId>'+senderCorpId+'</SenderCorpId>':''}</From><CreateTime>${now}</CreateTime><MsgId>M1</MsgId>${inner}</Msg></xml>`);
    const sig = createHash('sha1').update(['fixture', String(now), 'n', enc].sort().join('')).digest('hex');
    const req = Object.assign(Readable.from([Buffer.from(`<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`)]),
      { method: 'POST', headers: {}, setTimeout() {}, url: `${t.callback.path}?msg_signature=${sig}&timestamp=${now}&nonce=n` });
    const res = { destroyed: false, writeHead(s) { this.status = s; }, end() {} };
    await t.callback.handle(req, res);
    return res.status;
  };
  return { t, sent, arrivals, entered, deliver };
}
const direct = JSON.stringify(['wecom-customer-service', 'wxfixture', 'fwfixture', 'single:T1A']);

test('a private chat is the person\'s own room: every message is addressed, replies go back privately', async () => {
  const f = transport();
  assert.equal(await f.deliver('single', '<MsgType>text</MsgType><Content>帮我记一下明天交周报</Content>'), 200);
  assert.deepEqual([f.arrivals[0].source, f.arrivals[0].mentioned, f.arrivals[0].direct, f.arrivals[0].text], [direct, true, true, '帮我记一下明天交周报']);
  assert.equal(await f.t.sendMarkdown({ source: direct, text: '记下了' }, AbortSignal.timeout(1000)), 'delivered');
  assert.deepEqual(f.sent.at(-1)[1].receiver, { type: 'single', id: 'T1A' });
  assert.deepEqual(await f.t.chatMembers(direct, AbortSignal.timeout(1000)), ['T1A']);
  assert.equal(await f.t.mentionEveryone(direct, 'x', AbortSignal.timeout(1000)), 'rejected');
  assert.equal(await f.deliver('single', '<MsgType>Event</MsgType><Event>enter_chat</Event>'), 200);
  assert.deepEqual(f.entered, ['T1A']);
  assert.equal(f.arrivals.length, 1, 'events are not messages');
});

test('without the switch private chats keep the old notice', async () => {
  const f = transport({ directChats: false });
  assert.equal(await f.deliver('single', '<MsgType>text</MsgType><Content>hi</Content>'), 200);
  assert.equal(f.arrivals.length, 0);
  assert.match(f.sent[0][1].text.content, /暂不支持单聊/u);
});

test('voice in a group carries its media reference', async () => {
  const f = transport();
  await f.deliver('group', '<MsgType>voice</MsgType><MediaId>v1</MediaId><Format>amr</Format>');
  assert.deepEqual([f.arrivals[0].text, f.arrivals[0].voice], ['[语音]', { mediaId: 'v1', format: 'amr' }]);
});

test('the first private message binds to the person\'s server; welcome at most once a day', async () => {
  const binds = [], once = new Set(), welcomed = [];
  const store = { snapshot: async () => ({ binding: binds.length ? { serverId: 'one' } : null }), candidates: async () => [{ id: 'one', name: 'One' }],
    bind: async (...a) => { binds.push(a); }, ingest: async () => 'stored', claimOnce: async k => (once.has(k) ? false : (once.add(k), true)),
    rememberMention: async () => {}, openWindow: async () => {} };
  const transport = { subscribe: () => () => {}, senderNames: async () => new Map([['T1A', 'skipzhang']]), welcomeDirect: async id => { welcomed.push(id); return 'delivered'; } };
  const svc = new MirrorService({ store, transport, servers: [], corpId: 'wxfixture' });
  await svc.ingest({ source: direct, id: 'M1', author: 'T1A', text: '你好', at: 1, mentioned: true, direct: true });
  await svc.ingest({ source: direct, id: 'M2', author: 'T1A', text: '再来', at: 2, mentioned: true, direct: true });
  assert.equal(binds.length, 1); assert.equal(binds[0][0], direct); assert.equal(binds[0][2], 'one'); assert.equal(binds[0][3], 'skipzhang 的私聊');
  await svc.welcome('T1A'); await svc.welcome('T1A');
  assert.deepEqual(welcomed, ['T1A']);
});

test('transcribeVoice sends the original format and returns text; unconfigured or failing gives empty', async () => {
  let body;
  const fetcher = async (url, init) => { body = JSON.parse(init.body); return Response.json({ status: 'completed', output: { text: ' 明天上午十点开会 ' } }); };
  assert.equal(await transcribeVoice(Buffer.from('#!AMR'), 'AMR', { speech: async () => ({ apiKey: 'k', model: 'm' }), fetcher }), '明天上午十点开会');
  assert.deepEqual([body.model, body.voice_encode_format], ['m', 'amr']);
  assert.equal(await transcribeVoice(Buffer.from('x'), 'amr', { speech: async () => null, fetcher }), '');
  assert.equal(await transcribeVoice(Buffer.from('x'), 'amr', { speech: async () => ({ apiKey: 'k', model: 'm' }), fetcher: async () => new Response('', { status: 402 }) }), '');
  assert.equal(await transcribeVoice(Buffer.from('x'), 'exe', { speech: async () => ({ apiKey: 'k', model: 'm' }), fetcher }), '');
});

test('the gateway turns a voice message into text before the timeline records it', async () => {
  const { createMirrorTarget } = await import('../../plugins/wecom/mirror/target.mjs');
  const data = fs.mkdtempSync(join(os.tmpdir(), 'gwv-')); process.env.OPENCRAFT_DATA_DIR = data; process.env.OPENCRAFT_WORKSPACE_DIR = data + '-ws';
  const source = JSON.stringify(['wecom-customer-service', 'wxfixture', 'fwfixture', 'room']);
  let polled = false;
  const event = { source, id: 'V1', author: 'T1A', text: '[语音]', at: 1, mentioned: false, voice: { mediaId: 'v1', format: 'amr' } };
  const fetcher = async (url, options) => {
    const action = String(url).split('/').pop();
    if (action === 'poll') { const d = polled ? [] : [{ binding: { serverId: 'one', source }, event, token: 't' }]; polled = true; return Response.json({ deliveries: d }); }
    if (action === 'file') return new Response('#!AMR');
    return Response.json(action === 'link-poll' ? { links: [] } : {});
  };
  const target = await createMirrorTarget({ relayOrigin: 'https://relay.example/', serverId: 'one', credential: 'c'.repeat(43), corpId: 'wxfixture' },
    { collaboration: { synchronizeChannels: async () => [] } }, fetcher, { transcribe: async (bytes, format) => (assert.equal(format, 'amr'), '记得买牛奶') });
  const seen = [];
  target.subscribe(async e => { seen.push(e); return { messageId: 'n1' }; });
  for (let i = 0; i < 100 && !seen.length; i++) await new Promise(r => setTimeout(r, 30));
  await target.close();
  assert.equal(seen[0].text, '[语音] 记得买牛奶');
  assert.equal('voice' in seen[0], false);
});


test('welcome exposes working private shortcuts; clicks enter the authenticated owner inbox', async () => {
  const f = transport();
  await f.t.welcomeDirect('T1A', AbortSignal.timeout(1000));
  const payload = f.sent.at(-1)[1];
  assert.equal(payload.msgtype, 'rich_text');
  assert.deepEqual(payload.receiver, { type: 'single', id: 'T1A' });
  const links = payload.rich_text.filter(item => item.type === 'link');
  assert.deepEqual(links.map(item => item.link.key), DIRECT_MENU.map(item => item.key));
  for (const item of DIRECT_MENU) {
    assert.equal(await f.deliver('single', `<MsgType>Event</MsgType><Event>click</Event><EventKey>${item.key}</EventKey>`), 200);
    const arrival = f.arrivals.at(-1);
    assert.deepEqual([arrival.source, arrival.author, arrival.text, arrival.mentioned, arrival.direct, arrival.id],
      [direct, 'T1A', item.prompt, true, true, 'M1']);
  }
  const count = f.arrivals.length;
  await f.deliver('single', '<MsgType>Event</MsgType><Event>click</Event><EventKey>arbitrary-prompt</EventKey>');
  await f.deliver('group', '<MsgType>Event</MsgType><Event>click</Event><EventKey>oc-my-tasks</EventKey>');
  assert.equal(f.arrivals.length, count+1);
  assert.equal(f.arrivals.at(-1).author,'T1A');assert.equal(f.arrivals.at(-1).direct,undefined);
  assert.equal(JSON.parse(f.arrivals.at(-1).source)[3],'room');
  const disabled = transport({ directChats: false });
  await disabled.deliver('single', '<MsgType>Event</MsgType><Event>click</Event><EventKey>oc-my-tasks</EventKey>');
  assert.equal(disabled.arrivals.length, 0);
});

test('private template-card callback uses verified peer identity and private source',async()=>{
  const events=[];const f=transport({onCardEvent:async e=>events.push(e)});
  const event='<MsgType>Event</MsgType><Event>template_card_event</Event><TemplateCardEvent><CardType>button_interaction</CardType><TaskId>task</TaskId><EventKey>yes</EventKey><ResponseCode>response</ResponseCode></TemplateCardEvent><ResponseCode>response</ResponseCode>';
  assert.equal(await f.deliver('single',event),200);
  assert.equal(events.length,1);assert.equal(events[0].source,direct);assert.equal(events[0].author,'T1A');assert.equal(events[0].direct,true);
  const disabled=transport({directChats:false,onCardEvent:async e=>events.push(e)});
  await disabled.deliver('single',event);assert.equal(events.length,1);
});

test('forwarded mixed media preserves nested references without adopting forwarded identity',async()=>{
  const f=transport();
  await f.deliver('single','<MsgType>forward</MsgType><ForwardMessage><MsgItemList><MsgItem><Sender>SomeoneElse</Sender><MsgType>mixed</MsgType><MixedMessage><MsgItem><MsgType>image</MsgType><MediaId>img</MediaId></MsgItem><MsgItem><MsgType>file</MsgType><MediaId>pdf</MediaId><FileName>notes.pdf</FileName></MsgItem></MixedMessage></MsgItem></MsgItemList></ForwardMessage>');
  assert.equal(f.arrivals[0].author,'T1A');
  assert.deepEqual(f.arrivals[0].nestedMedia.map(x=>[x.type,x.path,x.mediaId]),[['image','1.1','img'],['file','1.2','pdf']]);
});

test('member display resolves cached robot identities without treating them as employees',async()=>{
 let robotCalls=0;
 const f=transport({fetcher:async(url)=>{
  if(url.pathname.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'token',expires_in:7200});
  if(url.pathname.endsWith('/chat/get'))return Response.json({errcode:0,chat_info:{userlist:['T1A','wbbot','fwfixture']}});
  if(url.pathname.endsWith('/convert_to_name'))return Response.json({errcode:0,user_list:[{userid:'T1A',name:'alice'}]});
  robotCalls++;return Response.json({errcode:0,robot_list:[{robotid:'wbbot',name:'构建机器人',head_image_url:'https://example.com/bot.png'}]});
 }});
 const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
 const members=await f.t.memberInfo(source,AbortSignal.timeout(1000));
 assert.deepEqual(members.map(m=>m.kind),['human','robot']);assert.equal(members[1].name,'构建机器人');
 await f.t.senderNames(source,['wbbot'],AbortSignal.timeout(1000));assert.equal(robotCalls,1);
 await assert.rejects(f.t.resolveSender(source,'wbbot',AbortSignal.timeout(1000)),/not an employee/u);
});


test('foreign sender callback cannot impersonate a local member, open direct chat or execute menu',async()=>{
 const clicks=[],f=transport({onShortcut:async e=>clicks.push(e)});
 assert.equal(await f.deliver('group','<MsgType>text</MsgType><Content>hi</Content><MentionedType>1</MentionedType>','wxforeign'),200);
 assert.match(f.arrivals[0].author,/^external:/);assert.equal(f.arrivals[0].mentioned,false);assert.match(f.arrivals[0].sender.displayName,/wxforeign/);
 await f.deliver('single','<MsgType>text</MsgType><Content>hi</Content>','wxforeign');
 await f.deliver('group','<MsgType>Event</MsgType><Event>click</Event><EventKey>oc-x-'+ 'a'.repeat(40)+'</EventKey>','wxforeign');
 assert.equal(f.arrivals.length,1);assert.equal(clicks.length,0);
});
test('signed custom clicks use verified group sender or private peer and unknown keys remain inert',async()=>{
 const clicks=[],f=transport({onShortcut:async e=>clicks.push(e)}),key='oc-x-'+'a'.repeat(40);
 await f.deliver('group','<MsgType>Event</MsgType><Event>click</Event><EventKey>'+key+'</EventKey>');
 await f.deliver('single','<MsgType>Event</MsgType><Event>click</Event><EventKey>'+key+'</EventKey>');
 assert.equal(clicks.length,2);assert.equal(clicks[0].author,'T1A');assert.equal(clicks[1].source,direct);assert.equal(f.arrivals.length,0);
});
