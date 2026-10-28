import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedWebServer } from '../../scripts/web-deployment/server.mjs';
import { parseWebUpdateStatus } from '../../packages/web-update-protocol/src/index.mjs';
import { releaseFixture } from '../support/web-deployment-fixture.mjs';

test('failed rollback recovery keeps current Web authoritative until a verified retry', async t => {
  const root = await mkdtemp(join(tmpdir(),'rollback-recovery-'));
  const fixture = await releaseFixture(root);
  let allowed=false, calls=0;
  const app=await createManagedWebServer({initialRelease:fixture.releases.get('1.0.0').packageRoot,
    stateDirectory:join(root,'state'),source:fixture.source,
    recoveryMarker:join(root,'maintenance'),
    rollbackRecovery:async()=>{calls++;if(!allowed)throw Error('connection probe failed');}});
  t.after(async()=>{await app.close();await fixture.close();await rm(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+(await app.listen({port:0})).port;
  let cookie='';
  const post=(action,data={})=>fetch(base+'/__opencraft_updates/'+action,{method:'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify(data)});
  const status=async()=>parseWebUpdateStatus(await (await fetch(base+'/__opencraft_updates')).json());
  const wait=async phase=>{const end=Date.now()+15000;while(Date.now()<end){const value=await status();if(value.job?.phase===phase)return value;await delay(20);}throw Error('transaction timeout');};
  const login=await post('login',{key:(await readFile(app.adminKeyPath,'utf8')).trim()});cookie=login.headers.get('set-cookie').split(';')[0];
  await post('check');
  for(let n=0;n<200&&(await status()).checking;n++)await delay(10);
  assert.equal((await post('install',{version:'1.1.0'})).status,202);await wait('completed');
  assert.equal(calls,0);
  assert.deepEqual((await status()).recovery,{maintenanceMarker:true,rollbackHook:true});
  assert.equal((await post('rollback')).status,202);
  assert.equal((await wait('failed')).current.version,'1.1.0');
  assert.match(await (await fetch(base+'/')).text(),/1\.1\.0/);
  allowed=true;
  assert.equal((await post('rollback')).status,202);
  assert.equal((await wait('completed')).current.version,'1.0.0');assert.equal(calls,2);
});
