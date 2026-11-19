import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {buildSupportReviewPackage} from '../plugins/support-review/build.mjs';
import {installRuntimePlugin,inspectRuntimePlugins} from '../runtime-plugins/store.mjs';
import {loadRuntimePlugins} from '../runtime-plugins/host.mjs';
const route='/__opencraft_enterprise_identity/support-reviews';
test('review code loads from persistent data, not its build output; state survives package host restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-data-package-'));
 const output=join(root,'package'),store=join(root,'store'),workerRoot=join(root,'business-data'),socketPath=join(root,'owner.sock'),tokenFile=join(root,'token');
 let hands:any,gateway:any;
 try {
  await mkdir(workerRoot);await writeFile(tokenFile,'package-fixture-token-'.repeat(4),{mode:0o600});
  await writeFile(join(workerRoot,'support-review.py'),'import sys,json,os\nr=json.load(sys.stdin)\np=os.path.join(os.environ["LIGHTVELA_SUPPORT_ROOT"],"fixture-state")\nn=int(open(p).read()) if os.path.exists(p) else 0\nif r["action"]=="assign":\n n+=1\n open(p,"w").write(str(n))\nprint(json.dumps({"ok":True,"result":{"actor":r["actor"],"n":n}}))\n');
  const gatewayFile=join(root,'gateway.json'),handsFile=join(root,'hands.json');
  await writeFile(gatewayFile,JSON.stringify({version:1,socketPath,tokenFile}),{mode:0o600});
  await writeFile(handsFile,JSON.stringify({version:1,socketPath,tokenFile,workerRoot,pythonExecutable:'/usr/bin/python3'}),{mode:0o600});
  const manifest=await buildSupportReviewPackage(output,'a'.repeat(40));assert.equal(manifest.id,'join.support-review');
  await installRuntimePlugin(output,store,{enable:true,configuration:{gateway:{configFile:gatewayFile},execution:{configFile:handsFile}}});
  await rm(output,{recursive:true});assert.equal((await inspectRuntimePlugins(store)).selected.length,1);
  const authority={authenticate:()=>({provider:'tencentoa',subject:'123',displayName:'reviewer',attributes:{loginName:'verified-reviewer'},expiresAt:Date.now()+60_000}),admissionStatus:()=>204};
  for(let restart=0;restart<2;restart++) {
   hands=await loadRuntimePlugins({directory:store,role:'execution'});gateway=await loadRuntimePlugins({directory:store,role:'gateway',authority});
   const server=createServer((req,res)=>{if(!gateway.handle(req,res)){res.statusCode=404;res.end();}});
   await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
   try {
    const origin=`http://127.0.0.1:${address.port}${route}`;
    const response=restart===0?await fetch(origin,{method:'POST',headers:{'X-LightVela-Review':'1'},body:JSON.stringify({action:'assign',actor:'attacker'})}):await fetch(origin);
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{actor:'verified-reviewer',n:1});
    if(restart===0){
      const nextOutput=join(root,'next-package');await buildSupportReviewPackage(nextOutput,'b'.repeat(40));
      await installRuntimePlugin(nextOutput,store,{enable:true});
      const mismatched=await loadRuntimePlugins({directory:store,role:'gateway',authority});
      const other=createServer((req,res)=>{mismatched.handle(req,res);});
      await new Promise<void>(resolve=>other.listen(0,'127.0.0.1',resolve));const at=other.address();assert(at&&typeof at==='object');
      try{const rejected=await fetch(`http://127.0.0.1:${at.port}${route}`,{method:'POST',headers:{'X-LightVela-Review':'1'},body:JSON.stringify({action:'assign'})});assert.equal(rejected.status,503);assert.equal(await readFile(join(workerRoot,'fixture-state'),'utf8'),'1');}
      finally{other.closeAllConnections();await new Promise<void>(resolve=>other.close(()=>resolve()));await mismatched.close();}
    }
   }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await gateway.close();await hands.close();gateway=hands=null;}
  }
  assert.equal(await readFile(join(workerRoot,'fixture-state'),'utf8'),'1');
 }finally{await gateway?.close();await hands?.close();await rm(root,{recursive:true,force:true});}
});
