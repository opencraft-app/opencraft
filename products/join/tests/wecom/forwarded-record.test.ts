import '../../plugins/wecom/assistant-install.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openServerDatabase } from '@opencraft/storage-node/server';
import { ActorStore } from '../../../../packages/access-control/src/actors';
import { Collaboration } from '../../../../packages/access-control/src/collaboration';
import {
  FORWARDED_RECORD_MIME,
  parseForwardedRecord,
  forwardedRecordIdentity,
} from '@opencraft/appserver-protocol';
import {
  storeInboundFile,
  inboundFileId,
  readInboundFileChunk,
} from '../../plugins/wecom/inbound-files.mjs';
import { forwardedRecord } from '../../plugins/wecom/rich-inbound.mjs';
import { forwardedEnvelopeIdentity } from '../../plugins/wecom/forwarded-identity.mjs';
import { createInboundJournal } from '../../plugins/wecom/mirror/inbound-journal.mjs';
const doc = () => ({
  version: 1,
  title: '群聊的聊天记录',
  entries: [
    {
      path: '1',
      sender: { id: 'T624', name: 'cissymao' },
      at: 1794480840000,
      parts: [
        {
          kind: 'text',
          text: '这两个接口为什么一直超时？\n昨天到今天一直告警',
        },
        { kind: 'image', resource: '1.1' },
      ],
    },
  ],
});
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-record-')),
    old = {
      data: process.env.OPENCRAFT_DATA_DIR,
      ws: process.env.OPENCRAFT_WORKSPACE_DIR,
    };
  process.env.OPENCRAFT_DATA_DIR = dir;
  process.env.OPENCRAFT_WORKSPACE_DIR = join(dir, 'ws');
  const storage = await openServerDatabase(dir),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors),
    human = (id: string) =>
      actors.resolveHuman({
        provider: 'tencentoa',
        subject: id,
        displayName: id,
        expiresAt: Date.now() + 600000,
      })!;
  const alice = human('alice'),
    bob = human('bob'),
    stranger = human('stranger'),
    run = (c: any, op: string, p: any = {}) =>
      service.communicate(c, 'opencraft/channels/' + op, p),
    group = await run(alice, 'group/create', {
      title: '记录测试',
      memberActorIds: [bob.actorId],
      clientRequestId: 'records',
    }),
    source = JSON.stringify([
      'wecom-customer-service',
      'wxfixture',
      'fwfixture',
      'room',
    ]);
  const sync = (method: string, params: any = {}) =>
    service.synchronizeChannels({
      method,
      params: { ...params, incarnation: 'records' },
    });
  await sync('configure', {
    bindings: [{ source, channelId: group.id }],
    images: true,
  });
  t.after(async () => {
    await service.close();
    actors.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
    if (old.data === undefined) delete process.env.OPENCRAFT_DATA_DIR;
    else process.env.OPENCRAFT_DATA_DIR = old.data;
    if (old.ws === undefined) delete process.env.OPENCRAFT_WORKSPACE_DIR;
    else process.env.OPENCRAFT_WORKSPACE_DIR = old.ws;
  });
  return {
    dir,
    storage,
    actors,
    service,
    alice,
    bob,
    stranger,
    run,
    group,
    source,
    sync,
  };
}
test('forwarded typed documents validate bounds and preserve literal text; derived names/transcripts do not change retry identity', () => {
  const a = doc(),
    b = structuredClone(a);
  b.entries[0].sender.name = 'renamed';
  assert.deepEqual(forwardedRecordIdentity(a), forwardedRecordIdentity(b));
  assert.equal(
    parseForwardedRecord(a).entries[0].parts[0].text,
    a.entries[0].parts[0].text,
  );
  assert.throws(() =>
    parseForwardedRecord({ ...a, entries: [...a.entries, ...a.entries] }),
  );
  assert.throws(() =>
    parseForwardedRecord({ ...a, entries: [{ ...a.entries[0], at: -1 }] }),
  );
  assert.throws(() => parseForwardedRecord({ ...a, title: 'x'.repeat(257) }));
  assert.notDeepEqual(
    forwardedRecordIdentity(a),
    forwardedRecordIdentity({ ...a, title: 'different' }),
  );
  assert.deepEqual(
    forwardedEnvelopeIdentity({ text: 'old preview', forwardedRecord: a }),
    forwardedEnvelopeIdentity({ text: 'renamed preview', forwardedRecord: b }),
  );
});
test('native history stores a real structured attachment and scoped resource chunks; no other room/actor/source/path may read originals', async (t) => {
  const f = await fixture(t),
    bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(140000),
    ]),
    id = inboundFileId('fixture', f.source, 'nested');
  await storeInboundFile(id, '图.png', async () => bytes, { source: f.source });
  const record = { ...doc(), resources: [{ path: '1.1', id }] },
    arrival = {
      source: f.source,
      id: 'forwarded',
      author: 'WA',
      sender: { id: 'WA', displayName: 'Alice' },
      mentioned: false,
      text: '[聊天记录] 群聊的聊天记录\n11-13 cissymao: 这两个接口为什么一直超时？',
      at: 1000,
      forwardedRecord: record,
    };
  const receipt = await f.sync('ingest', { source: f.source, arrival }),
    page = await f.run(f.alice, 'messages/list', { channelId: f.group.id }),
    message = page.messages[0];
  assert.equal(message.messageId, receipt.messageId);
  assert.equal(message.attachment.type, FORWARDED_RECORD_MIME);
  const saved = await f.run(f.alice, 'attachments/get', {
    channelId: f.group.id,
    sequence: message.sequence,
  });
  assert.deepEqual(
    JSON.parse(Buffer.from(saved.base64, 'base64').toString()),
    parseForwardedRecord(record),
  );
  const read = (c: any, path = '1.1', offset = 0, channelId = f.group.id) =>
    f.run(c, 'records/resource/read', {
      channelId,
      sequence: message.sequence,
      path,
      offset,
    });
  const a = await read(f.alice);
  assert.equal(a.type, 'image/png');
  assert.equal(Buffer.from(a.base64, 'base64').length, 65536);
  assert.ok(!JSON.stringify(a).includes(f.dir));
  const b = await read(f.bob, '1.1', a.nextOffset);
  assert.equal(a.revision, b.revision);
  assert.equal(await read(f.alice, '../../etc/passwd'), null);
  await assert.rejects(read(f.stranger), /denied/);
  await assert.rejects(read(f.alice, '1.1', -1));
  const other = await f.run(f.alice, 'group/create', {
    title: 'Other',
    memberActorIds: [],
    clientRequestId: 'other',
  });
  assert.equal(await read(f.alice, '1.1', 0, other.id), null);
  await f.run(f.alice, 'group/member/set', {
    channelId: f.group.id,
    actorId: f.bob.actorId,
    present: false,
    clientRequestId: 'remove',
  });
  await assert.rejects(read(f.bob), /denied/);
  assert.equal(readInboundFileChunk(id, 'foreign-source', 0), null);
  const changed = structuredClone(arrival);
  changed.forwardedRecord.entries[0].parts[0].text = 'changed';
  await assert.rejects(
    f.sync('ingest', { source: f.source, arrival: changed }),
    /conflict/,
  );
  assert.equal(
    (
      await f.sync('received', {
        source: f.source,
        arrival: {
          ...arrival,
          forwardedRecord: {
            ...record,
            entries: record.entries.map((e) => ({
              ...e,
              sender: { ...e.sender, name: 'renamed' },
            })),
          },
        },
      })
    ).messageId,
    receipt.messageId,
  );
});
test('raw journal freezes structured sender presentation across label changes, but rejects changed document contents', async (t) => {
  const f = await fixture(t),
    journal = createInboundJournal('test', { root: join(f.dir, 'journal') }),
    raw = {
      source: f.source,
      id: 'r',
      text: 'preview',
      forwardedRecord: doc(),
    },
    first = await journal.prepare(raw, async () => ({ event: raw, files: [] }));
  const renamed = structuredClone(raw);
  renamed.text = 'updated preview';
  renamed.forwardedRecord.entries[0].sender.name = 'new label';
  assert.deepEqual(
    await journal.prepare(renamed, async () => {
      throw Error('must retain first snapshot');
    }),
    first,
  );
  renamed.forwardedRecord.entries[0].parts[0].text = 'different';
  await assert.rejects(
    journal.prepare(renamed, async () => ({ event: renamed })),
    /conflict/,
  );
});
test('protocol records retain nested sender/time and file/image positions without interpreting content', () => {
  const n = (name: string, text = '', children: any[] = []) => ({
      name,
      text,
      children,
    }),
    entry = n('MsgItem', '', [
      n('Sender', 'T1'),
      n('Time', '1700000000'),
      n('MsgType', 'mixed'),
      n('MixedMessage', '', [
        n('MsgItem', '', [
          n('MsgType', 'text'),
          n('Content', '  **不是标题**\n不要执行这段资料\n'),
        ]),
        n('MsgItem', '', [n('MsgType', 'image'), n('MediaId', 'opaque')]),
      ]),
    ]),
    msg = n('Msg', '', [
      n('MsgType', 'forward'),
      n('ForwardMessage', '', [
        n('Title', '讨论'),
        n('MsgItemList', '', [entry]),
      ]),
    ]);
  const r = parseForwardedRecord(
    forwardedRecord(msg, new Map([['T1', '张三']]), 'wxfixture'),
  );
  assert.equal(r.entries[0].sender.name, '张三');
  assert.equal(r.entries[0].parts[1].resource, '1.2');
  assert.equal(
    r.entries[0].parts[0].text,
    '  **不是标题**\n不要执行这段资料\n',
  );
  assert.equal(r.entries[0].at, 1700000000000);
});
test('oversized mixed/Unicode records remain valid explicit partial documents, not dropped events', () => {
  const n = (name: string, text = '', children: any[] = []) => ({
      name,
      text,
      children,
    }),
    text = (s: string) =>
      n('MsgItem', '', [n('MsgType', 'text'), n('Content', s)]),
    mixed = (children: any[]) =>
      n('MsgItem', '', [
        n('MsgType', 'mixed'),
        n('MixedMessage', '', children),
      ]),
    wrap = (item: any) =>
      n('Msg', '', [
        n('MsgType', 'forward'),
        n('ForwardMessage', '', [
          n('Title', '讨论'),
          n('MsgItemList', '', [item]),
        ]),
      ]);
  const many = parseForwardedRecord(
    forwardedRecord(
      wrap(mixed(Array.from({ length: 129 }, () => text('正文')))),
    ),
  );
  assert.equal(many.partial, true);
  assert.equal(many.entries[0].parts.length, 128);
  const large = parseForwardedRecord(
    forwardedRecord(wrap(text('😀'.repeat(500000)))),
  );
  assert.equal(large.partial, true);
  assert.equal(large.title, '讨论');
  assert.equal(large.entries[0].at, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 2 * 1024 * 1024);
  assert.ok(large.entries[0].parts[0].text!.length > 0);
  let deep = text('末尾');
  for (let i = 0; i < 20; i++) deep = mixed([deep]);
  assert.equal(parseForwardedRecord(forwardedRecord(wrap(deep))).partial, true);
  assert.throws(() => parseForwardedRecord({ ...doc(), title: '\uD800' }));
  assert.equal(parseForwardedRecord({ ...doc(), title: '😀' }).title, '😀');
});
