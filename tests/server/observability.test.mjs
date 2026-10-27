import { generate } from '../../ops/observability/generate.mjs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ObserveStore, observationSchemaV1 } from '../../apps/observability-service/store.ts';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limits, sanitizeEvent, windowFor } from '../../packages/observability-contract/index.mjs';
import { createEventQueue } from '../../packages/observability-contract/queue.mjs';
import { compare, definitions } from '../../packages/observability-query/index.mjs';
import { startObserve } from '../../apps/observability-service/service.mjs';
import { socketRequest, nodeObserver } from '../../packages/observability-contract/node.mjs';
import { run } from '../../apps/observability-cli/main.mjs';
const now=Date.now();
const event=(fields={})=>({schemaVersion:1,kind:'operation',component:'web',eventId:crypto.randomUUID(),producerId:'test',at:now,operationType:'thread_open',outcome:'ok',durationMs:10,...fields});
test('closed schema never exports payloads and rejects malformed known fields',()=>{
  const value=sanitizeEvent(event({params:{secret:'canary'},error:'canary',path:'/secret',scope:'admin',actorId:'forged'}),now);
  assert(!JSON.stringify(value).includes('canary'));assert(!('actorId' in value));assert.equal(sanitizeEvent(event({operationType:'user-content'}),now),null);
  assert.equal(sanitizeEvent(event({durationMs:-1}),now),null);assert.throws(()=>windowFor({from:'2020-01-01',to:'2026-01-01'},now));
});
test('queue drops without blocking, retains bounds and accepts valid event after invalid',()=>{
  const queue=createEventQueue({maxEvents:2,maxBytes:4096,now:()=>now});
  assert.equal(queue.emit(event({kind:'garbage'})),false);assert(queue.emit(event()));assert(queue.emit(event()));assert.equal(queue.emit(event()),false);
  assert.equal(queue.stats().pending,2);assert.equal(queue.stats().dropped,1);assert.equal(queue.take().length,2);assert(queue.emit(event()));
});
test('comparison rejects missing/mixed workload and detects paired improvement and regression',()=>{
  const snapshot=(duration)=>({deploymentId:'test',queryDefinitionRevision:'v1',metricSchemaVersion:1,coverage:'complete',loss:{dropped:0},events:Array.from({length:20},(_,i)=>event({pairId:String(i),originClass:'probe',cache:'cold',engine:'codex',measurementScope:'in_page',workloadDigest:'fixture-v1',durationMs:duration+i}))});
  assert.equal(compare(snapshot(100),snapshot(10)).status,'improved');assert.equal(compare(snapshot(10),snapshot(100)).status,'regressed');
  const missing=snapshot(10);missing.events.pop();assert.equal(compare(snapshot(100),missing).status,'inconclusive');
  const mixed=snapshot(10);mixed.events[0].cache='warm';assert.equal(compare(snapshot(100),mixed).status,'inconclusive');
});
test('SQLite full aborts the batch atomically, drops the batch and keeps loss/query readable',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-full-'));
  const store=new ObserveStore(join(directory,'observe.sqlite'));
  try{
    const pages=store.db.prepare('PRAGMA page_count').get().page_count;
    store.db.exec(`PRAGMA max_page_count=${pages+3}`);
    const events=Array.from({length:32},(_,i)=>event({eventId:`full-${i}`,originClass:'interactive',visibility:'visible',measurementScope:'in_page',cache:'cold',engine:'codex',actorKind:'human',durationMs:10+i}));
    const receipt=store.ingest(events,'a'.repeat(64));
    assert.equal(receipt.accepted,0);assert.equal(receipt.dropped,32);assert.equal(receipt.rejected,0);assert.equal(receipt.duplicates,0);
    assert.equal(store.accepted,0);assert.equal(store.dropped,32);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,0,'full batch must not leave a partial commit');
    assert.equal(store.activity(now-1000,now+1000).humans,0);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('SQLite full does not count an existing duplicate as accepted or dropped',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-full-duplicate-'));
  const store=new ObserveStore(join(directory,'observe.sqlite'));
  try{
    const existing=event({eventId:'existing'});
    assert.equal(store.ingest([existing]).accepted,1);
    const pages=store.db.prepare('PRAGMA page_count').get().page_count;
    store.db.exec(`PRAGMA max_page_count=${pages+3}`);
    const receipt=store.ingest([existing,...Array.from({length:32},(_,i)=>event({eventId:`duplicate-full-${i}`,originClass:'interactive',visibility:'visible',measurementScope:'in_page',cache:'cold',engine:'codex',actorKind:'human',durationMs:10+i}))],'a'.repeat(64));
    assert.equal(receipt.accepted,0);assert.equal(receipt.duplicates,1);assert.equal(receipt.dropped,32);
    assert.equal(store.accepted,1);assert.equal(store.dropped,32);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('SQLite full counts persisted and intra-batch duplicates that appear after the failure',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-full-asymmetric-'));
  const store=new ObserveStore(join(directory,'observe.sqlite'));
  try{
    const existing=event({eventId:'asymmetric-existing'});
    assert.equal(store.ingest([existing]).accepted,1);
    const pages=store.db.prepare('PRAGMA page_count').get().page_count;
    store.db.exec(`PRAGMA max_page_count=${pages+3}`);
    const prefix=Array.from({length:64},(_,i)=>event({eventId:`asymmetric-new-${i}`,originClass:'interactive',visibility:'visible',measurementScope:'in_page',cache:'cold',engine:'codex',actorKind:'human',durationMs:10+i}));
    const receipt=store.ingest([...prefix,existing,prefix[0]],'a'.repeat(64));
    assert.equal(receipt.accepted,0);
    assert.equal(receipt.duplicates,2);
    assert.equal(receipt.dropped,64);
    assert.equal(store.accepted,1);
    assert.equal(store.dropped,64);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('capacity receipt survives a secondary rollback failure without masking the full batch',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-full-rollback-'));
  const store=new ObserveStore(join(directory,'observe.sqlite'));
  try{
    const pages=store.db.prepare('PRAGMA page_count').get().page_count;
    store.db.exec(`PRAGMA max_page_count=${pages+3}`);
    const original=store.db.exec.bind(store.db);
    store.db.exec=(sql)=>{if(sql==='ROLLBACK')throw Error('secondary rollback failure');return original(sql);};
    const events=Array.from({length:32},(_,i)=>event({eventId:`rollback-full-${i}`,originClass:'interactive',visibility:'visible',measurementScope:'in_page',cache:'cold',engine:'codex',actorKind:'human',durationMs:10+i}));
    const receipt=store.ingest(events,'a'.repeat(64));
    assert.equal(receipt.accepted,0);assert.equal(receipt.dropped,32);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('service stays queryable and exposes the loss counter after a capacity drop',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-full-service-'));
  const service=await startObserve({directory,deploymentId:'full-test',metricsPort:0,prometheus:'http://127.0.0.1:1'});
  try{
    const before=service.store.db.prepare('SELECT count(*) AS n FROM events').get().n;
    const pages=service.store.db.prepare('PRAGMA page_count').get().page_count;
    service.store.db.exec(`PRAGMA max_page_count=${pages+3}`);
    const events=Array.from({length:32},(_,i)=>event({eventId:`service-full-${i}`,originClass:'interactive',visibility:'visible',measurementScope:'in_page',cache:'cold',engine:'codex',actorKind:'human',durationMs:10+i}));
    const receipt=service.store.ingest(events,'a'.repeat(64));
    assert.equal(receipt.accepted,0);assert.equal(receipt.dropped,32);
    const result=await service.query('usage.activity24h');
    assert.equal(result.loss.dropped,32);assert.equal(result.query,'usage.activity24h');
    assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM events').get().n,before);
  }finally{await service.close();await rm(directory,{recursive:true,force:true});}
});

test('heartbeat-shaped batch at capacity is a drop, not a process failure',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-full-heartbeat-'));
  const service=await startObserve({directory,deploymentId:'full-heartbeat',metricsPort:0,prometheus:'http://127.0.0.1:1'});
  try{
    const pages=service.store.db.prepare('PRAGMA page_count').get().page_count;
    service.store.db.exec(`PRAGMA max_page_count=${pages}`);
    const insert=service.store.db.prepare('INSERT INTO events(event_id,at,received,kind,component,actor,body) VALUES(?,?,?,?,?,?,?)');
    let full=false;
    for(let i=0;i<500;i++){
      try{insert.run(`fill-${i}`,now,now,'operation','web',null,JSON.stringify({schemaVersion:1,kind:'operation',component:'web',eventId:`fill-${i}`,producerId:'fill',at:now,operationType:'thread_open',outcome:'ok',durationMs:1,padding:'x'.repeat(1800)}));}
      catch(error){full=error.errcode===13||/database or disk is full/i.test(error.message);break;}
    }
    assert(full,'fixture must fill the small page budget');
    const heartbeats=Array.from({length:32},(_,i)=>({schemaVersion:1,kind:'resource',component:'observe',producerId:'observe',eventId:`full-heartbeat-${i}`,at:now+i,rssBytes:1,cpuSeconds:1,sourceRevision:null,buildId:null,observedBy:'self',identitySource:'self',producerMode:'native',originClass:'operator'}));
    const receipt=service.store.ingest(heartbeats);
    assert.equal(receipt.accepted,0);assert.equal(receipt.dropped,32);
    const result=await service.query('usage.activity24h');
    assert.equal(result.loss.dropped,32);assert.equal(result.query,'usage.activity24h');
  }finally{await service.close();await rm(directory,{recursive:true,force:true});}
});

test('configured database bytes raise the SQLite page cap without losing old rows',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-capacity-'));
  const path=join(directory,'observe.sqlite');
  let store=new ObserveStore(path,()=>now);
  try{
    assert.equal(store.ingest([event({eventId:'capacity-old'})]).accepted,1);
    const pageSize=store.db.prepare('PRAGMA page_size').get().page_size;
    const pages=store.db.prepare('PRAGMA page_count').get().page_count;
    store.db.exec(`PRAGMA max_page_count=${pages}`);
    assert.equal(store.ingest(Array.from({length:32},(_,i)=>event({eventId:`capacity-blocked-${i}`}))).accepted,0);
    store.close();
    const configured=(pages+64)*pageSize;
    store=new ObserveStore(path,()=>now,configured);
    assert.equal(store.db.prepare('PRAGMA max_page_count').get().max_page_count,pages+64);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1,'old row must survive reopening');
    assert.equal(store.ingest(Array.from({length:8},(_,i)=>event({eventId:`capacity-accepted-${i}`}))).accepted,8);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,9);
    assert.equal(limits.retentionMs,7*86400000);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('real socket, domain dedup, immutable CLI output, unknown query and unavailable backend',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-'));
  const service=await startObserve({directory,deploymentId:'test',metricsPort:0,prometheus:'http://127.0.0.1:1'});
  try{
    const events=[event({kind:'execution',component:'core',engine:'codex',executionId:'one',outcome:'started'}),event({kind:'execution',component:'core',engine:'codex',executionId:'one',outcome:'ok'}),event({kind:'execution',component:'core',engine:'codex',executionId:'one',outcome:'started'})];
    const receipt=await socketRequest(service.socketPath,'/events',{events:[events[0],{bad:'record'},events[1],events[2]]});
    assert.equal(receipt.accepted,3);assert.equal(receipt.rejected,1);
    assert.equal((await socketRequest(service.socketPath,'/events',{events})).duplicates,3);
    assert.deepEqual(service.store.executions(now-1000,now+1000).map(row=>({...row})),[{outcome:'ok',count:1}]);
    const result=await socketRequest(service.socketPath,'/query',{name:'execution.progress'});assert.equal(result.availability,'backend_unreachable');
    await assert.rejects(()=>socketRequest(service.socketPath,'/query',{name:'arbitrary.sql'}),e=>e.code==='unknown_query');
    await assert.rejects(()=>socketRequest(service.socketPath,'/query',{name:'platform.status',scope:'forged'}),e=>e.code==='unknown_argument');
    const target=`unix://${service.socketPath}`,out=join(directory,'before.json');
    const value=await run(['snapshot','--target',target,'--out',out,'--json']);assert.equal(value.schemaVersion,1);assert.equal(value.coverage,'partial');
    const original=await readFile(out,'utf8');await assert.rejects(()=>run(['snapshot','--target',target,'--out',out]),e=>e.code==='EEXIST');assert.equal(await readFile(out,'utf8'),original);
  }finally{await service.close();await rm(directory,{recursive:true,force:true});}
});

test('unknown component identity clears prior identity; unresponsive snapshot shares one deadline',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-deadline-'));
  const stalled=createServer((_req,_res)=>{});await new Promise(resolve=>stalled.listen(0,'127.0.0.1',resolve));
  const service=await startObserve({directory,deploymentId:'deadline-test',metricsPort:0,prometheus:`http://127.0.0.1:${stalled.address().port}`});
  try{
    service.store.ingest([event({kind:'producer',component:'core',producerId:'independent',sourceRevision:'old-core',buildId:'old-build'})]);
    service.store.ingest([event({kind:'producer',component:'core',producerId:'independent',sourceRevision:null,buildId:null,observedBy:'gateway'})]);
    const identity=service.store.producers().find(row=>row.producer==='independent').identity;
    assert.equal(identity.sourceRevision,undefined);assert.equal(identity.buildId,undefined);assert.equal(identity.observedBy,'gateway');
    const started=performance.now();const snapshot=await service.snapshot();
    assert(performance.now()-started<4500);assert.equal(snapshot.coverage,'partial');
    assert(Object.values(snapshot.measurements).every(value=>value.availability==='backend_unreachable'));
  }finally{stalled.closeAllConnections();await new Promise(resolve=>stalled.close(resolve));await service.close();await rm(directory,{recursive:true,force:true});}
});

test('v1 evidence upgrades without rewriting migration history and rejects checksum tampering',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-upgrade-')),path=join(directory,'observe.sqlite');
  try{
    const db=new DatabaseSync(path);
    db.exec(observationSchemaV1+"CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT");
    db.prepare('INSERT INTO schema_migrations VALUES(1,?,?,?)').run('bounded-derived-observations',createHash('sha256').update(observationSchemaV1).digest('hex'),now);
    const original=event({actorKind:'human',originClass:'interactive',recoveryId:'existing',kind:'recovery'});
    db.prepare('INSERT INTO events(event_id,at,received,kind,component,actor,body) VALUES(?,?,?,?,?,?,?)').run(original.eventId,now,now,'recovery','web','verified',JSON.stringify(original));db.close();
    const store=new ObserveStore(path);assert.equal(store.outcome.status,'migrated');assert.equal(store.outcome.appliedVersion,4);
    assert.equal(store.events(now-1000,now+1000,Date.now()).find(row=>row.eventId===original.eventId).recoveryId,'existing');
    assert.equal(store.activity(now-1000,now+1000).humans,1);assert.equal(store.recoveries(now-1000,now+1000).value,1);
    store.db.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=1").run();store.close();
    assert.throws(()=>new ObserveStore(path));
    const inspect=new DatabaseSync(path,{readOnly:true});assert.equal(inspect.prepare('SELECT count(*) AS n FROM events').get().n,1);inspect.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('queue owner snapshots do not add execution rounds; late progress cannot revive a terminal domain',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-domain-'));
  let clock=now;const store=new ObserveStore(join(directory,'observe.sqlite'),()=>clock);
  try{
    store.ingest([event({kind:'queue',component:'gateway',engine:'codex',executionId:'queue-one',count:3})]);
    assert.equal(store.queues()[0].count,3);assert.equal(store.executions(now-1000,now+1000).length,0);
    store.ingest([event({kind:'queue',engine:'codex',executionId:'queue-one',count:7,at:now-500})]);
    assert.equal(store.queues()[0].count,3);
    store.ingest([event({kind:'execution',engine:'codex',executionId:'round-one',outcome:'started',stage:'running'}),event({kind:'execution',engine:'codex',executionId:'round-one',outcome:'progress',stage:'tool',at:now+100})]);
    assert.equal(store.progress()[0].stage,'tool');
    store.ingest([event({kind:'execution',engine:'codex',executionId:'round-one',outcome:'ok',stage:'completed',at:now+200}),event({kind:'execution',engine:'codex',executionId:'round-one',outcome:'progress',stage:'model',at:now-200})]);
    assert.equal(store.progress().length,0);assert.equal(store.executions(now-1000,now+1000)[0].count,1);
    clock=now+91000;assert.equal(store.queues().length,0);
    clock=now+604800001;store.prune();assert.equal(store.db.prepare('SELECT count(*) AS n FROM queue_samples').get().n,0);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});


test('installed CLI executes through a symlink and retains structured failures',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-cli-link-'));
  try{
    const entry=join(directory,'opencraft-observe.mjs');await symlink(fileURLToPath(new URL('../../apps/observability-cli/main.mjs',import.meta.url)),entry);
    const result=await new Promise(resolve=>execFile(process.execPath,[entry,'capabilities','--target',`unix://${directory}/missing.sock`,'--json'],{timeout:10000},(error,stdout)=>resolve({code:error?.code,stdout})));
    assert.equal(result.code,5);assert.equal(JSON.parse(result.stdout).error.code,'backend_unreachable');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('latest component response stays bounded across 10000 clients; probe/cache/visibility cannot mix latency histograms',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'opencraft-observe-cardinality-'));
  const service=await startObserve({directory,deploymentId:'cardinality-fixture',metricsPort:0,prometheus:'http://127.0.0.1:1'});
  try{
    for(let offset=0;offset<10000;offset+=32)service.store.ingest(Array.from({length:Math.min(32,10000-offset)},(_,i)=>event({kind:'client_signal',producerId:`client-${offset+i}`,incidentRef:`incident-${offset+i}`,executionId:`domain-${offset+i}`,actorKind:'human',originClass:'probe'})),'a'.repeat(64));
    const status=await service.query('platform.status');assert(status.components.length<=11);assert(JSON.stringify(status).length<65536);
    assert.equal(service.store.activity(now-1000,now+1000).humans,0);
    const valid={actorKind:'human',visibility:'visible',originClass:'interactive',measurementScope:'in_page',engine:'codex'};
    service.store.ingest([event({...valid,cache:'cold'}),event({...valid,cache:'warm'}),event({...valid,cache:'cold',originClass:'probe'}),event({...valid,cache:'cold',visibility:'hidden'}),event({...valid,cache:'cold',measurementScope:'rpc'})],'a'.repeat(64));
    const counters=service.store.db.prepare("SELECT dimension,value FROM metrics WHERE name='foreground_operation_count' ORDER BY dimension").all();
    assert.equal(counters.length,2);assert.deepEqual(counters.map(r=>r.value),[1,1]);assert.equal(service.store.activity(now-1000,now+1000).humans,1);
    service.store.ingest([event({...valid,actorKind:'human',cache:'cold'})],'b'.repeat(64));
    assert.equal(service.store.activity(now-1000,now+1000).humans,2);
    assert(service.store.db.prepare('SELECT count(*) AS n FROM metrics').get().n<10000);
  }finally{await service.close();await rm(directory,{recursive:true,force:true});}
});


for (const capability of ['normal', 'no-randomUUID', 'no-crypto', 'named-server']) {
  test(`client observation remains usable with ${capability}`, async () => {
    const moduleUrl = new URL('../../apps/workbench-web/src/runtime/observability.ts', import.meta.url).href;
    const contractUrl = new URL('../../packages/observability-contract/index.mjs', import.meta.url).href;
    const source = `
      import assert from 'node:assert/strict';
      if (${JSON.stringify(capability)} === 'no-randomUUID') Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      if (${JSON.stringify(capability)} === 'no-crypto') Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      const base = ${JSON.stringify(capability)} === 'named-server' ? '/servers/remote' : '';
      const document = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: () => null, getElementById: () => base ? {textContent: JSON.stringify({id:'remote',name:'Remote',basePath:base,selectorPath:'/servers'})} : null });
      const window = new EventTarget();
      Object.assign(globalThis, { document, window, PerformanceObserver: class { static supportedEntryTypes = []; } });
      Object.defineProperty(globalThis, 'performance', { configurable: true, value: {
        now: () => 10, timeOrigin: Date.now() - 10,
        getEntriesByType: () => [{ startTime: 0, type: 'navigate' }],
      } });
      const batches = [];
      let capabilityReads = 0, openCommand, opened;
      window.open = url => { opened = url; };
      globalThis.fetch = async (url, options) => {
        if (url.endsWith('/capabilities')) { assert.equal(url, base + '/__opencraft_observe/capabilities'); capabilityReads++; return { ok: true, json: async () => ({ telemetry: true, available: true }) }; }
        assert.equal(url, base + '/__opencraft_observe/events');
        batches.push(JSON.parse(options.body).events);
        return { ok: true };
      };
      const observation = await import(${JSON.stringify(moduleUrl)});
      const disabled = observation.beginObservedOperation('thread_open'); disabled('ok');
      observation.observeEvent({ kind: 'producer' });
      assert.equal(capabilityReads, 0); assert.deepEqual(batches, []);
      const controller = new AbortController();
      await observation.createObservabilityExtension().activate({ signal: controller.signal, commands: { register: (_definition, run) => {openCommand = run;} }, navigation: { register() {} } });
      openCommand(); assert.equal(opened, base + '/__opencraft_observe/grafana/d/opencraft-overview');
      const finish = observation.beginObservedOperation('thread_open'); finish('ok'); finish('failed');
      let lifecycle, unsubscribed = false;
      const client = { connectionGeneration: 2, subscribeRequestLifecycle(callback) { lifecycle = callback; return () => { unsubscribed = true; }; } };
      const dispose = observation.installClientObservation(client);
      lifecycle({ type: 'completed', durationMs: 3, hostId: 'fixture', id: 1, method: 'thread/read' });
      client.connectionGeneration = 3;
      lifecycle({ type: 'timed-out', durationMs: 4, hostId: 'fixture', id: 1, method: 'thread/read' });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort(); dispose();
      const events = batches.flat();
      assert(events.length >= 6); assert(unsubscribed);
      const { sanitizeEvent } = await import(${JSON.stringify(contractUrl)});
      assert(events.every(event => sanitizeEvent(event) !== null));
      assert(events.every(event => event.producerId !== 'unavailable'));
      assert.equal(new Set(events.map(event => event.producerId)).size, 1);
      assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
      const operations = events.filter(event => event.operationType === 'thread_open');
      assert.deepEqual(operations.map(event => event.outcome), ['started', 'ok']);
      assert.equal(operations[0].operationId, operations[1].operationId);
      const navigation = events.find(event => event.operationType === 'navigation');
      assert(navigation); assert.notEqual(navigation.operationId, operations[0].operationId);
      const requests = events.filter(event => event.kind === 'rpc');
      assert.equal(requests.length, 2); assert.notEqual(requests[0].requestId, requests[1].requestId);
      assert(requests[1].incidentRef); assert.notEqual(requests[1].incidentRef, requests[1].eventId);
      console.log('client observation capability passed');
    `;
    const stdout = await new Promise((resolve, reject) => execFile(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout)));
    assert.match(stdout, /client observation capability passed/);
  });
}

test('executions lifecycle retains started across progress events and prunes stale progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-observe-blindspots-'));
  let clock = now;
  const store = new ObserveStore(join(directory, 'observe.sqlite'), () => clock);
  try {
    // 1. Started is not overwritten by progress
    store.ingest([event({ kind: 'execution', engine: 'codex', executionId: 'turn-1', outcome: 'started', stage: 'running', at: clock })]);
    assert.deepEqual(store.executions(clock - 1000, clock + 1000).map(r => ({ ...r })), [{ outcome: 'started', count: 1 }]);
    store.ingest([event({ kind: 'execution', engine: 'codex', executionId: 'turn-1', outcome: 'progress', stage: 'tool', at: clock + 50 })]);
    assert.deepEqual(store.executions(clock - 1000, clock + 1000).map(r => ({ ...r })), [{ outcome: 'started', count: 1 }]);
    assert.equal(store.progress()[0].stage, 'tool');
    store.ingest([event({ kind: 'execution', engine: 'codex', executionId: 'turn-1', outcome: 'ok', stage: 'completed', at: clock + 100 })]);
    assert.deepEqual(store.executions(clock - 1000, clock + 1000).map(r => ({ ...r })), [{ outcome: 'ok', count: 1 }]);
    assert.equal(store.progress().length, 0);

    // 2. Stale execution progress (> 30 min) is excluded from progress() and marked terminal by prune()
    store.ingest([event({ kind: 'execution', engine: 'codex', executionId: 'stale-turn', outcome: 'started', stage: 'running', at: clock })]);
    assert.equal(store.progress().length, 1);
    clock += 1_800_001;
    assert.equal(store.progress().length, 0);
    store.prune();
    const row = store.db.prepare("SELECT terminal FROM execution_progress WHERE domain_key='codex:stale-turn'").get();
    assert.equal(row.terminal, 1);

    // 3. Newly added RPC methods are accepted by sanitizeEvent
    for (const m of ['thread/fork', 'thread/items/list', 'tasks/list', 'skills/read', 'fs/read', 'fuzzyFileSearch', 'mcpServerStatus/list']) {
      const e = sanitizeEvent({ schemaVersion: 1, kind: 'rpc', component: 'web', eventId: 'evt1', producerId: 'p1', at: clock, method: m, outcome: 'ok' }, clock);
      assert.notEqual(e, null, `method ${m} should be accepted`);
      assert.equal(e.method, m);
    }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('nodeObserver supports processResources:false and resolves thread.id fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencraft-node-obs-'));
  const socketPath = join(dir, 'test.sock');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: 1 }));
  });
  await new Promise(r => server.listen(socketPath, r));
  try {
    const obsWithoutRes = nodeObserver('pi', { socketPath, processResources: false });
    assert.equal(obsWithoutRes.stats().pending, 0);

    obsWithoutRes.execution('codex', 'turn/started', { turn: { id: 'turn-99' }, thread: { id: 'thr-xyz' } });
    assert.equal(obsWithoutRes.stats().pending, 1);
    obsWithoutRes.close();
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('operator Grafana paths accept server scope and reject traversal or URL input',async()=>{
  const {observationGrafanaBasePath}=await import('../../packages/observability-contract/node.mjs');
  assert.equal(observationGrafanaBasePath(),'/__opencraft_observe/grafana');
  assert.equal(observationGrafanaBasePath('/servers/example/__opencraft_observe/grafana'),'/servers/example/__opencraft_observe/grafana');
  for(const path of ['https://elsewhere.invalid/__opencraft_observe/grafana','//elsewhere.invalid/__opencraft_observe/grafana','/servers/../__opencraft_observe/grafana','/servers/%2e%2e/__opencraft_observe/grafana','/__opencraft_observe/grafana?x=1'])assert.throws(()=>observationGrafanaBasePath(path));
});

test('history first paint labels and foreground-only histograms reach the exporter and dashboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-paint-observe-'));
  const service = await startObserve({directory, deploymentId:'test', metricsPort:0});
  try {
    const fields = {operationType:'thread_history_first_paint',cache:'cold',engine:'pi',lengthBucket:'200to499',originClass:'interactive',visibility:'visible',measurementScope:'in_page',durationMs:560};
    assert.equal(sanitizeEvent(event({...fields,lengthBucket:'private-thread-123'})),null);
    assert(!('threadId' in sanitizeEvent(event({...fields,threadId:'private-thread-123'}))));
    for (const outcome of ['ok','aborted','failed','empty']) assert.equal(service.store.ingest([event({...fields,outcome})]).accepted,1);
    service.store.ingest([event({...fields,originClass:'probe'}), event({...fields,visibility:'hidden'})]);
    const metrics = await (await fetch(`http://127.0.0.1:${service.metricsAddress.port}/metrics`)).text();
    assert.match(metrics,/opencraft_thread_history_first_paint_duration_seconds_count\{cache="cold",length_bucket="200to499",engine="pi"\} 1/);
    for (const outcome of ['ok','aborted','failed','empty']) assert(metrics.includes(`engine="pi",outcome="${outcome}",origin="interactive"}`));
    assert(!metrics.includes('private-thread'));
    const output = join(directory,'provisioning-source'); await generate(output);
    const dashboard = JSON.parse(await readFile(join(output,'provisioning/dashboards/overview.json'),'utf8'));
    for (const q of [50,95]) {
      const definition = definitions[`operations.history_paint_p${q}`];
      assert(dashboard.panels.some(panel=>panel.title === definition.title && panel.targets.some(target=>target.expr===definition.promql)));
      assert(definition.promql.includes('cache, length_bucket, engine'));
    }
  } finally { await service.close(); await rm(directory,{recursive:true,force:true}); }
});
