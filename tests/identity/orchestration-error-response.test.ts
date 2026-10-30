import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { SessionCapabilities } from '../../packages/session-capabilities/src/index';
import { SessionCapabilityMcp } from '../../packages/session-capabilities/src/mcp';

test('MCP distinguishes a confirmed preparation rejection from an uncertain Host delivery',async t=>{
  let known=true;
  const capabilities=new SessionCapabilities();
  capabilities.register({id:'fixture',tools:()=>[{name:'fixture_probe',description:'fixture',inputSchema:{type:'object'}}],call:async()=>null});
  const mcp=new SessionCapabilityMcp(capabilities,randomBytes(32),undefined,{orchestration:async()=>{
    throw Object.assign(new Error('PRIVATE_NATIVE_MESSAGE'),{code:known?403:-32081,...(known?{status:403}:{})});
  }});
  await mcp.listen();t.after(()=>mcp.close());
  const config=mcp.config({serverId:'server',threadId:'source'}) as {url:string;http_headers:Record<string,string>};
  for(const value of [true,false]){
    known=value;
    const response=await fetch(config.url.replace(/\/mcp$/,'/orchestration'),{method:'POST',headers:{...config.http_headers,'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,known?403:503);
    assert.deepEqual(await response.json(),{error:known?'orchestration_rejected':'orchestration_outcome_unknown'});
  }
});
