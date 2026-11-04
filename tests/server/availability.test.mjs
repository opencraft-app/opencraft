import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startObserve } from '../../apps/observability-service/service.mjs';
import { startAvailabilityNotification } from '../../scripts/availability-notification.mjs';
import { request } from 'node:http';
function socketJson(socketPath,path,body,authorization) {return new Promise((yes,no)=>{const req=request({socketPath,path,method:'POST',headers:authorization?{authorization}:{}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>res.statusCode===200?yes(JSON.parse(text)):no(Error('rejected')));});req.on('error',no);req.end(JSON.stringify(body));});}
const event=fields=>({schemaVersion:1,kind:'availability',component:'gateway',producerId:'probe',eventId:crypto.randomUUID(),at:Date.now(),site:'local',hostId:'local-codex',engine:'codex',originClass:'probe',outcome:'failed',errorCode:'rpc:-32080',...fields});
test('fresh telemetry cannot hide failed connection; stale sample stays unknown',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'observe-availability-'));let now=Date.now();const service=await startObserve({directory:dir,deploymentId:'test',metricsPort:0,now:()=>now});
 try{
  service.store.ingest([event({at:now,outcome:'ok',lastSuccessAt:now})]);assert.equal((await service.query('platform.status')).status,'ok');
  now+=60000;service.store.ingest([event({at:now,consecutiveFailures:1,lastSuccessAt:now-60000})]);
  const health=await fetch(`http://127.0.0.1:${service.metricsAddress.port}/health`).then(r=>r.json());assert.equal(health.ok,false);assert.equal(health.status,'degraded');assert.ok(health.collection);
  const metrics=await fetch(`http://127.0.0.1:${service.metricsAddress.port}/metrics`).then(r=>r.text());assert.match(metrics,/opencraft_availability_success\{[^}]+\} 0/);assert.match(metrics,/opencraft_availability_ratio\{[^}]+\} 0.5/);
  now+=90001;assert.equal((await service.query('platform.status')).status,'unknown');
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});
test('incident summary covers over 500 failures and retains lifecycle events',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'observe-complete-')),service=await startObserve({directory:dir,deploymentId:'test',metricsPort:0});
 try{
  for(let n=0;n<20;n++)service.store.ingest(Array.from({length:32},()=>event({})));
  service.store.ingest([event({kind:'lifecycle',lifecycle:'owner_handoff',outcome:'ok'})]);
  const snap=await service.snapshot();assert.equal(snap.eventSummary.filter(row=>row.kind!=='resource').reduce((sum,row)=>sum+row.count,0),641);assert.equal(snap.truncated,false);assert.equal(snap.eventSampleTruncated,true);
  assert.equal(snap.eventSummary.find(r=>r.kind==='availability').count,640);assert.equal(snap.timeline[0].lifecycle,'owner_handoff');
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});
test('notification socket authenticates, fixes recipient, persists ACK and never resends after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'availability-notify-')),config={socketPath:join(dir,'notify.sock'),tokenFile:join(dir,'token'),receiptsFile:join(dir,'receipts'),channelId:'wecom',senderId:'target',actorId:'human'};
 const token='t'.repeat(40);await writeFile(config.tokenFile,token,{mode:0o600});const path=join(dir,'config');await writeFile(path,JSON.stringify(config),{mode:0o600});
 const sent=[],service={prepareOperatorNotification:(...target)=>async(text,requestId)=>{sent.push([...target,text,requestId]);return {delivered:true,receiptId:requestId};}};
 let server=await startAvailabilityNotification(path,()=>service);
 const body={incidentId:'incident',kind:'alert',site:'local',hostId:'local-codex',engine:'codex',errorCode:'initialize'};
 try{
  await assert.rejects(socketJson(config.socketPath,'/notify',body,'Bearer wrong'));
  await assert.rejects(socketJson(config.socketPath,'/notify',{...body,senderId:'other'},'Bearer '+token));assert.equal(sent.length,0);
  const receipt=await socketJson(config.socketPath,'/notify',body,'Bearer '+token);assert.equal(receipt.delivered,true);assert.equal(sent[0][1],'target');
  await server.close();server=await startAvailabilityNotification(path,()=>service);await socketJson(config.socketPath,'/notify',body,'Bearer '+token);assert.equal(sent.length,1);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('a known unavailable connection does not claim a notification; the same incident can deliver after recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'notify-unavailable-')),config={socketPath:join(dir,'notify.sock'),tokenFile:join(dir,'token'),receiptsFile:join(dir,'receipts'),channelId:'wecom',senderId:'target',actorId:'human'};
 const token='t'.repeat(40);await writeFile(config.tokenFile,token,{mode:0o600});await writeFile(join(dir,'config'),JSON.stringify(config),{mode:0o600});
 let ready=false,calls=0;
 const server=await startAvailabilityNotification(join(dir,'config'),()=>({prepareOperatorNotification(){if(!ready)throw Error('unavailable');return async(_text,requestId)=>{calls++;return {delivered:true,receiptId:requestId};};}}));
 const body={incidentId:'same',kind:'alert',site:'local',hostId:'local-codex',engine:'codex',errorCode:'initialize'};
 try{await assert.rejects(socketJson(config.socketPath,'/notify',body,'Bearer '+token));ready=true;const receipt=await socketJson(config.socketPath,'/notify',body,'Bearer '+token);assert.equal(receipt.delivered,true);assert.equal(calls,1);}finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('external availability never refreshes a component collection heartbeat',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'observe-probe-source-'));let now=Date.now();const service=await startObserve({directory:dir,deploymentId:'test',metricsPort:0,now:()=>now});
 try{service.store.ingest([event({kind:'resource',component:'gateway',producerId:'native-gateway',at:now})]);now+=120000;
  service.store.ingest([event({at:now,outcome:'ok',producerId:'external-probe'})]);
  const status=await service.query('platform.status');assert.equal(status.status,'ok');assert.equal(status.collection.producers.find(row=>row.component==='gateway').availability,'stale');
  assert.equal(service.store.producers().find(row=>row.component==='gateway').producer,'native-gateway');
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('incidents longer than 24 hours retain full aggregates with a bounded measurement window',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'observe-long-incident-')),now=Date.now(),service=await startObserve({directory:dir,deploymentId:'test',metricsPort:0,now:()=>now});
 try{service.store.ingest([event({at:now-2*86400000,incidentRef:'long'}),event({at:now-1000,incidentRef:'long'})]);
  const snapshot=await socketJson(service.socketPath,'/incident',{ref:'long'});
  assert.equal(snapshot.eventCount,2);assert(Date.parse(snapshot.window.to)-Date.parse(snapshot.window.from)>86400000);
  assert(Date.parse(snapshot.measurementsWindow.to)-Date.parse(snapshot.measurementsWindow.from)<=86400000);
 }finally{await service.close();await rm(dir,{recursive:true,force:true});}
});

test('explicit provider rejection is retryable; uncertain delivery is never automatically resent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'notify-retry-')),config={socketPath:join(dir,'notify.sock'),tokenFile:join(dir,'token'),receiptsFile:join(dir,'receipts'),channelId:'wecom',senderId:'target',actorId:'human'};
 const token='t'.repeat(40);await writeFile(config.tokenFile,token,{mode:0o600});await writeFile(join(dir,'config'),JSON.stringify(config),{mode:0o600});
 let mode='rejected',calls=0;
 const server=await startAvailabilityNotification(join(dir,'config'),()=>({prepareOperatorNotification:()=>async(_text,receiptId)=>{calls++;if(mode==='rejected')throw Object.assign(Error('rejected'),{deliveryState:'rejected'});if(mode==='unknown')throw Error('lost-ack');return {delivered:true,receiptId};}}));
 const body={incidentId:'same',kind:'alert',site:'local',hostId:'local-codex',engine:'codex',errorCode:'initialize'};
 try{await assert.rejects(socketJson(config.socketPath,'/notify',body,'Bearer '+token));mode='ok';assert.equal((await socketJson(config.socketPath,'/notify',body,'Bearer '+token)).delivered,true);assert.equal(calls,2);
  mode='unknown';await assert.rejects(socketJson(config.socketPath,'/notify',{...body,incidentId:'unknown'},'Bearer '+token));await assert.rejects(socketJson(config.socketPath,'/notify',{...body,incidentId:'unknown'},'Bearer '+token));assert.equal(calls,3);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
