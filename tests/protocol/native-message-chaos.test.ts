import assert from 'node:assert/strict';
import test from 'node:test';
import {messageAdapters} from './fixtures/native-message';
import {generateNativeMessageChaos,messageModes,parseNativeMessageTrace,simulateNativeMessages,type NativeMessageEvent,type NativeMessageMutant} from './fixtures/native-message-chaos';
import {ChaosViolation,shrinkChaosFailure} from './fixtures/recovery-chaos';
for(const adapter of messageAdapters)test(`${adapter} native message oracle accepts native delivery and explicit fresh heal`,async()=>{
  const result=await simulateNativeMessages([{type:'open',adapter},{type:'frame',mode:'normal'},{type:'heal'}]);
  assert.equal(result.opens,2);assert.equal(result.frames,2);assert.equal(result.heals,1);assert.equal(result.observations,4);
});
for(const [mutant,rule,events] of [
  ['drop-peer','MESSAGE_DELIVERY',[{type:'open',adapter:'memory'},{type:'frame',mode:'normal'}]],
  ['stale-observation','MESSAGE_CURRENT',[{type:'open',adapter:'memory'},{type:'frame',mode:'renew'}]],
  ['orphan-heal','MESSAGE_CONNECT_SETTLEMENT',[{type:'open',adapter:'memory'},{type:'heal'}]],
] as const)test(`native message chaos ${mutant} fails its exact rule and replays normally`,async()=>{
  const trace:NativeMessageEvent[]=[...events];
  const options={mutant:mutant as NativeMessageMutant};
  await assert.rejects(simulateNativeMessages(trace,options),(e:unknown)=>e instanceof ChaosViolation&&e.rule===rule&&!e.cleanupFailure);
  const minimal=await shrinkChaosFailure(trace,rule,events=>simulateNativeMessages(events,options));
  assert.equal(minimal.length,2);await simulateNativeMessages(minimal);
});
test('native message trace validates discriminants, saves explicit healing and mixes event families',async()=>{
  const empty=await simulateNativeMessages([]);assert.equal(empty.opens,0);assert.equal(empty.frames,0);assert.equal(empty.heals,0);
  const adapters=new Set<string>();for(let seed=0;seed<10;seed++){const first=generateNativeMessageChaos(seed,120)[0]!;assert.equal(first.type,'open');if(first.type==='open')adapters.add(first.adapter);}
  assert.equal(adapters.size,messageAdapters.length);
  const trace=generateNativeMessageChaos(0,120);assert.equal(trace.length,122);assert.equal(trace.at(-1)?.type,'heal');assert.deepEqual(parseNativeMessageTrace(trace),trace);
  const modes=new Set(trace.flatMap(event=>event.type==='frame'?[event.mode]:[]));assert.equal(modes.size,messageModes.length);
  for(const invalid of [[{type:'invented'}],[{type:'open',adapter:'invented'}],[{type:'frame',mode:'invented'}],null])assert.throws(()=>parseNativeMessageTrace(invalid));
});
