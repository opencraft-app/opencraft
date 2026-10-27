import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scopedHtml} from '../../apps/relay-server/src/selection.ts';
const input='<html><head><base href="/__opencraft_observe/grafana/" /><script src="public/build/runtime.js"></script><link href="/favicon.ico"></head></html>';
function base(html){return /<base href="([^"]+)"/.exec(html)?.[1];}
test('relay retains subapplication asset base for root and selected-server entry',()=>{
 for(const prefix of ['', '/servers/one']){
  const html=scopedHtml(input,{id:'one',name:'One',base:prefix});
  assert.equal(base(html),prefix+'/__opencraft_observe/grafana/');
  assert.equal(new URL('public/build/runtime.js','https://example.invalid'+base(html)).pathname,prefix+'/__opencraft_observe/grafana/public/build/runtime.js');
  assert.equal((html.match(/<base\b/gi)??[]).length,1);
  assert(html.includes('href="'+prefix+'/favicon.ico"'));
 }
});
test('normal workbench base and canonical navigation stay unchanged',()=>{
 for(const head of ['', '<base href="/">']){
  const html=scopedHtml('<html><head>'+head+'</head></html>',{id:'one',name:'One',base:'/servers/one',canonicalPath:'/servers/one/thread/t'});
  assert.equal(base(html),'/servers/one/');assert(html.includes('history.replaceState'));assert(html.includes('opencraft-server-context'));
 }
});
test('external and escaping base cannot retarget the selected installation',()=>{
 for(const href of ['https://evil.invalid/','//evil.invalid/','/\\evil.invalid/','javascript:alert(1)']){
  const html=scopedHtml('<head><base href="'+href+'"></head>',{id:'one',name:'One',base:'/servers/one'});
  assert.equal(base(html),'/servers/one/');
 }
 const html=scopedHtml("<HEAD><BASE HREF='/app/../sub/'></HEAD>",{id:'one',name:'One',base:'/servers/one'});
 assert.equal(base(html),'/servers/one/sub/');
});
