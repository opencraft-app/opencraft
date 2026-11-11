import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshCodexExecutionConfiguration } from '@opencraft/codex-execution';

test('shared execution configuration preserves read-only and approval settings across retirement',async()=>{
  const calls:{method:string;params:any}[]=[],live={sandbox:{type:'readOnly'},approvalPolicy:'on-request',approvalsReviewer:'user',model:'fixture',reasoningEffort:'low'};
  let unloaded=false,retirement:any;
  await refreshCodexExecutionConfiguration('thread',{'shell_environment_policy.set':{OPENCRAFT_THREAD_CLI:'fixture'}},{
    async request(method,params){calls.push({method,params});
      if(method==='thread/read')return {thread:{status:{type:unloaded?'notLoaded':'idle'}}};
      if(method==='thread/unsubscribe'){unloaded=true;return {};}
      return live;
    },current(){},stage(){},nativeStatus(){},ephemeral(){throw Error('unexpected');},cancelRelease(){},
    retirement:()=>retirement,waitForRetirement:false,pending:()=>Error('pending'),invalidate(){},
    retire:value=>{retirement=value;},unsubscribed(){},clearRetirement(){retirement=undefined;},
  });
  const resume=calls.filter(c=>c.method==='thread/resume').at(-1)!.params;
  assert.equal(resume.sandbox,'read-only');assert.equal(resume.approvalPolicy,'on-request');
  assert.equal(resume.approvalsReviewer,'user');
  const settings=calls.find(c=>c.method==='thread/settings/update')!.params;
  assert.deepEqual(settings.sandboxPolicy,{type:'readOnly'});assert.equal(settings.approvalPolicy,'on-request');
  assert.ok(calls.findIndex(c=>c.method==='thread/unsubscribe')<calls.findLastIndex(c=>c.method==='thread/resume'));
});

test('bridge configuration waits for native retirement and rechecks owner lifetime',async()=>{
  let reads=0,checks=0;const calls:string[]=[];
  await refreshCodexExecutionConfiguration('thread',{}, {
    async request(method){calls.push(method);if(method==='thread/read')return {thread:{status:{type:++reads<3?'idle':'notLoaded'}}};return {sandbox:{type:'readOnly'},approvalPolicy:'on-request'};},
    current(){checks++;},stage(){},nativeStatus(){},ephemeral(){},cancelRelease(){},retirement:()=>undefined,
    waitForRetirement:true,pending:()=>Error('pending'),invalidate(){},retire(){},unsubscribed(){},clearRetirement(){},
  });
  assert.equal(reads,3);assert.equal(checks,2);assert.equal(calls.filter(method=>method==='thread/unsubscribe').length,1);
});

test('bridge retirement budget refuses before applying configuration or starting a Turn',async()=>{
  const calls:string[]=[];
  await assert.rejects(refreshCodexExecutionConfiguration('thread',{}, {
    async request(method){calls.push(method);if(method==='thread/read')return {thread:{status:{type:'idle'}}};return {sandbox:{type:'readOnly'}};},
    current(){},stage(){},nativeStatus(){},ephemeral(){},cancelRelease(){},retirement:()=>undefined,
    waitForRetirement:true,retirementTimeoutMs:0,pending:()=>Error('cliUnavailable'),invalidate(){},retire(){},unsubscribed(){},clearRetirement(){},
  }),/cliUnavailable/);
  assert.equal(calls.filter(method=>method==='thread/resume').length,1);
  assert.ok(!calls.includes('turn/start'));
});
