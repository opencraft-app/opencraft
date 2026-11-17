import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
const output=process.env.OPENCRAFT_SMOKE_REPORT??'/tmp/opencraft-machine-settings-evidence';
const runtime=`
import {useSyncExternalStore} from 'react';
const listeners=new Set(),jobs=new Map(),phases=new Map();
const emit=()=>{for(const f of listeners)f();},subscribe=f=>{listeners.add(f);return()=>listeners.delete(f);};
const phase=id=>phases.get(id)??'idle';
const calls=[],requests=[];
const idleStore={subscribe:()=>()=>{},getScope:()=> 'fixture-account'};
const hosts={personalMachines:{async request(command){requests.push(['deployment-owner','opencraft/personal-machines',command.action]);return {hubId:'fixture-hub',ownerActorId:'human:fixture',enrollmentOrigin:'https://fixture.invalid',machines:[],...(command.action==='create'?{command:'echo fixture-enrollment',machineId:'fixture'}:{})};}},threadAttention:idleStore,displayContinuity:idleStore,agentRuntimes:{
 ensureReady(id){calls.push(id);phases.set(id,'connecting');emit();return new Promise((resolve,reject)=>jobs.set(id,{resolve,reject}));},
 async request(id,method){requests.push([id,method]);if(method==='opencraft/agents/onboarding/status')return {agents:[{id:id==='remote-a'?'codex':'cursor',engineId:id==='remote-a'?'codex':'cursor',installed:true,authenticated:true,account:null,activity:null,version:'fixture',installUrl:'https://example.invalid',canInstallPackage:false}]};throw new Error('Unexpected request');}
}};
export const fixture={calls,requests,disconnect(id){phases.set(id,'error');emit();},resolve(id){phases.set(id,'ready');emit();jobs.get(id).resolve({});},fail(id){phases.set(id,'error');emit();jobs.get(id).reject(new Error('Private diagnostic must not appear'));}};
export const useAppServerHosts=()=>hosts;
export const useHostConnectionPhase=id=>useSyncExternalStore(subscribe,()=>phase(id));
export const useHostExecutionState=()=> 'available';
export const useMachineConnectionPhase=ids=>useSyncExternalStore(subscribe,()=>ids.some(id=>phase(id)==='ready')?'ready':'idle');
export const useAppServerHostSnapshot=()=>({hostId:new URLSearchParams(location.search).has('enrollment')?'remote-a':'local'});
export const useComposerCatalog=()=>({models:[]});
`;
const source=`
import React,{useState} from 'react';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {HostAgentOnboarding} from '/apps/workbench-web/src/components/agent-management.tsx';
import {SettingsMachine} from '/apps/workbench-web/src/components/settings-machines.tsx';
import {DraftSetupNotice} from '/apps/workbench-web/src/components/draft-setup-notice.tsx';
import {groupWorkInMachines} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {fixture} from '/machine-runtime-probe';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const query=new QueryClient({defaultOptions:{queries:{retry:false}}});
const machine=id=>groupWorkInMachines([{hostId:id,displayName:id,machineIdentity:{machineId:id==='remote-a'?'11111111-2222-4333-8444-555555555555':'11111111-2222-4333-8444-666666666666',name:id,platform:'linux'},machinePresence:'online',agent:'OpenCraft',providerId:'opencraft.websocket',providerConfig:{url:'ws://fixture.invalid/internal-proxy'},providerConfigVersion:1,hostKind:'remote-control',enabled:true,autoConnect:false,includeInSidebar:true,credentialRef:null,transportEndpoint:null,executionLocation:null,workspaceBrowseRoots:[],revision:1}])[0];
function NoticeFixture(){const [mode,setMode]=useState('checking');const jobs={};const agent={hostId:'remote-a',hostName:'Remote machine',agentId:'codex',agentName:'Codex',modelId:'codex:current',effort:null};Object.assign(window,{noticeFixture:{setMode,resolve:()=>jobs.resolve(),fail:()=>jobs.reject(new Error('Private diagnostic')),}});return <div className='settings-page__viewport'><main className='settings-page__content'><textarea aria-label='fixture draft' defaultValue='Keep my draft'/><DraftSetupNotice kind='models' hostName='Local' readyAgents={mode==='ready'?[agent]:[]} checkingAgents={mode==='checking'} agentCheckFailed={mode==='failed'} onRetryAgents={()=>setMode('checking')} onUseAgent={choice=>{if(choice.hostId!=='remote-a'||choice.modelId!=='codex:current')throw new Error('Wrong target');return new Promise((resolve,reject)=>{jobs.resolve=resolve;jobs.reject=reject;});}} onConfigure={()=>{}} onRetry={()=>{}} onConnectionSettings={()=>{}} onConnectAgents={()=>{}} onConnectRemoteMachine={()=>{}}/></main></div>;}
function App(){const [id,setId]=useState('remote-a');if(new URLSearchParams(location.search).has('notice'))return <NoticeFixture/>;Object.assign(window,{machineFixture:{...fixture,setId,setThemePreference}});return <QueryClientProvider client={query}><div className='settings-page__viewport'><main className='settings-page__content'>{new URLSearchParams(location.search).has('enrollment')?<HostAgentOnboarding presentation='remote'/>:id?<SettingsMachine machine={machine(id)} pages={[]} platform='web' onSectionChange={()=>{}}/>:null}</main></div></QueryClientProvider>;}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<App/>);
`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},cacheDir:'node_modules/.vite-machine-settings',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'machine-settings-fixture',enforce:'pre',resolveId(id){if(id==='/machine-runtime-probe'||id.endsWith('/appserver-runtime-context'))return '/machine-runtime-probe';if(id==='/machine-settings-probe.tsx')return id;},load(id){if(id==='/machine-runtime-probe')return runtime;if(id==='/machine-settings-probe.tsx')return source;},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/machine-settings-probe.tsx"></script>');});}}]});
let browser:any;
try{await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true,...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE?{executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE}:{})});
 for(const touch of [false,true]){const context=await browser.newContext({hasTouch:touch,viewport:{width:touch?390:1100,height:900}}),page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as {port:number}).port);
 await page.getByText('连接工作台后，将显示这台机器上的 Agent。').waitFor();
 assert.deepEqual(await page.evaluate(()=>(window as any).machineFixture.calls),['remote-a']);
 await page.evaluate(()=>(window as any).machineFixture.fail('remote-a'));
 const retry=page.getByRole('button',{name:'重新连接',exact:true});await retry.waitFor();assert.ok(!(await page.locator('body').innerText()).includes('Private diagnostic'));
 if(touch)await retry.tap();else{await retry.focus();await page.keyboard.press('Enter');}
 await page.waitForFunction(()=>(window as any).machineFixture.calls.length===2);
 await page.evaluate(()=>(window as any).machineFixture.resolve('remote-a'));
 await page.getByText('Codex',{exact:true}).waitFor();await page.getByText('已连接',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'连接远程机器',exact:true}).count(),0);
 assert.ok(!(await page.locator('body').innerText()).includes('internal-proxy'));
 const nativeAgent=await page.getByText('Codex',{exact:true}).elementHandle();
 await page.evaluate(()=>(window as any).machineFixture.disconnect('remote-a'));await retry.waitFor();
 assert.equal(await nativeAgent.evaluate((node:Element)=>node.isConnected),true,'reconnection must preserve the Agent management surface');
 if(touch)await retry.tap();else await retry.click();
 await page.waitForFunction(()=>(window as any).machineFixture.calls.length===3);
 await page.evaluate(()=>(window as any).machineFixture.resolve('remote-a'));await page.getByText('已连接',{exact:true}).waitFor();
 for(const theme of ['light','dark']){await page.evaluate((v:string)=>(window as any).machineFixture.setThemePreference(v),theme);await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'.png'});}
 await page.evaluate(()=>{const f=(window as any).machineFixture;f.setId('remote-b');});
 await page.waitForFunction(()=>(window as any).machineFixture.calls.includes('remote-b'));
 await page.evaluate(()=>(window as any).machineFixture.setId('remote-a'));
 await page.waitForFunction(()=>(window as any).machineFixture.calls.length===5);
 await page.evaluate(()=>(window as any).machineFixture.fail('remote-b'));
 assert.equal(await retry.count(),0,'late failure from a previous route must not change current controls');
 await page.evaluate(()=>(window as any).machineFixture.resolve('remote-a'));await page.getByText('Codex',{exact:true}).waitFor();
 assert.ok((await page.evaluate(()=>(window as any).machineFixture.requests)).every(([id]:string[])=>id==='remote-a'));
 assert.deepEqual(errors,[]);await context.close();}
 for(const touch of [false,true]){const context=await browser.newContext({hasTouch:touch,viewport:{width:touch?390:1100,height:900}}),p=await context.newPage();await p.goto('http://127.0.0.1:'+(vite.httpServer!.address() as {port:number}).port+'/?notice');await p.getByText('正在检查已接入的 Agent…',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'配置模型',exact:true}).count(),0);await p.evaluate(()=>(window as any).noticeFixture.setMode('failed'));await p.getByText('暂时无法检查已接入的 Agent，请重试或检查机器连接。',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'配置模型',exact:true}).count(),0);const checkAgain=p.getByRole('button',{name:'重试',exact:true});if(touch)await checkAgain.tap();else await checkAgain.click();await p.getByText('正在检查已接入的 Agent…',{exact:true}).waitFor();await p.evaluate(()=>(window as any).noticeFixture.setMode('ready'));const use=p.getByRole('button',{name:'使用 Codex · Remote machine',exact:true});await use.waitFor();assert.equal(await p.getByRole('button',{name:'打开 Agent 接入',exact:true}).count(),0);if(touch)await use.tap();else{await use.focus();await p.keyboard.press('Enter');}assert.equal(await use.isDisabled(),true);await p.evaluate(()=>(window as any).noticeFixture.fail());await p.getByRole('alert').waitFor();assert.equal(await p.getByRole('textbox',{name:'fixture draft',exact:true}).inputValue(),'Keep my draft');if(touch)await use.tap();else await use.click();await p.evaluate(()=>(window as any).noticeFixture.resolve());await use.waitFor({state:'visible'});assert.equal(await p.getByRole('textbox',{name:'fixture draft',exact:true}).inputValue(),'Keep my draft');await p.screenshot({path:output+'/ready-agent-'+(touch?'touch':'desktop')+'.png'});await context.close();}
 for(const touch of [false,true]){
  const context=await browser.newContext({hasTouch:touch,viewport:{width:touch?390:1100,height:900}}),page=await context.newPage();
  await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as {port:number}).port+'/?enrollment');
  const generate=page.getByRole('button',{name:'生成 Bash 接入命令',exact:true});await generate.waitFor();
  if(touch)await generate.tap();else{await generate.focus();await page.keyboard.press('Enter');}
  await page.getByText('echo fixture-enrollment',{exact:true}).waitFor();
  const requests=await page.evaluate(()=>(window as any).machineFixture.requests);
  assert(requests.some(([id,method,action]:string[])=>id==='deployment-owner'&&method==='opencraft/personal-machines'&&action==='create'));
  assert(!requests.some(([id,method]:string[])=>id==='remote-a'&&method==='opencraft/personal-machines'),'selected remote companion never owns enrollment');
  await page.screenshot({path:output+'/enrollment-owner-'+(touch?'touch':'desktop')+'.png'});await context.close();
 }
 console.log('PASS machine settings: explicit route demand, native Agent discovery on the selected Host, error/retry, keyboard/touch, route change and late failure, light/dark. Runtime boundary simulated; screenshots: '+output);
}finally{await browser?.close();await vite.close();}
