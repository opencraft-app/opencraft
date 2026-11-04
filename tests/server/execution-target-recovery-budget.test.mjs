import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createExecutionDeployment} from '../../scripts/server-deployment/execution.mjs';

// Real adapter, filesystem pointer and HTTP readiness; only elapsed wall time is
// accelerated. Native preflight has a synthetic terminal, unrelated to timing.
const scenarios = ['ordinary', 'slow-recovery', 'expired-recovery', 'probe-and-restart', 'expired-probe', 'late-success'];
for (const {scenario,kind} of scenarios.flatMap(scenario => scenario==='ordinary' ? [{scenario,kind:'ordinary'}] : ['recovery','initial'].map(kind=>({scenario,kind})))) {
  test(`execution readiness budget: ${kind}/${scenario}`, async t => {
    const root=await mkdtemp(join(tmpdir(),'target-budget-')), target=join(root,'target'), link=join(root,'current');
    let core,health,starts=0,observations=0,clock=0,readyAfterExpiry=false;
    t.after(async()=>{for(const s of [core,health]) if(s){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(root,{recursive:true,force:true});});
    await mkdir(join(target,'execution/native/node-pty/lib'),{recursive:true});
    await writeFile(join(target,'package.json'),JSON.stringify({version:'2.0.0',opencraftWeb:{buildId:'two'},opencraftExecution:{protocolVersion:1,profile:'daemon',platform:process.platform,arch:process.arch,nodeAbi:process.versions.modules}}));
    for(const f of ['gateway.mjs','daemon.cjs','dsh-capability-plugin.mjs']) await writeFile(join(target,'execution',f),'// fixture');
    await writeFile(join(target,'execution/native/node-pty/lib/index.js'),"exports.spawn=()=>({onData:f=>f('opencraft-native-ok'),onExit:f=>setImmediate(()=>f({exitCode:0}))});");
    const tokenPath=join(root,'token');await writeFile(tokenPath,'synthetic');
    core=createServer((q,r)=>r.end(JSON.stringify({protocolVersion:1,pid:11,codexPid:12})));
    const endpoint=join(root,'core.sock');await new Promise(r=>core.listen(endpoint,r));
    health=createServer((q,r)=>{
      observations++;
      clock+=readyAfterExpiry?10_000:['expired-recovery','expired-probe','late-success'].includes(scenario)?1_800_000:scenario==='probe-and-restart'?600_000:10_000;
      const ok=readyAfterExpiry||scenario==='late-success'||scenario==='slow-recovery'&&clock>=40_000;
      r.writeHead(ok?200:503);r.end(JSON.stringify({ok,version:'2.0.0',buildId:'two',core:{pid:11,codexPid:12}}));
    });
    await new Promise(r=>health.listen(0,'127.0.0.1',r));
    if(['probe-and-restart','expired-probe'].includes(scenario)) await symlink(target,link);
    t.mock.method(Date,'now',()=>clock);
    const execution=createExecutionDeployment({link,unit:'execution.service',coreUnit:'core.service',coreEndpoint:endpoint,tokenPath,
      healthUrl:'http://127.0.0.1:'+health.address().port+'/health',validate:async()=>{},prepareAccess:async()=>{},restart:async()=>{starts++;},runtimeProcess:async()=>({pid:123,bootId:'boot',startTicks:'1'})});
    const release={releaseRoot:target,version:'2.0.0',buildId:'two',fullRelease:{authorization:'verified-installation',manifestSha256:'a'.repeat(64),releaseSequence:7}};
    const initial={schemaVersion:1,reason:'root-owned-exact-target',jobId:'accepted-job',target:{version:'2.0.0',buildId:'two',manifestSha256:'a'.repeat(64),releaseSequence:7},policySha256:'b'.repeat(64),selectedAt:0,deadlineAt:1_800_000};
    const options=kind==='ordinary'?undefined:kind==='initial'?{initialReadiness:initial}:{recoverTarget:true};
    const operation=execution.apply(release,options);
    if(scenario==='slow-recovery'){await operation;assert.equal(clock,40_000);assert.equal(observations,4);}
    else {await assert.rejects(operation,{code:'EXECUTION_READINESS_FAILED'});assert.equal(clock,scenario==='ordinary'?30_000:1_800_000);}
    assert.equal(starts,scenario==='expired-probe'?0:1,'one activation cannot loop restarts or renew its long budget');
    if(kind==='initial'&&['expired-recovery','expired-probe','late-success'].includes(scenario)) {
      const before=starts;
      await assert.rejects(execution.apply(release,options),{code:'EXECUTION_READINESS_FAILED'});
      assert.equal(starts,before,'reentry cannot renew or restart an exhausted original attempt');
      readyAfterExpiry=true;
      await execution.apply(release,{recoverTarget:true});
      assert.equal(clock,1_810_000,'an explicit later recovery gets its existing independent bounded attempt');
    }
  });
}
