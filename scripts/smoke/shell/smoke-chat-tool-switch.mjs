import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {WebSocketServer} from 'ws';
import {_electron} from 'playwright-core';
// A Web-only checkout can use an independently provisioned server fixture.
const backendRoot=process.env.OPENCRAFT_SWITCH_BACKEND_ROOT??resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const {startHeadlessServer}=await import(pathToFileURL(join(backendRoot,'apps/headless-server/src/headless-server.mjs')));
const {startHandsTerminal}=await import(pathToFileURL(join(backendRoot,'scripts/container-deployment/terminal.mjs')));
const {deploymentPaths}=await import(pathToFileURL(join(backendRoot,'scripts/container-deployment/paths.mjs')));
const directory=process.env.OPENCRAFT_SMOKE_OUTPUT??join(tmpdir(),'opencraft-tool-switch');await mkdir(directory,{recursive:true});if(!process.env.OPENCRAFT_SWITCH_WEB_ROOT||!process.env.OPENCRAFT_ELECTRON_EXECUTABLE)throw Error('Set OPENCRAFT_SWITCH_WEB_ROOT to a built Web package and OPENCRAFT_ELECTRON_EXECUTABLE to an Electron executable');
const root=await mkdtemp(join(tmpdir(),'opencraft-history-app-'));const browserMode=process.argv.includes('--browser');let site;if(browserMode){process.env.OPENCRAFT_BROWSER_ALLOW_NO_SANDBOX='1';await mkdir(join(root,'runtime'),{recursive:true});await symlink(process.env.OPENCRAFT_BROWSER_RUNTIME_DIR??(()=>{throw Error('Set OPENCRAFT_BROWSER_RUNTIME_DIR for --browser');})(),join(root,'runtime/browser'),'dir');const{createServer}=await import('node:http');site=createServer((request,response)=>{response.setHeader('content-type','text/html');response.end('<!doctype html><meta name=viewport content=width=device-width,initial-scale=1><title>Browser switch fixture</title><h1>Browser switch fixture</h1><input aria-label=Draft value=kept>');});await new Promise(r=>site.listen(0,'127.0.0.1',r));}
const paths=deploymentPaths({OPENCRAFT_DATA_DIR:join(root,'state'),OPENCRAFT_WORKSPACE_DIR:join(root,'work')});
await mkdir(paths.runtimeDirectory,{recursive:true});
const stop=await startHandsTerminal(paths);
const turns=Array.from({length:120},(_,i)=>({id:'native-turn-'+i,status:'completed',error:null,items:[
 {id:'user-'+i,type:'userMessage',content:[{type:'text',text:'History question '+i}]},
 {id:'answer-'+i,type:'agentMessage',text:'History answer '+i+'\n\n'+('A complete conversation remains readable. '.repeat(5)),phase:'final_answer'},
]}));
const thread={id:'history-acceptance',name:'History acceptance',preview:'History acceptance',cwd:paths.runtimeDirectory,
 createdAt:Math.floor(Date.now()/1000),updatedAt:Math.floor(Date.now()/1000),source:'cli',modelProvider:'fixture',path:null,turns};
const nativeMethods=[];
class Engine {
 status={state:'idle'};listeners=new Set();
 async connect(){this.status={state:'open'};}async close(){this.status={state:'closed'};}
 subscribeStatus(){return()=>{};}subscribeMessage(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
 async send(frame){const value=JSON.parse(frame);if(value.id==null)return;nativeMethods.push(value.method);let result={data:[],nextCursor:null,providers:[],models:[],settings:[]};
  if(value.method==='initialize')result={serverInfo:{name:'History fixture',version:'1'},capabilities:{}};
  if(value.method==='thread/list')result={data:[{...thread,turns:[]}],nextCursor:null};
  if(['thread/read','thread/resume'].includes(value.method))result={thread,model:'fixture',modelProvider:'fixture',cwd:paths.runtimeDirectory,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};
  if(value.method==='thread/turns/list')result={data:turns,nextCursor:null};
  if(value.method.includes('/items/list'))result={data:turns.find(t=>t.id===value.params?.turnId)?.items??[],nextCursor:null};
  if(value.method==='project/list')result={data:[{id:'history-project',name:'History fixture',roots:[{id:'root',path:paths.runtimeDirectory}],metadata:{}}],nextCursor:null};
  if(value.method==='config/read')result={config:{cwd:paths.runtimeDirectory},origins:{}};
  for(const listener of this.listeners)listener(JSON.stringify({jsonrpc:'2.0',id:value.id,result,__opencraftClient:value.__opencraftClient}));
 }
}
const agent=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(resolve=>agent.once('listening',resolve));
agent.on('connection',socket=>{const engine=new Engine();engine.subscribeMessage(frame=>socket.readyState===1&&socket.send(frame));socket.on('message',raw=>engine.send(raw.toString()));});
const principal={provider:'history-fixture',subject:'acceptance-user',displayName:'History tester',expiresAt:Date.now()+600000};
const app=await startHeadlessServer({root,webRoot:process.env.OPENCRAFT_SWITCH_WEB_ROOT ?? join(directory,'overlay/web'),dataDirectory:join(root,'gateway'),runtimeDirectory:paths.runtimeDirectory,port:0,
 accessMemberProviders:[principal.provider],terminalOwner:{directory:paths.terminalDirectory,endpoint:paths.terminalEndpoint,tokenFile:paths.terminalToken},
 createCodexTransport:()=>new Engine(),startAgentHost:async()=>({websocketUrl:'ws://127.0.0.1:'+agent.address().port+'/rpc',close(){}})},
 {createIdentity:async()=>({providers:[{authenticate:request=>request.headers['x-fixture-proof']==='verified'?principal:null}],close(){}})});
let browser;
try {
 const script=join(root,'app.cjs');await writeFile(script,"const{app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(()=>new BrowserWindow({show:true,width:1280,height:900,webPreferences:{sandbox:true}}).loadURL('about:blank'));");
 const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','DISPLAY','WAYLAND_DISPLAY'])delete env[key];
 browser=await _electron.launch({executablePath:process.env.OPENCRAFT_ELECTRON_EXECUTABLE,args:['--ozone-platform=headless','--ozone-override-screen-size=1920,1080','--disable-gpu','--disable-dev-shm-usage',script],env});
 const page=await browser.firstWindow();page.setDefaultTimeout(20000);
 const touch=!process.argv.includes('--pointer'), viewport=touch?{width:390,height:844}:{width:1280,height:900};
 await page.setViewportSize({width:1280,height:900});const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false,maxTouchPoints:1});
 await page.context().setExtraHTTPHeaders({'x-fixture-proof':'verified'});await page.goto(app.url+'/local/history-acceptance?hostId=local-codex');
 await page.getByText('History answer 119',{exact:false}).waitFor();
 await page.locator('.opencraft-composer-editor').fill('Preserve this switching draft');
 await page.getByRole('button',{name:'Open preview panel',exact:true}).click();
 await page.getByRole('button',{name:'New terminal',exact:true}).click();
 await page.getByRole('button',{name:'Maximize panel',exact:true}).click();
 await page.locator('.xterm-helper-textarea').waitFor();
 await page.locator('.xterm-helper-textarea').focus();
 await page.keyboard.insertText('i=0; while [ "$i" -lt 2000 ]; do printf "fixture terminal output line %s\\r\\n" "$i"; i=$((i+1)); done');
 await page.keyboard.press('Enter');await page.waitForTimeout(1000);if(touch){await page.setViewportSize(viewport);await cdp.send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:true});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});await page.waitForTimeout(600);const open=page.getByRole('button',{name:'Open preview panel',exact:true});if(await open.isVisible())await open.click();await page.getByRole('button',{name:'Back to workspace',exact:true}).waitFor();await page.waitForTimeout(600);}
 await page.evaluate(()=>{window.firstTerminalNode=document.querySelector('.xterm');window.firstEditorNode=document.querySelector('.opencraft-composer-editor');window.switchTasks=[];new PerformanceObserver(list=>window.switchTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:false});});
 if(browserMode){const result=await page.evaluate(url=>{const element=document.querySelector('.right-panel-content');let fiber=element[Object.keys(element).find(k=>k.startsWith('__reactFiber'))],owner,runtime;for(;fiber;fiber=fiber.return){if(fiber.memoizedProps?.state?.ownerId)owner=fiber.memoizedProps.state.ownerId;const value=fiber.memoizedProps?.value;if(value?.pages&&value?.presentations&&value?.workbench)runtime=value;}if(!runtime||!owner)throw Error('Browser owner not found');const opened=runtime.workbench.open(owner,{initialUrl:url});window.browserSwitchRuntime=runtime;window.browserSwitchOpened=opened;return opened;},'http://127.0.0.1:'+site.address().port);console.log('BROWSER_OPENED',result);await page.getByRole('button',{name:'Back to workspace',exact:true}).waitFor();await page.locator('canvas[aria-label="Browser page"]').waitFor({state:'visible'});await page.waitForTimeout(1000);const inspection=await page.evaluate(async()=>{const r=window.browserSwitchRuntime,o=window.browserSwitchOpened;const i=await r.pages.inspectPage(o.pageId);await r.pages.fillElement(o.pageId,i.elements.find(e=>e.role==='input').ref,i.revision,'browser input preserved');return i;});assert.equal(inspection.title,'Browser switch fixture');console.log('BROWSER_READY');}await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await cdp.send('Profiler.enable');await cdp.send('Profiler.start');const samples=[];
 const activate=async locator=>{
  const bounds=await locator.boundingBox();
  await page.evaluate(()=>{window.switchStarted=performance.now();window.switchTasks=[];window.switchFrameGaps=[];let previous=performance.now();window.switchStop=false;function frame(now){window.switchFrameGaps.push(now-previous);previous=now;if(!window.switchStop)requestAnimationFrame(frame);}requestAnimationFrame(frame);});
  if(touch){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}else await locator.click();
  const firstPaint=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-window.switchStarted)))));
  await page.waitForTimeout(700);
  return {...await page.evaluate(()=>{window.switchStop=true;return {longTasks:window.switchTasks,maxFrameGap:Math.max(...window.switchFrameGaps),terminalRetained:window.firstTerminalNode===document.querySelector('.xterm'),editorRetained:window.firstEditorNode===document.querySelector('.opencraft-composer-editor')};}),firstPaint};
 };
 for(let i=0;i<5;i++){
  const close=await activate(page.getByRole('button',{name:touch?'Back to workspace':'Close preview panel',exact:true}));
  const open=await activate(page.getByRole('button',{name:'Open preview panel',exact:true}));
  samples.push({close,open});console.log('SWITCH',i,JSON.stringify({close,open}));
 }
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});if(browserMode){const inspection=await page.evaluate(async()=>window.browserSwitchRuntime.pages.inspectPage(window.browserSwitchOpened.pageId));assert.equal(inspection.title,'Browser switch fixture');assert.equal(inspection.elements.find(e=>e.role==='input').value,'browser input preserved');}else{await page.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('printf "switch-%s\\n" "still-running"');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent.includes('switch-still-running'));}assert.equal(await page.locator('.opencraft-composer-editor').innerText(),'Preserve this switching draft');
 const frequencies={};for(const method of nativeMethods)frequencies[method]=(frequencies[method]??0)+1;console.log('NATIVE_METHODS',Object.entries(frequencies).sort((a,b)=>b[1]-a[1]).slice(0,15));if(!process.argv.includes('--baseline'))assert.ok(samples.every(s=>s.close.terminalRetained&&s.open.terminalRetained),'panel visibility must preserve the terminal renderer');assert.ok(!nativeMethods.includes('turn/start'));const suffix=(process.env.OPENCRAFT_SWITCH_STAGE??'current')+(browserMode?'-browser':'');const profile=await cdp.send('Profiler.stop');await writeFile(join(directory,suffix+'-'+(touch?'touch':'pointer')+'.cpuprofile'),JSON.stringify(profile.profile));
 await page.screenshot({path:join(directory,suffix+'-'+(touch?'touch':'pointer')+'.png')});
 await writeFile(join(directory,suffix+'-'+(touch?'touch':'pointer')+'.json'),JSON.stringify({touch,cpuThrottle:4,turns:120,terminalLines:2000,samples,modelCalls:0},null,2));
}catch(error){if(browser){const page=await browser.firstWindow();console.error('FAILED_BODY',await page.locator('body').innerText());await page.screenshot({path:join(directory,'failed.png')}).catch(()=>{});}throw error;}finally{await browser?.close();await app.close();if(site)await new Promise(r=>site.close(r));for(const socket of agent.clients)socket.terminate();await new Promise(resolve=>agent.close(resolve));await stop();await rm(root,{recursive:true,force:true});}
