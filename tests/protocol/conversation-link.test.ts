import assert from 'node:assert/strict';
import test from 'node:test';
import {conversationLink, encodeConversationRef, parseConversationRef} from '../../packages/appserver-protocol/src/collaboration';

const ref={serverId:'stable:server',threadId:'thread-B'};

test('conversation links replace stale query and fragment while preserving the base path',()=>{
 for (const suffix of ['', '?token=stale&conversation=old', '#old-route?token=stale', '?token=stale&conversation=old#old-route']) {
  const link=conversationLink('https://example.com:8443/nested/a%23b/'+suffix,ref);
  const url=new URL(link);
  assert.equal(url.origin,'https://example.com:8443');
  assert.equal(url.pathname,'/nested/a%23b/');
  assert.equal(url.hash,'');
  assert.deepEqual([...url.searchParams], [['conversation',encodeConversationRef(ref)]]);
  assert.deepEqual(parseConversationRef(link),ref);
 }
});
