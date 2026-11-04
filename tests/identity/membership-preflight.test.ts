import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openServerDatabase} from '../../packages/storage-node/src/server/index.js';
import {MembershipStore} from '../../packages/access-control/src/index.js';
test('empty alias binding stays read-only during another writer and explicit revocation wins',async()=>{
 const root=await mkdtemp(join(tmpdir(),'oc-member-preflight-')),db=await openServerDatabase(root),store=new MembershipStore(db);
 const principal={provider:'fixture',subject:'stable',displayName:'Fixture',expiresAt:Date.now()+60000,aliases:['legacy']};
 try{
  for(const aliases of [[],['ungranted']]){
   const worker=new Worker(`const{parentPort,workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);db.exec('COMMIT');db.close();`,{eval:true,workerData:join(root,'opencraft-server.sqlite'),execArgv:[]});
   try{await once(worker,'message');const began=performance.now();store.bindLegacyAlias({...principal,aliases});assert.ok(performance.now()-began<100,'empty binding waited for writer');await once(worker,'exit');}
   finally{await worker.terminate();}
  }
  store.set({...principal,subject:'legacy'},'member',true,'fixture');store.set(principal,'member',false,'fixture');
  store.bindLegacyAlias(principal);assert.equal(store.membership(principal)?.enabled,false);assert.equal(store.membership({...principal,subject:'legacy'})?.enabled,true);
  store.bindLegacyAlias({...principal,subject:'new-stable'});assert.equal(store.membership({...principal,subject:'new-stable'})?.enabled,true);assert.equal(store.membership({...principal,subject:'legacy'})?.enabled,false);
 }finally{store.close();await db.close();await rm(root,{recursive:true,force:true});}
});
