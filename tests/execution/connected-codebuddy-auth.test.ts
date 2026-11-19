import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectedAgentHost} from '../../apps/local-agent-host/src/connected-agents.js';

test('CodeBuddy readiness reads the native account without opening a session or caching a placeholder model',async()=>{
 let signedIn=true,lookups=0,starts=0;
 const host=new ConnectedAgentHost({async status(){return {agents:[{id:'codebuddy',installed:true,authenticated:null,activity:null}]};}} as never,'/unused','/workspace',{} as never);
 (host as any).engines.set('codebuddy',{
  async readCodeBuddyUser(){lookups++;await new Promise(r=>setTimeout(r,1));return signedIn;},
  async request(method:string){if(method==='thread/start')starts++;throw Error('status must not create a session or read the model cache');},
  async close(){},
 });
 try{
  const [a,b]=await Promise.all([host.status(),host.status()]);
  assert.equal(a.agents[0]?.authenticated,true);assert.equal(b.agents[0]?.authenticated,true);assert.equal(lookups,1);assert.equal(starts,0);
  assert.equal((host as any).discovered.has('codebuddy'),false);
  signedIn=false;assert.equal((await host.status()).agents[0]?.authenticated,false);assert.equal(lookups,2);assert.equal(starts,0);
  (host as any).engines.set('codebuddy',{async readCodeBuddyUser(){throw Error('ACP engine is not connected');},async request(){throw Error('status must not create a session');},async close(){}});
  assert.equal((await host.status()).agents[0]?.authenticated,null);
  (host as any).engines.set('codebuddy',{async readCodeBuddyUser(){throw Error('Authentication required: no account');},async close(){}});
  assert.equal((await host.status()).agents[0]?.authenticated,false);
 }finally{await host.close();}
});


test('connecting an installed agent preserves requested restrictions',async()=>{
 const host=new ConnectedAgentHost({} as never,'/unused','/workspace',{} as never);
 let forwarded:any;
 (host as any).engines.set('codebuddy',{async request(method:string,params:any){forwarded=params;throw Error('Restricted profile is unavailable');},async close(){}});
 try{await assert.rejects(host.dispatch('thread/start',{model:'codebuddy:model',permissions:'read-only-profile',approvalPolicy:'on-request',sandbox:'read-only'}),/Restricted profile/);assert.equal(forwarded.permissions,'read-only-profile');assert.equal(forwarded.approvalPolicy,'on-request');assert.equal(forwarded.sandbox,'read-only');}finally{await host.close();}
});
