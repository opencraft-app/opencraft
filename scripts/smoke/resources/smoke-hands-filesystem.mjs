import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocketServer} from 'ws';
import {_electron} from 'playwright-core';
import {startHeadlessServer} from '../../headless-server.mjs';
import {startHostFileSystem} from '../../host-filesystem.ts';

const webRoot=process.env.OPENCRAFT_FILES_WEB_ROOT;
const executablePath=process.env.OPENCRAFT_ELECTRON_EXECUTABLE;
if(!webRoot||!executablePath)throw Error('Set OPENCRAFT_FILES_WEB_ROOT and OPENCRAFT_ELECTRON_EXECUTABLE');
const output=resolve(process.env.OPENCRAFT_SMOKE_OUTPUT??'/tmp/opencraft-files-smoke');await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'opencraft-files-ui-')),work=join(root,'workspace');await mkdir(work);
const image=join(work,'preview.png'),text=join(work,'notes.txt');
await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
await writeFile(text,'Hands file preview acceptance');
const files={endpoint:join(root,'files.sock'),tokenFile:join(root,'files.token')};
const owner=await startHostFileSystem(files),nativeFiles=[];
const turn={id:'turn-files',status:'completed',error:null,items:[
  {id:'user',type:'userMessage',content:[{type:'text',text:'Show my workspace files and image'}]},
  {id:'answer',type:'agentMessage',phase:'final_answer',text:`[Browse workspace](${work})\n\n[Read notes](${text})\n\n![Hands preview](${image})`},
]};
const thread={id:'files-acceptance',name:'Hands files acceptance',preview:'Files fixture',cwd:work,createdAt:Math.floor(Date.now()/1000),updatedAt:Math.floor(Date.now()/1000),source:'cli',modelProvider:'fixture',path:null,turns:[turn]};
class Engine{
 status={state:'open'};listeners=new Set();async connect(){}async close(){}subscribeStatus(){return()=>{};}subscribeMessage(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
 async send(frame){const v=JSON.parse(frame);if(v.id==null)return;let result={data:[],nextCursor:null,providers:[],models:[],settings:[]};
  if(v.method.startsWith('fs/'))nativeFiles.push(v.method);
  if(v.method==='initialize')result={serverInfo:{name:'Files fixture',version:'1'},capabilities:{}};
  if(v.method==='thread/list')result={data:[{...thread,turns:[]}],nextCursor:null};
  if(['thread/read','thread/resume'].includes(v.method))result={thread,model:'fixture',modelProvider:'fixture',cwd:work,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};
  if(v.method==='thread/turns/list')result={data:[turn],nextCursor:null};
  if(v.method.includes('/items/list'))result={data:turn.items,nextCursor:null};
  if(v.method==='project/list')result={data:[{id:'files-project',name:'Files fixture',roots:[{id:'root',path:work}],metadata:{}}],nextCursor:null};
  if(v.method==='config/read')result={config:{cwd:work},origins:{}};
  const reply={id:v.id,__opencraftClient:v.__opencraftClient,...(v.method.startsWith('fs/')?{error:{code:-32603,message:'local filesystem is not configured'}}:{result})};
  for(const fn of this.listeners)fn(JSON.stringify(reply));
 }
}
const agent=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>agent.once('listening',r));
agent.on('connection',socket=>{const engine=new Engine();engine.subscribeMessage(frame=>socket.readyState===1&&socket.send(frame));socket.on('message',frame=>engine.send(String(frame)));});
const principal={provider:'files-fixture',subject:'acceptance-user',displayName:'Files tester',expiresAt:Date.now()+600000};
let app,browser;
try{
 app=await startHeadlessServer({root,webRoot,dataDirectory:join(root,'gateway'),runtimeDirectory:work,port:0,fileSystemOwner:files,
  accessMemberProviders:[principal.provider],createCodexTransport:()=>new Engine(),startAgentHost:async()=>({websocketUrl:'ws://127.0.0.1:'+agent.address().port+'/rpc',close(){}})},
  {createIdentity:async()=>({providers:[{authenticate:request=>request.headers['x-fixture-proof']==='verified'?principal:null}],close(){}})});
 const script=join(root,'app.cjs');await writeFile(script,"const{app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(()=>new BrowserWindow({show:true,width:1280,height:900,webPreferences:{sandbox:true}}).loadURL('about:blank'));");
 const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','DISPLAY','WAYLAND_DISPLAY'])delete env[key];
 browser=await _electron.launch({executablePath,args:['--ozone-platform=headless','--ozone-override-screen-size=1920,1080','--disable-gpu','--disable-dev-shm-usage',script],env});
 const page=await browser.firstWindow();page.setDefaultTimeout(20000);await page.context().setExtraHTTPHeaders({'x-fixture-proof':'verified'});
 const touch=process.argv.includes('--touch');if(touch){await page.setViewportSize({width:390,height:844});const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});}
 await page.goto(app.url+'/local/files-acceptance?hostId=local-codex');
 await page.getByRole('link',{name:'Browse workspace',exact:true}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('img')].some(img=>img.alt==='Hands preview'&&img.complete&&img.naturalWidth===1));
 await page.getByRole('link',{name:'Browse workspace',exact:true}).click();
 if(touch){
  await page.getByText('Select a file from this directory.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Back to workspace',exact:true}).click();
  await page.getByRole('link',{name:'Read notes',exact:true}).click();
 }else{
  await page.getByRole('button',{name:'Show file tree',exact:true}).click();
  await page.getByText('notes.txt',{exact:true}).first().waitFor();
  await page.getByText('notes.txt',{exact:true}).first().click();
 }
 assert.equal(await page.getByText('local filesystem is not configured',{exact:false}).count(),0);
 await page.getByText('Hands file preview acceptance',{exact:false}).waitFor();
 await page.screenshot({path:join(output,touch?'files-touch.png':'files-pointer.png'),timeout:5000});
 await page.reload();
 if(!await page.getByText('Hands file preview acceptance',{exact:false}).isVisible())
  await page.getByRole('link',{name:'Read notes',exact:true}).click();
 await page.getByText('Hands file preview acceptance',{exact:false}).waitFor();
 const data=await page.evaluate(async image=>{const response=await fetch('/__opencraft_files?'+new URLSearchParams({hostId:'local-codex',path:image}));return{status:response.status,bytes:(await response.arrayBuffer()).byteLength};},image);
 assert.equal(data.status,200);assert.ok(data.bytes>0);assert.deepEqual(nativeFiles,[]);
 console.log(JSON.stringify({ok:true,touch,imagePreview:true,directoryMetadata:true,directoryTree:!touch,filePreview:true,fileAccessAfterReload:true,downloadBytes:data.bytes,nativeFsRequests:nativeFiles.length,modelCalls:0}));
}catch(error){if(browser){const page=await browser.firstWindow();console.error('FILES_FAILED_BODY',await page.locator('body').innerText());await page.screenshot({path:join(output,'files-failed.png'),timeout:5000}).catch(()=>{});}throw error;}
finally{await browser?.close();await app?.close();for(const socket of agent.clients)socket.terminate();await new Promise(r=>agent.close(r));await owner.close();await rm(root,{recursive:true,force:true});}
