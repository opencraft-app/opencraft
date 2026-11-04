import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {run} from '../../apps/opencraft-cli/src/main';
import {CliSshTransport} from '../../apps/opencraft-cli/src/ssh';
const ref='opencraft://conversation/v1/s/t';
test('show configuration requires explicit selector and opt-in before opening any connection',async()=>{
 for(const args of [['--include-turn-configuration'],['--turn','A'],['--include-turn-configuration','--turn','A','--delivery','R']])
  await assert.rejects(run(['thread','show',ref,...args]),{code:'INVALID_ARGUMENTS'});
});
test('show default and receipt remain cheap; explicit configuration is independently negotiated',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cli-config-')),prior=process.env.OPENCRAFT_CONFIG;process.env.OPENCRAFT_CONFIG=join(root,'connections.json');
 t.after(async()=>{if(prior===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=prior;await rm(root,{recursive:true,force:true});});
 await writeFile(process.env.OPENCRAFT_CONFIG,JSON.stringify({schemaVersion:1,defaultConnection:'test',connections:{test:{sshAlias:'fixture',instanceId:'i'}}}));
 let capable=true;const actions:string[]=[];
 t.mock.method(CliSshTransport.prototype,'connect',async function(this:any){this.update({state:'open'});});
 t.mock.method(CliSshTransport.prototype,'send',async function(this:any,frame:string){const m=JSON.parse(frame);if(m.id===undefined)return;
  const a=m.params?.action;actions.push(a??m.method);
  const result=m.method==='initialize'?{capabilities:{extensions:{'opencraft/collaboration':{version:1,servers:true,metadata:true,deliveryMetadata:true,lookup:true,turnConfigurationObservation:capable}}}}
   :a==='servers'?{instanceId:'i',actor:{id:'fixture',kind:'human',generation:1},servers:[{serverId:'s',capabilities:{metadata:true,turnConfigurationObservation:capable}}]}
   :a==='metadata'?{ref:{serverId:'s',threadId:'t'},actualTurnSettings:null}
   :a==='delivery'?{ref:{serverId:'s',threadId:'t'},requestId:'R',targetTurnId:'A',actualTurnSettings:null,taskOutcome:'unknown'}
   :a==='lookup'?{found:true,receipt:{ref:{serverId:'s',threadId:'t'},targetTurnId:'A',actualTurnSettings:null}}
   :{turnConfigurationObservation:{status:'observed',turnId:m.params.target.turnId??'A',scope:'turn-first-recorded-context'}};
  for(const listener of this.messages)listener(JSON.stringify({id:m.id,result}));
 });
 const plain=await run(['thread','show',ref]) as any;assert.equal(plain.actualTurnSettings,null);assert.equal(actions.includes('turnConfigurationObservation'),false);
 await run(['thread','show',ref,'--delivery','R']);assert.equal(actions.includes('turnConfigurationObservation'),false);
 const observed=await run(['thread','show',ref,'--delivery','R','--include-turn-configuration']) as any;assert.equal(observed.actualTurnSettings,null);assert.equal(observed.turnConfigurationObservation.turnId,'A');
 const explicit=await run(['thread','show',ref,'--turn','B','--include-turn-configuration']) as any;assert.equal(explicit.turnConfigurationObservation.turnId,'B');
 capable=false;actions.length=0;const old=await run(['thread','show',ref,'--delivery-key','K','--include-turn-configuration']) as any;assert.equal(old.turnConfigurationObservation.status,'unsupported');assert.equal(actions.includes('turnConfigurationObservation'),false);
});

test('outer configuration deadline is unknown while an immediate Host failure stays unavailable',{timeout:15000},async()=>{
 const {createConversationExecution}=await import('../../scripts/conversation-execution.mjs');
 let closed=0;const host={accept(){return{close(){closed++;}};}};
 const port=createConversationExecution(()=>host,{serverId:'s',hostId:'h'});
 const keepAlive=setTimeout(()=>{},12000);
 try{
  const result=await port.turnConfigurationObservation({serverId:'s',threadId:'t'},'A');
  assert.equal(result.status,'unknown');assert.equal(result.model,null);assert.equal(result.watermark,null);assert.equal(closed,1);
 }finally{clearTimeout(keepAlive);}
 const failing=createConversationExecution(()=>({accept(){throw Error('local source unavailable');}}),{serverId:'s',hostId:'h'});
 assert.equal((await failing.turnConfigurationObservation({serverId:'s',threadId:'t'},'A')).status,'unavailable');
});
