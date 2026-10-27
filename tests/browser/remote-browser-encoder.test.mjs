import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('late outputs and errors from a retired encoder cannot release or corrupt its replacement', async () => {
  const events=new Map(),sent=[],encoders=[];
  class Encoder {
    static async isConfigSupported(){return {supported:true}}
    constructor(callbacks){this.callbacks=callbacks;encoders.push(this)}
    configure(){} encode(){} close(){this.closed=true}
  }
  const ipcRenderer={on:(name,fn)=>events.set(name,fn),send:(...args)=>sent.push(args)};
  vm.runInNewContext(await readFile(new URL('../../scripts/remote-browser/encoder-preload.cjs',import.meta.url),'utf8'),{
    require:()=>({ipcRenderer}),VideoEncoder:Encoder,VideoFrame:class{close(){}},Uint8Array,
  });
  await new Promise(r=>setImmediate(r));
  const frame=epoch=>({id:'same-logical-tab',epoch,width:64,height:64,bytes:new Uint8Array(64*64*4),timestamp:1,key:true});
  events.get('encode-frame')({},frame('old-epoch'));const old=encoders[0];
  events.get('release-encoder')({},'same-logical-tab');
  events.get('encode-frame')({},frame('new-epoch'));const current=encoders[1];
  const chunk={byteLength:1,copyTo(){},type:'key',timestamp:1};
  old.callbacks.output(chunk);old.callbacks.error();
  assert.equal(current.closed,undefined,'old error cannot close the new encoder');
  assert.equal(sent.filter(x=>['encoded-packet','encoder-error'].includes(x[0])).length,0,'old callbacks cannot emit into replacement epoch');
  current.callbacks.output(chunk);assert.equal(sent.at(-1)[1].epoch,'new-epoch');
  current.callbacks.error();assert.equal(current.closed,true);assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))),['encoder-error',{id:'same-logical-tab',epoch:'new-epoch'}]);
});


test('encoder construction failure still reports the owned media epoch', async () => {
  const events=new Map(),sent=[];
  class Encoder { static async isConfigSupported(){return {supported:true}} constructor(){throw Error('failed')} }
  vm.runInNewContext(await readFile(new URL('../../scripts/remote-browser/encoder-preload.cjs',import.meta.url),'utf8'),{
    require:()=>({ipcRenderer:{on:(name,fn)=>events.set(name,fn),send:(...args)=>sent.push(args)}}),VideoEncoder:Encoder,
  });
  await new Promise(r=>setImmediate(r));
  events.get('encode-frame')({},{id:'tab',epoch:'fresh',bytes:new Uint8Array(4)});
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))),['encoder-error',{id:'tab',epoch:'fresh'}]);
});
