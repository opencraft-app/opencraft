import test from 'node:test';
import assert from 'node:assert/strict';
import {observeClientLifecycle} from '../../apps/workbench-web/src/runtime/client-lifecycle-observation';

test('visible gaps and hidden/freeze wake observations keep wall and elapsed clocks separate and dispose',()=>{
  const page=Object.assign(new EventTarget(),{visibilityState:'visible'}),window=new EventTarget();
  let wall=0,elapsed=0,next=0;const timers=new Map<number,()=>void>(),events:any[]=[];
  const stop=observeClientLifecycle(page,window,e=>events.push(e),{wall:()=>wall,elapsed:()=>elapsed,
    every:fn=>{timers.set(++next,fn);return next;},clear:id=>{timers.delete(id as number);}});
  wall=elapsed=2000;for(const fn of timers.values())fn();assert.equal(events.length,0);
  wall=12000;elapsed=4000;for(const fn of timers.values())fn();
  assert.equal(events[0].clientSignal,'timer_gap');assert.equal(events[0].clientWallMs,10000);assert.equal(events[0].clientElapsedMs,2000);
  page.visibilityState='hidden';page.dispatchEvent(new Event('visibilitychange'));assert.equal(timers.size,0);
  wall+=240000;elapsed+=118000;page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(events.at(-1).clientSignal,'visible');assert.equal(events.at(-1).clientWallMs,240000);assert.equal(events.at(-1).clientElapsedMs,118000);assert.equal(timers.size,1);
  page.dispatchEvent(new Event('freeze'));assert.equal(timers.size,0);
  page.dispatchEvent(new Event('resume'));assert.equal(timers.size,1);
  window.dispatchEvent(new Event('offline'));assert.equal(events.at(-1).clientSignal,'offline');
  stop();const count=events.length;assert.equal(timers.size,0);
  page.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pageshow'));assert.equal(events.length,count);
});
