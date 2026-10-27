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
