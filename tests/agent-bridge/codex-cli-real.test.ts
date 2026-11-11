import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat,readFile } from 'node:fs/promises';
import { CodexOwnerConnection } from '../../apps/agent-bridge-host/src/codex-owner';
import { CodexBridgeRuntime } from '../../apps/agent-bridge-host/src/codex-runtime';

/** Opt-in real Core prerequisite. No second CODEX_HOME writer or paid model task. */
test('opt-in existing Core accepts the real Codex bridge and lists available models',{
  skip:!process.env.OPENCRAFT_CODEX_CORE_CONFIG,timeout:30_000,
},async t=>{
  const path=process.env.OPENCRAFT_CODEX_CORE_CONFIG!;
  const info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&!(info.mode&0o077));
  const config=JSON.parse(await readFile(path,'utf8'));
  let runtime:CodexBridgeRuntime;const frames:any[]=[];
  const owner=new CodexOwnerConnection(config.endpoint,config.token,(method,params)=>runtime.notification(method,params),()=>{},()=>{});
  t.after(()=>owner.close());runtime=new CodexBridgeRuntime(owner,frame=>frames.push(frame));
  await owner.connect();
  await runtime.handle({jsonrpc:'2.0',id:'init',method:'initialize',params:{protocolVersion:1,grammarRange:{min:1,max:1}}});
  await runtime.handle({jsonrpc:'2.0',id:'models',method:'model/list',params:{}});
  const reply=frames.find(frame=>frame.id==='models');assert.ok(reply&&!reply.error);
  assert.ok(Array.isArray(reply.result.data)&&reply.result.data.length>0);
});
