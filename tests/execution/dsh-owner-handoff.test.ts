import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {startIndependentDshHost} from '../../scripts/server-deployment/dsh-host.mjs';
import WebSocket from 'ws';
import {DshClient} from '../../apps/local-agent-host/src/dsh-client.ts';

const expected=(host:any)=>({expectedOwner:host.handoff.authority.owner,expectedEpoch:host.handoff.authority.snapshot().epoch,operationId:'test',fence:'test'});
test('real native direct RPC fence, consumer custody and cold successor',async t=>{
 const root=await mkdtemp('/tmp/dsh-p3c-');const skills=join(root,'skills');await mkdir(skills);
 const options={coldDependencyRoots:[resolve('node_modules')],dataDirectory:join(root,'agent'),descriptorPath:join(root,'connection.json'),runtimeDirectory:root,skillsDirectory:skills,
 dshExecutable:resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),dshCapabilityPlugin:resolve('apps/local-agent-host/src/dsh-capability-plugin.mjs')};
 let host:any;
 t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true});});
 host=await startIndependentDshHost(options);
 // Isolate protocol assertions from the separate Linux/systemd OS contract.
 host.handoff.inspectOsWork=()=>({coverage:'complete',activeCount:0});
 await assert.rejects(startIndependentDshHost(options));
 const socket=new WebSocket(host.websocketUrl);
 await new Promise<void>((done,fail)=>{socket.once('open',done);socket.once('error',fail);});
 const response:any=await new Promise(done=>{socket.once('message',data=>done(JSON.parse(data.toString())));socket.send(JSON.stringify({id:1,method:'initialize',params:{}}));});
 assert.ok(response.opencraftDshReceipt);
 assert.equal(host.handoff.receipts.observation().activeCount,1);
 assert.throws(()=>host.handoff.acknowledgeReceipt({...response.opencraftDshReceipt,receipt:'wrong'}));
 socket.send(JSON.stringify({method:'opencraft/owner/receipt',params:response.opencraftDshReceipt}));
 for(let i=0;i<100&&host.handoff.receipts.observation().activeCount;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(host.handoff.receipts.observation().activeCount,0);socket.close();
 const client=new DshClient(host.dshUrl);
 assert.equal((await host.handoff.inspect()).activeCount,0);
 // Deliberately lose the consumer response acknowledgment; no retry executes it.
 const raw=await fetch(new URL('/api/session.create',host.dshUrl),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'direct-create',method:'session.create',payload:{cwd:root}})});
 assert.equal(raw.status,200);const result:any=await raw.json();assert.equal(result.result.ok,true);
 const receipt=raw.headers.get('x-opencraft-dsh-receipt');assert.ok(receipt);
 await host.handoff.control('fence',expected(host));
 assert.ok((await host.handoff.inspect()).activeCount>0);
 await assert.rejects(host.handoff.control('release',expected(host)),/drained/);
 await assert.rejects(client.call('session.create',{cwd:root}),/409/);
 const ack=await fetch(new URL('/api/opencraft-owner-receipt',host.dshUrl),{method:'POST',body:JSON.stringify({rpcId:'direct-create',receipt})});
 assert.equal(ack.status,200);
 assert.equal((await host.handoff.inspect()).activeCount,0);
 const prior=(await host.nativeOwner('inspect')).records;
 await host.handoff.control('release',expected(host));await host.close();
 host=await startIndependentDshHost(options);host.handoff.inspectOsWork=()=>({coverage:'complete',activeCount:0});
 assert.equal(host.handoff.open(),false);
 const ready:any=await host.handoff.control('cold-ready',expected(host));
 assert.deepEqual((await host.nativeOwner('inspect')).records,prior);
 await writeFile(join(skills,'changed.json'),'{}');
 await assert.rejects(host.handoff.control('resume',{...expected(host),identity:ready.handoff.ready.identity}),/changed/);
 const fresh:any=await host.handoff.control('cold-ready',expected(host));
 await host.handoff.control('resume',{...expected(host),identity:fresh.handoff.ready.identity});
 assert.equal(host.handoff.open(),true);
 assert.ok(await new DshClient(host.dshUrl).call('session.list',{}));
 await assert.rejects(host.restartEngine(),/fenced process handoff/);
 process.kill(host.engineProcessId,'SIGKILL');
 for(let i=0;i<100&&host.handoff.open();i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(host.handoff.open(),false);
 await host.close();
 await assert.rejects(startIndependentDshHost(options),/unconfirmed/);
});

test('missing or invalid native history headers cannot certify a cold handoff',async t=>{
 const {readdir}=await import('node:fs/promises');const {dirname,basename}=await import('node:path');const {zstdCompressSync}=await import('node:zlib');
 const root=await mkdtemp('/tmp/dsh-corrupt-');const skills=join(root,'skills');await mkdir(skills);
 const options={coldDependencyRoots:[resolve('node_modules')],dataDirectory:join(root,'agent'),descriptorPath:join(root,'connection.json'),runtimeDirectory:root,skillsDirectory:skills,
 dshExecutable:resolve('runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),dshCapabilityPlugin:resolve('apps/local-agent-host/src/dsh-capability-plugin.mjs')};
 const host=await startIndependentDshHost(options);t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});host.handoff.inspectOsWork=()=>({coverage:'complete',activeCount:0});
 const created:any=await new DshClient(host.dshUrl).call('session.create',{cwd:root});
 await host.nativeOwner('inspect');
 const entries=await readdir(options.dataDirectory,{recursive:true});const log=entries.find(path=>/session\.jsonl(?:\.zstd)?$/.test(path));assert.ok(log,JSON.stringify(entries));
 const corrupt=join(dirname(dirname(join(options.dataDirectory,log))),'corrupt-session');await mkdir(corrupt);
 await host.handoff.control('fence',expected(host));
 const target=join(corrupt,basename(log));await writeFile(target,'');
 assert.equal((await host.handoff.inspect()).coverage,'unknown');
 await assert.rejects(host.handoff.control('release',expected(host)));
 const verifyReconciliation=async()=>{
   for(const method of ['host.describe','session.cancel']){
     const rpcId='after-failed-seal-'+method+'-'+Date.now();
     const reply=await fetch(new URL('/api/'+method,host.dshUrl),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method,payload:{sessionId:created.sessionId}})});
     assert.equal(reply.status,200,'fenced reconciliation remains admitted after failed seal');
     const receipt=reply.headers.get('x-opencraft-dsh-receipt');
     if(receipt){const ack=await fetch(new URL('/api/opencraft-owner-receipt',host.dshUrl),{method:'POST',body:JSON.stringify({rpcId,receipt})});assert.equal(ack.status,200);}
   }
 };
 await verifyReconciliation();
 const invalid=Buffer.from('{"type":"invalid"}\n');await writeFile(target,log.endsWith('.zstd')?zstdCompressSync(invalid):invalid);
 assert.equal((await host.handoff.inspect()).coverage,'unknown');await assert.rejects(host.handoff.control('release',expected(host)));
 await verifyReconciliation();
 await rm(corrupt,{recursive:true});assert.equal((await host.handoff.inspect()).coverage,'complete');
});
