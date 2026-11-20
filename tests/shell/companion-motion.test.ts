import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameBudget } from '../../packages/design-system/src/frame-budget';
import { companionKinds, companionIdentity, companionArtwork, companionScene } from '../../packages/design-system/src/companion-artwork';
import { companionPose, restingCompanionPose, companionMotionPolicy } from '../../packages/design-system/src/companion-motion';

test('crowded surfaces obey rolling quota, concurrency and FPS caps at 60/120Hz', () => {
 for (const hz of [60,120]) {
  let clock = 0; const counts = Array.from({length:80},()=>[] as number[]);
  const b = new FrameBudget(companionMotionPolicy,()=>clock),cleanups=[];
  for(let i=0;i<counts.length;i++)cleanups.push(b.add({fps:24,priority:1,paint:t=>counts[i]!.push(t),pause(){}}));
  for(let frame=0;frame<600;frame++){clock=frame*1000/hz;b.frame(clock);}
  assert.equal(b.grantedCount,4);assert.equal(counts.filter(x=>x.length).length,4);
  const paints=counts.flat().sort((a,b)=>a-b);
  for(const t of paints)assert(paints.filter(p=>p>t-1000&&p<=t).length<=96,'page rolling quota');
  for(const c of counts)for(const t of c)assert(c.filter(p=>p>t-1000&&p<=t).length<=24,'avatar FPS cap');
  cleanups.forEach(c=>c());assert.equal(b.active,false);assert.equal(b.size,0);
 }
});
test('higher-priority current reply preempts decoration; release returns grant and hidden state performs no work',()=>{
 let now=0,pauses=0;const b=new FrameBudget({...companionMotionPolicy,maxConcurrent:1},()=>now),calls:string[]=[];
 b.add({fps:12,priority:1,paint:()=>calls.push('waiting'),pause:()=>pauses++});b.frame(now);
 const release=b.add({fps:24,priority:2,paint:()=>calls.push('working'),pause:()=>pauses++});now=100;b.frame(now);
 assert.deepEqual(calls,['waiting','working']);assert.equal(pauses,1);
 b.setEnabled(false);now=500;b.frame(now);assert.equal(calls.length,2);assert.equal(b.active,false);
 b.setEnabled(true);release();now=1500;b.frame(now);assert.equal(calls.at(-1),'waiting');
});
test('slow artwork yields within frame-work budget, never catches up in a burst; late disposal is safe',()=>{
 let clock=0;const b=new FrameBudget(companionMotionPolicy,()=>clock),calls:number[]=[];
 for(let i=0;i<4;i++)b.add({fps:24,priority:1,paint:()=>{calls.push(i);clock+=2.1;},pause(){}});
 b.frame(0);assert.deepEqual(calls,[0]);clock=20;b.frame(20);assert.deepEqual(calls,[0,1]);
 clock=10000;b.frame(10000);assert.equal(calls.length,3);
});
test('callback failures retire only that owner; grants do not leak across disable/enable',()=>{
 let now=0;const b=new FrameBudget(companionMotionPolicy,()=>now);let good=0;
 b.add({fps:24,priority:1,paint:()=>{throw Error('renderer detached')},pause(){}});
 b.add({fps:24,priority:1,paint:()=>good++,pause(){}});b.frame(now);assert.equal(good,1);assert.equal(b.size,1);
 for(let i=0;i<10;i++){b.setEnabled(false);assert.equal(b.grantedCount,0);b.setEnabled(true);assert.equal(b.grantedCount,1);}now=1000;b.frame(now);assert.equal(good,2);
});
test('all six identities share stable layered artwork and safe deterministic gesture poses',()=>{
 for(const kind of companionKinds){const identity={...companionIdentity('fixture'),kind},scene=companionScene(identity);
  assert.deepEqual(companionArtwork(identity),[...scene.surface,...scene.figure,...scene.eyes,...scene.expression]);assert.equal(scene.eyes.length,2);
  assert.deepEqual(companionPose(kind,'rest',999),restingCompanionPose);assert.deepEqual(companionPose(kind,'working',0),restingCompanionPose);
  for(let t=0;t<10000;t+=37){const pose=companionPose(kind,'working',t,1);assert(Object.values(pose).every(Number.isFinite));assert(Math.abs(pose.y)<=2.3);assert(Math.abs(pose.rotation)<=5);assert(pose.eyeScale>=.1);}
 }
});
