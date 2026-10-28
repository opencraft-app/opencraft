import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadHistoryFirstPaintObserver, historyLengthBucket, historyEngine } from '../../apps/workbench-web/src/runtime/thread-history-first-paint';
import type { beginObservedOperation } from '../../apps/workbench-web/src/runtime/observability';

test('paint owns completion after navigation; replacement/cancel/failure/empty never become success', () => {
  const events: any[] = [];
  const begin: typeof beginObservedOperation = (operation, fields) => {
    events.push({operation,fields});
    return (outcome = 'ok', extra = {}) => { events.push({outcome,extra}); };
  };
  const observer = createThreadHistoryFirstPaintObserver(begin);
  const cold = observer.begin('local-view-a','cold');
  assert.equal(events.length,1,'navigation preparation alone has no success');
  const warm = observer.begin('local-view-b','warm');
  observer.settle(cold,'ok',{engine:'pi',lengthBucket:'lt50'});
  assert.equal(events.length,3,'late paint of aborted view is ignored');
  observer.settle(warm,'ok',{engine:'codex',lengthBucket:'50to199'});
  observer.settle(warm,'failed');
  const failure=observer.begin('local-view-c','cold'); observer.settle(failure,'failed');
  const empty=observer.begin('local-view-d','cold'); observer.settle(empty,'empty',{engine:'dsh',lengthBucket:'lt50'});
  observer.begin('local-view-e','warm'); observer.abort(); observer.abort();
  assert.deepEqual(events.filter(entry=>entry.outcome).map(entry=>entry.outcome),['aborted','ok','failed','empty','aborted']);
  assert.equal(observer.getSnapshot(),null);
  assert(!JSON.stringify(events).includes('local-view'));
});

test('length boundaries require complete history and engine follows declared ownership', () => {
  for (const [count,expected] of [[0,'lt50'],[49,'lt50'],[50,'50to199'],[199,'50to199'],[200,'200to499'],[499,'200to499'],[500,'500plus']] as const) {
    assert.equal(historyLengthBucket(count,true),expected);
    assert.equal(historyLengthBucket(count,false),'unknown');
  }
  assert.equal(historyLengthBucket(NaN,true),'unknown');
  const extensions={'opencraft/execution-engines':{defaultEngine:'codex',providers:[{id:'pi',threadPrefix:'pi:'},{id:'dsh',modelPrefix:'dsh:'}]}};
  assert.equal(historyEngine(extensions,'pi:private'),'pi');
  assert.equal(historyEngine(extensions,'dsh:private'),'dsh');
  assert.equal(historyEngine(extensions,'ordinary'),'codex');
  assert.equal(historyEngine(undefined,'private'),'unknown');
});

test('durable View lookup is inside the timer, cancellation is fenced, and real coordinator failures report failed', async () => {
  const {createWorkbenchNavigationTransaction} = await import('../../apps/workbench-web/src/runtime/workbench-navigation-transaction');
  const {createWorkbenchCoordinator, createWorkbenchDraftLocation, createWorkbenchThreadLocation, asRouteScopeId} = await import('../../packages/workbench-runtime/src/index');
  const {createObservabilityExtension, observeEvent} = await import('../../apps/workbench-web/src/runtime/observability');
  const originals = new Map(['window','document','fetch','PerformanceObserver'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const captured: any[]=[];
  const controller = new AbortController();
  Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'visible',querySelector:()=>null,addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{pathname:'/',href:'http://localhost/'},history:{state:null},addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'PerformanceObserver',{configurable:true,value:{supportedEntryTypes:[]}});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async (_url:unknown, init?:RequestInit)=>{
    if(init?.body) captured.push(...JSON.parse(String(init.body)).events);
    return new Response(JSON.stringify({telemetry:true,available:false}),{status:200,headers:{'content-type':'application/json'}});
  }});
  const scopes={getActiveDraft:()=>null} as any;
  const a=createWorkbenchDraftLocation('local','a'), b=createWorkbenchThreadLocation('local','private-b');
  let nav: ReturnType<typeof createWorkbenchNavigationTransaction> | undefined;
  try {
    await (createObservabilityExtension() as any).activate({signal:controller.signal});
    await new Promise(resolve=>setTimeout(resolve,10));
    let resolveView!: (value: any)=>void;
    let mounted=0;
    nav=createWorkbenchNavigationTransaction(a,{setViewId(){},cancelPending(){},mountInitial(){mounted++;},prepare:async()=>({commit:()=>true,cancel(){}})} as any,scopes,
      {mode:'memory',isRetainedView:()=>false,restoreViewId:()=>new Promise(resolve=>{resolveView=resolve;})});
    const opening=nav.selectConversation(b);
    const duringLookup=nav.historyFirstPaint.getSnapshot();
    assert(duringLookup,'measurement starts before durable lookup settles');
    await new Promise(resolve=>setTimeout(resolve,10));
    resolveView(asRouteScopeId('restored-view'));
    assert.equal(await opening,true);assert.equal(mounted,1);
    const restored=nav.historyFirstPaint.getSnapshot()!;
    assert.equal(restored.viewId,'restored-view');assert.equal(restored.cache,'warm');
    nav.historyFirstPaint.settle(restored,'ok',{engine:'pi',lengthBucket:'lt50'});
    nav.dispose();
    nav=createWorkbenchNavigationTransaction(a,{setViewId(){},cancelPending(){},mountInitial(){mounted++;},prepare:async()=>({commit:()=>true,cancel(){}})} as any,scopes,
      {mode:'memory',isRetainedView:()=>false,restoreViewId:()=>new Promise(resolve=>{resolveView=resolve;})});
    const cancelled=nav.selectConversation(b);
    await Promise.resolve();
    nav.openSettings();resolveView(asRouteScopeId('obsolete-view'));
    assert.equal(await cancelled,false);assert.equal(mounted,1);
    assert.equal(nav.historyFirstPaint.getSnapshot(),null);nav.dispose();
    nav=createWorkbenchNavigationTransaction(a,{setViewId(){},cancelPending(){},prepare:async()=>({commit:()=>true,cancel(){}})} as any,scopes,
      {mode:'memory',isRetainedView:()=>false,restoreViewId:async()=>{await new Promise(resolve=>setTimeout(resolve,10));return undefined;}});
    assert.equal(await nav.selectConversation(b),true);
    const uncached=nav.historyFirstPaint.getSnapshot()!;
    assert(uncached);assert.equal(uncached.cache,'cold');
    nav.historyFirstPaint.settle(uncached,'ok',{engine:'codex',lengthBucket:'lt50'});nav.dispose();
    // WorkbenchCoordinator intentionally converts both connection and acquire errors to null.
    for (const stage of ['connection','thread']) {
      const runtime={acquireThread:async()=>{throw new Error('fixture failure');}};
      const coordinator=createWorkbenchCoordinator({ensureConnected:async()=>{if(stage==='connection')throw new Error('fixture failure');return runtime;}} as any,a);
      nav=createWorkbenchNavigationTransaction(a,{setViewId:coordinator.setViewId,cancelPending:coordinator.cancelPending,prepare:coordinator.prepare} as any,scopes,{mode:'memory',isRetainedView:()=>false});
      assert.equal(await nav.selectConversation(b),false);
      assert.equal(coordinator.getSnapshot().phase,'error');
      nav.dispose();coordinator.dispose();
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    observeEvent({kind:'client_signal',outcome:'failed'});
    await new Promise(resolve=>setTimeout(resolve,10));
    const terminal=captured.filter(e=>e.operationType==='thread_history_first_paint'&&e.outcome!=='started');
    assert.deepEqual(terminal.map(e=>e.outcome),['ok','aborted','ok','failed','failed']);
    assert.equal(terminal[0].cache,'warm');assert(terminal[0].durationMs>=10,'durable storage wait is included');
    assert(!JSON.stringify(captured).includes('private-b'));
  } finally {
    nav?.dispose();controller.abort();
    for(const [key,descriptor] of originals) { if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key]; }
  }
});

test('full indexed count classifies a partial display without treating its window as total', () => {
  assert.equal(historyLengthBucket(10, false, 601), '500plus');
  assert.equal(historyLengthBucket(10, false, 75), '50to199');
  assert.equal(historyLengthBucket(10, false, -1), 'unknown');
  assert.equal(historyLengthBucket(10, false, NaN), 'unknown');
});

test('history RPC keeps its opening operation through replacement and exports only bounded timings', async () => {
  const {createObservabilityExtension, installClientObservation, observeEvent} = await import('../../apps/workbench-web/src/runtime/observability');
  const originals = new Map(['window','document','fetch','PerformanceObserver'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const captured: any[] = [], visibility: Array<() => void> = [];
  const controller = new AbortController();
  Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'visible',querySelector:()=>null,
    addEventListener(name:string, fn:()=>void){if(name==='visibilitychange')visibility.push(fn);},removeEventListener(){}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{pathname:'/',href:'http://localhost/'},addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'PerformanceObserver',{configurable:true,value:{supportedEntryTypes:[]}});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async (_url:unknown, init?:RequestInit)=>{
    if(init?.body)captured.push(...JSON.parse(String(init.body)).events);
    return new Response(JSON.stringify({telemetry:true,available:false}),{status:200});
  }});
  let listener!: (event:any)=>void;
  let dispose: (()=>void)|undefined;
  try {
    await (createObservabilityExtension() as any).activate({signal:controller.signal});
    await new Promise(resolve=>setTimeout(resolve,30));
    dispose = installClientObservation({connectionGeneration:1,subscribeRequestLifecycle(fn:any){listener=fn;return ()=>{};}} as any);
    const observer = createThreadHistoryFirstPaintObserver();
    const first = observer.begin('view-first','cold',{hostId:'local',threadId:'private-thread'});
    listener({type:'started',hostId:'local',id:'read-1',method:'thread/read',params:{threadId:'private-thread'},startedAtMs:123,queueWaitMs:2});
    observer.begin('view-second','cold',{hostId:'local',threadId:'private-thread'});
    listener({type:'completed',hostId:'local',id:'read-1',method:'thread/read',durationMs:100,result:{
      thread:{id:'private-thread',content:'private-content'},__opencraftHistoryTiming:{pairId:'server-trace',coreMs:90,nativeRpcMs:75,queueMs:3,sourceMs:-1,evil:'private-content'}}});
    observer.settle(first,'ok'); observer.abort();
    observeEvent({kind:"operation",operationType:"other",outcome:"failed"});
    for (const callback of visibility)callback();
    await new Promise(resolve=>setTimeout(resolve,30));
    const starts = captured.filter(event=>event.operationType==='thread_history_first_paint'&&event.outcome==='started');
    const rpc = captured.find(event=>event.kind==='rpc'&&event.pairId==='server-trace');
    assert.equal(starts.length,2);assert(rpc);
    assert.equal(rpc.operationId,starts[0].operationId);
    assert.notEqual(rpc.operationId,starts[1].operationId);
    assert.equal(rpc.webSentAt,123);assert.equal(rpc.clientQueueMs,2);
    assert.equal(rpc.historyCoreMs,90);assert.equal(rpc.historyNativeRpcMs,75);
    assert.equal(rpc.historySourceMs,undefined);
    assert(!JSON.stringify(captured).includes('private-'));
  } finally {
    dispose?.();controller.abort();
    for(const [key,descriptor]of originals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];
  }
});
