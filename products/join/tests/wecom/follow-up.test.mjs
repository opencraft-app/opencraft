import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MirrorService, streamIdFor, FOLLOW_UP_WINDOW_MS, FOLLOW_UP_PLACEHOLDER_DELAY_MS } from '../../plugins/wecom/mirror/service.mjs';

const source = JSON.stringify(['wecom-customer-service', 'wxfixture', 'fwfixture', 'room']);
function fixture({ followUps = true } = {}) {
  const kv = new Map(), windows = new Map(), calls = { ingest: [], respond: [] };
  const store = {
    snapshot: async () => ({ binding: { serverId: 'one' } }),
    serverCapabilities: async () => ({ streamReplies: true }),
    ingest: async e => { calls.ingest.push(e); return 'stored'; },
    rememberMention: async (s, id, a) => kv.set('m' + id, a), mentionAuthor: async (s, id) => kv.get('m' + id) ?? null,
    openWindow: async (s, a) => windows.set(a, true), windowOpen: async (s, a) => windows.has(a),
    trackPlaceholder: async () => {}, streamClaimed: async (s, id) => kv.has('c' + id),
    claimStream: async (s, id) => kv.has('c' + id) ? false : (kv.set('c' + id, 1), true),
  };
  const transport = { subscribe: () => () => {}, respond: async (...a) => { calls.respond.push(a); return 0; }, send: async () => 'delivered' };
  const service = new MirrorService({ store, transport, servers: [], corpId: 'wxfixture', streamReplies: true, followUps, followUpDelay: 30 });
  return { service, calls, windows };
}
const msg = (id, author, text, mentioned = false) => ({ source, id, author, text, at: 1, mentioned });
const settle = async svc => { await new Promise(r => setTimeout(r, 60)); await Promise.allSettled([...svc.pending]); };

test('an @ opens a window: the same person can follow up without @, others cannot', async () => {
  const f = fixture();
  await f.service.ingest(msg('M1', 'T1A', '@bot 中午吃什么', true));
  await f.service.ingest(msg('M2', 'T1A', '要辣的'));
  await f.service.ingest(msg('M3', 'T2B', '我也饿了'));
  await f.service.ingest(msg('M4', 'T1A', '帮助'));
  await settle(f.service);
  assert.deepEqual(f.calls.ingest.map(e => [e.id, e.mentioned]), [['M1', true], ['M2', true], ['M3', false], ['M4', false]]);
});

test('intake never posts per-message typing bubbles; fast replies do not leave late dots',async()=>{
 const f=fixture();await f.service.ingest(msg('M1','T1A','@bot q',true));await f.service.ingest(msg('M2','T1A','补充'));
 await settle(f.service);assert.equal(f.calls.respond.length,0);
 await f.service.reply({source,requestId:'r',text:'答案',author:'A',replyTo:'M2'},AbortSignal.timeout(1000));
 await settle(f.service);assert.equal(f.calls.respond.length,1);assert.equal(f.calls.respond[0][3],true);
});

test('an answer reopens the requester\x27s window; disabled follow-ups keep @-only behaviour', async () => {
  const f = fixture();
  await f.service.ingest(msg('M1', 'T1A', '@bot q', true)); await settle(f.service);
  f.windows.clear();
  await f.service.reply({ source, requestId: 'r', text: '答案', author: 'A', replyTo: 'M1' }, AbortSignal.timeout(1000)); await settle(f.service);
  assert.ok(f.windows.has('T1A'));
  const off = fixture({ followUps: false });
  await off.service.ingest(msg('M1', 'T1A', '@bot q', true)); await off.service.ingest(msg('M2', 'T1A', '追问'));
  assert.equal(off.calls.ingest[1].mentioned, false);
});

test('image/voice/file follow-ups renew only their sender window without immediate typing acknowledgement',async()=>{
 const f=fixture();await f.service.ingest(msg('start','T1A','@bot 看一下',true));
 const seen=new Set(),decisions=new Map();f.service.store.followUpDecision=async(s,id,author)=>{if(!decisions.has(id))decisions.set(id,f.windows.has(author));return decisions.get(id);};
 f.service.store.ingest=async(e,bytes)=>{f.calls.ingest.push(e);if(seen.has(e.id))return'duplicate';if(e.mediaId&&!bytes)return'media_required';seen.add(e.id);return'stored';};
 let fail=true;f.service.transport.images={download:async()=>{if(fail){fail=false;throw Error('temporary');}return Buffer.from([137,80,78,71,13,10,26,10]);}};
 const image={...msg('image','T1A',''),mediaId:'picture'};await assert.rejects(f.service.ingest(image));f.windows.clear();await f.service.ingest(image);await settle(f.service);
 assert.ok(f.calls.ingest.filter(e=>e.id==='image').every(e=>e.mentioned));assert.ok(f.windows.has('T1A'));assert.equal(f.calls.respond.length,0);
 await f.service.ingest({...msg('file','T1A','[文件] x.pdf'),file:{mediaId:'f',name:'x.pdf'}});await f.service.ingest({...msg('voice','T1A','[语音]'),voice:{mediaId:'v',format:'amr'}});await f.service.ingest({...msg('other','T2B',''),mediaId:'other'});
 assert.equal(f.calls.ingest.find(e=>e.id==='file').mentioned,true);assert.equal(f.calls.ingest.find(e=>e.id==='voice').mentioned,true);assert.equal(f.calls.ingest.find(e=>e.id==='other').mentioned,false);
});


test('five-minute follow-ups are scoped to one sender and room, renew on activity and expire at the boundary',async()=>{
 const f=fixture(),windows=new Map(),durations=[];let now=0;
 const key=(s,a)=>JSON.stringify([s,a]);
 f.service.store.openWindow=async(s,a,ms)=>{durations.push(ms);windows.set(key(s,a),now+ms);};
 f.service.store.windowOpen=async(s,a)=>(windows.get(key(s,a))??0)>now;
 assert.equal(FOLLOW_UP_WINDOW_MS,300000);
 assert.equal(FOLLOW_UP_PLACEHOLDER_DELAY_MS,0,'waiting is immediate independently of the five-minute follow-up window');
 await f.service.ingest(msg('start5','T1A','@bot q',true));
 now=31000;await f.service.ingest(msg('after30','T1A','补充说明'));
 now=4*60000;await f.service.ingest(msg('before5','T1A','再补充'));
 await f.service.ingest(msg('other-person','T2B','不是我的追问'));
 await f.service.ingest({...msg('other-room','T1A','别的群'),source:source.replace('room','another-room')});
 now=4*60000+300000;await f.service.ingest(msg('expired5','T1A','过期了'));
 assert.deepEqual(f.calls.ingest.map(e=>[e.id,e.mentioned]),[['start5',true],['after30',true],['before5',true],['other-person',false],['other-room',false],['expired5',false]]);
 assert.deepEqual(durations,[300000,300000,300000]);
 await f.service.reply({source,requestId:'reply5',text:'答案',author:'A',replyTo:'start5'},AbortSignal.timeout(1000));
 await Promise.allSettled([...f.service.pending]);
 assert.equal(windows.get(key(source,'T1A')),now+300000,'the answer also starts a fresh five-minute follow-up window');
 assert.equal(durations.at(-1),300000);
 await f.service.close();
});
