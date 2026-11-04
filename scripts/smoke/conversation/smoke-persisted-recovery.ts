import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ConversationHistory } from "../../../packages/app-host-server/src/conversation-history";
import { ConversationHistoryTransport } from "../../../packages/app-host-server/src/conversation-history-transport";

// Real SQLite -> persistent transport -> WebSocket -> Workbench -> Conversation.
// The native engine initializes but never answers history or executes anything.
const temporary = await mkdtemp(join(tmpdir(),"persisted-recovery-browser-"));
const storage = await openServerDatabase(temporary);
const info = {codexHome:"/fixture",platformFamily:"unix",platformOs:"linux",userAgent:"persistent-smoke",capabilities:{extensions:{}}};
const metadata = {id:"s",sessionId:"s",cwd:"/fixture",path:"/fixture/history",historyMode:"paginated",turns:[]};
const row = (n:number,text=`Answer ${n}`) => ({id:`persisted-${n}`,status:n===34?"inProgress":"completed",itemsView:"full",items:[
  {id:`question-${n}`,type:"userMessage",content:[{type:"text",text:`Question ${n}`}]},
  {id:`answer-${n}`,type:"agentMessage",text:text+"\n"+"Recovery content. ".repeat(60)},
]});
let history:ConversationHistory, peer:InMemoryAppServerPeer|undefined;
let readRequests=0, inject=false, injected=false, dropCommitted=false;
const nativeRequests:string[]=[];
const transports = new Set<ConversationHistoryTransport>();
const sockets = new WebSocketServer({noServer:true});
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:"error",resolve:{dedupe:["react","react-dom"]},
  cacheDir:"node_modules/.vite-persisted-recovery-smoke",optimizeDeps:{entries:["tests/fixtures/recovery-browser.tsx"]},server:{host:"127.0.0.1",port:0},
  plugins:[{name:"persisted-recovery-fixture",configureServer(server){server.middlewares.use(async(req,res,next)=>{
    if(req.url==="/__opencraft_apphost_diagnostic"){for await(const _ of req){} res.statusCode=202;res.end('{}');return;}
    if(req.url?.split('?')[0]!=="/")return next();res.setHeader("content-type","text/html");
    res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/recovery-browser.tsx"></script>');
  });}}]});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const output=process.env.OPENCRAFT_RECOVERY_EVIDENCE??join(temporary,"evidence");
try {
  await mkdir(output,{recursive:true});await vite.listen();
  vite.httpServer!.on("upgrade",(req,socket,head)=>{if(req.url==="/fixture-rpc")sockets.handleUpgrade(req,socket,head,ws=>sockets.emit("connection",ws,req));});
  sockets.on("connection",ws=>{
    const engine=new MemoryTransport({connected(value){peer=value;},receive(frame,value){const request=JSON.parse(frame);nativeRequests.push(request.method);
      if(request.method==="initialize")value.send(JSON.stringify({id:request.id,result:info}));
    }});
    const transport=new ConversationHistoryTransport(engine,history,undefined,10_000);transports.add(transport);
    transport.subscribeMessage(frame=>{
      const packet=JSON.parse(frame);
      if(packet.method==="opencraft/history/changed"&&dropCommitted){dropCommitted=false;return;}
      if(packet.result?.capabilities){const declared=packet.result.capabilities.extensions["opencraft/read-history"];
        assert.equal(declared.versionedUpdates,true);assert.equal(declared.boundedRecovery,undefined);}
      ws.send(frame);
      if(inject && !injected && packet.result?.initialTurnsPage){injected=true;
        peer!.send(JSON.stringify({method:"item/agentMessage/delta",params:{threadId:"s",turnId:"persisted-34",itemId:"answer-34",delta:" AFTER"}}));}
    });
    ws.on("message",async frame=>{const request=JSON.parse(frame.toString());if(request.method==="thread/read"){
      readRequests++;if(inject)peer!.send(JSON.stringify({method:"item/agentMessage/delta",params:{threadId:"s",turnId:"persisted-34",itemId:"answer-34",delta:" BEFORE"}}));
    }try{await transport.send(frame.toString());}catch(error){if(request.id!==undefined&&ws.readyState===1)ws.send(JSON.stringify({id:request.id,error:{code:-32000,message:String(error)}}));}});
    ws.on("close",()=>{void transport.close().finally(()=>transports.delete(transport));});
    void transport.connect();
  });
  browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  const results=[];
  for(const width of [390,1100])for(const theme of ["light","dark"]){
    history=new ConversationHistory(storage.database,`${width}-${theme}`);
    history.importResult("initialize",{},info,0);
    history.importResult("thread/read",{threadId:"s",includeTurns:true},{thread:{...metadata,turns:Array.from({length:35},(_,n)=>row(n))}},0);
    const page=await browser.newPage({viewport:{width,height:850},hasTouch:width===390,isMobile:width===390});
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?theme=${theme}`);
    await page.waitForSelector('[data-authoritative="true"]');await page.getByText('Question 34',{exact:true}).waitFor();
    const draft=page.getByRole('textbox',{name:'Unsent draft'});await draft.fill('Preserve my unsent words');await draft.focus();
    await page.evaluate(()=>{(window as any).originalRow=document.querySelector('[data-turn-key="persisted-34"]');});
    const before=readRequests;inject=true;injected=false;
    await page.evaluate(()=>(window as any).recovery.revalidate());
    await page.waitForFunction(()=>JSON.stringify((window as any).recovery.snapshot().timeline).includes(' BEFORE AFTER'));
    inject=false;assert.equal(injected,true);assert.equal(readRequests-before,1,'stream activity must not require silence');
    assert.equal(await page.evaluate(()=>document.querySelector('[data-turn-key="persisted-34"]')===(window as any).originalRow),true);
    // Load a saved older page, omit one commit, then send the following commit.
    await page.evaluate(()=>(window as any).recovery.loadOlder());
    await page.waitForFunction(()=>JSON.stringify((window as any).recovery.snapshot().timeline).includes('Answer 30'));
    dropCommitted=true;const repairStart=readRequests;
    history.observe('item/completed',{threadId:'s',turnId:'persisted-30',item:{id:'answer-30',type:'agentMessage',text:'Repaired older answer'}});
    assert.equal(dropCommitted,false,'watch subscription must receive the injected omitted commit');
    history.importResult('thread/read',{threadId:'s',includeTurns:false},{thread:{...metadata,name:'After omitted change'}},history.revision('s'));
    await page.waitForFunction(()=>{const state=(window as any).recovery.snapshot();return state.authoritative&&JSON.stringify(state.timeline).includes('Repaired older answer');});
    assert.equal(readRequests-repairStart,1,'gap has one existing-owner readonly repair');
    assert.equal(await draft.inputValue(),'Preserve my unsent words');
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Unsent draft');
    assert.equal(await page.locator('.conversation-recovery-notice').count(),0);
    const bounds=await draft.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width);
    await page.screenshot({path:`${output}/persisted-${width}-${theme}.png`});
    assert.deepEqual(errors,[]);results.push({width,theme,singleReadUnderOutput:true,missingRangeRepaired:true,draftAndFocusPreserved:true,retainedDOM:true,noLoadingNotice:true});
    await page.close();for(const transport of [...transports])await transport.close();transports.clear();
  }
  assert.equal(nativeRequests.some(method=>["thread/resume","turn/start"].includes(method)),false);
  await writeFile(`${output}/results.json`,JSON.stringify({results,noExecution:true},null,2));console.log(JSON.stringify(results));
}finally{await browser?.close();for(const socket of sockets.clients)socket.terminate();for(const transport of transports)await transport.close();await new Promise<void>(resolve=>sockets.close(()=>resolve()));await vite.close();await storage.close();await rm(temporary,{recursive:true,force:true});}
