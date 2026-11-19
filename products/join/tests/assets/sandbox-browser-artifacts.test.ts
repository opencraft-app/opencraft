import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {browserRuntimeManifest,browserRuntimePreparationScript,createSandboxBrowserPreparer} from '../../assets/sandbox-browser-artifacts';
const pin={version:1 as const,archives:[{path:'/shared/.opencraft/runtime-cache/browser.tgz',sha256:'a'.repeat(64)}]};
const archiveHelper="import tarfile,io,sys\npath,kind=sys.argv[1:]\nwith tarfile.open(path,'w:gz') as t:\n m=tarfile.TarInfo('.');m.type=tarfile.DIRTYPE;m.mode=0o755;m.uid=99998;m.gid=99998;t.addfile(m)\n names=['electron/electron','owner.cjs','worker.cjs','encoder.html','encoder-preload.cjs','annotation-preload.cjs','preview-bridge.js']\n for name in names:\n  m=tarfile.TarInfo(name);b=b'fixture';m.size=len(b);m.mode=0o755 if name=='electron/electron' else 0o644;t.addfile(m,io.BytesIO(b))\n if kind!='good':\n  m=tarfile.TarInfo('../escape' if kind=='traversal' else 'electron/chrome-sandbox' if kind=='sandboxhelper' else 'bad')\n  if kind=='symlink':m.type=tarfile.SYMTYPE;m.linkname='/tmp'\n  if kind=='fifo':m.type=tarfile.FIFOTYPE\n  if kind in ('setuid','sandboxhelper'):m.mode=0o4755\n  t.addfile(m)\n";

function archive(root:string,kind:string){
 const path=join(root,kind+'.tgz');execFileSync('/usr/bin/python3',['-c',archiveHelper,path,kind]);
 return {path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
}
test('manifest accepts deployment cache only and snapshots caller input',()=>{
 const input=structuredClone(pin),value=browserRuntimeManifest(input);input.archives[0]!.sha256='b'.repeat(64);
 assert.equal(value.archives[0]!.sha256,'a'.repeat(64));
 for(const path of ['/workspace/a.tgz','https://example.test/a.tgz','/shared/.opencraft/runtime-cache/../a.tgz'])
  assert.throws(()=>browserRuntimeManifest({...pin,archives:[{path,sha256:'a'.repeat(64)}]}),/Invalid/);
 assert.throws(()=>browserRuntimeManifest({...pin,archives:[]}),/Invalid/);
});
test('actual Python verifies and extracts local runtime with private root',()=>{
 const root=mkdtempSync(join(tmpdir(),'browser-archives-'));let directory:string|undefined;
 try{
  const entry=archive(root,'good');
  const result=spawnSync('/usr/bin/python3',['-c',browserRuntimePreparationScript,JSON.stringify({archives:[entry]})],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);directory=JSON.parse(result.stdout).directory;
  assert.ok(directory!.startsWith('/tmp/opencraft-browser-runtime-'));assert.equal(statSync(directory!).mode&0o777,0o700);assert.equal(statSync(directory!).uid,process.getuid?.());
  assert.equal(readFileSync(join(directory!,'worker.cjs'),'utf8'),'fixture');
 }finally{if(directory)rmSync(directory,{recursive:true,force:true});rmSync(root,{recursive:true,force:true})}
});
for(const kind of ['traversal','symlink','fifo','setuid','digest'])test('actual Python rejects '+kind,()=>{
 const root=mkdtempSync(join(tmpdir(),'browser-bad-archive-'));
 try{
  const entry=archive(root,kind==='digest'?'good':kind);if(kind==='digest')entry.sha256='0'.repeat(64);
  const result=spawnSync('/usr/bin/python3',['-c',browserRuntimePreparationScript,JSON.stringify({archives:[entry]})],{encoding:'utf8'});
  assert.equal(result.status,1);assert.deepEqual(JSON.parse(result.stdout),{error:'browser_runtime_preparation_failed'});
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('preparation failure is retained without retry',async()=>{
 let starts=0;const p=createSandboxBrowserPreparer({manifest:pin,authorize:async()=>{},onCleanupUnconfirmed(){},
 sandbox:{async spawn(){starts++;throw Error('fixture failure')}}});
 await assert.rejects(p.prepare(),/fixture failure/);await assert.rejects(p.prepare(),/fixture failure/);assert.equal(starts,1);
});
test('authorization is rechecked before publishing receipt',async()=>{
 let checks=0,stops=0;const p=createSandboxBrowserPreparer({manifest:pin,authorize:async()=>{if(++checks===3)throw Error('revoked')},onCleanupUnconfirmed(){},
 sandbox:{async spawn(_command,output){output?.({stream:'stdout',data:Buffer.from(JSON.stringify({directory:'/tmp/opencraft-browser-runtime-test'}))});return {
 kind:'process',id:'fixture',exited:Promise.resolve({code:0}),closeStdin:async()=>{},writeStdin:async()=>{},terminate:async()=>{stops++},
 }}}});
 await assert.rejects(p.prepare(),/revoked/);assert.equal(stops,1);
});

test('pinned Electron helper is extracted without archive privilege bits',()=>{
 const root=mkdtempSync(join(tmpdir(),'browser-helper-'));let directory:string|undefined;
 try{
  const entry=archive(root,'sandboxhelper');
  const result=spawnSync('/usr/bin/python3',['-c',browserRuntimePreparationScript,JSON.stringify({archives:[entry]})],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);directory=JSON.parse(result.stdout).directory;
  assert.equal(statSync(join(directory!,'electron/chrome-sandbox')).mode&0o7777,0o755);
 }finally{if(directory)rmSync(directory,{recursive:true,force:true});rmSync(root,{recursive:true,force:true})}
});
