import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { SupportReviewHttp, SUPPORT_REVIEW_PATH } from '../plugins/support-review/src/server';
import { HandsReviewExecutor } from '../plugins/support-review/src/hands-client';
import { startReviewHandsOwner } from '../plugins/support-review/src/hands-owner';
import type { ReviewExecutor } from '../plugins/support-review/src/contract';

async function httpFixture(run: (origin: string) => Promise<void>, executor: ReviewExecutor, current = () => true) {
 const adapter = new SupportReviewHttp(executor);
 const server = createServer((req,res) => {
  if (!adapter.route(req,res,{authenticate:() => ({subject:'verified-subject',loginName:'verified-reviewer'}),isAllowed:current})) {res.statusCode=404;res.end();}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
 try { await run(`http://127.0.0.1:${address.port}${SUPPORT_REVIEW_PATH}`); }
 finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
}
async function fixture(run: (origin: string, root: string) => Promise<void>, options: { script?: string; current?: () => boolean; timeoutMs?: number } = {}) {
 const root=await mkdtemp(join(tmpdir(),'review-hands-'));
 const tokenFile=join(root,'token'),socketPath=join(root,'review.sock');
 await writeFile(tokenFile,'review-fixture-'.repeat(4),{mode:0o600});
 if (options.script !== '') await writeFile(join(root,'support-review.py'),options.script ?? 'import sys,json\nr=json.load(sys.stdin)\nprint(json.dumps({"ok":True,"result":{"actor":r.get("actor"),"action":r.get("action")}}))\n',{mode:0o600});
 const owner=await startReviewHandsOwner({socketPath,tokenFile,workerRoot:root,pythonExecutable:'/usr/bin/python3'}, {timeoutMs:options.timeoutMs});
 const executor=new HandsReviewExecutor(async()=>({socketPath,tokenFile}));
 try { await httpFixture(origin=>run(origin,root),executor,options.current); }
 finally { await owner.close(); await rm(root,{recursive:true,force:true}); }
}
const post=(origin:string,action='assign',extra:Record<string,unknown>={})=>fetch(origin,{method:'POST',headers:{'X-LightVela-Review':'1'},body:JSON.stringify({action,...extra})});

test('real Hands IPC: verified identity overrides actor; reads and writes use the original worker',async()=>fixture(async origin=>{
 const r=await post(origin,'assign',{actor:'attacker',command:'touch /not-executed',workerRoot:'/not-used'});
 assert.equal(r.status,200);assert.deepEqual(await r.json(),{actor:'verified-reviewer',action:'assign'});
 assert.deepEqual(await (await fetch(origin)).json(),{actor:'verified-reviewer',action:'list'});
}));
test('remote intake, POST list and missing intent rejected before execution',async()=>httpFixture(async origin=>{
 assert.equal((await fetch(origin,{method:'POST',body:'{"action":"approve_send"}'})).status,403);
 assert.equal((await post(origin,'intake')).status,400);
 assert.equal((await post(origin,'list')).status,400);
}, {execute:async()=>{assert.fail('must not dispatch');}}));
test('revoked admission cannot read queue',async()=>httpFixture(async origin=>{
 assert.equal((await fetch(origin)).status,403);
}, {execute:async()=>{assert.fail('must not dispatch');}},()=>false));
test('revocation while Hands finishes does not disclose result',async()=>{
 let current=true;
 await httpFixture(async origin=>{const r=await fetch(origin);assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:'access_revoked_result_not_disclosed'});},
 {execute:async()=>{current=false;return {ok:true,result:'private'};}},()=>current);
});
test('failed worker keeps GET retryable and POST unknown; stderr is never disclosed',async()=>fixture(async origin=>{
 const get=await fetch(origin);assert.equal(get.status,503);assert.deepEqual(await get.json(),{error:'review_list_unavailable'});
 const sent=await post(origin,'approve_send');assert.equal(sent.status,503);assert.deepEqual(await sent.json(),{error:'review_operation_result_unknown'});
},{script:'import sys\nsys.stderr.write("private customer payload")\nsys.exit(3)\n'}));
test('missing worker does not invoke a Gateway fallback',async()=>fixture(async origin=>{
 const response=await fetch(origin);assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'review_list_unavailable'});
},{script:''}));
test('reviewer denial is still decided by the original business worker',async()=>fixture(async origin=>{
 const response=await fetch(origin);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'Reviewer access required'});
},{script:'print(\'{"ok":false,"error":"Reviewer access required"}\')\n'}));
test('unknown exit, invalid JSON and nonzero exit are never success',async()=>{
 for(const script of ['print("not-json")','import sys\nprint(\'{"ok":true,"result":"must-not-return"}\')\nsys.exit(2)']) {
  await fixture(async origin=>{assert.equal((await post(origin,'approve_send')).status,503);},{script});
 }
});
test('worker timeout terminates the process and keeps send outcome unknown',async()=>fixture(async origin=>{
 const response=await post(origin,'approve_send');assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'review_operation_result_unknown'});
},{script:'import time\ntime.sleep(30)\n',timeoutMs:50}));
test('cross-origin, cross-site, query and unsupported HTTP methods fail before dispatch',async()=>httpFixture(async origin=>{
 assert.equal((await post(origin+'?actor=attacker')).status,404);
 assert.equal((await fetch(origin,{headers:{origin:'https://other.invalid'}})).status,403);
 assert.equal((await fetch(origin,{headers:{'sec-fetch-site':'cross-site'}})).status,403);
 assert.equal((await fetch(origin,{method:'PUT'})).status,405);
}, {execute:async()=>{assert.fail('must not dispatch');}}));
test('oversized browser input is rejected without dispatch',async()=>httpFixture(async origin=>{
 assert.equal((await post(origin,'edit',{text:'x'.repeat(1_000_001)})).status,413);
},{execute:async()=>{assert.fail('must not dispatch');}}));
test('Hands configuration absent or owner unavailable is fail-closed',async()=>{
 for(const configuration of [null,{socketPath:'/nonexistent-review.sock',tokenFile:'/nonexistent-review.token'}]) {
  await httpFixture(async origin=>{assert.equal((await post(origin,'approve_send')).status,503);},new HandsReviewExecutor(async()=>configuration));
 }
});
test('lost Hands acknowledgement makes exactly one request, never automatic resend',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-lost-'));let calls=0;
 const tokenFile=join(root,'token'),socketPath=join(root,'owner.sock');await writeFile(tokenFile,'x'.repeat(64),{mode:0o600});
 const owner=createServer((req)=>{calls++;req.resume();req.on('end',()=>req.socket.destroy());});
 await new Promise<void>(resolve=>owner.listen(socketPath,resolve));
 try {await httpFixture(async origin=>{const r=await post(origin,'approve_send');assert.equal(r.status,503);assert.equal(calls,1);},new HandsReviewExecutor(async()=>({tokenFile,socketPath})));}
 finally {await new Promise<void>(resolve=>owner.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
test('owner rejects wrong tokens and arbitrary execution actions',async()=>fixture(async(_origin,root)=>{
 const tokenFile=join(root,'wrong-token');await writeFile(tokenFile,'wrong'.repeat(16),{mode:0o600});
 const client=new HandsReviewExecutor(async()=>({socketPath:join(root,'review.sock'),tokenFile}));
 assert.equal(await client.execute({action:'list',actor:'verified-reviewer'},()=>true),null);
 assert.equal(await client.execute({action:'exec',actor:'verified-reviewer',command:'id'},()=>true),null);
 assert.equal(await client.execute({action:'list',actor:'\n'},()=>true),null);
}));
test('non-private tokens are rejected, not chmodded by the client',async()=>fixture(async(_origin,root)=>{
 const tokenFile=join(root,'token');await chmod(tokenFile,0o644);
 const client=new HandsReviewExecutor(async()=>({socketPath:join(root,'review.sock'),tokenFile}));
 assert.equal(await client.execute({action:'list',actor:'verified-reviewer'},()=>true),null);
}));
test('worker retains existing state across owner restarts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-restart-'));const socketPath=join(root,'r.sock'),tokenFile=join(root,'token');
 await writeFile(tokenFile,'r'.repeat(64),{mode:0o600});
 await writeFile(join(root,'support-review.py'),'import os,json,sys\nr=json.load(sys.stdin)\np=os.path.join(os.environ["LIGHTVELA_SUPPORT_ROOT"],"fixture-ledger")\nn=int(open(p).read()) if os.path.exists(p) else 0\nif r["action"]=="assign":\n n+=1\n open(p,"w").write(str(n))\nprint(json.dumps({"ok":True,"result":{"n":n}}))\n');
 const config={socketPath,tokenFile,workerRoot:root,pythonExecutable:'/usr/bin/python3'};const client=new HandsReviewExecutor(async()=>({socketPath,tokenFile}));
 let owner=await startReviewHandsOwner(config);
 try {
  assert.deepEqual(await client.execute({action:'assign',actor:'reviewer'},()=>true),{ok:true,result:{n:1}});
  await owner.close();owner=await startReviewHandsOwner(config);
  assert.deepEqual(await client.execute({action:'list',actor:'reviewer'},()=>true),{ok:true,result:{n:1}});
  assert.equal(await readFile(join(root,'fixture-ledger'),'utf8'),'1');
 } finally {await owner.close();await rm(root,{recursive:true,force:true});}
});
test('plugin route does not claim other plugins and requires a verified identity',async()=>{
 const plugin=new SupportReviewHttp({execute:async()=>{assert.fail('not authenticated');}});
 const server=createServer((req,res)=>{if(!plugin.route(req,res,{authenticate:()=>null,isAllowed:()=>true})){res.statusCode=404;res.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
 try {const origin=`http://127.0.0.1:${address.port}`;assert.equal((await fetch(origin+SUPPORT_REVIEW_PATH)).status,401);assert.equal((await fetch(origin+'/other-plugin')).status,404);}
 finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('oversized worker output is bounded and never forwarded as a successful send',async()=>fixture(async origin=>{
 const response=await post(origin,'approve_send');assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'review_operation_result_unknown'});
},{script:'import sys\nsys.stdout.write("x"*8000001)\n'}));
