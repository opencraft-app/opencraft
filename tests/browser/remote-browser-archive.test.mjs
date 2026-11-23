import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RemoteBrowserService } from '../../apps/headless-server/src/remote-browser-service.mjs';
import { browserConversation } from '../../apps/headless-server/src/remote-browser-state-file.mjs';
import { ConversationResourceLifecycle } from '../../apps/headless-server/src/conversation-resource-lifecycle.mjs';

test('browser ownership resolves canonical and pre-binding draft scopes', () => {
  assert.deepEqual(browserConversation(null,{scopeId:'conversation:["h:a","t:b"]'}),{hostId:'h:a',threadId:'t:b'});
  assert.deepEqual(browserConversation({values:{bindings:JSON.stringify([{scopeId:'draft',hostId:'h',threadId:'t'}])}}, {scopeId:'draft'}),{hostId:'h',threadId:'t'});
  assert.equal(browserConversation(null,{scopeId:'draft'}),null);
});
test('archive closes all humans native pages, retains checkpoints, and fences recreation until unarchive', async () => {
  const dir=await mkdtemp(join(tmpdir(),'archive-browser-')); const closed=[];
  const service = new RemoteBrowserService({root:dir,dataDirectory:dir,ownerConnector:null});
  // Durability is covered by tests/server/conversation-resource-lifecycle.test.mjs; this exercises the browser owner.
  const lifecycle = new ConversationResourceLifecycle(null, {browser:row=>service.releaseThread(row.hostId,row.threadId)});
  service.conversationLifecycle=lifecycle;
  service.start=async()=>{}; service.request=async(id,method)=>{if(method==='close')closed.push(id);};
  try {
    await service.load();
    for(const [owner,host,thread] of [['alice','h','t'],['bob','h','t'],['alice','other','t']]) {
      const key=JSON.stringify([owner,host+'-lease']),id=createHash('sha256').update(key).digest('hex');
      const record={key,id,ownerId:owner,lifecycle:'open',link:{scopeId:'conversation:'+JSON.stringify([host,thread])},runtime:{kind:'live',generation:1},url:'https://example.com',zoom:125};
      await service.commit(draft=>draft.pages.push(record));
      service.pages.set(key,{...record,live:true});
    }
    await lifecycle.observe('h','t','archived');
    assert.equal(closed.length,2);
    assert.equal(service.store.current.pages.length,3);
    assert.equal(service.store.current.pages.filter(p=>p.runtime.kind==='absent').length,2);
    assert.equal(service.store.current.pages[0].url,'https://example.com');
    assert.throws(()=>service.assertConversation('alice',JSON.stringify(['alice','h-lease'])));
    service.assertConversation('alice',JSON.stringify(['alice','other-lease']));
    await lifecycle.observe('h','t','active');
    service.assertConversation('alice',JSON.stringify(['alice','h-lease']));
    assert.equal(service.pages.get(JSON.stringify(['alice','h-lease'])).live,false);
  } finally {await lifecycle.close();await service.close();await service.persistence; await rm(dir,{recursive:true,force:true});}
});
