import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {createWorkbenchWebServer} from '../../scripts/serve-workbench-web.mjs';

test('direct DSH gateway acknowledges only its matched responses and preserves raw frames',async t=>{
 const root=await mkdtemp('/tmp/dsh-gateway-');await writeFile(join(root,'index.html'),'<html><head></head></html>');
 const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(done=>upstream.once('listening',done));
 let peer;const acknowledgments=[];
 upstream.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
   if(raw.toString()==='ping'){socket.send('pong');return;}
   const frame=JSON.parse(raw);if(frame.method==='opencraft/owner/receipt'){acknowledgments.push(frame.params);return;}
   socket.send(JSON.stringify({id:frame.id,__opencraftClient:frame.__opencraftClient,result:{accepted:true},opencraftDshReceipt:{id:'exact',receipt:'proof'}}));
 });});
 const gateway=await createWorkbenchWebServer({root,appServerTarget:`ws://127.0.0.1:${upstream.address().port}/rpc`});
 const address=await gateway.listen({host:'127.0.0.1',port:0});
 const client=new WebSocket(`ws://127.0.0.1:${address.port}/appserver`);
 t.after(async()=>{client.terminate();for(const socket of upstream.clients)socket.terminate();await gateway.close();await new Promise(done=>upstream.close(done));await rm(root,{recursive:true,force:true});});
 await new Promise(done=>client.once('open',done));
 const receive=()=>new Promise(done=>client.once('message',raw=>done(raw.toString())));
 let response=receive();client.send('ping');assert.equal(await response,'pong');
 response=receive();client.send(JSON.stringify({id:1,__opencraftClient:'logical',method:'turn/start',params:{}}));await response;
 for(let i=0;i<100&&acknowledgments.length===0;i++)await new Promise(done=>setTimeout(done,10));
 assert.deepEqual(acknowledgments,[{id:'exact',receipt:'proof'}]);
 response=receive();peer.send(JSON.stringify({id:99,result:{},opencraftDshReceipt:{id:'late',receipt:'unknown'}}));await response;
 await new Promise(done=>setTimeout(done,25));assert.equal(acknowledgments.length,1);
});
