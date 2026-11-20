import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeferredDesktopMedia } from '../../apps/workbench-web/src/runtime/deferred-desktop-media';
import type { RfbDesktopAdapter, DesktopRfbSession } from '@opencraft/plugin-cloud-desktop/rfb';

function session(){let closes=0;return {value:{openChannel:()=>{throw Error('unexpected socket')},close:()=>{closes++}} as DesktopRfbSession,closes:()=>closes};}
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject};}

test('media is not loaded by capability setup or a surface mount without a connection',()=>{
 let loads=0;const media=createDeferredDesktopMedia(async()=>{loads++;throw Error('load')});
 assert.equal(loads,0);assert.throws(()=>media.surfaces.mount({} as any,{} as any),/not connected/);assert.equal(loads,0);
});
test('already-aborted connect closes once without starting an import',async()=>{
 let loads=0;const media=createDeferredDesktopMedia(async()=>{loads++;throw Error('load')});const s=session(),abort=new AbortController();abort.abort();
 await assert.rejects(media.connect(s.value,abort.signal),{name:'AbortError'});assert.equal(s.closes(),1);assert.equal(loads,0);
});
test('abort during shared loading closes promptly and cannot connect a retired session',async()=>{
 const gate=deferred<RfbDesktopAdapter>();let loads=0;const media=createDeferredDesktopMedia(()=>{loads++;return gate.promise});const a=session(),b=session(),abort=new AbortController();
 const first=media.connect(a.value,abort.signal);const second=media.connect(b.value,new AbortController().signal);const rejection=assert.rejects(first,{name:'AbortError'});
 abort.abort();assert.equal(a.closes(),1);assert.equal(b.closes(),0);assert.equal(loads,1);
 const connection={} as any;let received:DesktopRfbSession|undefined;const element={} as any,surface={} as any;
 gate.resolve({connect:async s=>{received=s;return connection},surfaces:{mount:(el,c)=>{assert.equal(el,element);assert.equal(c,connection);return surface}}});
 await rejection;assert.equal(await second,connection);assert.equal(a.closes(),1);assert.equal(media.surfaces.mount(element,connection),surface);received!.close();received!.close();assert.equal(b.closes(),1);
});
test('failed imports retire their session and can be retried by another attachment',async()=>{
 let loads=0;const connection={} as any;const media=createDeferredDesktopMedia(async()=>{if(++loads===1)throw Error('offline module');return {connect:async()=>connection,surfaces:{mount(){throw Error('unused')}}}});const a=session(),b=session();
 await assert.rejects(media.connect(a.value,new AbortController().signal),/offline module/);assert.equal(a.closes(),1);
 assert.equal(await media.connect(b.value,new AbortController().signal),connection);assert.equal(loads,2);assert.equal(b.closes(),0);
});
test('adapter connection failures and cancellation share an exact-once session close',async()=>{
 const s=session(),abort=new AbortController();const media=createDeferredDesktopMedia(async()=>({connect:async owned=>{owned.close();abort.abort();throw Error('retired')},surfaces:{mount(){throw Error('unused')}}}));
 await assert.rejects(media.connect(s.value,abort.signal),/retired/);assert.equal(s.closes(),1);
});

test('a failed session teardown cannot replace module admission failure',async()=>{
 let closes=0;const media=createDeferredDesktopMedia(async()=>{throw Error('module admission failed')});
 await assert.rejects(media.connect({openChannel(){throw Error('unexpected socket')},close(){closes++;throw Error('teardown failed')}},new AbortController().signal),/module admission failed/);
 assert.equal(closes,1);
});
