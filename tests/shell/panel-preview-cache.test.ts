import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelPreviewCache, type PanelTabDescriptor } from '../../packages/workbench-panels/src/index';
const tab=(id:string):PanelTabDescriptor=>({id,kind:'test',region:'right',title:id,closable:true,preview:false});
const tick=()=>new Promise(r=>setTimeout(r,0));
test('deduplicates, bounds concurrency and drops closed resources even after late completion', async()=>{
 const cache=new PanelPreviewCache('a',32,2);let active=0,max=0,calls=0;const release:(()=>void)[]=[];
 const provider=async()=>{calls++;active++;max=Math.max(max,active);await new Promise<void>(r=>release.push(r));active--;return {kind:'text' as const,text:'result'}};
 for(const id of ['a','b','c'])cache.request(tab(id),provider);cache.request(tab('a'),provider);await tick();assert.equal(calls,2);
 cache.retain([tab('b'),tab('c')]);release.shift()!();await tick();assert.equal(calls,3);assert.equal(cache.get(tab('a')),null);
 release.splice(0).forEach(r=>r());await tick();assert.equal(max,2);assert.equal(cache.get(tab('b'))?.kind,'text');cache.request(tab('b'),provider);await tick();assert.equal(calls,3);
});
test('isolates scopes, invalidates disposal and rejects unbounded/non-raster previews',async()=>{
 const a=new PanelPreviewCache('a'),b=new PanelPreviewCache('b');let finish!:(x:any)=>void;
 a.request(tab('x'),()=>new Promise(r=>finish=r));await tick();a.clear();finish({kind:'text',text:'secret'});await tick();assert.equal(a.get(tab('x')),null);assert.equal(b.get(tab('x')),null);
 a.request(tab('x'),()=>({kind:'image',src:'https://example.com/private'}));await tick();assert.equal(a.get(tab('x')),null);
 a.request(tab('y'),()=>({kind:'text',text:'x'.repeat(3000)}));await tick();assert.equal((a.get(tab('y')) as any).text.length,1800);
});
test('evicts oldest entries and invalidates same-id resource replacement',async()=>{
 const cache=new PanelPreviewCache('a',2);for(const id of ['a','b','c']){cache.request(tab(id),()=>({kind:'text',text:id}));await tick();}assert.equal(cache.get(tab('a')),null);
 cache.retain([{...tab('b'),resource:'new'}]);assert.equal(cache.get(tab('b')),null);assert.equal(cache.get(tab('c')),null);
});
test('presentation invalidation drops old document results and sanitizes favicon',async()=>{
 const cache=new PanelPreviewCache('a');let finish!:(x:any)=>void;
 cache.request(tab('x'),()=>new Promise(r=>finish=r));await tick();cache.invalidate(tab('x'));assert.equal(cache.has(tab('x')),false);
 cache.request(tab('x'),()=>({kind:'placeholder',iconSrc:'https://example.test/icon'}));await tick();finish({kind:'image',src:'data:image/png;base64,YQ=='});await tick();
 assert.deepEqual(cache.get(tab('x')),{kind:'placeholder',iconSrc:undefined});
});
test('refresh retains current preview until replacement and ignores an obsolete in-flight result',async()=>{
 const cache=new PanelPreviewCache('a');let version=0,finish!:(x:any)=>void;
 const provider=()=>++version===1?{kind:'text' as const,text:'old'}:new Promise<any>(r=>finish=r);
 cache.request(tab('x'),provider);await tick();cache.refresh(tab('x'));
 assert.equal(cache.has(tab('x')),false);assert.deepEqual(cache.get(tab('x')),{kind:'text',text:'old'});
 cache.request(tab('x'),provider);await tick();cache.refresh(tab('x'));finish({kind:'text',text:'obsolete'});await tick();
 assert.deepEqual(cache.get(tab('x')),{kind:'text',text:'old'});
 cache.request(tab('x'),()=>({kind:'text',text:'replacement'}));await tick();
 assert.deepEqual(cache.get(tab('x')),{kind:'text',text:'replacement'});
});
test('conversation previews remain bounded and keep role semantics',async()=>{
 const cache=new PanelPreviewCache('a');cache.request(tab('x'),()=>({kind:'conversation',messages:[{role:'user',text:'question'},{role:'assistant',text:'a'.repeat(900)}]}));await tick();
 const preview=cache.get(tab('x'));assert.equal(preview?.kind,'conversation');if(preview?.kind==='conversation'){assert.equal(preview.messages[0]?.role,'user');assert.equal(preview.messages[1]?.text.length,600);}
});
