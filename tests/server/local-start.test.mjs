import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localStartOptions,openLocalClient,startLocalService} from '../../scripts/web-deployment/local-start.mjs';
import {assertLocalServiceRuntime} from '../../scripts/web-deployment/local-service-profile.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {c} from 'tar';
import {unpackPackage} from '../../scripts/web-deployment/releases.mjs';

test('startup identity is independent of npm cache and launch cwd; flags do not silently choose a new data root',()=>{
  assert.equal(localStartOptions([],{},'/example').dataDirectory,'/example/.opencraft');
  assert.equal(localStartOptions([],{OPENCRAFT_HOME:'/existing'},'/other').dataDirectory,'/existing');
  assert.deepEqual(localStartOptions(['--data-dir','/retained','--port','0','--no-open'],{},'/example'),{dataDirectory:'/retained',port:0,open:false});
  for(const args of [['--port','bad'],['--port','-1'],['--data-dir'],['--reset'],['--port','1','--port','2']])assert.throws(()=>localStartOptions(args,{},'/example'));
});
test('client launch uses OS argument arrays without a shell and never opens a remote credential-bearing URL',async()=>{
  const calls=[],run=async(...args)=>calls.push(args);
  for(const platform of ['darwin','linux','win32'])await openLocalClient('http://127.0.0.1:10000/',platform,run);
  assert.deepEqual(calls.map(c=>c[0]),['/usr/bin/open','xdg-open','rundll32.exe']);
  assert.ok(calls.every(c=>!c[2].shell));
  await assert.rejects(openLocalClient('https://external.test/', 'darwin',run));
});
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'local-start-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const initial=join(root,'npm-cache/package'),data=join(root,'user-data'),committed=join(data,'web/releases/retained/package');
  for(const directory of [initial,committed]){await mkdir(directory,{recursive:true});await writeFile(join(directory,'package.json'),JSON.stringify({version:'1.0.0',opencraftWeb:{buildId:'first'},opencraftLocalService:{schemaVersion:1},opencraftExecution:{protocolVersion:1,profile:'daemon',platform:process.platform,arch:process.arch,nodeAbi:process.versions.modules}}));}
  return {root,initial,committed,data};
}
test('the committed release supplies execution code; web shutdown precedes Host drain and storage release',async t=>{
  const f=await fixture(t),events=[];
  const runtime={acquireLocalAgentStorageOwner:async path=>{assert.equal(path,f.data);events.push('claim');return()=>events.push('release');},
    startLocalAgentHost:async options=>{assert.equal(options.dataDirectory,f.data);assert.equal(options.runtimeDirectory,f.committed);events.push('host-start');return {websocketUrl:'ws://127.0.0.1:1234/rpc?private',close:async()=>events.push('host-close')};}};
  const service=await startLocalService({releaseRoot:f.initial,dataDirectory:f.data,env:{}},{loadRuntime:async root=>{assert.equal(root,f.committed);return runtime;},
    createWebServer:async options=>{assert.equal(options.stateDirectory,join(f.data,'web'));assert.equal(await options.appServerOwner.start({releaseRoot:f.committed}),'ws://127.0.0.1:1234/rpc?private');assert.deepEqual(options.appServerOwner.referencedRoots(),[f.committed]);return {adminKeyPath:join(f.data,'web/admin-key'),listen:async()=>({port:1235}),close:async()=>events.push('web-close')};},
    openClient:async url=>{assert.equal(url,'http://127.0.0.1:1235/');events.push('open');}});
  await Promise.all([service.close(),service.close()]);assert.deepEqual(events,['claim','host-start','open','web-close','host-close','release']);
});
test('a local update cannot install a different native platform, ABI or capability schema',()=>{
  const manifest={opencraftLocalService:{schemaVersion:1},opencraftExecution:{protocolVersion:1,profile:'daemon',platform:process.platform,arch:process.arch,nodeAbi:process.versions.modules}};
  assertLocalServiceRuntime(manifest);
  for(const target of [{...manifest.opencraftExecution,platform:'wrong'},{...manifest.opencraftExecution,nodeAbi:'0'},{...manifest.opencraftExecution,profile:'headless'}])
    assert.throws(()=>assertLocalServiceRuntime({...manifest,opencraftExecution:target}));
  assert.throws(()=>assertLocalServiceRuntime({...manifest,opencraftLocalService:{schemaVersion:2}}));
});
test('no browser is required for a terminal installation and failed startup closes the owned runtime',async t=>{
  const f=await fixture(t);let hostClosed=0,released=0;
  const runtime={acquireLocalAgentStorageOwner:async()=>()=>released++,startLocalAgentHost:async()=>({websocketUrl:'ws://127.0.0.1:1/rpc',close:async()=>hostClosed++})};
  await assert.rejects(startLocalService({releaseRoot:f.initial,dataDirectory:f.data,open:false,env:{}},{loadRuntime:async()=>runtime,
    createWebServer:async options=>{await options.appServerOwner.start({releaseRoot:f.committed});throw new Error('Web startup failed');},openClient:async()=>{throw new Error('must not open');}}),/Web startup failed/);
  assert.equal(hostClosed,1);assert.equal(released,1);
});
test('client updates and rollback cannot change the retained execution runtime on restart',async t=>{
  const f=await fixture(t),roots=[];
  const runtime={acquireLocalAgentStorageOwner:async()=>()=>{},startLocalAgentHost:async()=>({websocketUrl:'ws://127.0.0.1:1/rpc',close:async()=>{}})};
  let current=f.committed;
  const dependencies={loadRuntime:async root=>{roots.push(root);return runtime;},createWebServer:async options=>{
    await options.appServerOwner.start({releaseRoot:current});
    assert.deepEqual(options.appServerOwner.referencedRoots(),[f.committed]);
    return {adminKeyPath:'unused',listen:async()=>({port:1}),close:async()=>{}};
  }};
  const first=await startLocalService({releaseRoot:f.initial,dataDirectory:f.data,open:false,env:{}},dependencies);await first.close();
  current=join(f.data,'web/releases/new-client/package');await cp(f.committed,current,{recursive:true});
  const manifest=JSON.parse(await readFile(join(current,'package.json'),'utf8'));manifest.version='2.0.0';manifest.opencraftWeb.buildId='second';await writeFile(join(current,'package.json'),JSON.stringify(manifest));
  const second=await startLocalService({releaseRoot:f.initial,dataDirectory:f.data,open:false,env:{}},dependencies);await second.close();
  assert.deepEqual(roots,[f.committed,f.committed]);
  const pin=JSON.parse(await readFile(join(f.data,'web/local-runtime.json'),'utf8'));assert.equal(pin.version,'1.0.0');
  await writeFile(join(f.data,'web/local-runtime.json'),'broken');
  await assert.rejects(startLocalService({releaseRoot:f.initial,dataDirectory:f.data,open:false,env:{}},dependencies),/pin is unreadable/);
  assert.equal(await readFile(join(f.data,'web/local-runtime.json'),'utf8'),'broken','never reset unreadable authority');
});
test('the npx dispatcher retains admitted execution CLI commands instead of starting another service',async t=>{
  const root=await mkdtemp(join(tmpdir(),'local-cli-dispatch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(new URL('../../scripts/web-deployment/start-cli.mjs',import.meta.url),join(root,'start-cli.mjs'));
  await writeFile(join(root,'opencraft-cli.mjs'),'export async function main(argv){console.log(JSON.stringify(argv));}');
  for(const args of [[],['context'],['thread','list']]) {
    const {stdout}=await promisify(execFile)(process.execPath,[join(root,'start-cli.mjs'),...args],{env:{...process.env,OPENCRAFT_THREAD_CLI_CONNECTION:'fixture'}});
    assert.deepEqual(JSON.parse(stdout),args);
  }
});
test('a complete-runtime entry budget remains bounded instead of disabling archive validation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'local-archive-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'package'));await writeFile(join(root,'package/a'),'a');await writeFile(join(root,'package/b'),'b');
  const archive=join(root,'fixture.tgz');await c({cwd:root,file:archive,gzip:true},['package/a','package/b']);
  await assert.rejects(unpackPackage(archive,join(root,'rejected'),null,1),/Unsafe Web archive contents/);
  const accepted=await unpackPackage(archive,join(root,'accepted'),null,4);assert.equal(await readFile(join(accepted,'b'),'utf8'),'b');
});
