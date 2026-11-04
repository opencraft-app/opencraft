import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';
import { WebBrowserPageRuntime } from '../../apps/workbench-web/src/browser/web-browser-runtime';
import { BrowserWorkbenchCoordinator } from '../../apps/workbench-web/src/browser/browser-workbench-coordinator';
import { createConversationBindingStore } from '@opencraft/workbench-runtime';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function surfaceFixture(t:TestContext) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else delete (globalThis as any).window;});
  const host:any=new RemoteBrowserSurfaceHost('mse',{getItem:()=>null,setItem(){}},'viewport-intent');
  let ready!:()=>void;const p:any={closed:false,visible:true,connection:1,controlGeneration:1,interaction:0,ready:new Promise<void>(resolve=>ready=resolve),events:{onInputError(){}},control:{controller:false}};
  host.pages.set('page',p);host.isVisible=(page:any)=>page.visible;const requests:string[]=[],errors:string[]=[];
  host.acquireControl=async (_page:any,kind:string)=>{requests.push(kind);};p.events.onInputError=(kind:string)=>errors.push(kind);
  return {host,p,ready,requests,errors};
}

test('an explicit device edit waits for current ready and requests the original human authority path',async t=>{
  const f=surfaceFixture(t);f.host.requestViewportControl('page');await tick();assert.deepEqual(f.requests,[]);
  f.ready();await tick();assert.deepEqual(f.requests,['human']);assert.deepEqual(f.errors,[]);
});
for(const boundary of ['hidden','closed','connection','generation','interaction'] as const)test(`${boundary} cancels an edit while readiness is pending`,async t=>{
  const f=surfaceFixture(t);f.host.requestViewportControl('page');
  if(boundary==='hidden')f.p.visible=false;else if(boundary==='closed')f.p.closed=true;
  else if(boundary==='connection')f.p.connection++;else if(boundary==='generation')f.p.controlGeneration++;else f.p.interaction++;
  f.ready();await tick();assert.deepEqual(f.requests,[]);assert.deepEqual(f.errors,[]);
});
test('hidden or unmaterialized tabs do not acquire resources or control',async t=>{
  const f=surfaceFixture(t);f.p.visible=false;f.host.requestViewportControl('page');f.host.requestViewportControl('absent');f.ready();await tick();assert.deepEqual(f.requests,[]);
});
test('control denial from a device edit stays nonfatal input feedback',async t=>{
  const f=surfaceFixture(t);f.host.acquireControl=async()=>{throw Object.assign(Error('Denied'),{code:'CONTROL_BUSY'});};f.ready();f.host.requestViewportControl('page');await tick();assert.deepEqual(f.errors,['control']);
});

test('logical restoration stays passive while explicit edits route the same page and persist its mode',()=>{
  const records=new Map<string,string>(),intents:string[]=[];let materialized=0;
  const surfaces:any={requestViewportControl:(id:string)=>intents.push(id),navigate(){materialized++;return false;},close(){},forget(){},dispose(){}};
  const storage={getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);}};
  let pages=new WebBrowserPageRuntime(surfaces,null,()=>null,storage);
  const panels:any={open:()=>({id:'panel'}),ensureOwner(){},dispatch(){},close(){}};
  let tabs=new BrowserWorkbenchCoordinator(pages,panels,createConversationBindingStore(),storage);
  const tab=tabs.open('scope')!;assert.deepEqual(intents,[]);assert.equal(materialized,0);
  const mode={type:'device',presetId:'iphone-15-pro',width:393,height:852} as const;
  tabs.setViewportMode(tab.tabId,mode);assert.deepEqual(intents,[tab.pageId]);assert.deepEqual(tabs.getTabSnapshot(tab.tabId)?.viewportMode,mode);assert.equal(materialized,0);
  tabs.dispose();pages.dispose();intents.length=0;
  pages=new WebBrowserPageRuntime(surfaces,null,()=>null,storage);tabs=new BrowserWorkbenchCoordinator(pages,panels,createConversationBindingStore(),storage);
  assert.deepEqual(tabs.getTabSnapshot(tab.tabId)?.viewportMode,mode);assert.deepEqual(intents,[]);assert.equal(materialized,0);
  tabs.dispose();pages.dispose();
});
