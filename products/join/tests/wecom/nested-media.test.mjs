import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNestedMedia} from '../../plugins/wecom/nested-media.mjs';

test('nested documents/images are stored and voices transcribed within the parent source',async()=>{
  const fetched=[],stored=[];
  const result=await resolveNestedMedia({source:'source',id:'message',text:'forward',nestedMedia:[
    {type:'file',mediaId:'pdf',name:'a.pdf',path:'1'},
    {type:'image',mediaId:'image',name:'image.png',path:'2'},
    {type:'voice',mediaId:'voice',name:'voice.amr',format:'amr',path:'3'}]}, {
    secret:'secret',signal:new AbortController().signal,
    download:async(source,id)=>{fetched.push([source,id]);return Buffer.from('content');},
    transcribe:async()=> '明天交报告',store:async(id,name,get)=>{stored.push([id,name]);await get();},
  });
  assert.deepEqual(fetched,[['source','pdf'],['source','image'],['source','voice']]);
  assert.equal(stored.length,3);assert.notEqual(stored[0][0],stored[1][0]);
  assert.match(result.text,/资料编号 f[0-9a-f]{32}/u);assert.match(result.text,/明天交报告/u);assert.equal(result.nestedMedia,undefined);
});

test('nested download deadline produces a readable partial result instead of wedging the inbox',async()=>{
 const controller=new AbortController();controller.abort();
 const result=await resolveNestedMedia({source:'s',id:'m',text:'forward',nestedMedia:[{type:'voice',mediaId:'v',name:'v',path:'1'}]},
 {secret:'secret',signal:controller.signal,download:async()=>{throw Error('aborted');},transcribe:async()=>''});
 assert.match(result.text,/读取超时/u);
});
