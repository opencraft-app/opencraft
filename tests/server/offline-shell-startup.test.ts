import assert from "node:assert/strict";
import test from "node:test";
import { waitForOfflinePreparation } from "../../apps/workbench-web/src/runtime/offline-shell";

test("offline warming waits for load, grace and idle, and cancellation removes its work", async () => {
 const originals = Object.fromEntries(["window", "document", "setTimeout", "clearTimeout"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
 const view = new EventTarget(), doc = new EventTarget();
 Object.assign(doc, {readyState:"loading",visibilityState:"visible"});
 const pending = new Map<number,{callback:()=>void,ms:number}>(); let id=0;
 Object.assign(view,{requestIdleCallback:(callback:()=>void)=>{pending.set(++id,{callback,ms:1000});return id;},cancelIdleCallback:(key:number)=>pending.delete(key)});
 try {
  Object.defineProperties(globalThis, {window:{value:view,configurable:true},document:{value:doc,configurable:true},setTimeout:{value:(callback:()=>void,ms:number)=>{pending.set(++id,{callback,ms});return id;},configurable:true},clearTimeout:{value:(key:number)=>pending.delete(key),configurable:true}});
  const tick=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
  const owner = new AbortController(); let ready=false;
  const operation=waitForOfflinePreparation(owner.signal).then(()=>{ready=true;});
  await tick(); assert.equal(pending.size,0); assert.equal(ready,false);
  view.dispatchEvent(new Event("load")); await tick();
  assert.equal([...pending.values()][0].ms,10000);
  const grace=[...pending.entries()][0];pending.delete(grace[0]);grace[1].callback();await tick();
  assert.equal(ready,false);assert.equal([...pending.values()][0].ms,1000);
  const idle=[...pending.entries()][0];pending.delete(idle[0]);idle[1].callback();await operation;assert.equal(ready,true);
  Object.assign(doc,{readyState:"complete"});const retiring=new AbortController();const stopped=waitForOfflinePreparation(retiring.signal);retiring.abort();await assert.rejects(stopped);assert.equal(pending.size,0);
  Object.assign(doc,{readyState:"loading"});const early=new AbortController();const loading=waitForOfflinePreparation(early.signal);early.abort();await assert.rejects(loading);view.dispatchEvent(new Event("load"));await tick();assert.equal(pending.size,0);
 } finally {for(const [k,descriptor] of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete (globalThis as any)[k];}}
});
