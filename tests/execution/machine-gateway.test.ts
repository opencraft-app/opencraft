import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {createRelayServer} from '../../apps/relay-server/src/server.js';
import {connectRelay} from '../../plugins/relay-connect/src/server.js';
import {createLocalIngress} from '../../packages/hub-network/src/local-ingress.js';
import {MACHINE_ENROLLMENT_PATHS} from '@opencraft/relay-protocol';

test('dedicated enrollment gateway forwards only machine paths and preserves their independent credentials',async t=>{
 const key=randomBytes(32).toString('base64url');
 const origin='https://machine.fixture.test';let observed='';
 const local=createServer((req,res)=>{observed=req.headers.authorization??'';res.writeHead(req.url?.startsWith('/__opencraft_machines/source.tgz')&&observed==='Bearer pairing' ?200:403);res.end('fixture source');});
 const sockets=new WebSocketServer({noServer:true});
 local.on('upgrade',(req,socket,head)=>{
  if(req.headers.authorization!=='Bearer enrolled-machine'){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  sockets.handleUpgrade(req,socket,head,ws=>{ws.on('message',message=>ws.send(message));});
 });
 await new Promise<void>(r=>local.listen(0,'127.0.0.1',r));
 const app=createRelayServer([],{machineGateway:{credential:key,origin}});
 await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));
 const endpoint='http://127.0.0.1:'+(app.server.address() as any).port;
 const ingress=createLocalIngress(()=>({port:(local.address() as any).port,origin}),MACHINE_ENROLLMENT_PATHS);
 const connection=connectRelay({relay:endpoint,credential:key,machineGateway:true,allowLoopbackInsecure:true,acceptStream:s=>ingress.accept(s)});
 t.after(async()=>{connection.close();ingress.close();for(const ws of sockets.clients)ws.terminate();sockets.close();await app.close();local.closeAllConnections();await new Promise<void>(r=>local.close(()=>r()));});
 for(let i=0;!app.connected('personal-machine-owner');i++){assert(i<100);await new Promise(r=>setTimeout(r,20));}
 const fetch=async(url:string,options:{headers?:Record<string,string>}={})=>new Promise<{status:number}>((resolve,reject)=>{const req=request(url,{headers:options.headers},res=>{res.resume();resolve({status:res.statusCode!});});req.on('error',reject);req.end();});
 const headers={host:'machine.fixture.test',authorization:'Bearer pairing'};
 assert.equal((await fetch(endpoint+'/__opencraft_machines/source.tgz?id=fixture',{headers})).status,200);
 assert.equal(observed,'Bearer pairing','gateway does not replace a machine credential with its publication key');
 assert.equal((await fetch(endpoint+'/__opencraft_machines/source.tgz',{headers:{host:'machine.fixture.test'}})).status,403);
 for(const path of ['/','/rpc','/__opencraft_machines/status','/__opencraft_machines/fixture/rpc','/__opencraft_update','/__opencraft_hub/operator']){
  assert.equal((await fetch(endpoint+path,{headers})).status,403,path);
 }
 assert.equal((await fetch(endpoint+'/__opencraft_machines/source.tgz',{headers:{...headers,origin:'https://another.test'}})).status,403);
 const ws=new WebSocket(endpoint.replace('http','ws')+'/__opencraft_relay/control',{headers:{host:'machine.fixture.test',authorization:'Bearer enrolled-machine'}});
 await once(ws,'open');const echo=once(ws,'message');ws.send('test');assert.equal(String((await echo)[0]),'test');
 const closed=once(ws,'close');connection.close();await closed;
 assert.equal((await fetch(endpoint+'/__opencraft_machines/source.tgz',{headers})).status,503);
});
