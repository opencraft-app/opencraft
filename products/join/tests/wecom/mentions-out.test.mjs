import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentionedNames, mentionsEveryone } from '../../plugins/wecom/mentions-out.mjs';
import { MirrorService } from '../../plugins/wecom/mirror/service.mjs';

const source = JSON.stringify(['wecom-customer-service', 'wxfixture', 'fwfixture', 'room']);
test('reply text yields @rtx names, never @all or emails', () => {
  assert.deepEqual(mentionedNames('@lisi 你负责这个，@zhangsan 跟进；@all 注意；邮件 a@b.com；@lisi'), ['lisi', 'zhangsan']);
  assert.deepEqual(mentionedNames('没有提到人'), []);
});
test('reply @names never trigger an unsolicited trailing mention, for streams or fallback', async () => {
  const calls = [], replies = []; let refuseStream = false;
  const transport = { subscribe: () => () => {}, respond: async (...args) => { replies.push(['stream', ...args]); return refuseStream ? 1 : 0; }, send: async m => { replies.push(['send', m]); return 'delivered'; }, sendMarkdown:async m=>{replies.push(['markdown',m]);return 'delivered';},
    chatMembers: async () => ['T1A', 'T2B'], senderNames: async () => new Map([['T1A', 'skipzhang'], ['T2B', 'lisi']]),
    mentionMembers: async (s, ids, text) => { calls.push(ids); return 'delivered'; } };
  const store = { claimStream: async () => true, mentionAuthor: async () => null, openWindow: async () => {} };
  const service = new MirrorService({ store, transport, servers: [], corpId: 'wxfixture', streamReplies: true });
  await service.reply({ source, requestId: 'r', text: '@lisi 你负责这个，@wangwu 不在群里', author: 'A', replyTo: 'M1' }, AbortSignal.timeout(1000));
  await Promise.allSettled([...service.pending]);
  assert.deepEqual(calls, []);
  assert.equal(replies.length, 1);
  refuseStream = true;
  await service.reply({ source, requestId: 'r2', text: '@skipzhang 普通回复', author: 'A', replyTo: 'M1' }, AbortSignal.timeout(1000));
  await Promise.allSettled([...service.pending]);
  assert.equal(calls.length, 0);
  assert.equal(replies.at(-1)[0], 'markdown');
  assert.ok(!replies.some(r=>r[0]==='send'));
});

import { createWeComChannelTransport } from '../../plugins/wecom/channel-transport.mjs';
test('sendFile uploads a temporary file then posts it to the bound group', async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push([url.pathname, url.searchParams.get('type'), init.body instanceof FormData ? init.body.get('media').name : init.body && JSON.parse(init.body)]);
    if (url.pathname.endsWith('/gettoken')) return Response.json({ errcode: 0, access_token: 't', expires_in: 7200 });
    if (url.pathname.endsWith('/media/upload')) return Response.json({ errcode: 0, media_id: 'MID' });
    return Response.json({ errcode: 0 });
  };
  const t = createWeComChannelTransport({ corpId: 'wxfixture', corpSecret: 's', serviceId: 'fwfixture', token: 'fixture',
    aesKey: Buffer.alloc(32, 1).toString('base64').replace(/=$/, ''), relayIngress: true, fetcher });
  assert.equal(await t.sendFile(source, '周报.pdf', Buffer.from('x'), AbortSignal.timeout(1000)), 'delivered');
  assert.deepEqual(calls[1].slice(0, 3), ['/cgi-bin/media/upload', 'file', '周报.pdf']);
  assert.deepEqual(calls[2][2], { receiver: { type: 'group', id: 'room' }, msgtype: 'file', file: { media_id: 'MID' } });
});

test('standalone assistant messages (scheduled reports) post as Markdown with the assistant name', async () => {
  const sent = [];
  const transport = { subscribe: () => () => {}, respond: async () => 0, sendMarkdown: async m => { sent.push(m.text); return 'delivered'; }, send: async () => { sent.push('TEXT'); return 'delivered'; },
    chatMembers: async () => { throw Error('Plain replies must not resolve mention recipients'); },
    mentionMembers: async () => { throw Error('Plain replies must not send a trailing ping'); } };
  const store = { snapshot: async () => ({ binding: { serverId: 'one' } }) };
  const service = new MirrorService({ store, transport, servers: [{ id: 'one', name: 'One', credential: 'c'.repeat(43) }], corpId: 'wxfixture', streamReplies: true });
  service.authenticate = () => service.servers.get('one');
  const { Readable } = await import('node:stream');
  const post = async body => { const res = { writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
    await service.handle(Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: '/__opencraft_wecom_mirror/send', method: 'POST', headers: {}, socket: { encrypted: true } }), res); return res; };
  await post({ source, requestId: 'wecom-assistant:'+'a'.repeat(64), text: '### 日报\n- @skipzhang 构建通过', author: 'skipzhang的助理' });
  await post({ source, requestId: 'r2', text: '人发的消息', author: 'skipzhang' });
  await Promise.allSettled([...service.pending]);
  assert.deepEqual(sent, ['**🤖 skipzhang的助理 · One**\n\n### 日报\n- @skipzhang 构建通过', 'TEXT']);
});

test('@all only for an explicit request in the asker\'s own message, at most once per cooldown', async () => {
  assert.equal(mentionsEveryone('@所有人 下午三点开会'), true);
  assert.equal(mentionsEveryone('请 @all 看一下'), true);
  assert.equal(mentionsEveryone('a@all.com 不算'), false);
  const everyone = [], named = [], regular = [];
  const transport = { subscribe: () => () => {}, respond: async (...args) => { regular.push(args); return 0; }, send: async () => { regular.push('send'); return 'delivered'; },
    chatMembers: async () => ['T1A'], senderNames: async () => new Map([['T1A', 'skipzhang']]),
    mentionMembers: async (s, ids) => { named.push(ids); return 'delivered'; },
    mentionEveryone: async (s, text) => { everyone.push(text); return 'delivered'; } };
  const allowed = new Set(); let cooldown = false;
  const store = { claimStream: async () => true, mentionAuthor: async () => null, openWindow: async () => {},
    windowOpen: async () => false, snapshot: async () => ({ binding: { serverId: 'one' } }), ingest: async () => 'stored',
    rememberMention: async () => {}, allowEveryone: async (s, id) => allowed.add(id), everyoneAllowed: async (s, id) => allowed.has(id),
    claimEveryone: async () => (cooldown ? false : (cooldown = true)) };
  const service = new MirrorService({ store, transport, servers: [], corpId: 'wxfixture', streamReplies: true });
  const settle = () => Promise.allSettled([...service.pending]);
  // The assistant writes @所有人 although nobody asked: no ping.
  await service.reply({ source, requestId: 'r1', text: '@所有人 注意', author: 'A', replyTo: 'M1' }, AbortSignal.timeout(1000)); await settle();
  assert.equal(everyone.length, 0);
  // A scheduled post (no request) cannot @all either.
  await service.reply({ source, requestId: 'r0', text: '@all 日报', author: 'A' }, AbortSignal.timeout(1000)); await settle();
  assert.equal(everyone.length, 0);
  // The owner asks for it.
  await service.ingest({ source, id: 'M2', author: 'T1A', text: '@Join 支持 @所有人 通知大家三点开会', at: 1, mentioned: true }); await settle();
  const before = regular.length;
  await service.reply({ source, requestId: 'r2', text: '@所有人 三点开会', author: 'A', replyTo: 'M2' }, AbortSignal.timeout(1000)); await settle();
  assert.equal(everyone.length, 1);
  assert.equal(regular.length, before + 1, 'Only the empty placeholder is closed before the real @all notification');
  assert.equal(regular.at(-1)[2], '');
  assert.equal(regular.at(-1)[3], true);
  assert.equal(everyone[0], '💬 A\n@所有人 三点开会');
  assert.deepEqual(named, []);
  // Within the cooldown a second one is not sent.
  await service.ingest({ source, id: 'M3', author: 'T1A', text: '@Join 支持 再 @所有人 一次', at: 2, mentioned: true }); await settle();
  await service.reply({ source, requestId: 'r3', text: '@所有人 再提醒', author: 'A', replyTo: 'M3' }, AbortSignal.timeout(1000)); await settle();
  assert.equal(everyone.length, 1);
});

test('mentionEveryone sends a rich_text @all to the bound group', async () => {
  const bodies = [];
  const fetcher = async (url, init = {}) => {
    if (url.pathname.endsWith('/gettoken')) return Response.json({ errcode: 0, access_token: 't', expires_in: 7200 });
    bodies.push(JSON.parse(init.body)); return Response.json({ errcode: 0 });
  };
  const t = createWeComChannelTransport({ corpId: 'wxfixture', corpSecret: 's', serviceId: 'fwfixture', token: 'fixture',
    aesKey: Buffer.alloc(32, 1).toString('base64').replace(/=$/, ''), relayIngress: true, fetcher });
  assert.equal(await t.mentionEveryone(source, '请看', AbortSignal.timeout(1000)), 'delivered');
  assert.deepEqual(bodies[0].rich_text[0], { type: 'mentioned', mentioned: { userlist: ['@all'] } });
});

test('authorized @all refusal or uncertain delivery never falls back to a duplicate answer', async () => {
  let outcome = 'rejected', regular = 0;
  const service = new MirrorService({ corpId: 'wxfixture', servers: [],
    store: { everyoneAllowed: async () => true, claimEveryone: async () => true },
    transport: { subscribe: () => () => {},
      respond: async () => { regular++; return 0; }, send: async () => { regular++; return 'delivered'; },
      mentionEveryone: async () => { if (outcome === 'unknown') throw Error('uncertain'); return outcome; } } });
  const input = { source, requestId: 'all', text: '@所有人 开会', author: 'A', replyTo: 'M1' };
  assert.equal(await service.reply(input, AbortSignal.timeout(1000)), 'rejected');
  outcome = 'unknown';
  await assert.rejects(service.reply(input, AbortSignal.timeout(1000)), /uncertain/);
  assert.equal(regular, 0);
});
