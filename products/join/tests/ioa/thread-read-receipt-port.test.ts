import assert from 'node:assert/strict';
import test from 'node:test';
import {createTencentOaReadReceipts} from "../../plugins/tencentoa/src/read-receipts";
test('account HTTP adapter checks response identity, uses same-origin credentials and propagates cancellation',async()=>{
 const calls:any[]=[];
 const port=createTencentOaReadReceipts((async(_url,options)=>{calls.push(options);return new Response(JSON.stringify({scope:'other',receipts:[]}));}) as typeof fetch);
 await assert.rejects(port.read('account',new AbortController().signal),/account changed/);
 assert.equal(calls[0].credentials,'same-origin');assert.equal(calls[0].cache,'no-store');
 const controller=new AbortController();let received:AbortSignal|undefined;
 const hanging=createTencentOaReadReceipts(((_url,options)=>{received=options?.signal as AbortSignal;return new Promise((_resolve,reject)=>{received!.addEventListener('abort',()=>reject(Error('cancelled')));});}) as typeof fetch);
 const pending=hanging.read('account',controller.signal);controller.abort();await assert.rejects(pending,/cancelled/);assert.equal(received?.aborted,true);
});
