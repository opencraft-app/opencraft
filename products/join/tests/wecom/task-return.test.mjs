import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTaskReturns } from '../../plugins/wecom/task-return.mjs';

const reference = 'opencraft://conversation/v1/server/codex/task';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)'); t.after(()=>db.close());
  let time=0, permitted=true, lost=false;
  const sent=new Map(), calls=[];
  const params={argv:['thread','start','--profile','default','--title','构建','--prompt','运行构建','--idempotency-key','build-1']};
  const receipt={operationId:'op1',reference,state:'submitted'};
  const operation={...receipt,input:{deliveryState:'submitted',targetTurnId:'turn1'}};
  const output={state:{state:'active',turnId:'turn1'},history:{entries:[],latestTurnId:'turn1',nextCursor:null}};
  const options={db,now:()=>time,authorize:async()=>{if(!permitted)throw Error('revoked');},
    command:async p=>{calls.push(p);return p.argv[1]==='start'?receipt:p.argv[1]==='operation'?operation:p.argv[1]==='stop'?{stopped:true,turnId:'turn1'}:output;},
    reply:async p=>{if(sent.has(p.id))assert.equal(sent.get(p.id),p.text);sent.set(p.id,p.text);if(lost){lost=false;throw Error('ack lost');}}};
  return {options,params,output,operation,sent,calls,advance:()=>time+=60001,revoke:()=>{permitted=false;},loseAck:()=>{lost=true;}};
}
test('only completed submitted turn returns, survives restart, and retries frozen text with the same ID',async t=>{
  const f=fixture(t);let watcher=createTaskReturns(f.options);
  await watcher.invoke(f.params);await watcher.poll();assert.equal(f.sent.size,0);
  f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'构建通过'}];
  f.advance();f.loseAck();await watcher.poll();assert.equal(f.sent.size,1);
  watcher=createTaskReturns(f.options);f.output.history.entries[0].text='changed';f.advance();await watcher.poll();
  assert.equal(f.sent.size,1);assert.match([...f.sent.values()][0],/构建通过/u);
  f.advance();await watcher.poll();assert.equal(f.sent.size,1);
});
test('revoked scope cannot publish and another turn never leaks into the group',async t=>{
  const f=fixture(t),watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
  f.output.state={state:'completed',turnId:'private-turn'};
  f.output.history={latestTurnId:'private-turn',entries:[{role:'assistant',turnId:'private-turn',text:'private'}]};
  await watcher.poll();assert.equal(f.sent.size,0);
  const g=fixture(t),other=createTaskReturns(g.options);await other.invoke(g.params);g.revoke();await other.poll();assert.equal(g.sent.size,0);
});
test('queue acceptance alone is not completion, and unrelated commands do not create return bindings',async t=>{
  const f=fixture(t),watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
  f.operation.input.targetTurnId=null;f.output.state.state='completed';await watcher.poll();assert.equal(f.sent.size,0);
  const before=f.options.db.prepare('SELECT count(*) n FROM meta').get().n;
  await watcher.invoke({argv:['thread','output',reference]});
  assert.equal(f.options.db.prepare('SELECT count(*) n FROM meta').get().n,before);
});

test('task exports return with stable file ids across restart and lost acknowledgement',async t=>{
  const f=fixture(t),files=new Map();let fail=true;
  f.options.taskFiles={prepare:()=>'/scoped/export',list:()=>({files:[{name:'report.pdf',size:6,sha256:'hash'}],skipped:[]}),read:()=>({bytes:Buffer.from('report'),sha256:'hash'})};
  f.options.sendFile=async p=>{files.set(p.id,p.bytes.toString());if(fail){fail=false;throw Error('lost ack');}};
  let watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
  assert.match(f.calls[0].argv.join(' '),/\/scoped\/export/u);
  f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];
  await watcher.poll();assert.equal(files.size,1);
  f.advance();watcher=createTaskReturns(f.options);await watcher.poll();assert.equal(files.size,1);
  assert.equal(f.options.db.prepare('SELECT value FROM meta').get().value.includes('"done":true'),true);
});

test('walks history cursors to the actual completed-turn answer',async t=>{
 const f=fixture(t);f.output.state.state='completed';f.output.history.nextCursor='next';
 const original=f.options.command;f.options.command=async p=>p.argv.includes('--cursor')?{state:f.output.state,history:{latestTurnId:'turn1',entries:[{role:'assistant',turnId:'turn1',itemId:'final',text:'final result'}]}}:original(p);
 const watcher=createTaskReturns(f.options);await watcher.invoke(f.params);await watcher.poll();assert.match([...f.sent.values()][0],/final result/u);
});

test('replaying a completed task returns its saved receipt without resubmitting altered prompt',async t=>{
 const f=fixture(t),watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
 f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];await watcher.poll();
 const count=f.calls.length;await watcher.invoke(f.params);assert.equal(f.calls.length,count);
});

test('stop addresses only the submitted turn and rerun uses a fresh invocation',async t=>{
 const f=fixture(t),watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
 const key=f.options.db.prepare('SELECT key FROM meta').get().key;
 await assert.rejects(watcher.control('stop','foreign','event'),/does not belong/u);
 await watcher.control('stop',key,'event');
 assert.ok(f.calls.some(c=>c.argv[1]==='stop'&&c.argv.includes('turn1')));
 await assert.rejects(watcher.control('rerun',key,'again'),/finish/u);
 f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];await watcher.poll();
 await watcher.control('rerun',key,'again');
 const starts=f.calls.filter(c=>c.argv[1]==='start');assert.equal(starts.length,2);assert.notDeepEqual(starts[0].argv,starts[1].argv);
});

test('a failed file does not block later files or completed-task rerun; retries use frozen bytes after restart',async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),{join}=await import('node:path');
 const {createTaskFiles}=await import('../../plugins/wecom/task-files.mjs');const root=fs.mkdtempSync(join(os.tmpdir(),'return-snapshot-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const f=fixture(t),files=createTaskFiles({root}),cards=[],attempts=[];let fail=true;
 f.options.taskFiles=files;f.options.taskCard=async p=>cards.push(p);f.options.sendFile=async p=>{attempts.push([p.name,p.bytes.toString()]);if(p.name==='one.txt'&&fail)throw Error('temporary');};
 let watcher=createTaskReturns(f.options);await watcher.invoke(f.params);const key=f.options.db.prepare('SELECT key FROM meta').get().key,dir=files.prepare(key);
 fs.writeFileSync(join(dir,'one.txt'),'first original');fs.writeFileSync(join(dir,'two.txt'),'second original');
 f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];await watcher.poll();
 assert.deepEqual(attempts.map(a=>a[0]),['one.txt','two.txt']);assert.equal(cards.at(-1).state,'completed');
 await watcher.control('rerun',key,'again');
 fs.rmSync(dir,{recursive:true});fail=false;watcher=createTaskReturns(f.options);f.advance();await watcher.poll();
 assert.deepEqual(attempts,[['one.txt','first original'],['two.txt','second original'],['one.txt','first original']]);
 const row=JSON.parse(f.options.db.prepare('SELECT value FROM meta WHERE key=?').get(key).value);assert.equal(row.done,true);assert.equal(row.deliveryState,'delivered');
});
test('legacy missing export is reported once without blocking later files or task completion',async t=>{
 const f=fixture(t),sent=[];f.options.taskFiles={prepare:()=>'/export',list:()=>({files:[{name:'missing',size:1,sha256:'one'},{name:'valid',size:1,sha256:'two'}],skipped:[]}),read:(_key,name)=>{if(name==='missing')throw Object.assign(Error('missing'),{code:'ENOENT'});return{bytes:Buffer.from('x'),sha256:'two'};}};
 f.options.sendFile=async p=>sent.push(p.name);const watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
 f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];await watcher.poll();
 assert.deepEqual(sent,['valid']);assert.equal(f.sent.size,2);assert.equal(JSON.parse(f.options.db.prepare('SELECT value FROM meta').get().value).done,true);
});
test('failed, exhausted, stopped, and rejected tasks have truthful final cards',async t=>{
 for(const [state,expected]of [['failed','failed'],['exhausted','failed'],['interrupted_by_user','stopped'],['completed','completed'],['rejected','failed']]){
  const f=fixture(t),cards=[];f.options.taskCard=async p=>cards.push(p);const watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
  f.output.state.state=state;f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'result'}];if(state==='rejected')f.operation.state='rejected';await watcher.poll();
  assert.equal(cards.at(-1).state,expected,state);
 }
});
test('card failure does not undo execution completion or disable rerun',async t=>{
 const f=fixture(t);f.options.taskCard=async p=>{if(p.state==='completed')throw Error('card unavailable');};const watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
 f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];await watcher.poll();
 const row=JSON.parse(f.options.db.prepare('SELECT value FROM meta').get().value);assert.equal(row.done,true);await watcher.control('rerun',row.key,'again');
});

test('delegated task receives its group-bound CLI launcher but no connection credentials',async t=>{
 const f=fixture(t);f.options.cliLauncher='/private/current/wecom';const w=createTaskReturns(f.options);await w.invoke(f.params);const prompt=f.calls[0].argv.join(' ');assert.match(prompt,/\/private\/current\/wecom/u);assert.ok(!prompt.includes('Bearer '));
});

test('completed-before-stop is not reported as stopped, including a legacy stopped flag',async t=>{
 const f=fixture(t),cards=[],original=f.options.command;f.options.taskCard=async p=>cards.push(p);
 f.options.command=async p=>p.argv[1]==='stop'?{stopped:false,state:'completed',turnId:'turn1'}:original(p);
 const w=createTaskReturns(f.options),receipt=await w.invoke(f.params);
 assert.match(await w.control('stop',receipt.taskKey,'stop'),/已经完成/u);
 let row=JSON.parse(f.options.db.prepare('SELECT value FROM meta').get().value);assert.equal(row.stopRequested,undefined);assert.equal(row.stopped,undefined);
 row.stopped=true;f.options.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(row),receipt.taskKey);
 f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];await w.poll();
 assert.equal(cards.at(-1).state,'completed');assert.match([...f.sent.values()][0],/任务完成/u);
});
test('a confirmed stop request cannot override a later completed execution; unknown outcomes fail closed',async t=>{
 const f=fixture(t),cards=[];f.options.taskCard=async p=>cards.push(p);const w=createTaskReturns(f.options),r=await w.invoke(f.params);
 assert.match(await w.control('stop',r.taskKey,'stop'),/停止请求/u);assert.equal((await w.query('list')).tasks[0].stopRequested,true);
 f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];await w.poll();assert.equal(cards.at(-1).state,'completed');
 for(const result of [{stopped:true,turnId:'foreign'},{stopped:false,state:'active'},{}]){
  const g=fixture(t),orig=g.options.command;g.options.command=async p=>p.argv[1]==='stop'?result:orig(p);const v=createTaskReturns(g.options),r=await v.invoke(g.params);
  await assert.rejects(v.control('stop',r.taskKey,'stop'),/unconfirmed/u);assert.equal((await v.query('list')).tasks[0].stopRequested,false);
 }
});
test('queued receipts have stable keys, active cards require observed execution, task queries are scoped and sanitized',async t=>{
 const f=fixture(t),cards=[];f.options.taskCard=async p=>cards.push(p);const w=createTaskReturns(f.options),r=await w.invoke(f.params);
 assert.match(r.taskKey,/^join:wecom:task-return:[a-f0-9]{64}$/u);assert.deepEqual(cards.map(c=>c.state),['queued']);
 f.operation.input.targetTurnId=null;await w.poll();assert.deepEqual(cards.map(c=>c.state),['queued']);assert.equal((await w.query('get',r.taskKey)).state,'queued');
 f.operation.input.targetTurnId='turn1';f.advance();await w.poll();assert.deepEqual(cards.map(c=>c.state),['queued','running']);assert.equal((await w.query('get',r.taskKey)).state,'active');
 const page=await w.query('list');assert.equal(page.tasks[0].taskKey,r.taskKey);assert.equal(page.tasks[0].stateSource,'local-tracker');assert.ok(!JSON.stringify(page).includes('运行构建'));
 assert.deepEqual((await w.query('list',undefined,{offset:1})).tasks,[]);await assert.rejects(w.query('list',undefined,{limit:51}),/Invalid/u);
 await assert.rejects(w.query('get','foreign'),/does not belong/u);
 f.output.state.turnId='private';assert.equal((await w.query('get',r.taskKey)).state,'superseded');
 f.output.state={state:'completed',turnId:'turn1'};f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'done'}];f.advance();await w.poll();assert.equal((await w.invoke(f.params)).taskKey,r.taskKey);
 f.revoke();await assert.rejects(w.query('list'),/revoked/u);await assert.rejects(w.query('get',r.taskKey),/revoked/u);
});

test('live supplements reuse the scoped task watcher, original export contract and final delivery',async t=>{
 const f=fixture(t),cards=[];let prepared=0;
 f.options.taskCard=async card=>cards.push(card);
 f.options.taskFiles={prepare:()=>{prepared++;return '/original/export'},list:()=>({files:[],skipped:[]})};f.options.sendFile=async()=>{};
 const command=f.options.command,steerReceipt={operationId:'steer-operation',reference,state:'submitted',inputMode:'steer',expectedTurnId:'turn1',taskOutcome:'unknown'};
 f.options.command=async p=>p.argv[1]==='tell'?(f.calls.push(p),steerReceipt):command(p);
 const watcher=createTaskReturns(f.options),start=await watcher.invoke(f.params);
 const params={argv:['thread','tell',reference,'--delivery','steer','--expected-turn','turn1','--message','仅补充检查，不要发布','--idempotency-key','steer-1'],workId:'control-work'};
 const receipt=await watcher.invoke(params);assert.equal(receipt.taskKey,start.taskKey);assert.equal(receipt.inputMode,'steer');
 assert.deepEqual(f.calls.find(p=>p.argv[1]==='tell'),params);assert.equal(prepared,1);assert.equal(f.options.db.prepare('SELECT count(*) n FROM meta').get().n,1);
 assert.deepEqual(cards.map(c=>c.state),['queued']);assert.equal((await watcher.query('list')).tasks.length,1);
 assert.equal((await watcher.invoke(params)).operationId,receipt.operationId);assert.equal(prepared,1);
 f.output.state.state='completed';f.output.history.entries=[{role:'assistant',turnId:'turn1',text:'按补充要求完成',itemId:'final'}];await watcher.poll();
 assert.equal(f.sent.size,1);assert.match([...f.sent.values()][0],/按补充要求完成/u);assert.deepEqual(cards.map(c=>c.state),['queued','completed']);
});
test('group live supplements cannot target another scope or another turn and never gain a fresh return binding',async t=>{
 const f=fixture(t),watcher=createTaskReturns(f.options);await watcher.invoke(f.params);
 const live=(ref=reference,turn='turn1')=>({argv:['thread','tell',ref,'--delivery','steer','--expected-turn',turn,'--message','change','--idempotency-key','steer']});
 await assert.rejects(watcher.invoke(live('foreign')),/does not match/);
 await assert.rejects(watcher.invoke(live(reference,'private-turn')),/does not match/);
 assert.equal(f.calls.filter(p=>p.argv[1]==='tell').length,0);assert.equal(f.options.db.prepare('SELECT count(*) n FROM meta').get().n,1);
 f.revoke();await assert.rejects(watcher.invoke(live()),/revoked/);assert.equal(f.calls.filter(p=>p.argv[1]==='tell').length,0);
});
