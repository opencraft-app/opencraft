import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { createWeComChannelTransport } from '../../products/join/plugins/wecom/channel-transport.mjs';
import { createWeComCallbackIngress } from '../wecom-callback.js';
import { joinRelayConfiguration } from '../relay-composition.js';

const config = { corpId: 'wxfixture', serviceId: 'fwfixture', corpSecret: 'fixture-secret', token: 'fixture',
  aesKey: Buffer.alloc(32, 1).toString('base64').replace(/=$/, '') };
function envelope(type: string) {
  const xml = `<xml><ServiceId>${config.serviceId}</ServiceId><ToUserName>${config.corpId}</ToUserName><AgentType>chat</AgentType><Msg><From><Type>${type}</Type><Id>Wei</Id><Sender>Wei</Sender></From><MsgType>text</MsgType><MsgId>fixture-id</MsgId><Content>fixture</Content></Msg></xml>`;
  const body = Buffer.from(xml), size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  const clear = Buffer.concat([Buffer.alloc(16), size, body, Buffer.from(config.serviceId)]);
  const padding = 32 - clear.length % 32, key = Buffer.alloc(32, 1);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([clear, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'fixture+nonce';
  const msg_signature = createHash('sha1').update([config.token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
  return { query: new URLSearchParams({ timestamp, nonce, msg_signature }), body: `<xml>\r\n<Encrypt><![CDATA[${encrypted}]]></Encrypt>\r\n</xml>` };
}

test('Hub callback mode replies to private chats locally and forwards verified group ciphertext unchanged', async t => {
  const provider: any[] = [], forwarded: any[] = []; let unavailable = false;
  const transport = createWeComChannelTransport({ ...config, localGroups: [], relayIngress: true,
    fetcher: async (url: URL, options: any) => {
      provider.push({ path: url.pathname, body: options.body && JSON.parse(options.body) });
      return Response.json({ errcode: 0, access_token: 'synthetic-access' });
    } });
  const receiver = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    forwarded.push({ path: req.url, body: Buffer.concat(chunks).toString(), cookie: req.headers.cookie });
    res.end('native-receiver');
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  t.after(() => new Promise<void>(resolve => receiver.close(() => resolve())));
  const ingress = createWeComCallbackIngress({ hubId: 'hub-' + 'a'.repeat(40), origin: 'http://receiver.test' }, async () => {
    if (unavailable) throw Error('withdrawn');
    const socket = connect((receiver.address() as any).port, '127.0.0.1'); await once(socket, 'connect'); return socket;
  }, transport.callback);
  const server = createServer((req, res) => { if (!ingress(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as any).port}/wecom_callback`;
  const post = async (message: ReturnType<typeof envelope>) => {
    const response = await fetch(origin + '?' + message.query, { method: 'POST', body: message.body, headers: { cookie: 'private=fixture' } });
    return { status: response.status, body: await response.text() };
  };
  assert.equal((await post(envelope('single'))).status, 200);
  assert.equal(forwarded.length, 0);
  assert.deepEqual(provider.at(-1).body.receiver, { type: 'single', id: 'Wei' });
  const group = envelope('group');
  assert.deepEqual(await post(group), { status: 200, body: 'native-receiver' });
  assert.deepEqual(forwarded, [{ path: '/__opencraft_im/shadow-callback/wecom?' + group.query, body: group.body, cookie: undefined }]);
  group.query.set('msg_signature', '0'.repeat(40));
  assert.equal((await post(group)).status, 401);
  assert.equal(forwarded.length, 1);
  unavailable = true;
  assert.equal((await post(envelope('group'))).status, 503);
});

test('Standalone private-chat notices require the existing Hub route and cannot compete with mirror ingress', () => {
  const base = { schemaVersion: 1, host: '127.0.0.1', port: 18090, routes: [] };
  assert.throws(() => joinRelayConfiguration(base, undefined, undefined, undefined, '/private/wecom.json'), /single-chat notice/);
  const callback = { ...base, hubNetwork: { stateFile: '/private/hub.json', operatorCredentialFile: '/private/operator.json' },
    wecomCallback: { hubId: 'hub-' + 'a'.repeat(40), origin: 'http://receiver.test' } };
  assert.throws(() => joinRelayConfiguration(callback, undefined, undefined, undefined, 'relative.json'), /single-chat notice/);
  assert.throws(() => joinRelayConfiguration(callback, undefined, undefined, '/private/mirror.json', '/private/wecom.json'), /single-chat notice/);
  assert.ok(joinRelayConfiguration(callback, undefined, undefined, undefined, '/private/wecom.json').composition.createIngress);
});
