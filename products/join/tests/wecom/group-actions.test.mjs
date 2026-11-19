import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCreateChat, parseEditChat } from '../../plugins/wecom/group-actions.mjs';
import { MirrorService } from '../../plugins/wecom/mirror/service.mjs';

test('the /建群 line yields a title and distinct members', () => {
  assert.deepEqual(parseCreateChat('好的\n/建群 事故 #123 讨论 @zhangsan @lisi @zhangsan'), { title: '事故 #123 讨论', members: ['zhangsan', 'lisi'] });
  assert.equal(parseCreateChat('我们可以 /建群 吗'), null);
  assert.equal(parseCreateChat('/建群 @lisi'), null);
});

test('chat-create creates the group with owner and found members, binds it and reports missing names', async () => {
  const calls = [];
  const transport = { subscribe: () => () => {},
    chatMembers: async () => ['T1A', 'T2B'],
    userIds: async names => new Map(names.filter(n => n !== 'nobody').map(n => [n, 'U-' + n])),
    createChat: async (name, users) => { calls.push(['create', name, users]); return 'NEWSRC'; },
    sendMarkdown: async m => { calls.push(['md', m.source, m.text]); return 'delivered'; } };
  const store = { snapshot: async () => ({ binding: { serverId: 'one' } }), bind: async (...a) => { calls.push(['bind', ...a]); } };
  const service = new MirrorService({ store, transport, servers: [{ id: 'one', name: 'One', credential: 'c'.repeat(43) }], corpId: 'wxfixture' });
  service.authenticate = () => service.servers.get('one');
  const res = { writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
  const { Readable } = await import('node:stream');
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ source: 'ORIGIN', title: '事故 #123', owner: 'T1A', members: ['zhangsan', 'nobody'] }))]),
    { url: '/__opencraft_wecom_mirror/chat-create', method: 'POST', headers: {}, socket: { encrypted: true } });
  await service.handle(req, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(calls[0], ['create', '事故 #123', ['T1A', 'U-zhangsan']]);
  assert.equal(calls[1][0], 'bind'); assert.equal(calls[1][1], 'NEWSRC'); assert.equal(calls[1][3], 'one');
  assert.match(calls.at(-1)[2], /未找到：nobody/u);

  const deny = Object.assign(Readable.from([Buffer.from(JSON.stringify({ source: 'ORIGIN', title: 'x', owner: 'T9Z', members: [] }))]),
    { url: '/__opencraft_wecom_mirror/chat-create', method: 'POST', headers: {}, socket: { encrypted: true } });
  await service.handle(deny, res);
  assert.equal(res.status, 403, 'only a member of the origin group can own the new group');
});

test('/拉人 /移出 /改群名 lines merge into one edit', () => {
  assert.deepEqual(parseEditChat('好的\n/拉人 @wangwu @lisi\n/移出 @zhaoliu\n/改群名 事故#123 已解决'), { add: ['wangwu', 'lisi'], remove: ['zhaoliu'], name: '事故#123 已解决' });
  assert.deepEqual(parseEditChat('/踢人 @a1 \n/拉人 @a1'), { add: ['a1'], remove: [] });
  assert.equal(parseEditChat('能不能 /拉人 @x 呢'), null);
  assert.equal(parseEditChat('普通回复'), null);
  assert.deepEqual(parseEditChat('/拉人 @ruippan\n/移出 @ruippan'), {add:[],remove:['ruippan']});
  assert.deepEqual(parseEditChat('/移出 @ruippan\n/拉人 @ruippan\n/移出 @ruippan'), {add:[],remove:['ruippan']});
});

test('chat-update adds non-members, removes members except the requester, renames, and reports', async () => {
  const calls = [];
  const transport = { subscribe: () => () => {},
    chatMembers: async () => ['T1A', 'U-lisi'],
    userIds: async names => new Map(names.filter(n => n !== 'nobody').map(n => [n, n === 'me' ? 'T1A' : 'U-' + n])),
    updateChat: async (s, change) => { calls.push(['update', s, change]); return 'delivered'; },
    sendMarkdown: async m => { calls.push(['md', m.text]); return 'delivered'; } };
  const store = { snapshot: async () => ({ binding: { serverId: 'one' } }) };
  const service = new MirrorService({ store, transport, servers: [{ id: 'one', name: 'One', credential: 'c'.repeat(43) }], corpId: 'wxfixture' });
  service.authenticate = () => service.servers.get('one');
  service.authorizedSource = async () => {};
  const { Readable } = await import('node:stream');
  const send = async body => {
    const res = { writeHead(s) { this.status = s; }, end(b) { this.body = b && JSON.parse(b); } };
    await service.handle(Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),
      { url: '/__opencraft_wecom_mirror/chat-update', method: 'POST', headers: {}, socket: { encrypted: true } }), res);
    return res;
  };
  let res = await send({ source: 'ROOM', owner: 'T1A', add: ['wangwu', 'lisi', 'nobody'], remove: ['lisi', 'me'], name: '已解决' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(calls[0], ['update', 'ROOM', { name: '已解决', add: ['U-wangwu'], remove: ['U-lisi'] }]);
  assert.match(calls[1][1], /群名：已解决[\s\S]*拉入：@wangwu[\s\S]*移出：lisi[\s\S]*未找到：nobody/u);
  res = await send({ source: 'ROOM', owner: 'T9Z', add: ['wangwu'], remove: [] });
  assert.equal(res.status, 403, 'only a current member can change the group');
});
