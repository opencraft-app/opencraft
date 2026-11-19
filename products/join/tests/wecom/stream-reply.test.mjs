import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MirrorService, streamIdFor, STILL_WORKING, PLACEHOLDER_TIMEOUT_MS } from '../../plugins/wecom/mirror/service.mjs';
import { communicationExtension } from '../../plugins/wecom/assistant-extension.mjs';

const source = JSON.stringify(['wecom-customer-service', 'wxfixture', 'fwfixture', 'room']);
function fixture({ streamReplies = true, capable = true, bound = true, respond = async () => 0 } = {}) {
  const calls = { respond: [], send: [], markdown: [] };
  const claimed = new Set();
  const store = {
    ingest: async () => 'stored',
    snapshot: async () => ({ binding: bound ? { serverId: 'one' } : null }),
    serverCapabilities: async () => (capable ? { streamReplies: true } : { recording: true }),
    async streamClaimed(s, id) { return claimed.has(s + id); },
    async claimStream(s, id) { const k = s + id; if (claimed.has(k)) return false; claimed.add(k); this.placeholders.delete(JSON.stringify([s, id])); return true; },
    placeholders: new Map(),
    async trackPlaceholder(s, id, at = Date.now()) { this.placeholders.set(JSON.stringify([s, id]), at); },
    async stalePlaceholders(cutoff) { return [...this.placeholders].filter(([, at]) => at <= cutoff).map(([member]) => { const [source, msgId] = JSON.parse(member); return { source, msgId, member }; }); },
    async dropPlaceholder(member) { this.placeholders.delete(member); },
  };
  const transport = {
    subscribe: () => () => {},
    respond: async (...args) => { calls.respond.push(args.slice(0, 4)); return respond(...args); },
    send: async input => { calls.send.push(input); return 'delivered'; },
    sendMarkdown: async input => { calls.markdown.push(input); return 'delivered'; },
  };
  const service = new MirrorService({ store, transport, servers: [], corpId: 'wxfixture', streamReplies, followUpDelay: 0 });
  return { service, calls, store };
}
const flush = async svc => { await new Promise(r => setTimeout(r, 20)); await Promise.allSettled([...svc.pending]); };
const mention = { source, id: 'MSG-1', author: 'T1A', text: '@bot hi', at: 1, mentioned: true };

test('assistant mentions are ingested without immediate placeholder streams', async () => {
  const on = fixture();
  await on.service.ingest(mention); await flush(on.service);
  assert.deepEqual(on.calls.respond, []);
  for (const options of [{ streamReplies: false }, { capable: false }, { bound: false }]) {
    const off = fixture(options);
    await off.service.ingest(mention); await flush(off.service);
    assert.equal(off.calls.respond.length, 0, JSON.stringify(options));
  }
  const command = fixture();
  await command.service.ingest({ ...mention, text: '@bot 帮助' }); await flush(command.service);
  assert.equal(command.calls.respond.length, 0);
});

test('first reply finishes the placeholder stream, later parts and fallbacks are separate', async () => {
  const f = fixture();
  const input = { source, requestId: 'r1', text: '答案 **ok**', author: '张三的助理', presentation: {version:1,sender:{id:'assistant-actor',role:'assistant',displayName:'张三的助理'},format:'markdown'}, replyTo: 'MSG-1' };
  assert.equal(await f.service.reply(input, AbortSignal.timeout(1000)), 'delivered');
  assert.deepEqual(f.calls.respond[0], ['MSG-1', streamIdFor(source, 'MSG-1'), '**🤖 张三的助理**\n\n答案 **ok**', true]);
  await f.service.reply({ ...input, requestId: 'r2', text: '第二段' }, AbortSignal.timeout(1000));
  assert.equal(f.calls.respond[1][1], streamIdFor(source, 'MSG-1', 'r2'));
  assert.equal(f.calls.send.length, 0);

  const expired = fixture({ respond: async () => 780013 });
  assert.equal(await expired.service.reply(input, AbortSignal.timeout(1000)), 'delivered');
  assert.equal(expired.calls.markdown.length, 1, 'definitive provider refusal falls back to Markdown');
  assert.equal(expired.calls.send.length,0);

  const huge = fixture();
  await huge.service.reply({ ...input, text: '字'.repeat(7000) }, AbortSignal.timeout(1000));
  assert.equal(huge.calls.respond.length, 0); assert.ok(huge.calls.markdown.length>1); assert.equal(huge.calls.send.length, 0);

  const broken = fixture({ respond: async () => { throw Error('network'); } });
  await assert.rejects(broken.service.reply(input, AbortSignal.timeout(1000)), /network/);
  assert.equal(broken.calls.send.length, 0, 'uncertain outcomes are never resent');
  assert.equal(broken.calls.markdown.length,0);
});

test('replyTarget follows the latest unanswered mention; later output and notices behave', () => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE actor_messages(id TEXT, seq INTEGER, content TEXT);
    CREATE TABLE join_wecom_assistant_requests(message_id TEXT, scope TEXT);
    CREATE TABLE join_wecom_assistant_replies(message_id TEXT, request_id TEXT, payload_hash TEXT);
    CREATE TABLE actor_channel_external_messages(message_id TEXT, source TEXT, external_id TEXT, sender_id TEXT, fingerprint TEXT);
    INSERT INTO actor_messages VALUES('in-1',1,''),('reply-1',2,'a'),('in-2',3,''),('reply-2a',4,'b1'),('reply-2b',5,'b2'),('report',6,'日报'),('in-3',7,''),('notice',8,'n');
    INSERT INTO join_wecom_assistant_requests VALUES('in-1','S'),('in-2','S'),('in-3',NULL);
    INSERT INTO join_wecom_assistant_replies VALUES('reply-1','in-1','h1'),('reply-2a','in-1','h2'),('reply-2b','in-1','h2'),('report','in-1','h3'),('notice','in-3','h4');
    INSERT INTO actor_channel_external_messages VALUES('in-1','s','MSG-1','x','f'),('in-2','s','MSG-2','x','f'),('in-3','s','MSG-3','x','f');`);
  assert.equal(communicationExtension.replyTarget(db, 'reply-1'), 'MSG-1');
  assert.equal(communicationExtension.replyTarget(db, 'reply-2a'), 'MSG-2');
  assert.equal(communicationExtension.replyTarget(db, 'reply-2b'), 'MSG-2', 'chunks of one reply share the target');
  assert.equal(communicationExtension.replyTarget(db, 'report'), undefined, 'output after an answered mention posts on its own');
  assert.equal(communicationExtension.replyTarget(db, 'notice'), 'MSG-3');
});
