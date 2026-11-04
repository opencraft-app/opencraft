import assert from 'node:assert/strict';
import test from 'node:test';

import {createReplicaConversationRuntime} from '@opencraft/chat-runtime';
import {createConversationKey} from '@opencraft/chat-core';
function fixture(){
 const listeners=new Set();let entity={hostId:'local',threadId:'a',thread:{id:'a',turns:[]},turns:[],turnsPagination:{olderCursor:'older',isLoadingOlder:false,hasLoadedOldest:false}};
 let value={revision:1,storageKey:'synthetic',scope:'appserver-thread:local:a',phase:'live',authoritative:true,epoch:'synthetic',nextSeq:2,journalStartSeq:1,entities:new Map([['a',entity]]),lastError:null};
 const replica={getSnapshot:()=>value,subscribe(f){listeners.add(f);return ()=>listeners.delete(f);}};
 const failure=new Error('synthetic older page timeout');let fail=true;
 const runtime=createReplicaConversationRuntime({key:createConversationKey('local','a'),replica,commands:{},history:{async loadOlder(){if(fail)throw failure;}}});
 return {runtime,failure,setAuthority(authoritative){value={...value,revision:value.revision+1,phase:authoritative?'live':'reconnecting',authoritative};for(const f of listeners)f();},setEntity(newEntity){entity={...entity,...newEntity};value={...value,revision:value.revision+1,entities:new Map([['a',entity]])};for(const f of listeners)f();},allowSuccess(){fail=false;}};
}
test('successful authority restoration clears a failed older-page error in the Conversation cache',async()=>{
 const f=fixture();try{
  await assert.rejects(f.runtime.loadOlder(),/synthetic/);assert.equal(f.runtime.getSnapshot().history.error,f.failure);
  f.setAuthority(false);f.setEntity({historyError:null,turnsPagination:{olderCursor:'new-older',isLoadingOlder:false,hasLoadedOldest:false}});f.setAuthority(true);
  assert.equal(f.runtime.getSnapshot().authoritative,true);assert.equal(f.runtime.getSnapshot().history.error,null);
  f.allowSuccess();await f.runtime.loadOlder();assert.equal(f.runtime.getSnapshot().history.error,null);
 }finally{f.runtime.dispose();}
});
test('terminal history coverage clears the old failure when no older page remains',async()=>{
 const f=fixture();try{
  await assert.rejects(f.runtime.loadOlder(),/synthetic/);
  f.setAuthority(false);f.setEntity({historyError:null,turnsPagination:{olderCursor:null,isLoadingOlder:false,hasLoadedOldest:true}});f.setAuthority(true);
  assert.equal(f.runtime.getSnapshot().history.hasOlder,false);assert.equal(f.runtime.getSnapshot().history.error,null);
  f.allowSuccess();await f.runtime.loadOlder();assert.equal(f.runtime.getSnapshot().history.error,null);
 }finally{f.runtime.dispose();}
});
