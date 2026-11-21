import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationResourceTransport } from '../../apps/headless-server/src/conversation-resource-transport.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';

test('only successful archive and engine events retire resources, independently of UI subscribers', async () => {
  let receive!: (frame: string) => void; const observed: unknown[] = [];
  const inner: any = { status: { state: 'open' }, subscribeMessage(fn: any) { receive=fn; return ()=>{}; },
    subscribeStatus:()=>()=>{}, send: async()=>{}, close: async()=>{} };
  const wrapper = new ConversationResourceTransport(inner, 'host', {
    assertActive() {}, observe: async (...args) => { observed.push(args); },
  });
  const send = (client:string,id:number,method:string,threadId:string) => wrapper.send(JSON.stringify({id,method,params:{threadId},[LOGICAL_CLIENT_FIELD]:client}));
  const reply = (client:string,id:number,body:object) => receive(JSON.stringify({id,...body,[LOGICAL_CLIENT_FIELD]:client}));
  await send('a',1,'thread/archive','first'); await send('b',1,'thread/archive','second');
  reply('a',1,{error:{code:403}}); reply('b',1,{result:{}});
  assert.deepEqual(observed,[['host','second','archived']]);
  await send('b',2,'thread/archive','second');
  receive(JSON.stringify({method:'thread/archived',params:{threadId:'second'}}));
  receive(JSON.stringify({method:'thread/unarchived',params:{threadId:'second'}}));
  reply('b',2,{result:{}});
  assert.deepEqual(observed.slice(-2),[['host','second','archived'],['host','second','active']]);
  await wrapper.close();
});
