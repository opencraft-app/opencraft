import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { AppHostServer } from '../../packages/app-host-server/src/index.ts';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';
import { withGatewayUpdateIntent, readGatewayUpdateIntent } from '../../scripts/server-deployment/gateway-update-intent.mjs';
import { ObserveStore } from '../../apps/observability-service/store.ts';

test('a publication receipt is bound to its selected release and removed after a failed restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'oc-update-intent-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const target = join(root, 'release'), link = join(root, 'current'); await mkdir(target);
  await writeFile(join(target, 'package.json'), JSON.stringify({opencraftWeb:{buildId:'target-build'}})); await symlink(target,link);
  const release = {releaseRoot:target,buildId:'target-build'};
  await assert.rejects(withGatewayUpdateIntent(link, release, async () => {
    const context = await readGatewayUpdateIntent(join(link,'execution/gateway.mjs'));
    assert.equal(context.buildId,'target-build');
    assert.equal(await readGatewayUpdateIntent(join(link,'execution/gateway.mjs'), Date.now()+121000),null);
    throw Error('restart failed');
  }), /restart failed/);
  await assert.rejects(readFile(link+'.restart.json'),{code:'ENOENT'});
});

test('gateway publication counts actually open browser wires before closing them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'oc-update-wires-'));
  const appHost = new AppHostServer({createTransport(){throw Error('no model used');}});
  const native=new WebSocketServer({host:'127.0.0.1',port:0});await once(native,'listening');
  const receipts = [];
  const web = await createWorkbenchWebServer({root,appHostServer:appHost,appServerTarget:`ws://127.0.0.1:${native.address().port}`,
    observability:{handle:async()=>false,gatewayShutdown:async(count,update)=>{receipts.push({count,update});}}});
  const address = await web.listen({host:'127.0.0.1',port:0}), origin = `http://127.0.0.1:${address.port}`;
  const sockets=[];
  t.after(async()=>{for(const s of sockets)s.terminate();await appHost.close();for(const s of native.clients)s.terminate();await new Promise(done=>native.close(done));await rm(root,{recursive:true,force:true});});
  for(const path of ['/apphost','/apphost','/appserver']){const socket=new WebSocket(origin.replace('http','ws')+path,{origin});sockets.push(socket);await once(socket,'open');}
  const closed = sockets.map(socket=>once(socket,'close'));
  const update={updateId:'update-id',buildId:'target'};await web.close(update);
  assert.ok((await Promise.all(closed)).every(([code])=>code===1012),'browsers receive the standard service restart hint');
  assert.deepEqual(receipts,[{count:3,update}]);
});

test('person daily downtime unions tabs, splits UTC midnight and retains unfinished observations', async t => {
  const root=await mkdtemp(join(tmpdir(),'oc-outage-rollup-')), midnight=Date.UTC(2026,9,29), now=midnight+60000;
  let store=new ObserveStore(join(root,'observe.sqlite'),()=>now);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const actor='a'.repeat(64);
  const outage=(id,at,durationMs,outcome='ok',scope='connection')=>({schemaVersion:1,kind:'recovery',component:'web',producerId:'browser',eventId:crypto.randomUUID(),
    at,recoveryId:id,durationMs,outcome,stage:outcome==='ok'?'ready':'connecting',measurementScope:scope,originClass:'interactive',actorKind:'human'});
  const terminal=outage('tab-a',midnight+5000,10000);
  assert.equal(store.ingest([terminal,outage('tab-b',midnight+15000,15000),outage('pending',midnight+12000,2000,'progress'),outage('cold',midnight+20000,20000,'ok','client')],actor).accepted,4);
  assert.equal(store.ingest([terminal],actor).duplicates,1);
  store.ingest([outage('unverified',midnight+30000,30000)],null);
  const publication={schemaVersion:1,kind:'lifecycle',lifecycle:'deployment',component:'gateway',producerId:'updater',eventId:'publication',operationId:'update-1',buildId:'build-1',at:now,count:0};
  store.ingest([publication,publication]);
  assert.deepEqual(store.gatewayDisconnections(midnight,now).map(row=>({...row})),[{updateId:'update-1',buildId:'build-1',count:0}]);
  assert.deepEqual(store.connectionDowntime(midnight-86400000,now),[
    {actor,day:'2026-10-28',seconds:5,unfinished:0}, {actor,day:'2026-10-29',seconds:15,unfinished:1},
  ]);
  store.close(); store=new ObserveStore(join(root,'observe.sqlite'),()=>now);
  assert.equal(store.connectionDowntime(midnight,now)[0].seconds,15);
});
