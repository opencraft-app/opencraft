import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../../apps/opencraft-cli/src/main';
import {CliSshTransport} from '../../apps/opencraft-cli/src/ssh';
import {waitForResult} from '../../apps/opencraft-cli/src/result';

test('offline help is scoped, examples include complete input options, guide and version work without SSH',async t=>{
 t.mock.method(CliSshTransport.prototype,'connect',async()=>assert.fail('offline command connected'));
 for(const group of ['thread','server','project','queue','interactions','connection']){
  const h=(await run([group,'--help']) as any).help;
  assert.match(h,new RegExp('Usage: opencraft '+group));assert.match(h,/Example:/);
  if(group==='thread')assert.doesNotMatch(h,/connection add/);
 }
 for(const command of ['create','send','wait','output','list','search','defaults','show','log']){
  const h=(await run(['thread',command,'--help']) as any).help;
  assert.match(h,new RegExp('Usage: opencraft thread '+command));assert.match(h,/Example:/);
  if(command==='create') {assert.match(h,/--message-file/);assert.doesNotMatch(h,/Usage: opencraft thread send/);}
 }
 assert.match((await run(['guide']) as any).help,/thread create[\s\S]*thread wait[\s\S]*thread output[\s\S]*thread send/);
 assert.equal(typeof (await run(['--version']) as any).source,'string');
 assert.deepEqual(await run(['-V','--json']),await run(['--version']));
});

test('real CLI dispatch preserves per-Server pages and unsupported alternatives; no business writes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cli-58i-')),old=process.env.OPENCRAFT_CONFIG;
 process.env.OPENCRAFT_CONFIG=join(root,'connections.json');
 await writeFile(process.env.OPENCRAFT_CONFIG,JSON.stringify({schemaVersion:1,defaultConnection:'work',connections:{work:{sshAlias:'fixture',instanceId:'i',defaultServer:'server:i:codex'}}}));
 t.after(async()=>{if(old===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=old;await rm(root,{recursive:true,force:true});});
 const servers=['codex','dsh','pi'].map(engine=>({serverId:'server:i:'+engine,label:engine,engine,connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:engine==='codex',queue:true,steer:false,projectDiscovery:engine==='codex',threadSearch:engine==='codex',publicTextSearch:engine==='codex',exactResult:engine==='codex'}}));
 const actions:any[]=[];
 t.mock.method(CliSshTransport.prototype,'connect',async function(this:any){this.update({state:'open'});});
 t.mock.method(CliSshTransport.prototype,'send',async function(this:any,raw:string){
  const m=JSON.parse(raw);if(m.id===undefined)return;
  const p=m.params;
  if(m.method!=='initialize')actions.push(p);
  const result=m.method==='initialize'?{capabilities:{extensions:{'opencraft/collaboration':{version:1,servers:true,metadataDiscovery:true,projectDiscovery:true,threadSearch:true,threadSearchMode:'recorded-name-v1',publicTextSearch:true,publicTextSearchMode:'public-text-token-and-v1',exactResult:true}}}}
   :p.action==='servers'?{instanceId:'i',actor:{id:'a',kind:'human',generation:1},servers}
   :p.action==='discover'?{conversations:[{ref:{serverId:p.serverId,threadId:'same'},attention:null}],nextCursor:p.serverId.endsWith('dsh')?'more':null}
   :p.action==='exactResult'?{ref:p.reference,turnId:'A',matched:true,turnState:'completed',watermark:'w',entries:p.output?[{itemId:'f',phase:'final_answer',offset:0,text:'done'}]:[],nextCursor:null,complete:p.output,finalUnavailable:false}
   :{entries:[{ref:{serverId:p.serverId,threadId:'same'},name:'release'}],nextCursor:null};
  for(const fn of this.messages)fn(JSON.stringify({id:m.id,result}));
 });
 for(const engine of ['dsh','pi'])await assert.rejects(run(['project','list','--server',engine]),(e:any)=>{
  assert.equal(e.code,'UNSUPPORTED_CAPABILITY');assert.equal(e.details.serverId,'server:i:'+engine);assert.deepEqual(e.details.alternatives.map((r:any)=>r.serverId),['server:i:codex']);assert.match(e.message,/--server server:i:codex/);return true;
 });
 const list=await run(['thread','list','--all-servers']) as any;
 assert.equal(list.results.length,3);assert.equal(list.complete,false);assert.equal(list.partial,false);
 assert.deepEqual(list.results.map((r:any)=>r.data.conversations[0].ref.serverId),servers.map(s=>s.serverId));
 const before=actions.length;await run(['thread','list','--server','dsh','--cursor','more']);assert.equal(actions.at(-1).cursor,'more');assert.equal(actions.length,before+2);
 for(const field of ['name','text']){
  const search=await run(['thread','search','--all-servers','--field',field,'release']) as any;
  assert.equal(search.results.length,3);assert.equal(search.partial,true);assert.equal(search.complete,false);assert.equal(search.results[0].data.entries[0].ref.serverId,'server:i:codex');assert.equal(search.results[1].error.code,'UNSUPPORTED_CAPABILITY');
 }
 for(const option of ['--cursor','--server','--project','--cwd'])await assert.rejects(run(['thread','list','--all-servers',option,'x']),{code:'INVALID_ARGUMENTS'});
 const ref='opencraft://conversation/v1/'+encodeURIComponent('server:i:codex')+'/same';
 assert.equal((await run(['thread','wait',ref,'--turn','A','--output']) as any).entries[0].text,'done');
 assert.deepEqual((await run(['thread','wait',ref,'--turn','A']) as any).entries,[]);
 assert.ok(actions.every(p=>['servers','discover','threadSearch','publicTextSearch','exactResult'].includes(p.action)));
});

const ref={serverId:'s',threadId:'t'};
const terminal={ref,turnId:'A',matched:true,turnState:'failed',watermark:'w',entries:[],nextCursor:null,complete:false,finalUnavailable:false,requestId:'request-A',deliveryState:'submitted',taskOutcome:'unknown',observedAt:1};
test('wait --output pins the terminal Turn and collects Unicode final pages with original receipt facts',async()=>{
 const calls:any[]=[];
 const client={async exactResult(r:any,target:any,output:any,cursor:any){calls.push({r,target,output,cursor});if(!output)return terminal;
  assert.deepEqual(target,{turnId:'A'});return {...terminal,requestId:null,deliveryState:null,entries:[{itemId:'f',phase:'final_answer',offset:cursor?2:0,text:cursor?'尾':'你好'}],nextCursor:cursor?null:'next',complete:!!cursor};}};
 const result=await waitForResult(client as any,ref,{requestId:'request-A'},1000,true);
 assert.deepEqual(result.entries.map(e=>e.text),['你好','尾']);assert.equal(result.complete,true);assert.equal(result.turnState,'failed');assert.equal(result.requestId,'request-A');assert.equal(result.taskOutcome,'unknown');assert.equal(calls.length,3);
});
test('wait --output retains unavailable finals, rejects changed snapshots and preserves incomplete output on deadline',async()=>{
 assert.equal((await waitForResult({exactResult:async()=>({...terminal,finalUnavailable:true})} as any,ref,{turnId:'A'},1000,true)).finalUnavailable,true);
 let reads=0;
 await assert.rejects(waitForResult({async exactResult(_r:any,_t:any,output:any){if(!output)return terminal;return {...terminal,watermark:String(reads++),nextCursor:'page'+reads,entries:[]};}} as any,ref,{turnId:'A'},1000,true),{code:'HISTORY_CHANGED'});
 await assert.rejects(waitForResult({async exactResult(_r:any,_t:any,output:any){if(!output)return terminal;await new Promise(r=>setTimeout(r,25));return {...terminal,entries:[{itemId:'f',phase:'final_answer',offset:0,text:'part'}],nextCursor:'next'};}} as any,ref,{turnId:'A'},10,true),(e:any)=>{assert.equal(e.code,'TIMEOUT');assert.equal(e.details.result.complete,false);assert.equal(e.details.result.nextCursor,'next');return true;});
});
