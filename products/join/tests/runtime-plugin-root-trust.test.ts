import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,chown} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,installRuntimePlugin} from '../runtime-plugins/store.mjs';
import {loadRuntimePlugins} from '../runtime-plugins/host.mjs';
test('root Hands rejects a catalogue writable by the unprivileged Gateway owner',{skip:process.getuid?.()!==0},async()=>{
 const root=await mkdtemp(join(tmpdir(),'runtime-plugin-root-trust-'));const output=join(root,'package'),store=join(root,'store');
 try {
  await mkdir(output);const code='export async function activate(){return {close(){}};}';await writeFile(join(output,'entry.mjs'),code);
  await writeFile(join(output,'manifest.json'),JSON.stringify({schemaVersion:1,id:'fixture.root',version:'1.0.0',hostApi:1,nodeMajor:26,sourceRevision:'a'.repeat(40),roles:{hands:{entry:'entry.mjs'}},files:[{path:'entry.mjs',size:Buffer.byteLength(code),sha256:hash(code)}]}));
  await installRuntimePlugin(output,store,{enable:true,gid:990});let host=await loadRuntimePlugins({directory:store,role:'hands'});await host.close();
  await chown(join(store,'installed.json'),994,990);host=await loadRuntimePlugins({directory:store,role:'hands'});assert.equal(host.selected.length,0);assert.equal(host.skipped[0].reason,'catalogue_unavailable');await host.close();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('UID994 Gateway can load the same root-owned immutable package through its read-only group',{skip:process.getuid?.()!==0},async()=>{
 const {chmod}=await import('node:fs/promises'),{spawn}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'runtime-plugin-shared-group-'));await chmod(root,0o711);
 const output=join(root,'package'),store=join(root,'store');
 try {
  await mkdir(output);const code='export async function activate(context){if(context.role==="gateway")console.log(JSON.stringify({uid:process.getuid(),role:context.role}));return {handle(){},close(){}};}';await writeFile(join(output,'entry.mjs'),code);
  await writeFile(join(output,'manifest.json'),JSON.stringify({schemaVersion:1,id:'fixture.shared',version:'1.0.0',hostApi:1,nodeMajor:26,sourceRevision:'a'.repeat(40),roles:{gateway:{entry:'entry.mjs',routes:[{path:'/__fixture_shared',methods:['GET']}]},hands:{entry:'entry.mjs'}},files:[{path:'entry.mjs',size:Buffer.byteLength(code),sha256:hash(code)}]}));
  await installRuntimePlugin(output,store,{enable:true,gid:990});const hands=await loadRuntimePlugins({directory:store,role:'hands'});await hands.close();
  const child=spawn(process.execPath,['--input-type=module','-e',`import {loadRuntimePlugins} from ${JSON.stringify(new URL('../runtime-plugins/host.mjs',import.meta.url).href)};const host=await loadRuntimePlugins({directory:${JSON.stringify(store)},role:'gateway',authority:{authenticate:()=>null,admissionStatus:()=>403}});await host.close();`],{uid:994,gid:990,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});const timer=setTimeout(()=>child.kill('SIGKILL'),10_000);
  const codeResult=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});clearTimeout(timer);
  assert.equal(codeResult,0,err);assert.deepEqual(JSON.parse(out),{uid:994,role:'gateway'});
 }finally{await rm(root,{recursive:true,force:true});}
});
