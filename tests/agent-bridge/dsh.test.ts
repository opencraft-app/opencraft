import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Duplex } from 'node:stream';
import { DshChannel } from '../../packages/agent-bridge-acp/src/dsh';
// @ts-ignore Companion is shipped as source, loaded by DSH.
import { attach } from '../../packages/agent-bridge-acp/src/dsh-steering.mjs';

function harness() {
  const output: any[] = [], messages: any[] = [], removed: string[] = [];
  const hooks: Record<string, Function> = {};
  const stream = new Duplex({ read() {}, write(chunk, _enc, done) { output.push(JSON.parse(String(chunk))); done(); } });
  const agent = { status: 'running', session: { id: 's', header: { origin: 'acp' } }, steer(message: any) { messages.push(message); }, inbox: { remove(id: string) { removed.push(id); return true; } } };
  attach({ agents: { get: () => agent }, on: (name: string, fn: Function) => { hooks[name] = fn; }, effect() {} }, stream);
  const send = (method: string, extra = {}) => stream.emit('data', JSON.stringify({ jsonrpc: '2.0', id: output.length, method, params: { sessionId: 's', ...extra } }) + '\n');
  const steer = () => send('steer', { prompt: [{ type: 'text', text: 'correction' }] });
  const claim = () => hooks['agent/inbox/claimed']({ agent, message: messages[0] });
  return { output, messages, removed, stream, send, steer, claim, agent };
}
test('DSH admission has a native id; turn barrier discards only unclaimed messages', () => {
  const h = harness(); h.steer();
  assert.equal(h.output.at(-1).result.messageId, h.messages[0].id);
  h.send('settle'); assert.deepEqual(h.removed, [h.messages[0].id]);
  assert.equal(h.output.at(-1).result.settled, true); h.stream.destroy();
});
test('DSH withdrawal wins before claimed; claimed wins before withdrawal', () => {
  for (const first of ['claim', 'withdraw']) {
    const h = harness(); h.steer();
    if (first === 'claim') h.claim();
    h.send('withdraw', { messageId: h.messages[0].id });
    assert.equal(h.output.at(-1).result.withdrawn, first === 'withdraw');
    h.send('settle'); assert.equal(h.removed.length, first === 'withdraw' ? 1 : 0); h.stream.destroy();
  }
});
test('DSH absent/not-ready refuses mutations; lost response is unknown and never replayed', async () => {
  const writes: string[] = [];
  const stream = new Duplex({ read() {}, write(chunk, _enc, done) { writes.push(String(chunk)); done(); } });
  const channel = new DshChannel(stream, () => {});
  await assert.rejects(channel.request('steer', {}), /not ready/);
  assert.equal(writes.length, 0);
  stream.emit('data', Buffer.from('{"method":"ready"}\n'));
  const request = channel.request('steer', {});
  channel.close(); await assert.rejects(request, /unconfirmed/);
  await assert.rejects(channel.request('steer', {}));
  assert.equal(writes.length, 1);
});

import { AcpBridge } from '../../packages/agent-bridge-acp/src/bridge';
import { resolve } from 'node:path';
async function bridgeFixture(env: Record<string,string> = {}) {
 const deltas: any[] = [];
 const bridge = new AcpBridge({ profile: { providerId:'dsh',dialect:'dsh',minNativeVersion:'1',probeBasis:'fixture',defaultPermissionMode:'full',agent:{command:process.execPath,args:[resolve('tests/agent-bridge/fixtures/dsh-agent.mjs')],cwd:resolve('.'),env}},requestCallback:async (_method,params)=>{deltas.push(...(params.deltas as any[] ?? []));return {};}});
 const initialized = await bridge.initialize({protocolVersion:1,grammarRange:{min:1,max:1}});
 await bridge.handle('session/create',{threadId:'t',cwd:resolve('.')});
 return {bridge,deltas,initialized};
}
test('DSH bridge keeps absent plugin capability off', async () => {
 const h=await bridgeFixture({DSH_FIXTURE_ABSENT:'1'});
 try { assert.equal(h.initialized.effectiveCapabilities.steer.deliveryMethods.includes('native-inject'),false); }
 finally {await h.bridge.close();}
});
for (const unclaimed of [false,true]) test(`DSH bridge records admission then ${unclaimed?'confirmed cleanup failure':'native claimed evidence'}`,async()=>{
 const h=await bridgeFixture(unclaimed?{DSH_FIXTURE_UNCLAIMED:'1'}:{});
 try {
  await h.bridge.handle('turn/start',{threadId:'t',input:{text:'task'}});
  await new Promise(r=>setTimeout(r,30));
  await h.bridge.handle('turn/steer',{threadId:'t',inputId:'i',clientRequestId:'c',input:{text:'correction'},delivery:'native-inject'});
  await new Promise(r=>setTimeout(r,300));
  const result:any=await h.bridge.handle('input/query',{threadId:'t'});
  assert.equal(result.inputs[0].admission.value,'accepted');
  assert.equal(result.inputs[0].outcome,unclaimed?'failed':'delivered');
  assert.equal(h.deltas.some(d=>d.op==='input.evidence'&&d.evidenceKind==='native-input-id'),!unclaimed);
  assert.equal(h.deltas.filter(d=>d.op==='input.delivery').length,1);
 } finally {await h.bridge.close();}
});

test('DSH process loss after admission keeps the input unknown without replay',async()=>{
 const h=await bridgeFixture({DSH_FIXTURE_EXIT_AFTER_ADMISSION:'1'});
 try {
  await h.bridge.handle('turn/start',{threadId:'t',input:{text:'task'}});
  await new Promise(r=>setTimeout(r,30));
  await h.bridge.handle('turn/steer',{threadId:'t',inputId:'i',clientRequestId:'c',input:{text:'correction'}});
  await new Promise(r=>setTimeout(r,200));
  const result:any=await h.bridge.handle('input/query',{threadId:'t'});
  assert.equal(result.inputs[0].outcome,'unknown');
  assert.equal(result.inputs[0].nativeExecutions,1);
 } finally {await h.bridge.close();}
});

test('DSH invalid cleanup barrier remains unknown with one native execution',async()=>{
 const h=await bridgeFixture({DSH_FIXTURE_BAD_BARRIER:'1',DSH_FIXTURE_UNCLAIMED:'1'});
 try {
  await h.bridge.handle('turn/start',{threadId:'t',input:{text:'task'}});
  await new Promise(r=>setTimeout(r,30));
  await h.bridge.handle('turn/steer',{threadId:'t',inputId:'i',clientRequestId:'c',input:{text:'correction'}});
  await new Promise(r=>setTimeout(r,300));
  const result:any=await h.bridge.handle('input/query',{threadId:'t'});
  assert.equal(result.inputs[0].outcome,'unknown');
  assert.equal(result.inputs[0].nativeExecutions,1);
 } finally {await h.bridge.close();}
});
test('DSH unknown native withdrawal is terminal and cannot be replayed',async()=>{
 const h=await bridgeFixture({DSH_FIXTURE_UNKNOWN_WITHDRAW:'1',DSH_FIXTURE_UNCLAIMED:'1'});
 try {
  await h.bridge.handle('turn/start',{threadId:'t',input:{text:'task'}});
  await new Promise(r=>setTimeout(r,30));
  await h.bridge.handle('turn/steer',{threadId:'t',inputId:'i',clientRequestId:'c',input:{text:'correction'}});
  await new Promise(r=>setTimeout(r,30));
  await assert.rejects(h.bridge.handle('input/withdraw',{threadId:'t',inputId:'i'}),/outcome unconfirmed/);
  const result:any=await h.bridge.handle('input/query',{threadId:'t'});
  assert.equal(result.inputs[0].outcome,'unknown');
  assert.equal(result.inputs[0].withdrawal.value,'unknown');
  assert.equal(result.inputs[0].nativeExecutions,1);
  assert.deepEqual(await h.bridge.handle('input/withdraw',{threadId:'t',inputId:'i'}),{state:'unknown',outcome:'unknown'});
  assert.equal(h.deltas.filter(d=>d.op==='input.withdrawal').length,1);
 } finally {await h.bridge.close();}
});

test('DSH cleanup accepts native remove false meaning already absent',()=>{
 const h=harness(); h.steer();
 h.agent.inbox.remove=()=>false;
 h.send('settle');
 assert.equal(h.output.at(-1).result.settled,true);
 h.stream.destroy();
});
