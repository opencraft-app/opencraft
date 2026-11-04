import test from 'node:test';
import assert from 'node:assert/strict';
import { WebBrowserPageRuntime } from '../../apps/workbench-web/src/browser/web-browser-runtime';
import type { BrowserSurfaceEvents } from '../../apps/workbench-web/src/browser/web-browser-surface-host';

function fixture() {
  let events!: BrowserSurfaceEvents, writes=0;
  const surfaces: any={navigate(_id:unknown,_title:unknown,_url:unknown,port:BrowserSurfaceEvents){events=port;return false;},
    close(){},forget(){},setRoot(){},stop(){},commit(){},block(){},park(){},dispose(){},automation(){return null;}};
  const pages=new WebBrowserPageRuntime(surfaces,null,()=>null,{getItem:()=>null,setItem(){writes++;}});
  const id=pages.create({ownerId:'fixture-owner',initialUrl:'https://example.test/'});pages.prepareSurface(id);events.onLoaded('Fixture');
  return {pages,id,events,writes:()=>writes};
}

test('editing feedback leaves navigation, history, revision and persistence untouched',()=>{
  const f=fixture(),seen:any[]=[];const remove=f.pages.onInputError((page,kind)=>seen.push({page,kind}));
  const before=f.pages.getSnapshot(f.id),writes=f.writes();let changes=0;f.pages.subscribe(f.id,()=>changes++);
  for(const kind of ['focus','edit','copy','control'] as const)f.events.onInputError!(kind);
  assert.equal(f.pages.getSnapshot(f.id),before);assert.equal(f.writes(),writes);assert.equal(changes,0);
  assert.deepEqual(seen.map(v=>v.kind),['focus','edit','copy','control']);assert(seen.every(v=>v.page===f.id));
  remove();f.events.onInputError!('edit');assert.equal(seen.length,4);f.pages.dispose();
});

test('editing feedback cannot erase a real navigation failure',()=>{
  const f=fixture();f.events.onError('ERR_CONNECTION_TIMED_OUT');const before=f.pages.getSnapshot(f.id);
  const seen:string[]=[];f.pages.onInputError((_page,kind)=>seen.push(kind));f.events.onInputError!('focus');
  assert.equal(f.pages.getSnapshot(f.id),before);assert.equal(before?.error,'ERR_CONNECTION_TIMED_OUT');assert.deepEqual(seen,['focus']);f.pages.dispose();
});

for(const boundary of ['close','dispose'] as const)test(`${boundary} retires old surface feedback`,()=>{
  const f=fixture(),seen:string[]=[];f.pages.onInputError((_page,kind)=>seen.push(kind));
  if(boundary==='close')f.pages.close(f.id);else f.pages.dispose();
  f.events.onInputError!('edit');f.events.onError('late old failure');assert.deepEqual(seen,[]);assert.equal(f.pages.getSnapshot(f.id),null);f.pages.dispose();
});

test('separate application runtimes never receive each other’s input feedback',()=>{
  const a=fixture(),b=fixture(),seenA:string[]=[],seenB:string[]=[];
  a.pages.onInputError((_p,k)=>seenA.push(k));b.pages.onInputError((_p,k)=>seenB.push(k));a.events.onInputError!('focus');
  assert.deepEqual(seenA,['focus']);assert.deepEqual(seenB,[]);assert.equal(b.pages.getSnapshot(b.id)?.error,null);a.pages.dispose();b.pages.dispose();
});
