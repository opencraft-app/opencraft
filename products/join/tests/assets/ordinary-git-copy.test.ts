import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ordinaryGitGenerationPath, prepareOrdinaryGitCopy } from '../../assets/ordinary-git-copy';
import type { SandboxEnvironment } from '@opencraft/sandbox';
import type { ResolvedWorkspaceSelection } from '../../../../apps/local-agent-host/src/ordinary-workspace-selection';

// Runs the exact Python/Git preparation algorithm with temporary local mount
// roots. This is private-copy correctness, not NFS/provider/mount verification.
const git = (cwd:string,args:string[]) => execFileSync('git',['-c','safe.directory='+cwd,...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t:test.TestContext) {
 const root=mkdtempSync(join(tmpdir(),'ordinary-git-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repository=process.env.ORDINARY_GIT_FIXTURE_REPOSITORY ?? resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
 const commit=git(repository,['rev-parse','HEAD']);
 const selection:ResolvedWorkspaceSelection={version:1,environment:{configurationId:'base',configurationRevision:'a'.repeat(64),templateId:'template',cpuMillis:1,memoryBytes:1},
  source:{kind:'git',repositoryId:'fixture',commit,libraryId:'shared',authorizationDomain:'fixture',generation:'generation-1',relativePath:''}};
 assert.equal(selection.source.kind,'git');if(selection.source.kind!=='git')throw Error('fixture');
 const base=join(root,ordinaryGitGenerationPath(selection.source).slice(1));mkdirSync(dirname(base),{recursive:true});
 git(repository,['clone','--bare','--no-hardlinks',repository,base]);
 const remote='https://example.test/team/project.git',manifest={version:1,repositoryId:selection.source.repositoryId,authorizationDomain:selection.source.authorizationDomain,generation:selection.source.generation,commit:selection.source.commit,remote};
 writeFileSync(join(base,'opencraft-generation.json'),JSON.stringify(manifest));
 const workspace=(name:string)=>{
  const dir=join(root,name);mkdirSync(dir);
  const sandbox:Pick<SandboxEnvironment,'spawn'>={async spawn(command,output){
   const script=command.command[2]!.replace("pathlib.Path('/workspace')","pathlib.Path("+JSON.stringify(dir)+")");
   const child=spawn(command.command[0]!,['-c',script],{cwd:dir,env:command.env,stdio:['pipe','pipe','pipe']});
   const exited=new Promise<{code:number|null}>((ok,no)=>{child.once('error',no);child.once('close',code=>ok({code}));});
   const chunks:Buffer[]=[];child.stdout.on('data',d=>chunks.push(d));child.stderr.resume();
   child.stdout.on('end',()=>output?.({stream:'stdout',data:Buffer.from(Buffer.concat(chunks).toString().replaceAll(dir,'/workspace'))}));
   return {id:String(child.pid),kind:'process',exited,async writeStdin(bytes){
    const v=JSON.parse(Buffer.from(bytes).toString());v.base=join(root,v.base.slice(1));
    child.stdin.write(JSON.stringify(v));
   },async closeStdin(){child.stdin.end()},async terminate(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}};
  }};
  return {dir,run:()=>prepareOrdinaryGitCopy({sandbox,selection,remote,authorize:async()=>{}})};
 };
 return {root,base,selection,remote,workspace,manifest};
}
test('warm Git preparation borrows pinned objects, isolates copies and preserves dirty files on reopen',async t=>{
 const f=fixture(t),a=f.workspace('a'),b=f.workspace('b');
 assert.deepEqual(await a.run(),{cwd:'/workspace/project'});await b.run();
 const project=join(a.dir,'project'),other=join(b.dir,'project');
 assert.equal(readFileSync(join(project,'.git/objects/info/alternates'),'utf8'),f.base+'/objects\n');
 assert.equal(git(project,['rev-parse','HEAD']),f.selection.source.kind==='git'?f.selection.source.commit:'');
 assert.equal(existsSync(join(project,'.git/objects',f.selection.source.kind==='git'?f.selection.source.commit.slice(0,2):'',f.selection.source.kind==='git'?f.selection.source.commit.slice(2):'')),false);
 writeFileSync(join(project,'PRIVATE-EDIT'),'retained');assert.equal(existsSync(join(other,'PRIVATE-EDIT')),false);
 await a.run();assert.equal(readFileSync(join(project,'PRIVATE-EDIT'),'utf8'),'retained');
 renameSync(f.base,f.base+'.missing');await assert.rejects(a.run(),/preparation failed/);
 assert.equal(readFileSync(join(project,'PRIVATE-EDIT'),'utf8'),'retained');
});
test('wrong generation manifest and unrelated existing project are never overwritten',async t=>{
 const f=fixture(t),a=f.workspace('a');
 writeFileSync(join(f.base,'opencraft-generation.json'),'{}');await assert.rejects(a.run(),/preparation failed/);
 assert.equal(existsSync(join(a.dir,'project')),false);
 writeFileSync(join(f.base,'opencraft-generation.json'),JSON.stringify(f.manifest));
 mkdirSync(join(a.dir,'project'));writeFileSync(join(a.dir,'project','KEEP'),'user');
 await assert.rejects(a.run(),/preparation failed/);assert.equal(readFileSync(join(a.dir,'project','KEEP'),'utf8'),'user');
});
test('symlinked worktree and credential-bearing remote are rejected',async t=>{
 const f=fixture(t),a=f.workspace('a');symlinkSync(f.root,join(a.dir,'project'));
 await assert.rejects(a.run(),/preparation failed/);
 await assert.rejects(prepareOrdinaryGitCopy({sandbox:{async spawn(){throw Error('must not spawn')}},selection:f.selection,
  remote:'https://user:password@example.test/repo.git',authorize:async()=>{}}),/canonical Git remote/);
});

test('invalid remote and non-Git sources fail before any sandbox command',async()=>{
 const selection:ResolvedWorkspaceSelection={version:1,environment:{configurationId:'base',configurationRevision:'a'.repeat(64),templateId:'template',cpuMillis:1,memoryBytes:1},source:{kind:'git',repositoryId:'r',commit:'b'.repeat(40),libraryId:'l',authorizationDomain:'a',generation:'g',relativePath:''}};
 const sandbox={async spawn():Promise<never>{throw Error('must not spawn')}};
 for(const remote of ['https://user:password@example.test/a.git','file:///tmp/repo','https://example.test/a.git?key=x'])
  await assert.rejects(prepareOrdinaryGitCopy({sandbox,selection,remote,authorize:async()=>{}}),/canonical Git remote/);
 await assert.rejects(prepareOrdinaryGitCopy({sandbox,selection:{...selection,source:{kind:'empty'}},remote:'https://example.test/a.git',authorize:async()=>{}}),/Git source required/);
});
