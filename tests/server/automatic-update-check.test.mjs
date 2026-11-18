import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createUpdateChecker} from '../../scripts/web-deployment/update-checker.mjs';
import {parseWebUpdateStatus} from '../../packages/web-update-protocol/src/index.mjs';

async function until(predicate) {
  const end=Date.now()+2000;
  while(!predicate()){if(Date.now()>end)throw new Error('Update check timed out');await delay(5);}
}
test('server checks without a browser, serializes discovery and stops scheduling on shutdown',async t=>{
  let calls=0,release,active=0,maximum=0;
  const checker=createUpdateChecker({initialDelayMs:0,intervalMs:15,canCheck:()=>true,
    check:async()=>{calls++;active++;maximum=Math.max(maximum,active);if(calls===1)await new Promise(r=>release=r);active--;}});
  t.after(()=>checker.close());checker.start();checker.start();
  await until(()=>calls===1);await delay(45);assert.equal(calls,1);release();
  await until(()=>calls>=2);assert.equal(maximum,1);checker.close();
  const stopped=calls;await delay(40);assert.equal(calls,stopped);assert.equal(checker.snapshot().nextCheckAt,null);
});
test('execution/update activity defers discovery and transient errors do not stop the schedule',async t=>{
  let blocked=true,calls=0;
  const checker=createUpdateChecker({initialDelayMs:0,intervalMs:15,canCheck:()=>!blocked,
    check:async()=>{calls++;if(calls===1)throw new Error('Registry offline');}});
  t.after(()=>checker.close());checker.start();await delay(40);assert.equal(calls,0);blocked=false;
  await until(()=>calls>=2);assert.equal(checker.snapshot().enabled,true);
});
test('disabled checks do not query the source and invalid scheduling options are rejected',async()=>{
  let calls=0;const checker=createUpdateChecker({intervalMs:0,check:async()=>calls++,canCheck:()=>true});
  checker.start();await delay(15);assert.equal(calls,0);assert.deepEqual(checker.snapshot(),{enabled:false,intervalMs:0,nextCheckAt:null});checker.close();
  for(const intervalMs of [-1,NaN,Infinity,1.5,2_147_483_648])assert.throws(()=>createUpdateChecker({intervalMs,check(){},canCheck(){}}));
});
test('update status preserves the server schedule while accepting older peers',()=>{
  const base={schemaVersion:1,enabled:true,authenticated:false,current:{version:'1.0.0',buildId:'one'},latest:null,
    checking:false,checkedAt:null,checkError:null,canRollback:false,updateAvailable:false,execution:null,packageName:'fixture',channel:'latest',job:null};
  assert.equal(parseWebUpdateStatus(base).automaticCheck,undefined);
  assert.equal(parseWebUpdateStatus({...base,fullUpgrade:false}).fullUpgrade,false);
  assert.equal(parseWebUpdateStatus({...base,fullUpgrade:true}).fullUpgrade,true);
  assert.throws(()=>parseWebUpdateStatus({...base,fullUpgrade:'yes'}));
  const automaticCheck={enabled:true,intervalMs:21600000,nextCheckAt:new Date().toISOString()};
  assert.deepEqual(parseWebUpdateStatus({...base,automaticCheck}).automaticCheck,automaticCheck);
  for(const bad of [{...automaticCheck,enabled:false},{...automaticCheck,intervalMs:-1},{...automaticCheck,nextCheckAt:'invalid'}])
    assert.throws(()=>parseWebUpdateStatus({...base,automaticCheck:bad}));
});
