import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {codexHistoryHomes} from '../../apps/local-agent-host/src/codex-session-directory';
import {ConnectedAgentHost} from '../../apps/local-agent-host/src/connected-agents';
const id='11111111-2222-4333-8444-555555555555';
async function home(root:string,name:string,title:string) {
 const path=join(root,name);await mkdir(join(path,'sessions'),{recursive:true});
 const rollout=join(path,'sessions',`rollout-${id}.jsonl`);
 await writeFile(rollout,JSON.stringify({type:'session_meta',payload:{id}})+'\n');
 const db=new DatabaseSync(join(path,'state_5.sqlite'));
 db.exec('CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,updated_at INTEGER,created_at INTEGER,archived INTEGER,rollout_path TEXT)');
 db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id,root,'Original long prompt',1700000000,1600000000,0,rollout);db.close();
 if(title)await writeFile(join(path,'session_index.jsonl'),JSON.stringify({id,thread_name:title})+'\n');
 return path;
}
test('native homes discover resume naming source, deduplicate links and exclude database-only stores',async t=>{
 const root=await mkdtemp(join(tmpdir(),'oc-native-homes-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const configured=await home(root,'.codex','');const alternate=await home(root,'.codexl','Resume summary');
 await mkdir(join(root,'.codex-itfs-sqlite'));await writeFile(join(root,'.codex-itfs-sqlite','state_5.sqlite'),'');
 await symlink(alternate,join(root,'.codex-alias'));
 const awaitedAlternate=await realpath(alternate);
 const {sources}=await codexHistoryHomes(configured,root);
 assert.equal(sources.length,2);assert.equal(sources[0]!.id,'default');assert.equal(sources[0]!.configured,true);
 assert.equal(sources.find(source=>source.path===awaitedAlternate)?.hasNames,true);
});
test('same native UUID in different homes imports separately and keeps its resume home after restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'oc-source-routing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const configured=await home(root,'.codex','Default summary');const alternate=await home(root,'.codexl','Resume summary');
 const sourceId=createHash('sha256').update(alternate).digest('hex').slice(0,24);
 const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=configured;t.after(()=>{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;});
 const data=join(root,'host');
 const trace=join(root,'trace.jsonl');
 const oldTrace=process.env.ACP_TEST_TRACE,oldTraceHome=process.env.ACP_TEST_TRACE_HOME;
 process.env.ACP_TEST_TRACE=trace;process.env.ACP_TEST_TRACE_HOME='1';
 t.after(()=>{for(const [key,value] of [['ACP_TEST_TRACE',oldTrace],['ACP_TEST_TRACE_HOME',oldTraceHome]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}});
 function host(){
  const result=new ConnectedAgentHost({} as never,data,root,{} as never);
  (result as any).launch=async()=>({command:process.execPath,args:[resolve('tests/fixtures/acp-engine-peer.mjs')]});
  (result as any).sourceReader.sources=async()=>({sources:[{id:'default',path:configured,configured:true,hasNames:true},{id:sourceId,path:alternate,configured:false,hasNames:true}]});
  return result;
 }
 const first=host();
 try {
  const defaultPage=await first.localConversations('codex');assert.equal(defaultPage.conversations[0]!.title,'Default summary');
  const sourcePage=await first.localConversations('codex',undefined,undefined,false,sourceId);assert.equal(sourcePage.conversations[0]!.title,'Resume summary');
  await assert.rejects(first.importLocalConversation('codex',id,'abcdefabcdefabcdefabcdef'));
  const original=await first.importLocalConversation('codex',id);const imported=await first.importLocalConversation('codex',id,sourceId);
  assert.equal(original.id,`codex_${id}`);assert.equal(imported.id,`codex_source_${sourceId}_${id}`);
  assert.notEqual(imported.id,original.id);
  assert.equal((await first.localConversations('codex',undefined,undefined,false,sourceId)).conversations[0]!.imported,true);
  assert.equal(JSON.parse(await readFile(join(data,'codex-sources.json'),'utf8'))[0].path,alternate);
 }finally{await first.close();}
 const reopened=host();
 try {
  const rows=await reopened.threads();assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.name).sort(),['Default summary','Resume summary']);
  const engine=await (reopened as any).threadEngine('codex',`codex_source_${sourceId}_${id}`);
  assert.equal(engine.options.env.CODEX_HOME,alternate,'native resume inherits only its bound home');
  assert.equal((await (reopened as any).threadEngine('codex',`codex_${id}`)).options.env,undefined,'legacy import keeps original environment');
  await assert.rejects(reopened.dispatch('thread/read',{threadId:`codex_source_abcdefabcdefabcdefabcdef_${id}`}),/binding missing/u);
  await reopened.dispatch('thread/resume',{threadId:`codex_source_${sourceId}_${id}`});
  const calls=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.find(call=>call.method==='session/resume')?.sessionId,id);
  assert.equal(calls.find(call=>call.method==='session/resume')?.codexHome,alternate,'actual ACP peer receives the source-bound CODEX_HOME');
  assert.equal(calls.some(call=>['session/new','session/prompt'].includes(call.method)),false,'resume test never creates a replacement session or sends a prompt');
  assert.equal(process.env.CODEX_HOME,configured,'source selection never mutates process-wide native home');
 }finally{await reopened.close();}
});
