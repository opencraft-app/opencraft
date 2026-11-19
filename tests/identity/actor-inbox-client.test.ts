import assert from 'node:assert/strict';
import test from 'node:test';
import { ActorInboxClient } from '../../packages/appserver-client/src/actor-inbox';
import type { ActorInboxPage } from '../../packages/appserver-protocol/src/actor-inbox';
const item = { channelId: 'dm:a', kind: 'direct' as const, peerActorId: 'peer', unreadCount: 1,
  latestMessage: { id: 'message', sequence: '1', authorId: 'peer', text: 'hello', at: 1 } };
const page = (revision: string, reset = false): ActorInboxPage => ({ actorId: 'human', reset, cursor: revision,
  hasMore: false, changes: [{ channelId: item.channelId, revision, item }] });

test('replica rejects another identity, preserves data on transient errors and clears on auth expiry', async () => {
  let response: unknown = page('1', true), error: unknown;
  const client = new ActorInboxClient('human', { async sync() { if (error) throw error; return response; } });
  await client.refresh();
  response = { ...page('2'), actorId: 'other' };
  await assert.rejects(client.refresh(), /Invalid Inbox/);
  assert.equal(client.items.length, 1);
  error = new Error('offline');
  await assert.rejects(client.refresh(), /offline/);
  assert.equal(client.items.length, 1);
  error = Object.assign(new Error('expired'), { status: 401 });
  await assert.rejects(client.refresh(), /expired/);
  assert.deepEqual(client.items, []);
  await assert.rejects(client.refresh(), /closed/);
});

test('closing an identity discards a late transport response even when transport ignores abort', async () => {
  let complete!: (value: unknown) => void;
  const client = new ActorInboxClient('human', { sync: () => new Promise(resolve => { complete = resolve; }) });
  const pending = client.refresh();
  client.close(); complete(page('1', true));
  await assert.rejects(pending, /closed/);
  assert.deepEqual(client.items, []);
});

test('replica keeps tombstone revisions, resets on new epoch and drains all pages', async () => {
  const pages: ActorInboxPage[] = [
    { ...page('1', true), hasMore: true },
    { ...page('3'), changes: [{ channelId: item.channelId, revision: '3', item: null }] },
    page('2'), page('1', true),
  ];
  const cursors: (string | undefined)[] = [];
  const client = new ActorInboxClient('human', { async sync(cursor) { cursors.push(cursor); return pages.shift(); } });
  await client.refresh();
  assert.deepEqual(client.items, []);
  assert.deepEqual(cursors, [undefined, '1']);
  await client.refresh();
  assert.deepEqual(client.items, []);
  await client.refresh();
  assert.equal(client.items.length, 1);
  client.close();
});

test('group replica preserves the unread-mention destination and rejects malformed sequences', async()=>{
 let destination:unknown=12;
 const client=new ActorInboxClient('human',{async sync(){return {actorId:'human',reset:true,cursor:'1',hasMore:false,changes:[{channelId:'group:g',revision:'1',item:{channelId:'group:g',kind:'group',title:'Room',unreadCount:0,mentionUnreadCount:1,firstUnreadMentionSequence:destination,latestMessage:null}}]}}});
 await client.refresh();assert.equal(client.items[0]!.firstUnreadMentionSequence,12);
 for(destination of [0,-1,1.5,'12',Number.MAX_SAFE_INTEGER+1])await assert.rejects(client.refresh(),/Invalid Inbox mention destination/);
 client.close();
});
