import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {RsyncDelta,rollingChecksum,rollChecksum,RsyncError,type Delta} from "../src/index.js";
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const api=new RsyncDelta(hash), bytes=(s:string)=>new Uint8Array(Buffer.from(s));
const identity={context:"view/epoch/query",basisId:"revision-1",targetId:"revision-2"};
async function transfer(basis:Uint8Array,target:Uint8Array,blockSize:number,engine=api){
 const signatures=await engine.createSignatures(basis,{...identity,blockSize});
 const built=await engine.createDelta(target,signatures,identity);
 const output=await engine.applyDelta(basis,built.delta,{...identity,target:{...built.delta.target}});
 assert.deepEqual(output,target);return {...built,signatures};
}
const rejected=(code:string)=>(error:unknown)=>error instanceof RsyncError&&error.code===code;

test("rolling checksum matches direct weighted sums and slides across wrap boundaries",()=>{
 let seed=9;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(const size of [1,2,3,16,255,65535,65536,65537]){
  const data=Uint8Array.from({length:size+80},()=>random()>>>24);
  let weak=rollingChecksum(data.subarray(0,size));
  let a=0,b=0;for(let i=0;i<size;i++){a=(a+data[i]!)&65535;b=(b+((size-i)&65535)*data[i]!)&65535;}
  assert.equal(weak,((b<<16)|a)>>>0);
  for(let at=1;at<=80;at++){weak=rollChecksum(weak,size,data[at-1]!,data[at+size-1]!);assert.equal(weak,rollingChecksum(data.subarray(at,at+size)));}
 }
});

test("shifted unchanged blocks are copied after insertion, deletion and reordering",async()=>{
 const basis=bytes("abcdefghIJKLMNOPqrstuvwxYZ012345");
 const target=bytes("++qrstuvwxabcdefghIJKLMNOPYZ012345--");
 const {delta,statistics}=await transfer(basis,target,8);
 assert.equal(statistics.copiedBytes,32);assert.equal(statistics.literalBytes,4);
 assert(delta.operations.some(op=>op.type==="copy"&&op.offset===16));
});

test("a real weak checksum collision is rejected by the strong digest",async()=>{
 const basis=new Uint8Array([0,2,0]),target=new Uint8Array([1,0,1]);
 assert.equal(rollingChecksum(basis),rollingChecksum(target));assert.notDeepEqual(hash(basis),hash(target));
 const result=await transfer(basis,target,3);assert.equal(result.statistics.strongChecks,1);assert.equal(result.statistics.copiedBytes,0);
});

test("empty inputs, partial tails and repeated blocks reconstruct independently",async()=>{
 for(const [a,b] of [["",""],["","abc"],["abc",""],["abcdefg","++efgabcdefg"],["aaaaaaaabbbbbbbb","bbbbbbbbaaaaaaaaaaaaaaaa"]])
  for(const size of [1,3,8,64])await transfer(bytes(a!),bytes(b!),size);
});

test("deterministic generated edits agree with an independent byte target",async()=>{
 let seed=123456;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let example=0;example<1200;example++){
  const basis=Uint8Array.from({length:next()%400},()=>next()>>>24),target=[...basis];
  for(let edit=0;edit<1+next()%8;edit++){
   const at=next()%(target.length+1),kind=next()%4;
   if(kind===0)target.splice(at,0,...Array.from({length:next()%20},()=>next()>>>24));
   else if(kind===1)target.splice(at,next()%20);
   else if(kind===2){const block=target.slice(at,at+next()%30);target.splice(next()%(target.length+1),0,...block);}
   else if(at<target.length)target[at]=next()>>>24;
  }
  await transfer(basis,Uint8Array.from(target),1+next()%64);
 }
});

test("contexts, basis identities, basis bytes and confirmed target manifests are checked",async()=>{
 const basis=bytes("abcdefgh"),target=bytes("++abcdefgh"),{delta,signatures}=await transfer(basis,target,4);
 const expected={...identity,target:{...delta.target}};
 await assert.rejects(api.createDelta(target,signatures,{...identity,context:"other-view"}),rejected("CONTEXT_MISMATCH"));
 await assert.rejects(api.createDelta(target,signatures,{...identity,basisId:"other"}),rejected("BASIS_MISMATCH"));
 await assert.rejects(api.applyDelta(basis,delta,{...expected,context:"other-view"}),rejected("CONTEXT_MISMATCH"));
 await assert.rejects(api.applyDelta(basis,delta,{...expected,basisId:"other"}),rejected("BASIS_MISMATCH"));
 await assert.rejects(api.applyDelta(bytes("abcdefgh!"),delta,expected),rejected("BASIS_MISMATCH"));
 await assert.rejects(api.applyDelta(bytes("abcdefgh").fill(0),delta,expected),rejected("BASIS_MISMATCH"));
 await assert.rejects(api.applyDelta(basis,delta,{...expected,target:{...delta.target,id:"different-checkpoint"}}),rejected("TARGET_MISMATCH"));
 const corrupt=structuredClone(delta);const literal=corrupt.operations.find(op=>op.type==="literal");assert(literal?.type==="literal");literal.data[0]^=1;
 await assert.rejects(api.applyDelta(basis,corrupt,expected),rejected("TARGET_MISMATCH"));
});

test("invalid references, noninteger lengths, missing bytes and excess output are rejected",async()=>{
 const basis=bytes("abcdefgh"),{delta}=await transfer(basis,basis,4),expected={...identity,target:delta.target};
 for(const operations of [
  [{type:"copy",offset:-1,length:8}],[{type:"copy",offset:0,length:9}],
  [{type:"copy",offset:Number.MAX_SAFE_INTEGER,length:8}],[{type:"copy",offset:0,length:0}],
  [{type:"copy",offset:0,length:7.5}],[{type:"literal",data:bytes("abcdefghi")}],[],
  [{type:"literal",data:new Uint8Array(0)}],[{type:"unknown"}],[undefined],
 ])await assert.rejects(api.applyDelta(basis,{...delta,operations} as Delta,expected),rejected("INVALID_INPUT"));
 const bad=structuredClone(delta);bad.target.length=Number.MAX_SAFE_INTEGER;
 await assert.rejects(api.applyDelta(basis,bad,{...expected,target:bad.target}),rejected("LIMIT_EXCEEDED"));
});

test("signature dimensions and formats are validated before matching",async()=>{
 const basis=bytes("abcdefgh"),signature=await api.createSignatures(basis,{...identity,blockSize:4});
 for(const change of [
  {...signature,blocks:[]},{...signature,blockSize:0},{...signature,version:2},
  {...signature,blocks:signature.blocks.map(x=>({...x,weak:-1}))},
  {...signature,blocks:signature.blocks.map(x=>({...x,strong:"broken"}))},
  {...signature,blocks:signature.blocks.map(x=>({...x,length:3}))},
 ])await assert.rejects(api.createDelta(basis,change as typeof signature,identity),rejected("INVALID_INPUT"));
});

test("resource limits bound signature, output, instruction and strong-hash work",async()=>{
 const basis=bytes("abcdefgh"),sig=await api.createSignatures(basis,{...identity,blockSize:4});
 await assert.rejects(new RsyncDelta(hash,{maxBytes:1}).createSignatures(basis,{...identity,blockSize:4}),rejected("LIMIT_EXCEEDED"));
 await assert.rejects(new RsyncDelta(hash,{maxBlocks:1}).createSignatures(basis,{...identity,blockSize:4}),rejected("LIMIT_EXCEEDED"));
 await assert.rejects(new RsyncDelta(hash,{maxHashBytes:8}).createSignatures(basis,{...identity,blockSize:4}),rejected("LIMIT_EXCEEDED"));
 await assert.rejects(new RsyncDelta(hash,{maxHashBytes:8}).createDelta(basis,sig,identity),rejected("LIMIT_EXCEEDED"));
 await assert.rejects(new RsyncDelta(hash,{maxOperations:1}).createDelta(bytes("++abcdefgh"),sig,identity),rejected("LIMIT_EXCEEDED"));
 await assert.rejects(new RsyncDelta(()=>new Uint8Array(31)).createSignatures(basis,{...identity,blockSize:4}),rejected("INVALID_INPUT"));
});

test("async hash boundaries snapshot Buffer inputs, signatures and delta literals",async()=>{
 const basis=Buffer.from("abcdefgh");let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>started=resolve);let first=true;
 const engine=new RsyncDelta(async value=>{if(first){first=false;started();await gate;}return hash(value);});
 const pending=engine.createSignatures(basis,{...identity,blockSize:4});await began;basis.fill(0);release();
 const signature=await pending;assert.equal(signature.basis.sha256,Buffer.from(hash(bytes("abcdefgh"))).toString("hex"));
 const original=bytes("abcdefgh"),built=await api.createDelta(bytes("++abcdefgh"),signature,identity),manifest={...built.delta.target};
 const literal=built.delta.operations.find(op=>op.type==="literal");assert(literal?.type==="literal");literal.data=Buffer.from(literal.data);
 let resume!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>resume=r),inside=new Promise<void>(r=>entered=r);let once=true;
 const applying=new RsyncDelta(async value=>{if(once){once=false;entered();await waiting;}return hash(value);}).applyDelta(original,built.delta,{...identity,target:manifest});
 await inside;literal.data.fill(0);built.delta.target.id="mutated";original.fill(0);resume();
 assert.deepEqual(await applying,bytes("++abcdefgh"));
});

test("cancellation is checked across async digest completion",async()=>{
 const signal={aborted:false};const engine=new RsyncDelta(async value=>{signal.aborted=true;return hash(value);});
 await assert.rejects(engine.createSignatures(bytes("abc"),{...identity,blockSize:2},signal),rejected("ABORTED"));
 await assert.rejects(api.createSignatures(bytes("abc"),{...identity,blockSize:2},{aborted:true}),rejected("ABORTED"));
});

test("delta generation snapshots mutable signatures and a Buffer target before hashing",async()=>{
 const basis=bytes("abcdefgh"),signatures=await api.createSignatures(basis,{...identity,blockSize:4}),target=Buffer.from("++abcdefgh");
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);let once=true;
 const engine=new RsyncDelta(async value=>{if(once){once=false;started();await gate;}return hash(value);});
 const pending=engine.createDelta(target,signatures,identity);await began;
 target.fill(0);signatures.blocks[0]!.strong="0".repeat(64);signatures.basis.id="mutated";release();
 const {delta}=await pending;assert.deepEqual(await api.applyDelta(basis,delta,{...identity,target:delta.target}),bytes("++abcdefgh"));
});

test("a one-MiB shifted stream with one edited byte reuses all unaffected blocks",async()=>{
 let seed=17;const basis=Uint8Array.from({length:1024*1024},()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed&255;});
 const target=new Uint8Array(basis.length+13);target.fill(255,0,13);target.set(basis,13);target[450123+13]^=128;
 const {statistics}=await transfer(basis,target,4096);
 assert.equal(statistics.copiedBytes,basis.length-4096);assert.equal(statistics.literalBytes,4096+13);
 assert(statistics.rollingSteps<=target.length*2,"rolling updates advance monotonically across at most two window lengths");
});
