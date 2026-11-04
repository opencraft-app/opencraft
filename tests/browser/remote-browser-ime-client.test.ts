import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserIme } from '../../apps/workbench-web/src/browser/remote-browser-ime';
function fixture() {
  const receiver = { value: '' } as HTMLTextAreaElement;
  const calls: { input: { id: string; type: string; text?: string }; resolve(value?: unknown): void; reject(error: Error): void }[] = [];
  const errors: string[] = [];
  const ime = new RemoteBrowserIme(receiver, input => new Promise((resolve, reject) => calls.push({input,resolve,reject})), () => true, error => errors.push(error));
  return {receiver,calls,ime,errors};
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
test('terminal commit queues before the next begin even when every response is held', async () => {
  const f=fixture(); f.ime.start(); f.ime.update('ni'); f.ime.end('你'); f.ime.start(); f.ime.update('hao'); f.ime.end('好');
  assert.deepEqual(f.calls.map(c=>[c.input.type,c.input.text]), [['begin',undefined],['commit','你'],['begin',undefined],['commit','好']]);
  assert.equal(f.calls[0].input.id,f.calls[1].input.id);assert.equal(f.calls[2].input.id,f.calls[3].input.id);assert.notEqual(f.calls[0].input.id,f.calls[2].input.id);
  for(const c of [...f.calls]) c.resolve(); await tick();assert.deepEqual(f.errors,[]);
});
test('many intermediate compositions keep one outstanding and the latest pending preedit', async () => {
  const f=fixture();f.receiver.value='native-owned';f.ime.start();assert.equal(f.receiver.value,'native-owned');
  f.ime.update('n');f.ime.update('ni');assert.equal(f.calls.length,1);f.calls[0].resolve();await tick();assert.equal(f.calls[1].input.text,'ni');
  f.ime.update('nih');f.ime.update('nihao');assert.equal(f.calls.length,2);f.calls[1].resolve();await tick();assert.equal(f.calls[2].input.text,'nihao');
  f.ime.end('你好');assert.equal(f.calls[3].input.type,'commit');f.ime.end('重复');assert.equal(f.calls.length,4);
});
test('rapid direct mobile text does not cancel a pending preceding character', () => {
  const f=fixture();f.ime.commit('中');f.ime.commit('文');assert.deepEqual(f.calls.map(c=>c.input.type),['begin','commit','begin','commit']);
  assert.deepEqual(f.calls.filter(c=>c.input.type==='commit').map(c=>c.input.text),['中','文']);
});
test('retired begin completion cannot send preedit or cancel a newer id', async () => {
  const f=fixture();f.ime.start();f.ime.update('old');const old=f.calls[0].input.id;f.ime.retire();f.ime.start();const current=f.calls[2].input.id;
  f.calls[0].resolve();await tick();assert.equal(f.calls.at(-1)?.input.type,'cancel');assert.equal(f.calls.at(-1)?.input.id,old);assert.notEqual(old,current);
  assert(!f.calls.some(c=>c.input.type==='compose'));
});
test('old rejected operation cannot clear the current native composition buffer', async () => {
  const f=fixture();f.ime.commit('旧');f.ime.start();f.receiver.value='new';f.calls[0].reject(new Error('old target changed'));await tick();
  assert.equal(f.receiver.value,'new');assert(f.ime.composing);assert(!f.calls.some(c=>c.input.type==='cancel'&&c.input.id===f.calls[2].input.id));
});

test('empty cancellation update never consumes the owned preedit capability as an empty compose', async () => {
  const f=fixture();f.ime.start();f.calls[0].resolve();await tick();f.ime.update('hao');await tick();f.calls[1].resolve();await tick();f.ime.update('');f.ime.end('');
  assert.deepEqual(f.calls.map(c=>c.input.type),['begin','compose','cancel']);
});

test('final compositionupdate and compositionend in one native event task send one final edit', async () => {
  const f=fixture();f.ime.start();f.calls[0].resolve();await tick();f.ime.update('ni');await tick();f.calls[1].resolve();await tick();
  f.ime.update('你');f.ime.end('你');await tick();
  assert.deepEqual(f.calls.map(c=>[c.input.type,c.input.text]),[['begin',undefined],['compose','ni'],['commit','你']]);
});

test('late terminal and cancellation retain their original editor identity', async () => {
  const receiver={value:''} as HTMLInputElement;
  let editor='password-field'; const calls:any[]=[];
  const ime=new RemoteBrowserIme(receiver,async input=>{calls.push(input)},()=>true,()=>{},()=>editor);
  ime.start(); editor='search-field'; ime.end('fake'); await tick();
  assert(calls.every(c=>c.editor==='password-field'));
  ime.start(); ime.retire(); await tick();
  assert(calls.filter(c=>c.id===calls.at(-1).id).every(c=>c.editor==='search-field'));
});

test('an empty ongoing preedit clears the remote composition before later text in the same transaction', async () => {
 const f=fixture();f.ime.start();f.calls[0].resolve();await tick();
 f.ime.update('ni');await tick();f.calls[1].resolve();await tick();
 f.ime.update('');await tick();
 assert.deepEqual(f.calls.map(c=>[c.input.type,c.input.text]),[['begin',undefined],['compose','ni'],['compose','']]);
 f.ime.update('hao');f.calls[2].resolve();await tick();
 assert.equal(f.calls[3].input.text,'hao');assert(f.calls.every(c=>c.input.id===f.calls[0].input.id));
});

test('unknown-first composition keeps its original native activation when editor metadata arrives later',async()=>{
 const receiver={value:''} as HTMLInputElement,calls:any[]=[];let editor:string|null=null,activation='native-event-A';
 const ime=new RemoteBrowserIme(receiver,async input=>{calls.push(input)},()=>true,()=>{},()=>editor,()=>activation);
 ime.start();editor='new-hint';activation='native-event-B';ime.update('你');ime.end('你');await tick();
 assert(calls.filter(call=>call.type!=='cancel').every(call=>call.activation==='native-event-A'&&call.editor===null));
 ime.start();ime.end('好');await tick();assert.equal(calls.filter(call=>call.type==='begin').at(-1).activation,'native-event-B');
});
test('late failure identifies its original transaction without retiring the newer activation',async()=>{
 const receiver={value:''} as HTMLInputElement,calls:any[]=[],failures:any[]=[];let activation='native-event-A';
 const ime=new RemoteBrowserIme(receiver,input=>new Promise((resolve,reject)=>calls.push({input,resolve,reject})),()=>true,(_message,_error,origin)=>failures.push(origin),()=>null,()=>activation);
 ime.commit('旧');activation='native-event-B';ime.start();receiver.value='new';calls[0].reject(new Error('old rejected'));await tick();
 assert.equal(ime.currentActivation,'native-event-B');assert.equal(receiver.value,'new');assert.equal(failures[0].activation,'native-event-A');assert.equal(failures[0].wasCurrent,false);ime.retire();
});
test('oversized final text never enters a native commit or the transport queue',()=>{
 const f=fixture();f.ime.commit('x'.repeat(16385));assert(!f.calls.some(call=>call.input.type==='commit'));assert(f.errors.some(error=>error.includes('too long')));assert.equal(f.receiver.value,'');
});
