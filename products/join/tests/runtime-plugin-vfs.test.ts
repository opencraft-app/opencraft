import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {startHostFileSystem} from '../../../scripts/host-filesystem';
import {createHandsPluginSource} from '../runtime-plugins/hands-source.mjs';
import {createVfsPluginSource,snapshotVfsPlugin} from '../runtime-plugins/source.mjs';
import {loadRuntimePlugins} from '../runtime-plugins/host.mjs';
import {hash,installRuntimePlugin} from '../runtime-plugins/store.mjs';
const authority={authenticate:()=>({provider:'fixture',subject:'owner',expiresAt:Date.now()+60_000}),admissionStatus:()=>204};
async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'plugin-vfs-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
async function packageFixture(root:string,code?:string){
 const output=join(root,'package');await mkdir(output);
 const bytes=code??'export async function activate(){return {handle(_q,r){r.end("from-vfs");},close(){}};}';
 await writeFile(join(output,'entry.mjs'),bytes);
 await writeFile(join(output,'manifest.json'),JSON.stringify({schemaVersion:1,id:'fixture.vfs',version:'1.0.0',hostApi:1,nodeMajor:26,sourceRevision:'a'.repeat(40),roles:{gateway:{entry:'entry.mjs',routes:[{path:'/__fixture_vfs',methods:['GET']}]},execution:{entry:'entry.mjs'}},files:[{path:'entry.mjs',size:Buffer.byteLength(bytes),sha256:hash(bytes)}]}));
 const directory=join(root,'platform'),remote=join(root,'remote');
 const selection=await installRuntimePlugin(output,directory,{enable:true});await installRuntimePlugin(output,remote,{enable:true});
 await rm(join(directory,'packages'),{recursive:true});await rm(output,{recursive:true});
 return {directory,remote,selection,cacheDirectory:join(root,'cache')};
}
async function http(host:any,run:(url:string)=>Promise<void>){const server=createServer((q,r)=>{if(!host.handle(q,r)){r.statusCode=404;r.end();}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const at=server.address();assert(at&&typeof at==='object');try{await run(`http://127.0.0.1:${at.port}/__fixture_vfs`);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}
const fileSource=(root:string)=>createVfsPluginSource({root,readFile:async(path,{signal})=>readFile(path,{signal})});

test('platform reads JS through the real existing Hands file RPC, without a shared plugin path',async()=>fixture(async root=>{
 const p=await packageFixture(root),endpoint=join(root,'files.sock'),tokenFile=join(root,'files.token');
 const files=await startHostFileSystem({endpoint,tokenFile});
 const host=await loadRuntimePlugins({directory:p.directory,cacheDirectory:p.cacheDirectory,role:'gateway',authority,
  packageSource:createHandsPluginSource({root:p.remote,endpoint,tokenFile})});
 try{
  assert.equal(host.selected.length,1);await assert.rejects(access(join(p.directory,'packages')));
  await http(host,async url=>assert.equal(await(await fetch(url)).text(),'from-vfs'));
  const remoteEntry=join(p.remote,'packages',p.selection.id,p.selection.revision,'entry.mjs');await writeFile(remoteEntry,'throw Error("mutated remote");');
  await http(host,async url=>assert.equal(await(await fetch(url)).text(),'from-vfs'));
  const next=await loadRuntimePlugins({directory:p.directory,cacheDirectory:p.cacheDirectory,role:'gateway',authority,packageSource:fileSource(p.remote)});
  try{assert.equal(next.selected.length,0);assert.equal(next.skipped[0].reason,'verification_failed');}finally{await next.close();}
 }finally{await host.close();await files.close();}
}));
test('a VFS index or arbitrary folder cannot enable backend code',async()=>fixture(async root=>{
 const p=await packageFixture(root);await rm(join(p.directory,'installed.json'));let reads=0;
 const host=await loadRuntimePlugins({directory:p.directory,cacheDirectory:p.cacheDirectory,role:'gateway',authority,
  packageSource:createVfsPluginSource({root:p.remote,readFile:async()=>{reads++;throw Error('must not read');}})});
 assert.equal(host.selected.length,0);assert.equal(reads,0);await host.close();
}));
test('VFS source failure is skipped with no local package fallback or exception disclosure',async()=>fixture(async root=>{
 const p=await packageFixture(root),diagnostics:any[]=[];
 const host=await loadRuntimePlugins({directory:p.directory,cacheDirectory:p.cacheDirectory,role:'gateway',authority,
  packageSource:()=>{throw Error('secret source config');},onDiagnostic:d=>diagnostics.push(d)});
 assert.equal(host.selected.length,0);assert.deepEqual(diagnostics,[{role:'gateway',reason:'source_unavailable'}]);await host.close();
}));
test('source disappearance does not reactivate a cached copy',async()=>fixture(async root=>{
 const p=await packageFixture(root);let host=await loadRuntimePlugins({...p,role:'gateway',authority,packageSource:fileSource(p.remote)});assert.equal(host.selected.length,1);await host.close();
 await rm(p.remote,{recursive:true});host=await loadRuntimePlugins({...p,role:'gateway',authority,packageSource:fileSource(p.remote)});
 assert.equal(host.selected.length,0);await host.close();
}));
test('unlisted remote neighbours are never copied or imported',async()=>fixture(async root=>{
 const marker=join(root,'unexpected'),p=await packageFixture(root,'import "./neighbour.mjs";export function activate(){return {handle(){},close(){}};}');
 await writeFile(join(p.remote,'packages',p.selection.id,p.selection.revision,'neighbour.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
 const host=await loadRuntimePlugins({...p,role:'gateway',authority,packageSource:fileSource(p.remote)});
 assert.equal(host.selected.length,0);await assert.rejects(access(marker));await assert.rejects(access(join(p.cacheDirectory,p.selection.id,p.selection.revision,'neighbour.mjs')));await host.close();
}));
test('snapshot cache must be private and corruption cannot be repaired under an active generation',async()=>fixture(async root=>{
 const p=await packageFixture(root);await mkdir(p.cacheDirectory,{mode:0o755});await chmod(p.cacheDirectory,0o755);
 await assert.rejects(snapshotVfsPlugin(fileSource(p.remote),p.selection,{cacheDirectory:p.cacheDirectory}),/private/);
 await chmod(p.cacheDirectory,0o700);await snapshotVfsPlugin(fileSource(p.remote),p.selection,{cacheDirectory:p.cacheDirectory});
 const entry=join(p.cacheDirectory,p.selection.id,p.selection.revision,'entry.mjs');await chmod(entry,0o600);await writeFile(entry,'corrupt');
 await assert.rejects(snapshotVfsPlugin(fileSource(p.remote),p.selection,{cacheDirectory:p.cacheDirectory}));assert.equal(await readFile(entry,'utf8'),'corrupt');
}));
test('snapshot validates source adapter output before writing any supplied path',async()=>fixture(async root=>{
 const p=await packageFixture(root),source=fileSource(p.remote),fetched=await source.readPackage(p.selection,{});
 fetched.files.set('../../escape',Buffer.from('bad'));
 await assert.rejects(snapshotVfsPlugin({readPackage:async()=>fetched},p.selection,{cacheDirectory:p.cacheDirectory}));await assert.rejects(access(join(root,'escape')));
}));
test('bounded VFS timeout leaves the host usable and does not fall back to the local filesystem',async()=>fixture(async root=>{
 const p=await packageFixture(root);
 const host=await loadRuntimePlugins({...p,role:'gateway',authority,startupTimeoutMs:60,
  packageSource:createVfsPluginSource({root:p.remote,readFile:async(_path,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('private timeout')),{once:true}))})});
 assert.equal(host.selected.length,0);await http(host,async url=>assert.equal((await fetch(url)).status,404));await host.close();
}));
