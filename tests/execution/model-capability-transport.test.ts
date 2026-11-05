import test from 'node:test';import assert from 'node:assert/strict';
import {ModelCapabilityTransport} from '../../apps/local-agent-host/src/model-capability-transport';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
function fixture(inspect:any=async()=>({model:'m',revision:3,capabilities:{},sources:{},checks:[],notes:[]})){
 const listeners=new Set<(frame:string)=>void>(),sent:any[]=[];let current=true;
 const inner={status:{state:'open' as const},async connect(){},async close(){},subscribeMessage(fn:(f:string)=>void){listeners.add(fn);return()=>listeners.delete(fn)},subscribeStatus(){return()=>{}},captureMessageScope(){return()=>current},async send(frame:string){sent.push(JSON.parse(frame))},async sendWithContext(frame:string,context:any){sent.push({value:JSON.parse(frame),context})}};
 const transport=new ModelCapabilityTransport(inner,{read:async()=>({}as any),credential:async()=>undefined},inspect);const output:any[]=[];transport.subscribeMessage(f=>output.push(JSON.parse(f)));
 return{transport,output,sent,inner,retire(){current=false},receive(value:any){for(const fn of listeners)fn(JSON.stringify(value))}};
}
test('Host capability overlays an old engine directory without replacing its other metadata or submission context',async()=>{
 const f=fixture(),context={sender:null};const request={id:1,method:'runtime/providers/list',[LOGICAL_CLIENT_FIELD]:'client-a'};
 await f.transport.sendWithContext(JSON.stringify(request),context);
 assert.equal(f.sent[0].context,context);f.receive({id:1,[LOGICAL_CLIENT_FIELD]:'client-a',result:{creation:{kind:'openai-compatible'},providers:[{provider:'p',configuration:{modelDeclarations:true,apis:['openai-responses']}},{provider:'speech',configuration:{modelDeclarations:true,modelType:'asr'}}]}});
 assert.equal(f.output[0].result.providers[0].configuration.canInspectSaved,true);assert.equal(f.output[0].result.providers[1].configuration.canInspectSaved,false);assert.deepEqual(f.output[0].result.creation,{kind:'openai-compatible'});await f.transport.close();
});
test('new read-only method is served by the Host and retains logical-client routing',async()=>{
 let calls=0;const f=fixture(async(params:any)=>{calls++;assert.equal(params.model,'m');return{model:'m',revision:3}});
 await f.transport.send(JSON.stringify({id:2,method:'runtime/models/inspect',params:{model:'m'},[LOGICAL_CLIENT_FIELD]:'client-a'}));
 assert.equal(calls,1);assert.equal(f.sent.length,0);assert.equal(f.output[0][LOGICAL_CLIENT_FIELD],'client-a');assert.equal(f.output[0].result.model,'m');await f.transport.close();
});
test('closing or retiring a request resource drops a late local inspection reply',async()=>{
 for(const close of [true,false]){let release!:(v:any)=>void;const f=fixture(()=>new Promise(r=>{release=r}));let valid=true;const context:any={sender:null,resourceOwner:{assertCurrent(){if(!valid)throw Error('retired')}}};
 const pending=f.transport.sendWithContext(JSON.stringify({id:3,method:'runtime/models/inspect',params:{}}),context);if(close)await f.transport.close();else valid=false;release({model:'m'});await pending;assert.equal(f.output.length,0);if(!close)await f.transport.close();}
});
test('native publication guard is checked before each forwarded observer',async()=>{
 const f=fixture();let late=0;f.transport.subscribeMessage(()=>f.retire());f.transport.subscribeMessage(()=>late++);f.receive({method:'notification'});assert.equal(late,0);await f.transport.close();
});
test('arbitrary backend failures are not exposed to the Renderer',async()=>{
 const f=fixture(async()=>{throw Error('synthetic-private-key raw upstream payload')});await f.transport.send(JSON.stringify({id:4,method:'runtime/models/inspect',params:{}}));assert.doesNotMatch(JSON.stringify(f.output),/synthetic-private-key|raw upstream/);assert.equal(f.output[0].error.code,-32000);await f.transport.close();
});
