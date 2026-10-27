import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {ActorStore} from "../../../packages/access-control/src/actors";
import {Collaboration} from "../../../packages/access-control/src/collaboration";
import {CodexEngineAdapter} from "../../../apps/opencraft-daemon/src/codex-engine-adapter";
import {AppHostServer} from "../../../packages/app-host-server/src/index";
import {createConversationExecution} from "../../conversation-execution.mjs";
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
const root=await mkdtemp(join(tmpdir(),'conversation-browser-')),out=process.env.OPENCRAFT_SMOKE_OUTPUT??join(tmpdir(),'opencraft-conversation-browser-'+Date.now());await mkdir(out,{recursive:true});
const actors=new ActorStore(join(root,'actors.sqlite')),human=actors.resolveHuman({provider:'local',subject:'browser-test',displayName:'Test user',expiresAt:Date.now()+600000})!;
let service:Collaboration;const frames:any[]=[];let seq=0;
const adapter=new CodexEngineAdapter({executable:process.execPath,runtimeDirectory:root,dataDirectory:join(root,'codex'),nativeCodexHomeDirectory:join(root,'native'),upstreamBaseUrl:'http://127.0.0.1:9/backend-api/codex',fetch:async()=>Response.json({ok:true}),createMaintenanceClient:async()=>{throw Error('unused');},spawnAppServer:({cwd,env})=>spawn(process.execPath,[new URL("../../../tests/fixtures/fake-codex-stdio-appserver.mjs",import.meta.url).pathname],{cwd,env,stdio:['pipe','pipe','pipe']}),collaborationInput:{available:()=>service.available,mode:id=>service.inputMode(id),authorize:(thread,id,mode,turn)=>service.authorizeInput(thread,id,mode,turn)}});
adapter.subscribeMessage(f=>frames.push(JSON.parse(f)));
const host=new AppHostServer({physicalHostLifetime:'server',logicalClientRouting:true,createTransport:()=>adapter});
service=new Collaboration(join(root,'collaboration.sqlite'),actors,createConversationExecution(()=>host,{serverId:'fixture',hostId:'local-codex'}));service.start();
await host.ensureHostConnected('local-codex');
const rpc=async(method:string,params:any={})=>{const id='browser-'+seq++;await adapter.send(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'controller'}));for(let i=0;i<500;i++){const f=frames.find(f=>f.id===id);if(f){if(f.error)throw Error(JSON.stringify(f.error));return f.result;}await new Promise(r=>setTimeout(r,5));}throw Error('timeout');};
await rpc('initialize');await rpc('thread/start',{cwd:root,testNoServerRequest:true});await rpc('thread/fork',{threadId:'fixture-thread-1'});await rpc('test/setHistory',{threadId:'fixture-fork-1',turns:[{id:'saved',items:[{type:'agentMessage',id:'answer',text:'Verified target history from native adapter'}]}]});
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0},plugins:[{name:'conversation-browser',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.url?.startsWith('/fixture/command')){try{let data='';for await(const chunk of req)data+=chunk;const result=await service.command(human,JSON.parse(data));res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}catch{res.statusCode=403;res.end('{}');}return;}
 if(!req.url?.startsWith('/?'))return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-interoperability.tsx"></script>');
 });}}]});await vite.listen();
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const evidence:any[]=[];
try{for(const theme of ['light','dark'])for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:900},permissions:['clipboard-read','clipboard-write']});await context.addInitScript(()=>{(window as any).__name=(v:any)=>v;});const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(vite.resolvedUrls!.local[0]+'?theme='+theme);await page.getByRole('button',{name:'Target conversation',exact:true}).click({button:'right'});
 await page.getByRole('menuitem',{name:'Copy conversation reference'}).click();
 const copied=await page.evaluate(()=>navigator.clipboard.readText());assert.match(copied,/conversation=/);assert.ok(!copied.includes('token='));
 const editor=page.locator('.ProseMirror');await editor.click();await page.keyboard.press('ControlOrMeta+V');
 const token=page.locator('[data-conversation-reference]');await token.waitFor({timeout:5000}).catch(async error=>{console.log('paste-debug',JSON.stringify({copied,html:await editor.innerHTML(),snapshot:await page.evaluate(()=>(window as any).fixture.controller.getSnapshot())}));await page.screenshot({path:join(out,'paste-error.png')});throw error;});await token.click();await page.getByText('Verified target history from native adapter',{exact:true}).waitFor();
 const textarea=page.getByRole('textbox',{name:'Message to this conversation'});await textarea.fill('Browser delivery '+theme+width);await page.evaluate(()=>{(window as any).fixture.hold(true);(window as any).fixture.offline(true);});await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByRole('button',{name:'Send message',exact:true}).waitFor();assert.equal(await textarea.inputValue(),'Browser delivery '+theme+width);
 await page.evaluate(()=>{(window as any).fixture.offline(false);});await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByRole('button',{name:'Check delivery'}).waitFor();assert.equal(await textarea.inputValue(),'');
 await page.locator('[data-sonner-toast] [data-close-button]').click({timeout:500}).catch(()=>{});await page.screenshot({path:join(out,theme+'-'+width+'.png')});await page.keyboard.press('Escape');await editor.click();await page.keyboard.press('ControlOrMeta+A');
 // The native fixture catalog only exposes its original thread, so search that title.
 await page.keyboard.press('ControlOrMeta+A');await page.keyboard.type('@fixture');await page.getByRole('option').first().click({timeout:5000});assert.equal(await page.locator('[data-conversation-reference]').count(),1);
 const prompt=await page.evaluate(()=>(window as any).fixture.prompt());assert.match(JSON.stringify(prompt),/opencraft:\/\/conversation\/v1\/fixture/);
 await page.goto(vite.resolvedUrls!.local[0]+'?theme='+theme+'&conversation='+encodeURIComponent('opencraft://conversation/v1/fixture/fixture-fork-1'));await page.waitForFunction(()=>(window as any).navigated?.key?.threadId==='fixture-fork-1');
 await page.getByRole('link',{name:'Saved conversation reference'}).click();await page.getByText('Verified target history from native adapter',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);evidence.push({theme,width,copied,prompt});await context.close();
 }}finally{await browser.close();await vite.close();await service.close();await host.close();actors.close();await rm(root,{recursive:true,force:true});}
await writeFile(join(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log('PASS browser reference/copy/paste/search/read/send/failure in four viewport/theme cases');
