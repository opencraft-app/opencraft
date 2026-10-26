import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { patchDshThreadEnvironment, threadEnvironmentEdit, terminalThreadEnvironmentEdit } from '../../scripts/patch-dsh-thread-environment.mjs';

test('DSH thread environment patch is idempotent and rejects drift before write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-thread-env-')); t.after(() => rm(root, {recursive:true,force:true}));
  const module = join(root, 'node_modules/@deepseek-ai/dsh-bash-local/lib/index.js');
  await mkdir(join(module, '..'), {recursive:true}); await writeFile(module, threadEnvironmentEdit[0]);
  const terminal = join(root, 'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js');
  await mkdir(join(terminal, '..'), {recursive:true}); await writeFile(terminal, terminalThreadEnvironmentEdit[0]);
  await patchDshThreadEnvironment(root); const once = await readFile(module,'utf8');
  await patchDshThreadEnvironment(root); assert.equal(await readFile(module,'utf8'),once);
  await writeFile(module,'// unsupported pinned executor');
  await assert.rejects(patchDshThreadEnvironment(root), /boundary changed/);
  assert.equal(await readFile(module,'utf8'),'// unsupported pinned executor');
});

// Optional integration input is an existing pinned runtime; normal unit tests do
// not install one or modify its shared node_modules.
if (process.env.OPENCRAFT_DSH_RUNTIME) test('real pinned DSH spawn boundary injects per-call Thread ID and clears missing identity', async t => {
  const { build } = await import('esbuild');
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-thread-env-')); t.after(() => rm(root,{recursive:true,force:true}));
  const sourcePath = join(process.env.OPENCRAFT_DSH_RUNTIME,'node_modules/@deepseek-ai/dsh-bash-local/lib/index.js');
  const source = await readFile(sourcePath,'utf8');
  assert.equal(source.split(threadEnvironmentEdit[0]).length,2);
  const output = join(root,'executor.mjs');
  await build({stdin:{contents:source.replace(...threadEnvironmentEdit),sourcefile:sourcePath,resolveDir:join(sourcePath,'..')},outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
  const { LocalBashExecutor } = await import(pathToFileURL(output).href);
  for (const threadId of ['thread-A','thread-B',null]) {
    const spec = LocalBashExecutor.prototype.spawnSpec.call({config:{maxSpillBytes:10000,maxOutputBytes:10000,graceMs:100}},
      {workdir:root,env:{OPENCRAFT_THREAD_ID:'stale'},dshEnv:threadId?{DSH_SESSION_ID:`native-${threadId}`,DSH_OPENCRAFT_THREAD_ID:threadId}:{}}, ['unused'],10000);
    const result = await promisify(execFile)(process.execPath,['-e','process.stdout.write(process.env.OPENCRAFT_THREAD_ID)'], {cwd:root,env:spec.env});
    assert.equal(result.stdout,threadId??'');
  }
});


test('DSH shell and terminal resolver retain public identity across native generation changes', async()=>{
  const { registerDshExecutionEnvironment }=await import('../../apps/local-agent-host/src/dsh-execution-environment.mjs');
  const generations=new Map([['native-one',{logicalSessionId:'thread-public'}],['native-two',{logicalSessionId:'thread-public'}]]);
  let port,contributor;
  const context={provide(name,value){assert.equal(name,'opencraftExecutionThread');port=value;},inject(deps,setup){assert.deepEqual(deps,['shellEnv']);setup({shellEnv:{register(value){contributor=value;}}});}};
  registerDshExecutionEnvironment(context,id=>generations.get(id)?.logicalSessionId??id);
  for(const id of ['native-one','native-two']) {
    assert.equal(port.resolve(id),'thread-public');
    assert.deepEqual(contributor.resolve({agent:{session:{header:{id}}}}),{DSH_OPENCRAFT_THREAD_ID:'thread-public'});
  }
  assert.equal(port.resolve('generation-zero'),'generation-zero');assert.deepEqual(contributor.resolve({}),{});
});

test('ACP resolver reads atomic routing authority and refuses absent, conflicting and malformed mappings', async t => {
  const {createAcpExecutionThreadResolver}=await import('../../plugins/acp-engine/src/execution-thread-resolver.mjs');
  const root=await mkdtemp(join(tmpdir(),'acp-thread-map-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const resolve=createAcpExecutionThreadResolver(root);
  assert.equal(resolve('native'), '');
  await writeFile(join(root,'dsh_acp_public.json'),JSON.stringify({schemaVersion:1,id:'dsh_acp_public',nativeId:'native',cwd:root}));
  assert.equal(resolve('native'),'dsh_acp_public');assert.equal(resolve('dsh_acp_native'),'');
  await writeFile(join(root,'dsh_acp_other.json'),JSON.stringify({schemaVersion:1,id:'dsh_acp_other',nativeId:'native',cwd:root}));
  assert.equal(resolve('native'),'');
  await rm(join(root,'dsh_acp_other.json'));await writeFile(join(root,'dsh_acp_public.json'),'{');
  assert.equal(resolve('native'),'');
});

if (process.env.OPENCRAFT_DSH_RUNTIME) test('real pinned terminal child environment uses the same public mapping port', async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-terminal-id-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sourcePath=join(process.env.OPENCRAFT_DSH_RUNTIME,'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js');
  const source=await readFile(sourcePath,'utf8');assert.equal(source.split(terminalThreadEnvironmentEdit[0]).length,2);
  const patched=source.replace(...terminalThreadEnvironmentEdit);
  const start=patched.indexOf('function childEnvironment('), end=patched.indexOf('\n/**',start);
  assert.ok(start>=0 && end>start);
  // Evaluate the actual pinned boundary without importing PTY native modules.
  const childEnvironment=new Function('CONTROLLED_PROMPT',patched.slice(start,end)+'; return childEnvironment;')('probe> ');
  const spec={owner:{id:'native-id',ctx:{get:name=>name==='opencraftExecutionThread'?{resolve:id=>id==='native-id'?'public-id':''}:undefined}},sessionId:'terminal-id'};
  const env=childEnvironment(spec,'bash');
  const result=await promisify(execFile)(process.execPath,['-e','process.stdout.write(process.env.OPENCRAFT_THREAD_ID)'],{cwd:root,env});
  assert.equal(result.stdout,'public-id');
});
