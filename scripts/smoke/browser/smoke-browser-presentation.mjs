import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import WebSocket from 'ws';
import { RemoteBrowserService } from '../../../apps/headless-server/src/remote-browser-service.mjs';
const executable = process.env.OPENCRAFT_ELECTRON_EXECUTABLE;
if (!executable) throw Error('Set OPENCRAFT_ELECTRON_EXECUTABLE to a local Electron runtime');
const root=await mkdtemp(join(tmpdir(),'browser-presentation-')),directory=join(root,'runtime/browser');await mkdir(directory,{recursive:true});
await build({entryPoints:[resolve('apps/headless-server/src/remote-browser/worker.cjs')],outfile:join(directory,'worker.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node24'});
for(const name of ['encoder-preload.cjs','encoder.html'])await cp('apps/headless-server/src/remote-browser/'+name,join(directory,name));
await build({entryPoints:[resolve('packages/browser-preview-bridge/src/index.ts')],outfile:join(directory,'preview-bridge.js'),bundle:true,platform:'browser',format:'iife',globalName:'OpenCraftPreviewBridgeRuntime'});
await build({entryPoints:[resolve('apps/headless-server/src/remote-browser/annotation-preload.cjs')],outfile:join(directory,'annotation-preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
function chunk(type, data) { const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const out=Buffer.alloc(body.length+8);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,body.length+4);return out; }
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,60,100,220,255]))),chunk('IEND',Buffer.alloc(0))]);
const icoHeader=Buffer.alloc(22);icoHeader.writeUInt16LE(1,2);icoHeader.writeUInt16LE(1,4);icoHeader[6]=1;icoHeader[7]=1;icoHeader.writeUInt16LE(1,10);icoHeader.writeUInt16LE(32,12);icoHeader.writeUInt32LE(png.length,14);icoHeader.writeUInt32LE(22,18);const ico=Buffer.concat([icoHeader,png]);
const format=process.env.OPENCRAFT_ICON_FORMAT || 'png';
const icon = format === 'ico' ? ico : format === 'svg' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>') : png;
const service=new RemoteBrowserService({root,dataDirectory:root,executable,spawnImpl:(...args)=>{args[1].unshift('--disable-dev-shm-usage');const child=spawn(...args);return child;},allowNoSandbox:true,ownerConnector:null});
const server=createServer((req,res)=>{if(req.url==='/icon.png'){res.setHeader('content-type',format === 'ico' ? 'image/x-icon' : format === 'svg' ? 'image/svg+xml' : 'image/png');res.end(icon);return;}res.setHeader('content-type','text/html');res.end('<link rel="icon" href="/icon.png"><title>Remote preview</title><body style="background:#b6d8ee"><h1>Remote thumbnail</h1>');});
server.on('upgrade',(request,socket,head)=>service.upgrade(request,socket,head,{ownerId:request.url.slice(1),authorize(){}}));server.listen(0,'127.0.0.1');await once(server,'listening');
let frames=0;const receive=service.receive.bind(service);service.receive=event=>{if(event.type==='frame')frames++;receive(event);};
const port=server.address().port;const connections=[];
async function connect(owner){const ws=new WebSocket(`ws://127.0.0.1:${port}/${owner}`);connections.push(ws);await once(ws,'open');const pending=new Map(),events=[];ws.on('message',(bytes,binary)=>{if(binary)return;const v=JSON.parse(bytes);events.push(v);const p=pending.get(v.id);if(p){clearTimeout(p.timer);pending.delete(v.id);v.error?p.reject(Error(v.error.message)):p.resolve(v.value);}});return {ws,events,call:(method,input)=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>reject(Error(method+' timed out')),25000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,input}));})};}
try{
 const viewer=await connect('a'),lease=randomUUID();await viewer.call('open',{lease,multiView:true,visible:false,viewport:{width:430,height:932},initialUrl:`http://127.0.0.1:${port}/`});
 const reader=await connect('a');let data;
 for(let n=0;n<80;n++){data=await reader.call('presentation',{lease});if(data?.thumbnail&&data?.favicon)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(data?.thumbnail,'remote thumbnail');assert.ok(data?.favicon,'remote favicon');assert.ok(data.thumbnail.length<360000);assert.ok(data.favicon.length<24000);
 const native=[...service.pages.values()][0];assert.equal(native.controller,null);assert.equal(service.viewers(native).size,1);
 viewer.ws.close();await once(viewer.ws,'close');await new Promise(r=>setTimeout(r,50));
 const reloaded=await connect('a');assert.deepEqual(await reloaded.call('presentation',{lease}),data);
 assert.equal(service.viewers(native).size,0);assert.equal(native.controller,null);
 const stranger=await connect('b');assert.equal(await stranger.call('presentation',{lease}),null);
 const conditional=await reloaded.call('presentation',{lease,revision:data.revision});assert.equal(conditional.unchanged,true);
 assert.equal(frames,0,'preview reads must not start a video stream');
 await mkdir('.local/browser-presentation',{recursive:true});await writeFile('.local/browser-presentation/presentation.json',JSON.stringify(data));
 console.log(JSON.stringify({ok:true,thumbnail:true,favicon:true,reload:true,noViewer:true,noControl:true,ownerIsolation:true,conditional:true}));
}finally{for(const ws of connections)ws.terminate();service.close();await service.persistence;await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{});}
