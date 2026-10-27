import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyDependencyClosure, copyCodeTree } from '../../scripts/full-release/closure.mjs';
import { npmPack } from '../../scripts/full-release/producer.mjs';
import { scanArchive } from '../../scripts/full-release/archive.mjs';
import { fullComponents, COMPONENT_LIMITS } from '../../scripts/full-release/components.mjs';
const exec = promisify(execFile);
async function workspace(t) { const root=await mkdtemp(join(tmpdir(),'full-closure-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; }
async function pkg(root,name,version,body,dependencies={}) { await mkdir(root,{recursive:true});await writeFile(join(root,'package.json'),JSON.stringify({name,version,main:'index.cjs',dependencies}));await writeFile(join(root,'index.cjs'),body);await writeFile(join(root,'LICENSE'),'MIT'); }

test('isolated closure preserves conflicting versions, aliases, peers and dependency cycles',async t=>{
 const root=await workspace(t),source=join(root,'source'),modules=join(source,'node_modules'),out=join(root,'out/node_modules');await mkdir(source);await writeFile(join(source,'package.json'),'{}');
 await pkg(join(modules,'a'),'a','1.0.0',"module.exports=require('shared')",{shared:'1.0.0'});
 await pkg(join(modules,'b'),'b','1.0.0',"module.exports=[require('shared'),require('alias'),require('peer')]",{shared:'2.0.0',alias:'npm:real@1.0.0'});
 await pkg(join(modules,'shared'),'shared','1.0.0',"module.exports='one'");await pkg(join(modules,'b/node_modules/shared'),'shared','2.0.0',"module.exports='two'");
 await pkg(join(modules,'alias'),'real','1.0.0',"module.exports='alias'");await pkg(join(modules,'peer'),'peer','1.0.0',"module.exports='peer'");
 const b=JSON.parse(await readFile(join(modules,'b/package.json')));b.peerDependencies={peer:'1.0.0'};b.optionalDependencies={absent:'1.0.0'};await writeFile(join(modules,'b/package.json'),JSON.stringify(b));
 await pkg(join(modules,'cycle'),'cycle','1.0.0',"module.exports=require('a')",{a:'1.0.0'});const a=JSON.parse(await readFile(join(modules,'a/package.json')));a.dependencies.cycle='1.0.0';await writeFile(join(modules,'a/package.json'),JSON.stringify(a));
 await copyDependencyClosure(out,['a','b'],createRequire(join(source,'package.json')),source);
 const {stdout}=await exec(process.execPath,['-e',"console.log(JSON.stringify([require('a'),require('b')]))"],{cwd:join(root,'out'),env:{...process.env,NODE_PATH:''}});
 assert.deepEqual(JSON.parse(stdout),['one',['two','alias','peer']]);
});

test('normalized code detaches hardlinks and rejects escaping links and cycles',async t=>{
 const root=await workspace(t),source=join(root,'source'),out=join(root,'out');await mkdir(source);await writeFile(join(source,'data'),'code',{mode:0o600});await link(join(source,'data'),join(source,'hard'));await symlink('data',join(source,'soft'));
 await copyCodeTree(source,out);for(const name of ['data','hard','soft']){const s=await stat(join(out,name));assert.equal(s.mode&0o777,0o644);assert.equal(s.nlink,1);assert.equal(await readFile(join(out,name),'utf8'),'code');}assert.equal((await stat(join(source,'data'))).mode&0o777,0o600);
 await writeFile(join(root,'private'),'outside',{mode:0o600});await symlink('../private',join(source,'escape'));await assert.rejects(copyCodeTree(source,join(root,'bad')),/escapes/);await rm(join(source,'escape'));await symlink('.',join(source,'cycle'));await assert.rejects(copyCodeTree(source,join(root,'cycle-out')),/cycle/);
});

test('final staged npm dry-run retains nested dependency trees as ordinary files',async t=>{
 const root=await workspace(t),stage=join(root,'stage');await mkdir(stage);await writeFile(join(stage,'package.json'),JSON.stringify({name:'closure-fixture',version:'1.0.0',files:['full']}));await pkg(join(stage,'full/dsh/node_modules/runtime'),'runtime','1.0.0',"module.exports=42");
 const dry=await npmPack(stage,root,true),packed=await npmPack(stage,root),scan=await scanArchive(join(root,packed.filename));assert.equal(dry.integrity,packed.integrity);assert.ok(scan.files.some(f=>f[0]==='full/dsh/node_modules/runtime/index.cjs'));assert.ok(scan.files.every(f=>['0644','0755'].includes(f[3])));
});

test('component inventories cover each file exactly once and enforce per-layer limits',()=>{
 const tuple=(p,n=1)=>[p,'a'.repeat(64),n,'0644'];const files=[tuple('LICENSE'),tuple('package.json'),tuple('full/core/LICENSE'),tuple('full/core/main.cjs')];const pkg={version:'1.0.0',opencraftWeb:{buildId:'build'}},template={release:{source:{revision:'b'.repeat(40)}}};
 const components=fullComponents(files,pkg,template);assert.deepEqual(components.flatMap(c=>c.fileList),files);assert.ok(components.every(c=>c.licenses.every(p=>c.fileList.some(f=>f[0]===p))));
 assert.throws(()=>fullComponents([tuple('unknown/run')],pkg,template),/Unknown/);assert.throws(()=>fullComponents([tuple('full/core/LICENSE'),tuple('full/core/run',COMPONENT_LIMITS['full/core'][0])],pkg,template),/budget/);
});


test('expanded tar budget also rejects highly compressed padding and trailing data', async t => {
 const {gzipSync}=await import('node:zlib');const root=await workspace(t),path=join(root,'padding.tgz');await writeFile(path,gzipSync(Buffer.alloc(1024*1024)));
 await assert.rejects(scanArchive(path,{archiveBytes:1024*1024,unpackedBytes:1024,entries:1}),/expanded stream budget/);
});

test('closure cannot satisfy a missing pinned dependency from an ancestor or host installation',async t=>{
 const root=await workspace(t),source=join(root,'source');await mkdir(source);await writeFile(join(source,'package.json'),'{}');
 await pkg(join(source,'node_modules/app'),'app','1.0.0',"module.exports=require('host-only')",{'host-only':'1.0.0'});await pkg(join(root,'node_modules/host-only'),'host-only','1.0.0',"module.exports='host'");
 await assert.rejects(copyDependencyClosure(join(root,'out/node_modules'),['app'],createRequire(join(source,'package.json')),source),/Missing runtime dependency/);
});


test('complete unsigned packaging requires dry-run before creating any output',async t=>{
 const {packageWebServer}=await import('../../scripts/package-web-server.mjs');const root=await workspace(t),output=join(root,'package-output');
 await assert.rejects(packageWebServer({version:'1.0.0',output,completeRuntime:true}),/unsigned payloads/);await assert.rejects(stat(output),{code:'ENOENT'});
});

test('an incompatible nearer package cannot shadow the required shared dependency',async t=>{
 const root=await workspace(t),source=join(root,'source'),modules=join(source,'node_modules'),out=join(root,'out');await mkdir(source);await writeFile(join(source,'package.json'),'{}');
 await pkg(join(modules,'seed'),'seed','1.0.0',"module.exports=[require('z'),require('x')]",{z:'1.0.0',x:'1.0.0'});
 await pkg(join(modules,'seed/node_modules/z'),'z','1.0.0',"module.exports='seed-z'");
 await pkg(join(modules,'a'),'a','1.0.0',"module.exports=require('x')",{x:'2.0.0'});
 await pkg(join(modules,'a/node_modules/x'),'x','2.0.0',"module.exports=require('z')",{z:'2.0.0'});
 await pkg(join(modules,'z'),'z','2.0.0',"module.exports=require('x')",{x:'1.0.0'});
 await pkg(join(modules,'x'),'x','1.0.0',"module.exports='x1'");
 const original=await exec(process.execPath,['-e',"console.log(JSON.stringify(require('a')))"],{cwd:source});assert.equal(JSON.parse(original.stdout),'x1');
 await copyDependencyClosure(join(out,'node_modules'),['seed','a'],createRequire(join(source,'package.json')),source);
 const copied=await exec(process.execPath,['-e',"console.log(JSON.stringify(require('a')))"],{cwd:out,env:{...process.env,NODE_PATH:''}});assert.equal(JSON.parse(copied.stdout),'x1');
});

test('nested gzip cannot hide expanded tar bytes beyond the stream budget',async t=>{
 const {Header}=await import('tar');const{gzipSync}=await import('node:zlib');const root=await workspace(t),block=Buffer.alloc(512);new Header({path:'package/one',type:'File',mode:0o644,size:1}).encode(block);
 const tar=Buffer.concat([block,Buffer.from('x'),Buffer.alloc(511+1024+128*1024)]),limits={archiveBytes:1024*1024,unpackedBytes:1024,entries:1};
 const single=join(root,'single.tgz'),double=join(root,'double.tgz');await writeFile(single,gzipSync(tar));await writeFile(double,gzipSync(gzipSync(tar)));
 await assert.rejects(scanArchive(single,limits),/expanded stream budget/);await assert.rejects(scanArchive(double,limits),/Nested gzip/);
});

test('explicit roots keep their versions when earlier roots require conflicting nested versions',async t=>{
 const root=await workspace(t),source=join(root,'source'),modules=join(source,'node_modules'),out=join(root,'out');await mkdir(source);await writeFile(join(source,'package.json'),'{}');
 await pkg(join(modules,'a'),'a','1.0.0',"module.exports=require('x')",{x:'2.0.0'});await pkg(join(modules,'a/node_modules/x'),'x','2.0.0',"module.exports='x2'");await pkg(join(modules,'x'),'x','1.0.0',"module.exports='x1'");
 await copyDependencyClosure(join(out,'node_modules'),['a','x'],createRequire(join(source,'package.json')),source);
 const{stdout}=await exec(process.execPath,['-e',"console.log(JSON.stringify([require('a'),require('x')]))"],{cwd:out,env:{...process.env,NODE_PATH:''}});assert.deepEqual(JSON.parse(stdout),['x2','x1']);
});

test('bundled default dependency boundary cannot borrow a missing package from the release parent',async t=>{
 const{build}=await import('esbuild');const{fileURLToPath}=await import('node:url');const root=await workspace(t),release=join(root,'release'),runtime=join(release,'runtime'),entry=join(runtime,'prepare.mjs'),out=join(root,'out');await mkdir(runtime,{recursive:true});await writeFile(join(release,'package.json'),JSON.stringify({name:'fixed-release',version:'1.0.0',type:'module'}));
 await pkg(join(root,'node_modules/pinned'),'pinned','9.9.9',"module.exports='host-decoy'");
 const helper=fileURLToPath(new URL('../../scripts/package-mcp-app-runtime.mjs',import.meta.url));
 await build({stdin:{contents:`import{copyServerRuntime}from${JSON.stringify(helper)};console.log(JSON.stringify(await copyServerRuntime(${JSON.stringify(out)},['pinned'])));`,resolveDir:release},outfile:entry,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 await assert.rejects(exec(process.execPath,[entry],{cwd:release,env:{...process.env,NODE_PATH:''}}),/Missing runtime dependency/);
 await assert.rejects(stat(join(out,'pinned/package.json')),{code:'ENOENT'});
});

test('bundled tools resolve an explicitly selected release instead of their own or host dependencies',async t=>{
 const{build}=await import('esbuild');const{fileURLToPath}=await import('node:url');const root=await workspace(t),tool=join(root,'tool'),release=join(root,'release'),out=join(root,'out');await mkdir(join(tool,'runtime'),{recursive:true});await mkdir(release);for(const p of [tool,release])await writeFile(join(p,'package.json'),JSON.stringify({name:'fixed-runtime',version:'1.0.0',type:'module'}));
 await pkg(join(tool,'node_modules/pinned'),'pinned','9.0.0',"module.exports='tool-decoy'");await pkg(join(release,'node_modules/pinned'),'pinned','1.0.0',"module.exports='fixed-release'");
 const entry=join(tool,'runtime/prepare.mjs'),helper=fileURLToPath(new URL('../../scripts/package-mcp-app-runtime.mjs',import.meta.url));await build({stdin:{contents:`import{copyServerRuntime}from${JSON.stringify(helper)};import{createRequire}from'node:module';console.log(JSON.stringify(await copyServerRuntime(${JSON.stringify(out)},['pinned'],{installationRoot:${JSON.stringify(release)},resolver:createRequire(${JSON.stringify(join(release,'package.json'))})})));`,resolveDir:tool},outfile:entry,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const{stdout}=await exec(process.execPath,[entry],{cwd:tool,env:{...process.env,NODE_PATH:''}});assert.equal(JSON.parse(stdout).pinned,'1.0.0');assert.equal(await readFile(join(out,'pinned/index.cjs'),'utf8'),"module.exports='fixed-release'");
});
