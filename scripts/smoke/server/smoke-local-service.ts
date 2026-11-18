import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {constants} from 'node:fs';
import {createReadStream} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,cp,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {chromium} from 'playwright';
import {AcpEngine} from '../../../plugins/acp-engine/src/index.js';

const archive=process.argv[2];if(!archive)throw new Error('Give the complete local-service archive');
const output=await mkdtemp(join(tmpdir(),'opencraft-local-service-proof-'));
console.log(JSON.stringify({phase:'preparing-candidates',output}));
const data=join(output,'data'),native=join(data,'native-codex');await mkdir(join(native,'sessions'),{recursive:true});
const seed=new AcpEngine({id:'codex',command:process.execPath,args:[resolve('tests/fixtures/acp-engine-peer.mjs')],cwd:output,
  dataDirectory:join(data,'connected-agents/codex'),env:{ACP_TEST_PERMISSIONS:'1',ACP_TEST_MODELS:'1',ACP_TEST_NATIVE_ID:randomUUID()}});
const client={notify(){},async request(){throw new Error('No tools in preservation fixture');}};
const {thread}=await seed.request('thread/start',{model:'codex:default-native'},client);
await seed.request('thread/name/set',{threadId:thread.id,name:'Preserved conversation'},client);
await seed.close();
const record=JSON.parse(await readFile(join(data,'connected-agents/codex',thread.id+'.json'),'utf8'));
const history=join(native,'sessions',`rollout-test-${record.nativeId}.jsonl`);
const time=new Date().toISOString(),event=(payload:unknown)=>JSON.stringify({type:'event_msg',timestamp:time,payload})+'\n';
await writeFile(history,JSON.stringify({type:'session_meta',payload:{id:record.nativeId,cwd:output}})+'\n'
  +event({type:'task_started',turn_id:'preserved-turn'})
  +event({type:'item_completed',turn_id:'preserved-turn',item:{type:'UserMessage',id:'preserved-user',content:[{type:'text',text:'Preserve history',text_elements:[]}]}})
  +event({type:'item_completed',turn_id:'preserved-turn',item:{type:'AgentMessage',id:'preserved-answer',content:[{type:'Text',text:'History survived'}],phase:'final_answer'}})
  +event({type:'task_complete',turn_id:'preserved-turn'}));
await writeFile(join(native,'config.toml'),'model = "synthetic-preserved-model"\n');
const hash=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const before={history:await hash(history),config:await hash(join(native,'config.toml'))};
const releases=new Map<string,any>(),archives=new Map<string,string>();let selected='0.1.18-local.2',lookups=0;
const registry=createServer(async(req,res)=>{
  const path=decodeURIComponent(new URL(req.url!,'http://fixture').pathname);
  if(archives.has(path)){res.end(await readFile(archives.get(path)!));return;}
  if(path==='/@opencraft-app/opencraft'){lookups++;res.setHeader('content-type','application/json');res.end(JSON.stringify({name:'@opencraft-app/opencraft','dist-tags':{'local-proof':selected},versions:Object.fromEntries(releases)}));return;}
  res.writeHead(404).end();
});
await new Promise<void>(r=>registry.listen(0,'127.0.0.1',r));const registryUrl=`http://127.0.0.1:${(registry.address() as any).port}`;
const npm=process.platform==='win32'?'npm.cmd':'npm';
const unpacked=join(output,'seed');await mkdir(unpacked);
await promisify(execFile)('tar',['-xzf',resolve(archive),'-C',unpacked]);
const packageRoot=join(unpacked,'package');
const initial=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
assert.equal(initial.opencraftLocalService?.schemaVersion,1);
const nodeRuntime = {
  version: process.version,
  abi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
};
assert.equal(initial.opencraftExecution?.nodeAbi, nodeRuntime.abi);
assert.equal(initial.opencraftExecution.platform, nodeRuntime.platform);
assert.equal(initial.opencraftExecution.arch, nodeRuntime.arch);
// Produce exact controlled candidates from the already packaged runtime.
for(const version of ['0.1.18-local.2','0.1.18-local.3','0.1.18-local.4']) {
  if(process.env.OPENCRAFT_LOCAL_SMOKE_CANDIDATES) {
    const saved=join(process.env.OPENCRAFT_LOCAL_SMOKE_CANDIDATES,version),root=join(saved,'package');
    const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    assert.equal(manifest.version,version);assert.deepEqual(manifest.opencraftLocalService,initial.opencraftLocalService);
    assert.equal((await readFile(join(root,'web/index.html'),'utf8')).replaceAll(manifest.opencraftWeb.buildId,initial.opencraftWeb.buildId),await readFile(join(packageRoot,'web/index.html'),'utf8'),'reused candidates must contain the same client build');
    const file=join(saved,`opencraft-app-opencraft-${version}.tgz`),digest=createHash('sha512');
    for await(const chunk of createReadStream(file))digest.update(chunk);
    manifest.dist={tarball:registryUrl+'/'+version+'.tgz',integrity:'sha512-'+digest.digest('base64')};
    releases.set(version,manifest);archives.set('/'+version+'.tgz',file);continue;
  }
  const directory=join(output,version),root=join(directory,'package');
  await mkdir(directory,{recursive:true});
  if(process.platform==='darwin')await promisify(execFile)('/bin/cp',['-cR',packageRoot,root]);
  else await cp(packageRoot,root,{recursive:true,mode:constants.COPYFILE_FICLONE});
  const manifest={...initial,version,opencraftWeb:{...initial.opencraftWeb,buildId:'proof-'+version}};
  await writeFile(join(root,'package.json'),JSON.stringify(manifest));
  const metadata=JSON.parse(await readFile(join(root,'web/version.json'),'utf8'));metadata.buildId=manifest.opencraftWeb.buildId;
  await writeFile(join(root,'web/version.json'),JSON.stringify(metadata));
  await writeFile(join(root,'web/index.html'),(await readFile(join(root,'web/index.html'),'utf8')).replaceAll(initial.opencraftWeb.buildId,manifest.opencraftWeb.buildId));
  if(version.endsWith('.4'))await writeFile(join(root,'runtime/worker.mjs'),'process.exit(1);\n');
  const {stdout}=await promisify(execFile)(npm,['pack','--ignore-scripts','--json','--pack-destination',directory],{cwd:root,maxBuffer:16*1024*1024});
  const packed=JSON.parse(stdout)[0];manifest.dist={tarball:registryUrl+'/'+version+'.tgz',integrity:packed.integrity};
  releases.set(version,manifest);archives.set('/'+version+'.tgz',join(directory,packed.filename));
}
const npmConfig=join(output,'fixture.npmrc');await writeFile(npmConfig,'fetch-retries=0\nfetch-timeout=5000\n');
const env={...process.env,NPM_CONFIG_USERCONFIG:npmConfig,OPENCRAFT_NPM_USERCONFIG:npmConfig,npm_config_offline:'false',NPM_CONFIG_OFFLINE:'false',OPENCRAFT_HOME:data,CODEX_HOME:native,CURSOR_CONFIG_DIR:join(output,'cursor'),CLAUDE_CONFIG_DIR:join(output,'claude'),
  CODEBUDDY_CONFIG_DIR:join(output,'codebuddy'),PI_CODING_AGENT_DIR:join(output,'pi'),OPENCRAFT_NPM_REGISTRY:registryUrl,
  OPENCRAFT_UPDATE_CHANNEL:'local-proof',OPENCRAFT_UPDATE_CHECK_INTERVAL_MS:'5000'};
let child:ReturnType<typeof spawn>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
async function launch() {
  // npm exec is the npx entry, installed from the actual archive into an isolated cache.
  const proc=spawn(npm,['exec','--yes','--registry',registryUrl,'--cache',join(output,'npm-cache'),'--package='+resolve(archive),'--','opencraft','start','--data-dir',data,'--port','0','--no-open'],{env,stdio:['ignore','pipe','pipe']});child=proc;
  let logs='';proc.stdout!.on('data',x=>logs+=x);proc.stderr!.on('data',x=>logs+=x);
  const end=Date.now()+300000;
  while(!/\[opencraft\] Client: (http:\/\/127\.0\.0\.1:\d+\/)/u.test(logs)) {
    if(proc.exitCode!==null||Date.now()>end){await writeFile(join(output,'startup.log'),logs);throw new Error('Packaged service did not start; see private smoke output');}await delay(50);
  }
  const url=/\[opencraft\] Client: (http:\/\/127\.0\.0\.1:\d+\/)/u.exec(logs)![1];
  return {proc,url};
}
async function stop() {
  if(!child||child.exitCode!==null)return;
  // Signal the actual service owner, not npm's signal relay.
  const owner=JSON.parse(await readFile(join(data,'.daemon-storage-owner.json'),'utf8'));
  process.kill(owner.pid,'SIGTERM');
  const result=await Promise.race([once(child,'exit'),delay(30000).then(()=>{throw new Error('Local service shutdown timed out');})]);
  assert.equal(result[0],0,'shutdown drains before npm exits');
  await assert.rejects(access(join(data,'.daemon-storage-owner.json')));
}
async function rpc(url:string,method:string,params:any={}) {
  const ws=new WebSocket(url.replace(/^http/u,'ws')+'appserver');await once(ws,'open');
  let id=1;
  const call=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const key=id++;const timer=setTimeout(()=>reject(new Error('RPC observation timed out')),30000);
    const listener=(raw:any)=>{const frame=JSON.parse(String(raw));if(frame.id!==key)return;ws.off('message',listener);clearTimeout(timer);frame.error?reject(new Error('RPC rejected observation')):resolve(frame.result);};
    ws.on('message',listener);ws.send(JSON.stringify({jsonrpc:'2.0',id:key,method,params}));});
  try{await call('initialize',{});ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));return await call(method,params);}finally{ws.close();}
}
async function waitFor<T>(read:()=>Promise<T>,accept:(v:T)=>boolean){const end=Date.now()+90000;for(;;){const v=await read();if(accept(v))return v;if(Date.now()>end)throw new Error('Service observation timed out: '+JSON.stringify(v));await delay(100);}}
try {
  console.log(JSON.stringify({phase:'npx-install-and-start'}));
  let live=await launch();const status=async()=>(await fetch(live.url+'__opencraft_updates')).json();
  await waitFor(status,s=>s.latest?.version===selected&&!s.checking);
  assert.ok(lookups>=1,'a closed client is not required for registry discovery');
  const ownerBefore=JSON.parse(await readFile(join(data,'.daemon-storage-owner.json'),'utf8')).pid;
  const seeded=await rpc(live.url,'thread/list',{limit:100});assert.ok(seeded.data.some((t:any)=>t.id===thread.id));
  console.log(JSON.stringify({phase:'checking-persisted-history'}));
  const logBefore=await rpc(live.url,'thread/turns/list',{threadId:thread.id,limit:10,itemsView:'full',sortDirection:'asc'});
  assert.ok(JSON.stringify(logBefore).includes('History survived'));
  const space=await rpc(live.url,'opencraft/server-spaces',{action:'create',name:'Preserved Server'});
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage({locale:'zh-CN',viewport:{width:1280,height:900}});
  await page.addInitScript(()=>localStorage.setItem('opencraft.onboarding.completedAt',new Date().toISOString()));
  await page.goto(live.url+'settings/updates');await page.getByText('自动检查更新',{exact:true}).waitFor({timeout:60000});
  const key=(await readFile(join(data,'web/admin-key'),'utf8')).trim();
  await page.getByLabel('部署管理员密钥',{exact:true}).fill(key);
  await page.getByRole('button',{name:'授权管理',exact:true}).click();
  const update=page.getByRole('button',{name:'更新网站',exact:true});await update.waitFor();
  assert.equal((await status()).fullUpgrade,false);
  assert.equal(await page.getByRole('button',{name:'升级全部组件',exact:true}).count(),0);
  await page.screenshot({path:join(output,'updates-before.png')});
  const updateResponse=page.waitForResponse(r=>r.url().endsWith('/__opencraft_updates/install')&&r.request().method()==='POST');
  await update.click();assert.equal((await updateResponse).status(),202);await waitFor(status,s=>s.job?.phase==='completed'&&s.current.version===selected);
  console.log(JSON.stringify({phase:'first-update-completed'}));
  const firstState=JSON.parse(await readFile(join(data,'web/deployment.json'),'utf8'));
  const activeOwnerRoot=firstState.previous.releaseRoot;
  let cookie='';
  const login=await fetch(live.url+'__opencraft_updates/login',{method:'POST',headers:{origin:live.url.slice(0,-1),'content-type':'application/json'},body:JSON.stringify({key})});
  cookie=login.headers.get('set-cookie')!.split(';')[0];
  const action=async(name:string,body:any={})=>{const response=await fetch(live.url+'__opencraft_updates/'+name,{method:'POST',headers:{origin:live.url.slice(0,-1),cookie,'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${name}: ${response.status}`);};
  selected='0.1.18-local.3';await waitFor(status,s=>s.latest?.version===selected&&!s.checking);
  await action('install',{version:selected});await waitFor(status,s=>s.job?.phase==='completed'&&s.current.version===selected);
  await access(activeOwnerRoot);assert.equal(JSON.parse(await readFile(join(data,'.daemon-storage-owner.json'),'utf8')).pid,ownerBefore,'website upgrades do not replace the Agent owner');
  await action('rollback');await waitFor(status,s=>s.job?.phase==='completed'&&s.current.version==='0.1.18-local.2');
  selected='0.1.18-local.4';await waitFor(status,s=>s.latest?.version===selected&&!s.checking);
  await action('install',{version:selected});await waitFor(status,s=>s.job?.phase==='failed');assert.equal((await status()).current.version,'0.1.18-local.2');
  const preserved=async()=>{
    assert.equal(await hash(history),before.history);assert.equal(await hash(join(native,'config.toml')),before.config);
    const directory=await rpc(live.url,'opencraft/server-spaces',{action:'list'});assert.ok(directory.spaces.some((s:any)=>s.id===space.spaceId));
    const logs=await rpc(live.url,'thread/turns/list',{threadId:thread.id,limit:10,itemsView:'full',sortDirection:'asc'});assert.ok(JSON.stringify(logs).includes('History survived'));
    const saved=JSON.parse(await readFile(join(data,'connected-agents/codex',thread.id+'.json'),'utf8'));assert.equal(saved.model,record.model);assert.equal(saved.nativeId,record.nativeId);
  };
  await preserved();await page.reload();await page.getByText('自动检查更新',{exact:true}).waitFor();await page.screenshot({path:join(output,'updates-after-failed-candidate.png')});
  const touch=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const touchPage=await touch.newPage();await touchPage.addInitScript(()=>localStorage.setItem('opencraft.onboarding.completedAt',new Date().toISOString()));
  await touchPage.goto(live.url+'settings/updates');await touchPage.getByText('自动检查更新',{exact:true}).waitFor({timeout:60000});
  await touchPage.getByRole('button',{name:'检查更新',exact:true}).tap();
  await touchPage.screenshot({path:join(output,'updates-touch.png')});await touch.close();
  await browser.close();browser=undefined;await stop();
  live=await launch();assert.equal((await status()).current.version,'0.1.18-local.2');await preserved();await stop();
  await writeFile(join(output,'receipt.json'),JSON.stringify({nodeRuntime,npxInstalledActualArchive:true,automaticChecksWithoutPage:true,realWorkbenchUpdateClick:true,
    twoUpdates:true,activeOwnerRootRetained:true,rollback:true,failedCandidatePreserved:true,restartPreserved:true,
    connectedAgentConfigPreserved:true,nativeHistoryPreserved:true,serverSpacePreserved:true,realModelPrompts:0,boundary:'Real packaged Local Agent Host/DSH/Web; controlled npm registry and synthetic Codex transcript. Browser opener tested through its OS port.'},null,2));
  console.log(JSON.stringify({passed:true,output}));
} finally {await browser?.close();await stop().catch(()=>{});registry.closeAllConnections();await new Promise<void>(r=>registry.close(()=>r()));}
