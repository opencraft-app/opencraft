import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadUserPlugins } from '../../apps/headless-server/src/web-deployment/user-plugins.mjs';
import { createUserPluginCatalog } from '../../apps/headless-server/src/web-deployment/craft-plugins.mjs';
import { createWorkbenchWebServer as gateway } from '../../apps/headless-server/src/serve-workbench-web.mjs';
import { createWorkbenchWebServer as worker } from '../../apps/headless-server/src/workbench-web-server.mjs';

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'optional-user-plugins-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'plugins'),web=join(root,'web');await mkdir(web);await mkdir(directory);
 await writeFile(join(web,'index.html'),'<html><head><title>Core</title></head><body>Core</body></html>');
 async function plugin(id,branding) {
  const manifest={manifestVersion:1,apiVersion:1,id,name:id,version:'1.0.0',trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']};
  const code=`export default {manifest:${JSON.stringify(manifest)},activate(){}};`;
  await mkdir(join(directory,'public',id),{recursive:true});await writeFile(join(directory,'public',id,'plugin.mjs'),code);
  return {manifest,entry:id+'/plugin.mjs',sha256:createHash('sha256').update(code).digest('hex'),replaces:[],...(branding?{branding:{name:id}}:{})};
 }
 const index=plugins=>writeFile(join(directory,'plugins.json'),JSON.stringify({schemaVersion:1,plugins}));
 return {root,directory,web,plugin,index};
}
test('optional loader skips only corrupt packages and never rewrites the installation',async t=>{
 const f=await fixture(t),good=await f.plugin('join.good'),bad=await f.plugin('join.bad');await f.index([bad,good,null]);
 await writeFile(join(f.directory,'public/join.bad/plugin.mjs'),'private-error-fixture');
 const before=await readFile(join(f.directory,'plugins.json'),'utf8'),errors=[];
 const got=await loadUserPlugins(f.directory,{isolate:true,onDiagnostic:e=>errors.push(e)});
 assert.deepEqual(got,[good]);assert.equal(errors.length,2);assert.doesNotMatch(JSON.stringify(errors),/private-error-fixture|\/tmp/);
 assert.equal(await readFile(join(f.directory,'plugins.json'),'utf8'),before);
 await assert.rejects(loadUserPlugins(f.directory),/integrity/);
});
test('cold catalog survives malformed/missing/unreadable index and craft root and recovers',async t=>{
 const f=await fixture(t);await writeFile(join(f.directory,'plugins.json'),'{bad');await writeFile(join(f.directory,'crafts'),'not-a-directory');
 const catalog=await createUserPluginCatalog(f.directory,loadUserPlugins,{intervalMs:0});
 assert.deepEqual(catalog.getSnapshot().plugins,[]);assert.equal(catalog.getSnapshot().errors.length,2);
 const good=await f.plugin('join.good');await f.index([good]);assert.deepEqual((await catalog.refresh()).plugins,[good]);
 await rm(join(f.directory,'crafts'));await rm(join(f.directory,'plugins.json'));assert.deepEqual((await catalog.refresh()).plugins,[]);
 const custom=await createUserPluginCatalog(f.directory,async()=>{throw Error('SECRET_PATH')});assert.equal(custom.getSnapshot().plugins.length,0);
 assert.doesNotMatch(JSON.stringify(custom.getSnapshot()),/SECRET_PATH/);
});
test('duplicate IDs and conflicting brands do not reserve or replace healthy unrelated entries',async t=>{
 const f=await fixture(t),a=await f.plugin('join.a',true),b=await f.plugin('join.b',true),good=await f.plugin('join.good');
 await f.index([a,b,good]);assert.deepEqual(await loadUserPlugins(f.directory,{isolate:true}),[good]);
 await f.index([a,a,good]);assert.deepEqual(await loadUserPlugins(f.directory,{isolate:true}),[good]);
});
for(const [name,create]of [['gateway',gateway],['worker',worker]])test(name+': cold startup remains available with bad optional data, admission is unchanged',async t=>{
 const f=await fixture(t);await writeFile(join(f.directory,'plugins.json'),'{bad');
 const app=await create({root:f.web,userPluginDirectory:f.directory,appServerTarget:null});const a=await app.listen({host:'127.0.0.1',port:0}),url='http://127.0.0.1:'+a.port;
 try{assert.equal((await fetch(url)).status,200);const c=await(await fetch(url+'/__opencraft_plugin_catalog')).json();assert.deepEqual(c.plugins,[]);assert.equal(c.errors[0].message,'plugin_installation_unavailable');}finally{await app.close();}
 if(name==='gateway'){
 const denied=await create({root:f.web,userPluginDirectory:f.directory,appServerTarget:null,identityService:{admissionStatus:()=>403,connectionContext:()=>null,handle:async()=>false}});
 const b=await denied.listen({host:'127.0.0.1',port:0});try{assert.equal((await fetch('http://127.0.0.1:'+b.port+'/__opencraft_plugin_catalog')).status,403);}finally{await denied.close();}
 }
});
