import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createWeComChannelTransport } from '../../plugins/wecom/channel-transport.mjs';

const config = {
  corpId: 'wxfixture', corpSecret: 'synthetic-fixture', serviceId: 'fwfixture', token: 'fixture',
  aesKey: Buffer.alloc(32, 1).toString('base64').replace(/=$/, ''),
  localGroups: [{ chatId: 'room', channelId: 'group:00000000-0000-0000-0000-000000000001' }],
};

function envelope({ fromType = 'single', userId = 'Wei', messageType = 'text', serviceId = config.serviceId, messageId = 'direct-id' } = {}) {
  const xml = `<xml><ServiceId>${serviceId}</ServiceId><ToUserName>${config.corpId}</ToUserName><AgentType>chat</AgentType><Msg><From><Type>${fromType}</Type><Id>${userId}</Id></From><MsgType>${messageType}</MsgType><MentionedType>1</MentionedType><MsgId>${messageId}</MsgId><Content>@机器人 保存 server-one</Content><MediaId>private-image</MediaId><CreateTime>1700000000</CreateTime></Msg></xml>`;
  const body = Buffer.from(xml), size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  const clear = Buffer.concat([Buffer.alloc(16), size, body, Buffer.from(config.serviceId)]);
  const padding = 32 - clear.length % 32, key = Buffer.alloc(32, 1);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([clear, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'fixture';
  const msg_signature = createHash('sha1').update([config.token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
  return { query: new URLSearchParams({ timestamp, nonce, msg_signature }), body: `<xml><Encrypt>${encrypted}</Encrypt></xml>` };
}

async function fixture(t, relayIngress = true) {
  const calls = [], arrivals = [], mentions = []; let rejected = false;
  const transport = createWeComChannelTransport({ ...config, relayIngress,
    onMention: event => mentions.push(event),
    fetcher: async (url, options) => {
      calls.push({ path: url.pathname, body: options.body && JSON.parse(options.body) });
      return Response.json(url.pathname.endsWith('/gettoken')
        ? { errcode: 0, access_token: 'synthetic-token', expires_in: 7200 }
        : { errcode: rejected ? 1 : 0 });
    },
  });
  const unsubscribe = transport.subscribe(event => arrivals.push(event));
  const server = createServer((req, res) => void transport.callback.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { unsubscribe(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}${transport.callback.path}`;
  const post = async (options, forged = false) => {
    const { query, body } = envelope(options);
    if (forged) query.set('msg_signature', '0'.repeat(40));
    const response = await fetch(`${origin}?${query}`, { method: 'POST', body });
    await response.text();
    return response.status;
  };
  return { calls, arrivals, mentions, post, reject: value => { rejected = value; } };
}

test('Relay tells a single-chat sender to use a group without accepting text, commands or attachments', async t => {
  const f = await fixture(t);
  for (const messageType of ['text', 'image', 'voice', 'video', 'file']) {
    assert.equal(await f.post({ messageType }), 200);
  }
  const sends = f.calls.filter(call => call.path.endsWith('/chat/send'));
  assert.equal(sends.length, 5);
  for (const call of sends) assert.deepEqual(call.body, {
    receiver: { type: 'single', id: 'Wei' }, msgtype: 'text',
    text: { content: '暂不支持单聊，请将我加入企业微信群后，在群聊中使用。' },
  });
  assert.equal(f.calls.some(call => call.path.includes('/media/')), false);
  assert.deepEqual(f.arrivals, []);
  assert.deepEqual(f.mentions, []);
});

test('Unverified, mismatched, self, event and malformed callbacks cannot trigger a private notice', async t => {
  const f = await fixture(t);
  assert.equal(await f.post({}, true), 401);
  assert.equal(await f.post({ serviceId: 'fwother' }), 403);
  for (const options of [{ userId: config.serviceId }, { userId: '' }, { messageId: '' }, { messageType: 'event' }, { fromType: 'unknown' }]) {
    assert.equal(await f.post(options), 200);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.arrivals, []);
});

test('A failed private notice remains retryable without accepting the message', async t => {
  const f = await fixture(t);
  f.reject(true);
  assert.equal(await f.post(), 503);
  f.reject(false);
  assert.equal(await f.post(), 200);
  assert.deepEqual(f.arrivals, []);
});

test('The native group connector leaves single-chat handling to the Relay', async t => {
  const f = await fixture(t, false);
  assert.equal(await f.post(), 200);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.arrivals, []);
});
