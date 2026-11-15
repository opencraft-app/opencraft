import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectedAgentHost} from '../../apps/local-agent-host/src/connected-agents.js';

test('CodeBuddy readiness requires a fresh native session, not a saved model catalog',async()=>{
 let signedIn=true,starts=0;
 const host=new ConnectedAgentHost({async status(){return {agents:[{id:'codebuddy',installed:true,authenticated:null,activity:null}]};}} as never,'/unused','/workspace',{} as never);
 (host as any).engines.set('codebuddy',{async request(method:string){
  if(method==='thread/start'){starts++;await new Promise(r=>setTimeout(r,1));if(!signedIn)throw Error('Authentication required');return {thread:{id:'codebuddy_probe'}};}
  if(method==='model/list')return {data:[{id:'codebuddy:model',displayName:'Native model'}]};
  if(method==='thread/archive')return {};throw Error('Unexpected execution during discovery');
 },async close(){}});
 try{
  const [a,b]=await Promise.all([host.status(),host.status()]);assert.equal(a.agents[0]?.authenticated,true);assert.equal(b.agents[0]?.authenticated,true);assert.equal(starts,1);
  signedIn=false;assert.equal((await host.status()).agents[0]?.authenticated,false);assert.equal(starts,2);
 }finally{await host.close();}
});


test('connecting an installed agent preserves requested restrictions',async()=>{
 const host=new ConnectedAgentHost({} as never,'/unused','/workspace',{} as never);
 let forwarded:any;
 (host as any).engines.set('codebuddy',{async request(method:string,params:any){forwarded=params;throw Error('Restricted profile is unavailable');},async close(){}});
 try{await assert.rejects(host.dispatch('thread/start',{model:'codebuddy:model',permissions:'read-only-profile',approvalPolicy:'on-request',sandbox:'read-only'}),/Restricted profile/);assert.equal(forwarded.permissions,'read-only-profile');assert.equal(forwarded.approvalPolicy,'on-request');assert.equal(forwarded.sandbox,'read-only');}finally{await host.close();}
});
