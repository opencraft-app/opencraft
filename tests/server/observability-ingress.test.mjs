import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservabilityIngress } from '../../scripts/observability-ingress.mjs';
import { startObserve } from '../../apps/observability-service/service.mjs';

test('host identity wins over forged Grafana headers/cookies; member cannot use deployment queries; content never persists',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-ingress-'));
  const service=await startObserve({directory,deploymentId:'ingress-test',metricsPort:0});
  let role=null;
  const principal={provider:'synthetic',subject:'human',expiresAt:Date.now()+60000};
  const access={authenticate:()=>role?principal:null,role:()=>role,trustedOrigin:()=>origin};
  const config=join(directory,'ingress.json');await writeFile(config,JSON.stringify({socketPath:service.socketPath,grafanaSocket:join(directory,'missing.sock'),pseudonymKey:'1'.repeat(64)}),{mode:0o600});
  const ingress=await createObservabilityIngress(config,{access,actors:{findHuman:()=>({id:'verified-human'})}});
  const server=createServer((req,res)=>void ingress.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const path of ['/grafana/d/opencraft-overview','/grafana/public/build/test.js','/grafana/api/ds/query','/api/capabilities']){
      const response=await fetch(origin+'/__opencraft_observe'+path,{headers:{'X-WEBAUTH-USER':'admin','X-WEBAUTH-ROLE':'Admin','Cookie':'grafana_session=forged'}});assert.equal(response.status,401);
    }
    role='member';assert.equal((await fetch(origin+'/__opencraft_observe/api/capabilities')).status,403);
    const capability=await(await fetch(origin+'/__opencraft_observe/capabilities')).json();assert.equal(capability.available,false);assert.equal(capability.telemetry,true);
    const input={schemaVersion:1,kind:'rpc',component:'core',producerId:'synthetic',eventId:'one',at:Date.now(),method:'thread/read',outcome:'ok',params:{text:'sensitive-canary'},actorKind:'human',actorId:'forged',originClass:'automation',error:'sensitive-canary'};
    assert.equal((await fetch(origin+'/__opencraft_observe/events',{method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.invalid'},body:JSON.stringify({events:[input]})})).status,403);
    const accepted=await fetch(origin+'/__opencraft_observe/events',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({events:[input,{...input,eventId:'two',kind:'execution',executionId:'forged'}]})});
    assert.equal(accepted.status,200);assert.equal((await accepted.json()).rejected,1);
    const rows=service.store.events(Date.now()-60000,Date.now(),Date.now());assert.equal(rows.length,2); // observe heartbeat and one client record
    const rpc=rows.find(e=>e.kind==='rpc');assert.equal(rpc.component,'web');assert.equal(rpc.originClass,'interactive');assert(!JSON.stringify(rows).includes('sensitive-canary'));
    role='admin';assert.equal((await fetch(origin+'/__opencraft_observe/api/capabilities')).status,200);
    const down=await fetch(origin+'/__opencraft_observe/grafana/d/opencraft-overview');assert.equal(down.status,503);assert.equal((await down.json()).error.code,'dashboard_unavailable');
    role=null;assert.equal((await fetch(origin+'/__opencraft_observe/api/capabilities')).status,401);
  }finally{ingress.close();server.closeAllConnections();await new Promise(r=>server.close(r));await service.close();await rm(directory,{recursive:true,force:true});}
});

test('named-server Grafana path maps HTML/assets/queries and retains authority',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-ingress-scope-'));
  const socket=join(directory,'grafana.sock'),seen=[];
  const grafana=createServer((req,res)=>{seen.push({path:req.url,user:req.headers['x-webauth-user'],role:req.headers['x-webauth-role']});res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');});
  await new Promise(resolve=>grafana.listen(socket,resolve));
  const config=join(directory,'ingress.json');await writeFile(config,JSON.stringify({socketPath:join(directory,'observe.sock'),grafanaSocket:socket,pseudonymKey:'1'.repeat(64),grafanaBasePath:'/servers/example/__opencraft_observe/grafana'}),{mode:0o600});
  let role='admin';const access={authenticate:()=>({provider:'fixture',subject:'operator'}),role:()=>role,trustedOrigin:()=>origin};
  const ingress=await createObservabilityIngress(config,{access});
  const server=createServer((req,res)=>void ingress.handle(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const path of ['/d/overview','/public/app.js','/api/ds/query?ds=one']){
      const method=path.includes('/api/')?'POST':'GET';const r=await fetch(origin+'/__opencraft_observe/grafana'+path,{method,headers:{origin}});assert.equal(r.status,200);
      assert.equal(seen.at(-1).path,'/servers/example/__opencraft_observe/grafana'+path);assert.equal(seen.at(-1).role,'Viewer');assert(seen.at(-1).user);
    }
    role='member';assert.equal((await fetch(origin+'/__opencraft_observe/grafana/d/overview')).status,403);assert.equal(seen.length,3);
  }finally{ingress.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));grafana.closeAllConnections();await new Promise(resolve=>grafana.close(resolve));await rm(directory,{recursive:true,force:true});}
});
