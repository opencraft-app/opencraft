import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {hash,installRuntimePlugin,readCatalogue,parseManifest,verifyPackage} from '../runtime-plugins/store.mjs';
import {loadRuntimePlugins,runtimePluginDirectory} from '../runtime-plugins/host.mjs';
const principal={provider:'fixture',subject:'owner',displayName:'Owner',expiresAt:Date.now()+60_000};
const authority={authenticate:()=>principal,admissionStatus:()=>204};
async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'runtime-plugin-data-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
async function pkg(root:string,id='fixture.example',version='1.0.0',code?:string,route='/__fixture_plugin'){
 const directory=join(root,id+'-'+version);await mkdir(directory);
 const module=code??`export async function activate(context){return {handle(_req,res){res.end(JSON.stringify({version:${JSON.stringify(version)},role:context.role}));},close(){}};}`;
 const path='entry.mjs';await writeFile(join(directory,path),module);
 const manifest={schemaVersion:1,id,version,hostApi:1,nodeMajor:26,sourceRevision:'a'.repeat(40),roles:{gateway:{entry:path,routes:[{path:route,methods:['GET']}]},hands:{entry:path}},files:[{path,size:Buffer.byteLength(module),sha256:hash(module)}]};
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));return {directory,manifest};
}
async function withHttp(host:any,run:(origin:string)=>Promise<void>){const server=createServer((req,res)=>{if(!host.handle(req,res)){res.statusCode=404;res.end();}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');try{await run(`http://127.0.0.1:${address.port}`);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}

test('an empty standard host does not discover or execute arbitrary directories',async()=>fixture(async root=>{
 const store=join(root,'store');await mkdir(store);await mkdir(join(store,'arbitrary'));await writeFile(join(store,'arbitrary','entry.mjs'),'throw Error("must not load")');
 const host=await loadRuntimePlugins({directory:store,role:'gateway',authority});assert.deepEqual(host.selected,[]);await host.close();
}));
test('installation is data-only, default disabled, and explicit enabling survives host restart',async()=>fixture(async root=>{
 const marker=join(root,'marker');const p=await pkg(root,'fixture.install','1.0.0',`import {appendFile} from 'node:fs/promises';export async function activate(){await appendFile(${JSON.stringify(marker)},'activate\\n');return {handle(_q,r){r.end('ok');},close:()=>appendFile(${JSON.stringify(marker)},'close\\n')};}`);
 const store=join(root,'store');await installRuntimePlugin(p.directory,store);
 await assert.rejects(readFile(marker));let host=await loadRuntimePlugins({directory:store,role:'gateway',authority});assert.equal(host.selected.length,0);await host.close();
 await installRuntimePlugin(p.directory,store,{enable:true});await assert.rejects(readFile(marker));
 host=await loadRuntimePlugins({directory:store,role:'gateway',authority});await host.close();
 host=await loadRuntimePlugins({directory:store,role:'gateway',authority});await host.close();
 assert.equal(await readFile(marker,'utf8'),'activate\nclose\nactivate\nclose\n');
}));
test('updating a data package leaves the active generation and old immutable version intact',async()=>fixture(async root=>{
 const p1=await pkg(root,'fixture.versions','1.0.0'),p2=await pkg(root,'fixture.versions','2.0.0'),store=join(root,'store');
 await installRuntimePlugin(p1.directory,store,{enable:true});const old=await loadRuntimePlugins({directory:store,role:'gateway',authority});
 await installRuntimePlugin(p2.directory,store,{enable:true});const next=await loadRuntimePlugins({directory:store,role:'gateway',authority});
 try {
  await withHttp(old,async origin=>assert.equal((await(await fetch(origin+'/__fixture_plugin')).json()).version,'1.0.0'));
  await withHttp(next,async origin=>assert.equal((await(await fetch(origin+'/__fixture_plugin')).json()).version,'2.0.0'));
  assert.equal((await readdir(join(store,'packages','fixture.versions'))).length,2);
 }finally{await old.close();await next.close();}
}));
test('tampered code is skipped without preventing a verified plugin from loading',async()=>fixture(async root=>{
 const marker=join(root,'marker'),p=await pkg(root,'fixture.first','1.0.0',`import {writeFile} from 'node:fs/promises';export async function activate(){await writeFile(${JSON.stringify(marker)},'executed');return {handle(){},close(){}};}`,'/__fixture_first');
 const second=await pkg(root,'fixture.second','1.0.0',undefined,'/__fixture_second'),store=join(root,'store');
 await installRuntimePlugin(p.directory,store,{enable:true});const selected=await installRuntimePlugin(second.directory,store,{enable:true});
 await writeFile(join(store,'packages',selected.id,selected.revision,'entry.mjs'),'throw Error("tampered")');
 const host=await loadRuntimePlugins({directory:store,role:'gateway',authority});
 assert.deepEqual(host.selected.map(p=>p.id),['fixture.first']);assert.equal(host.skipped[0].id,'fixture.second');assert.equal(await readFile(marker,'utf8'),'executed');await host.close();
}));
test('manifest digest and catalogue identity are verified, not inferred from a folder name',async()=>fixture(async root=>{
 const p=await pkg(root),store=join(root,'store'),selected=await installRuntimePlugin(p.directory,store,{enable:true});
 const manifest=join(store,'packages',selected.id,selected.revision,'manifest.json');await writeFile(manifest,(await readFile(manifest,'utf8'))+' ');
 const host=await loadRuntimePlugins({directory:store,role:'hands'});assert.equal(host.selected.length,0);assert.equal(host.skipped[0].reason,'verification_failed');await host.close();
}));
test('reserved and duplicate routes, unsupported APIs and escaping paths are rejected',async()=>fixture(async root=>{
 const p=await pkg(root);
 for(const input of [{...p.manifest,hostApi:2},{...p.manifest,roles:{gateway:{entry:'entry.mjs',routes:[{path:'/__opencraft_access',methods:['GET']}]}}},{...p.manifest,files:[{path:'../escape',size:1,sha256:'a'.repeat(64)}]}])assert.throws(()=>parseManifest(input));
 const store=join(root,'store');await installRuntimePlugin(p.directory,store,{enable:true});const second=await pkg(root,'fixture.conflict');await installRuntimePlugin(second.directory,store,{enable:true});
 const host=await loadRuntimePlugins({directory:store,role:'gateway',authority});assert.equal(host.selected.length,1);assert.equal(host.skipped.length,1);await withHttp(host,async origin=>assert.equal((await fetch(origin+'/__fixture_plugin')).status,200));await host.close();
}));
test('invalid source installation preserves the current catalogue and package selection',async()=>fixture(async root=>{
 const p=await pkg(root),store=join(root,'store');await installRuntimePlugin(p.directory,store,{enable:true});const before=await readFile(join(store,'installed.json'),'utf8');
 await writeFile(join(p.directory,'entry.mjs'),'changed');await assert.rejects(installRuntimePlugin(p.directory,store,{enable:true}));assert.equal(await readFile(join(store,'installed.json'),'utf8'),before);
}));
test('symlinks and undeclared files cannot enter a package',async()=>fixture(async root=>{
 const p=await pkg(root);await writeFile(join(p.directory,'unexpected'),'not inventoried');await assert.rejects(verifyPackage(p.directory),/Undeclared/);await rm(join(p.directory,'unexpected'));
 await rm(join(p.directory,'entry.mjs'));await writeFile(join(root,'elsewhere'),'export{}');await symlink(join(root,'elsewhere'),join(p.directory,'entry.mjs'));await assert.rejects(verifyPackage(p.directory));
}));
test('writable-by-others catalogues are not a trust source',async()=>fixture(async root=>{
 const p=await pkg(root),store=join(root,'store');await installRuntimePlugin(p.directory,store,{enable:true});await chmod(join(store,'installed.json'),0o666);
 const host=await loadRuntimePlugins({directory:store,role:'hands'});assert.equal(host.selected.length,0);assert.equal(host.skipped[0].reason,'catalogue_unavailable');await host.close();
}));
test('route dispatch reuses verified identity and instance admission; catalogue cannot grant membership',async()=>fixture(async root=>{
 const p=await pkg(root),store=join(root,'store');await installRuntimePlugin(p.directory,store,{enable:true});
 for(const [auth,status] of [[{authenticate:()=>null,admissionStatus:()=>204},401],[{authenticate:()=>principal,admissionStatus:()=>403},403],[authority,200]] as const){
  const host=await loadRuntimePlugins({directory:store,role:'gateway',authority:auth});
  try{await withHttp(host,async origin=>{assert.equal((await fetch(origin+'/__fixture_plugin')).status,status);assert.equal((await fetch(origin+'/not-a-plugin')).status,404);assert.equal((await fetch(origin+'/__fixture_plugin',{method:'POST'})).status,405);});}
  finally{await host.close();}
 }
}));
test('activation failure preserves healthy plugins and does not disclose plugin errors',async()=>fixture(async root=>{
 const marker=join(root,'closed'),p=await pkg(root,'fixture.good','1.0.0',`import {writeFile} from 'node:fs/promises';export async function activate(){return {handle(_q,r){r.end('healthy');},close:()=>writeFile(${JSON.stringify(marker)},'closed')};}`,'/__fixture_good');
 const q=await pkg(root,'fixture.bad','1.0.0','export async function activate(){throw Error("secret fixture token");}','/__fixture_bad'),store=join(root,'store');
 await installRuntimePlugin(p.directory,store,{enable:true});await installRuntimePlugin(q.directory,store,{enable:true});
 const diagnostics:any[]=[];const host=await loadRuntimePlugins({directory:store,role:'gateway',authority,onDiagnostic:value=>diagnostics.push(value)});
 assert.equal(host.selected.length,1);assert.deepEqual(diagnostics,[{id:'fixture.bad',role:'gateway',reason:'activation_or_runtime_failed'}]);await assert.rejects(readFile(marker));
 await withHttp(host,async origin=>{assert.equal(await(await fetch(origin+'/__fixture_good')).text(),'healthy');assert.equal((await fetch(origin+'/__fixture_bad')).status,404);});
 await host.close();assert.equal(await readFile(marker,'utf8'),'closed');
}));
test('close drains accepted requests before disposing plugin resources',async()=>fixture(async root=>{
 const marker=join(root,'order'),p=await pkg(root,'fixture.drain','1.0.0',`import {appendFile} from 'node:fs/promises';export async function activate(){return {async handle(_q,r){await appendFile(${JSON.stringify(marker)},'start\\n');await new Promise(resolve=>setTimeout(resolve,80));r.end('done');await appendFile(${JSON.stringify(marker)},'end\\n');},close:()=>appendFile(${JSON.stringify(marker)},'close\\n')};}`),store=join(root,'store');
 await installRuntimePlugin(p.directory,store,{enable:true});const host=await loadRuntimePlugins({directory:store,role:'gateway',authority});
 await withHttp(host,async origin=>{
  const response=fetch(origin+'/__fixture_plugin');for(let i=0;i<100;i++){try{if((await readFile(marker,'utf8')).includes('start'))break;}catch{}await new Promise(resolve=>setTimeout(resolve,5));}
  await host.close();assert.equal((await response).status,200);assert.equal(await readFile(marker,'utf8'),'start\nend\nclose\n');assert.equal((await fetch(origin+'/__fixture_plugin')).status,503);
 });
}));
test('installer serialization refuses concurrent mutation without changing the selected index',async()=>fixture(async root=>{
 const p=await pkg(root),store=join(root,'store');await installRuntimePlugin(p.directory,store);const before=await readCatalogue(store);
 await mkdir(join(store,'.install-lock'));await assert.rejects(installRuntimePlugin(p.directory,store,{enable:true}));assert.deepEqual(await readCatalogue(store),before);
}));

test('product identity paths cannot be claimed by a data plugin',async()=>fixture(async root=>{
 const p=await pkg(root,'fixture.identity','1.0.0',undefined,'/__fixture_identity/session'),store=join(root,'store');await installRuntimePlugin(p.directory,store,{enable:true});
 const host=await loadRuntimePlugins({directory:store,role:'gateway',authority,protectedPaths:['/__fixture_identity']});assert.equal(host.selected.length,0);assert.equal(host.skipped.length,1);await host.close();
}));

// Optional plugin failures must never be forwarded to the core Hands owner failure port.
test('missing, malformed or misconfigured plugin storage leaves core HTTP available',async()=>fixture(async root=>{
 const store=join(root,'store');await mkdir(store);await writeFile(join(store,'installed.json'),'invalid secret JSON');
 for(const directory of [store,null,runtimePluginDirectory(root,{OPENCRAFT_RUNTIME_PLUGIN_DIRECTORY:'relative'})]){
  const host=await loadRuntimePlugins({directory,role:'gateway',authority,onDiagnostic:()=>{throw Error('logger failed');}});
  assert.equal(host.selected.length,0);assert.equal(host.skipped.length,1);
  const server=createServer((req,res)=>{if(!host.handle(req,res))res.end('core healthy');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const at=server.address();assert(at&&typeof at==='object');
  try{assert.equal(await(await fetch(`http://127.0.0.1:${at.port}/health`)).text(),'core healthy');}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await host.close();}
 }
}));
test('runtime failure port disables only that plugin and leaves another plugin serving',async()=>fixture(async root=>{
 const store=join(root,'store'),bad=await pkg(root,'fixture.fault','1.0.0',`export async function activate(context){return {handle(_q,r){context.onFailure();r.end('stopped');},close(){}};}`,'/__fixture_fault');
 const good=await pkg(root,'fixture.healthy','1.0.0',undefined,'/__fixture_healthy');
 await installRuntimePlugin(bad.directory,store,{enable:true});await installRuntimePlugin(good.directory,store,{enable:true});
 const host=await loadRuntimePlugins({directory:store,role:'gateway',authority});
 try{await withHttp(host,async origin=>{
  assert.equal((await fetch(origin+'/__fixture_fault')).status,200);
  assert.equal((await fetch(origin+'/__fixture_fault')).status,404);
  assert.equal((await fetch(origin+'/__fixture_healthy')).status,200);
 });assert.deepEqual(host.selected.map(p=>p.id),['fixture.healthy']);}finally{await host.close();}
}));
test('an asynchronous activation hang has a bounded startup budget and late completion is cleaned up',async()=>fixture(async root=>{
 const store=join(root,'store'),marker=join(root,'late-closed');
 const good=await pkg(root,'fixture.early','1.0.0',undefined,'/__fixture_early');
 const slow=await pkg(root,'fixture.slow','1.0.0',`import {writeFile} from 'node:fs/promises';export async function activate(){await new Promise(resolve=>setTimeout(resolve,650));return {handle(){},close:()=>writeFile(${JSON.stringify(marker)},'closed')};}`,'/__fixture_slow');
 await installRuntimePlugin(good.directory,store,{enable:true});await installRuntimePlugin(slow.directory,store,{enable:true});
 const started=performance.now();const host=await loadRuntimePlugins({directory:store,role:'gateway',authority,startupTimeoutMs:300});
 assert.ok(performance.now()-started<600);assert.deepEqual(host.selected.map(p=>p.id),['fixture.early']);
 await withHttp(host,async origin=>assert.equal((await fetch(origin+'/__fixture_early')).status,200));await host.close();
 for(let i=0;i<100;i++){try{assert.equal(await readFile(marker,'utf8'),'closed');return;}catch{await new Promise(resolve=>setTimeout(resolve,15));}}
 assert.fail('late activation was not disposed');
}));
test('failed activation does not reserve routes that a later healthy plugin can serve',async()=>fixture(async root=>{
 const store=join(root,'store'),bad=await pkg(root,'fixture.badroute','1.0.0','throw Error("import failed");'),good=await pkg(root,'fixture.goodroute');
 await installRuntimePlugin(bad.directory,store,{enable:true});await installRuntimePlugin(good.directory,store,{enable:true});
 const host=await loadRuntimePlugins({directory:store,role:'gateway',authority});
 try{assert.deepEqual(host.selected.map(p=>p.id),['fixture.goodroute']);await withHttp(host,async origin=>assert.equal((await fetch(origin+'/__fixture_plugin')).status,200));}finally{await host.close();}
}));
