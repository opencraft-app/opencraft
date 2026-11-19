import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createWeComChannelTransport } from '../../plugins/wecom/channel-transport.mjs';

const aesKey = Buffer.alloc(32, 1).toString('base64').replace(/=$/, '');
function encrypt(xml) {
  const key = Buffer.from(aesKey + '=', 'base64'), body = Buffer.from(xml), length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  let plain = Buffer.concat([randomBytes(16), length, body, Buffer.from('fwfixture')]); const pad = 32 - (plain.length % 32);
  plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); c.setAutoPadding(false);
  return Buffer.concat([c.update(plain), c.final()]).toString('base64');
}
async function deliver(inner, fetcher = async () => Response.json({ errcode: 0, access_token: 't', expires_in: 7200, user_list: [{ userid: 'T1A', name: 'skipzhang' }, { userid: 'T2B', name: 'lisi' }] }), direct = false) {
  const arrivals = [];
  const t = createWeComChannelTransport({ corpId: 'wxfixture', corpSecret: 's', serviceId: 'fwfixture', token: 'fixture', aesKey, relayIngress: true, directChats:direct, fetcher });
  t.subscribe(async a => { arrivals.push(a); });
  const now = Math.floor(Date.now() / 1000);
  const enc = encrypt(`<xml><ToUserName>wxfixture</ToUserName><ServiceId>fwfixture</ServiceId><AgentType>chat</AgentType><Msg>
    <From><Type>${direct?'single':'group'}</Type><Id>${direct?'T1A':'room'}</Id><Sender>T1A</Sender></From><CreateTime>${now}</CreateTime><MsgId>M1</MsgId>${inner}</Msg></xml>`);
  const sig = createHash('sha1').update(['fixture', String(now), 'n', enc].sort().join('')).digest('hex');
  const req = Object.assign(Readable.from([Buffer.from(`<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`)]),
    { method: 'POST', headers: {}, setTimeout() {}, url: `${t.callback.path}?msg_signature=${sig}&timestamp=${now}&nonce=n` });
  const res = { destroyed: false, writeHead(s) { this.status = s; }, end() {} };
  await t.callback.handle(req, res);
  return { status: res.status, arrivals };
}

test('forwarded chat records become readable text with resolved names and times', async () => {
  const { status, arrivals } = await deliver(`<MsgType>forward</MsgType><ForwardMessage><Title>事故讨论</Title><MsgItemList>
    <MsgItem><Sender>T1A</Sender><Time>1794500000</Time><MsgType>text</MsgType><Content>数据库挂了</Content></MsgItem>
    <MsgItem><Sender>T2B</Sender><Time>1794500060</Time><MsgType>text</MsgType><Content>我来看</Content></MsgItem>
    <MsgItem><Sender>T2B</Sender><Time>1794500120</Time><MsgType>image</MsgType><MediaId>x</MediaId></MsgItem>
    <MsgItem><Sender>T1A</Sender><Time>1794500180</Time><MsgType>forward</MsgType><ForwardMessage><Title>更早</Title><MsgItemList>
      <MsgItem><Sender>T2B</Sender><Time>1794400000</Time><MsgType>text</MsgType><Content>旧消息</Content></MsgItem></MsgItemList></ForwardMessage></MsgItem>
    </MsgItemList></ForwardMessage>`);
  assert.equal(status, 200);
  const text = arrivals[0].text;
  assert.match(text, /^\[聊天记录\] 事故讨论\n/u);
  assert.match(text, /skipzhang: 数据库挂了/u);
  assert.match(text, /lisi: 我来看/u);
  assert.match(text, /lisi: \[图片\]/u);
  assert.match(text, /\[聊天记录\] 更早\n  .*lisi: 旧消息/u);
  assert.match(text, /\d\d-\d\d \d\d:\d\d skipzhang/u);
});

test('files, mixed messages and voice are recorded instead of dropped', async () => {
  const file = (await deliver('<MsgType>file</MsgType><MediaId>m</MediaId><FileName>周报.pdf</FileName>')).arrivals[0];
  assert.equal(file.text, '[文件] 周报.pdf');
  assert.deepEqual(file.file, { mediaId: 'm', name: '周报.pdf' });
  assert.equal((await deliver(`<MsgType>mixed</MsgType><MixedMessage><MsgItem><MsgType>text</MsgType><Content>看这个</Content></MsgItem>
    <MsgItem><MsgType>image</MsgType><MediaId>i</MediaId></MsgItem></MixedMessage>`)).arrivals[0].text, '看这个 [图片]');
  assert.equal((await deliver('<MsgType>voice</MsgType><MediaId>v</MediaId>')).arrivals[0].text, '[语音]');
});

test('name lookup failure still records the record with provider ids', async () => {
  const { arrivals } = await deliver(`<MsgType>forward</MsgType><ForwardMessage><Title>t</Title><MsgItemList>
    <MsgItem><Sender>T9Z</Sender><Time>1794500000</Time><MsgType>text</MsgType><Content>hi</Content></MsgItem></MsgItemList></ForwardMessage>`,
    async () => { throw Error('down'); });
  assert.match(arrivals[0].text, /T9Z: hi/u);
});

test('private forwarded records resolve names and preserve typed entries instead of dropping their structure',async()=>{
 const {status,arrivals}=await deliver('<MsgType>forward</MsgType><ForwardMessage><Title>群聊的聊天记录</Title><MsgItemList><MsgItem><Sender>T2B</Sender><Time>1700000000</Time><MsgType>text</MsgType><Content>昨天到今天一直告警</Content></MsgItem></MsgItemList></ForwardMessage>',async()=>Response.json({errcode:0,access_token:'t',expires_in:7200,user_list:[{userid:'T2B',name:'lisi'}]}),true);
 assert.equal(status,200);assert.equal(arrivals.length,1);assert.match(arrivals[0].text,/lisi/);assert.equal(arrivals[0].forwardedRecord.entries[0].sender.name,'lisi');assert.equal(arrivals[0].forwardedRecord.entries[0].parts[0].text,'昨天到今天一直告警');
});
