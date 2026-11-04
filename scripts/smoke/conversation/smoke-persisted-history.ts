import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { AppHostServer } from "../../../packages/app-host-server/src/index.js";
import { ConversationHistory } from "../../../packages/app-host-server/src/conversation-history.js";
import { ConversationHistoryTransport } from "../../../packages/app-host-server/src/conversation-history-transport.js";
import { openServerDatabase } from "../../../packages/storage-node/src/server/index.js";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import { createWorkbenchWebServer as createStaticWorker } from "../../workbench-web-server.mjs";
import { createHeadlessBackendProxy } from "../../web-deployment/headless-backend.mjs";

const root=resolve(process.env.OPENCRAFT_HISTORY_WEB_ROOT ?? "apps/workbench-web/dist");
const output=resolve(process.env.OPENCRAFT_HISTORY_EVIDENCE ?? ".local/persisted-history");
await mkdir(output,{recursive:true});
const nativeDirectory=process.env.OPENCRAFT_HISTORY_NATIVE_DIRECTORY === "1";
const directory=await mkdtemp(join(tmpdir(),"opencraft-history-smoke-"));
let storage=await openServerDatabase(directory);
const threadId="persisted-history-fixture";
const question="Read this conversation while the execution engine is offline";
const answer="This ftsneedle answer and its tool activity are stored by OpenCraft.";
const body="Synthetic stored tool output toolneedle\n"+"bounded detail\n".repeat(12000)+"END OF STORED DETAIL";
const history=new ConversationHistory(storage.database,"local-codex");
history.importResult("thread/read",{threadId,includeTurns:true},{thread:{id:threadId,sessionId:threadId,name:"Stored conversation",preview:question,cwd:"/synthetic",path:null,historyMode:"paginated",createdAt:1,updatedAt:2,status:{type:"idle"},turns:[{
 id:"stored-group",status:"completed",itemsView:"full",startedAt:1700000000,completedAt:1700000010,durationMs:10000,error:null,items:[
  {id:"question",type:"userMessage",content:[{type:"text",text:question,textElements:[]}]},
  {id:"tool",type:"commandExecution",command:"printf synthetic-stored-output",cwd:"/synthetic",status:"completed",aggregatedOutput:body,exitCode:0,durationMs:2},
  {id:"answer",type:"agentMessage",text:answer,phase:"final_answer"},
 ]
}]}},0);
history.importResult("thread/read",{threadId:"weak-search",includeTurns:true},{thread:{id:"weak-search",sessionId:"weak-search",name:"Recent weak match",preview:"Recent question",cwd:"/synthetic",createdAt:10,updatedAt:10000,status:{type:"idle"},turns:[{id:"weak-group",status:"completed",itemsView:"full",items:[
 {id:"weak-question",type:"userMessage",content:[{type:"text",text:"Recent question",textElements:[]}]},
 {id:"weak-answer",type:"agentMessage",text:"filler ".repeat(1000)+"ftsneedle",phase:"final_answer"}
]}]}},0);
history.importResult("thread/read",{threadId:"scroll-history",includeTurns:true},{thread:{id:"scroll-history",sessionId:"scroll-history",name:"History continuity",cwd:"/synthetic",createdAt:20,updatedAt:30,turns:Array.from({length:14},(_,index)=>({
 id:`scroll-${index}`,status:index===13?"inProgress":"completed",itemsView:"full",items:[
  {id:`scroll-question-${index}`,type:"userMessage",content:[{type:"text",text:`History question ${index}`,textElements:[]}]},
  {id:`scroll-answer-${index}`,type:"agentMessage",text:`History answer ${index}\n\n`+"A paragraph retained while reading older messages. ".repeat(60),phase:index===13?null:"final_answer"},
 ]}))}},0);
if(nativeDirectory)history.importResult("thread/list",{}, {data:[],nextCursor:"expired-directory-from-another-connection"},history.catalogRevision());
await storage.close(); storage=await openServerDatabase(directory);
const sourceMethods:string[]=[],sourceCursors:(string|null)[]=[];
const histories=new Map<string,ConversationHistory>();
const emitters=new Map<string,(method:string,params:Record<string,unknown>)=>void>();
const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:"server",createTransport(hostId){
 const saved=new ConversationHistory(storage.database,hostId);histories.set(hostId,saved);
 const messages=new Set<(frame:string)=>void>(),lanes=new Set<string>();let sourceOpen=false,cursorSequence=0;
 const nativeCursors=new Map<string,string>();
 emitters.set(hostId,(method,params)=>{for(const lane of lanes)for(const listener of messages)listener(JSON.stringify({method,params,__opencraftClient:lane}));});
 return new ConversationHistoryTransport({get status(){return {state:sourceOpen?"open" as const:"idle" as const};},async connect(){sourceOpen=true;},async send(frame){const packet=JSON.parse(frame);if(packet.__opencraftClient)lanes.add(packet.__opencraftClient);sourceMethods.push(packet.method);if(process.env.OPENCRAFT_HISTORY_DEBUG)console.log("fixture-native-method",packet.method);
   if(nativeDirectory && packet.method === "initialize") {
    for(const listener of messages)listener(JSON.stringify({id:packet.id,result:{userAgent:"synthetic-directory",capabilities:{extensions:{}}},__opencraftClient:packet.__opencraftClient}));return;
   }
   if(nativeDirectory && ["initialized","runtime/client/disconnect"].includes(packet.method))return;
   if(nativeDirectory && packet.method === "thread/list") {
    const cursor=packet.params?.cursor??null,lane=packet.__opencraftClient??"";sourceCursors.push(cursor);
    let result:unknown;
    if(cursor===null) {
     const next=`native-directory:${lane}:${++cursorSequence}`;nativeCursors.set(next,lane);
     result={data:[saved.thread("weak-search"),saved.thread("scroll-history")].filter(Boolean),nextCursor:next};
    } else if(nativeCursors.get(cursor)===lane) {
     nativeCursors.delete(cursor);result={data:[saved.thread(threadId),{id:"source-directory-only",name:"Only in the native directory",cwd:"/synthetic",createdAt:0,updatedAt:0,turns:[]}].filter(Boolean),nextCursor:null};
    } else {
     for(const listener of messages)listener(JSON.stringify({id:packet.id,error:{code:-32080,message:"Directory cursor expired; restart the list",data:{retryable:true}},__opencraftClient:lane}));return;
    }
    for(const listener of messages)listener(JSON.stringify({id:packet.id,result,__opencraftClient:lane}));return;
   }
   throw new Error("Synthetic source history is offline");},
  subscribeMessage(listener){messages.add(listener);return()=>messages.delete(listener);},subscribeStatus(){return()=>{};},async close(){}},saved,()=>{},100);
}});
const backend=await createWorkbenchWebServer({root,appHostServer:host,appServerTarget:null,loopbackOnly:true});
const backendAddress=await backend.listen({host:"127.0.0.1",port:0});
const backendTarget=`http://127.0.0.1:${backendAddress.port}`;
const web=await createStaticWorker({root,appServerTarget:null,headlessServer:true,headlessBackendTarget:backendTarget});
web.server.removeAllListeners("upgrade");
const proxy=createHeadlessBackendProxy(backendTarget)!;
web.server.on("upgrade",(request,socket,head)=>proxy.upgrade(request,socket,head,()=>{},new Set()));
const address=await web.listen({host:"127.0.0.1",port:0});
const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE || undefined,args:["--no-sandbox"]});
const results:unknown[]=[];
try {
 for(const touch of [false,true]) {
  const context=await browser.newContext({viewport:{width:touch?390:1280,height:850},hasTouch:touch});
  const page=await context.newPage(); const errors:string[]=[];
  page.on("console",message=>{if(message.text().includes("Directory cursor expired"))errors.push("directory-cursor-expired");});
  page.on("pageerror",error=>errors.push(error.message));
  if(process.env.OPENCRAFT_HISTORY_DEBUG) {
   page.on("console",message=>console.log("fixture-console",message.text()));
   page.on("websocket",socket=>{socket.on("framereceived",frame=>console.log("fixture-frame",String(frame.payload).slice(0,700)));socket.on("socketerror",error=>console.log("fixture-ws-error",error));});
  }
  await page.addInitScript("window.__name = value => value");
  await page.goto(`http://127.0.0.1:${address.port}/local/weak-search?hostId=local-codex`,{waitUntil:"domcontentloaded"});
  await page.getByText("Recent question",{exact:true}).first().waitFor({timeout:20000});
  if(nativeDirectory) {
   for(let attempt=0;attempt<100&&!histories.get("local-codex")?.thread("source-directory-only");attempt++)await page.waitForTimeout(20);
   assert.ok(histories.get("local-codex")?.thread("source-directory-only"),"directory gap must import the source-only row");
  }
  await page.keyboard.press("Control+k");
  const dialog=page.getByRole("dialog",{name:"Search conversations",exact:true});
  await dialog.getByRole("combobox").fill("ftsneedle");
  await page.waitForFunction(()=>document.querySelectorAll('[role="option"]').length===2);
  assert.match(await dialog.getByRole("option").first().textContent()??"",/Stored conversation/);
  assert.match(await dialog.locator(".conversation-search__snippet").first().textContent()??"",/ftsneedle/);
  await page.screenshot({path:join(output,touch?"touch-search.png":"desktop-search.png"),fullPage:true});
  if(touch)await dialog.getByRole("option").first().tap();else await dialog.getByRole("option").first().click();
  await dialog.waitFor({state:"hidden"});
  await page.getByText(answer,{exact:true}).first().waitFor({timeout:20000});
  await page.getByText(question,{exact:true}).first().waitFor();
  await page.screenshot({path:join(output,touch?"touch-offline.png":"desktop-offline.png"),fullPage:true});
  const peer=await context.newPage();
  await peer.goto(`http://127.0.0.1:${address.port}/local/${threadId}?hostId=local-codex`,{waitUntil:"domcontentloaded"});
  await peer.getByText(answer,{exact:true}).first().waitFor({timeout:20000});
  const updated=answer+" Updated in both cached windows.";
  histories.get("local-codex")!.observe("item/completed",{threadId,turnId:"stored-group",item:{id:"answer",type:"agentMessage",text:updated,phase:"final_answer"}});
  await page.getByText(updated,{exact:true}).first().waitFor({timeout:10000});
  await peer.getByText(updated,{exact:true}).first().waitFor({timeout:10000});
  await peer.close();
  histories.get("local-codex")!.observe("item/completed",{threadId,turnId:"stored-group",item:{id:"answer",type:"agentMessage",text:answer,phase:"final_answer"}});
  await page.getByText(answer,{exact:true}).first().waitFor();
  const toggle=page.locator(".thread-agent-activity__turn-toggle").first();
  if(touch)await toggle.tap();else await toggle.click();
  const detail=page.locator(".thread-activity-item__hit-target").first();
  await detail.waitFor();
  if(touch)await detail.tap();else await detail.click();
  await page.getByText(/END OF STORED DETAIL/).first().waitFor({timeout:10000});
  await page.screenshot({path:join(output,touch?"touch-detail.png":"desktop-detail.png"),fullPage:true});
  await page.goto(`http://127.0.0.1:${address.port}/local/weak-search?hostId=local-codex`,{waitUntil:"domcontentloaded"});
  await page.getByText("Recent question",{exact:true}).first().waitFor({timeout:20000});
  await page.keyboard.press("Control+k");
  const toolDialog=page.getByRole("dialog",{name:"Search conversations",exact:true});
  await toolDialog.getByRole("combobox").fill("toolneedle");
  const option=toolDialog.getByRole("option").first();await option.waitFor({timeout:10000});
  if(touch)await option.tap();else await option.click();
  await toolDialog.waitFor({state:"hidden"});
  await page.getByText(/END OF STORED DETAIL/).first().waitFor({timeout:15000});
  await page.waitForFunction(()=>{
    const node=[...document.querySelectorAll<HTMLElement>("[data-content-search-unit-keys]")].find(element=>JSON.parse(element.dataset.contentSearchUnitKeys??"[]").includes("tool"));
    const viewport=document.querySelector("[data-thread-scroll]")??document.querySelector(".thread-scroll");
    if(!node||!viewport)return false;const r=node.getBoundingClientRect(),v=viewport.getBoundingClientRect();return r.top>=v.top-1&&r.top<v.bottom;
  },undefined,{timeout:10000});
  assert.equal(await page.locator(".conversation-search-position").count(),0);
  await page.screenshot({path:join(output,touch?"touch-tool-search.png":"desktop-tool-search.png"),fullPage:true});
  await page.goto(`http://127.0.0.1:${address.port}/local/scroll-history?hostId=local-codex`,{waitUntil:"domcontentloaded"});
  await page.getByText("History question 13",{exact:true}).first().waitFor({timeout:20000});
  const viewport=page.locator(".thread-scroll").first();
  for(let attempt=0;attempt<12 && !await page.getByText("History question 12",{exact:true}).count();attempt++) {
   const bounds=await viewport.boundingBox();assert.ok(bounds);
   if(touch) {
    const cdp=await context.newCDPSession(page),x=bounds.x+bounds.width/2,start=bounds.y+Math.min(100,bounds.height/4);
    await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y:start}]});
    for(let step=1;step<=6;step++) {await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x,y:start+step*60}]});await page.waitForTimeout(20);}
    await page.waitForTimeout(120);
    await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x,y:start+360}]});
    await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});await cdp.detach();
   } else {await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.wheel(0,-2000);}
   await page.waitForTimeout(150);
  }
  const anchor=page.getByText("History question 12",{exact:true}).first();await anchor.waitFor({timeout:10000});
  await anchor.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await anchor.evaluate(element=>{(window as any).__historyContinuityAnchor=element;});
  const beforeAnchor=await anchor.boundingBox(),beforeScroll=await viewport.evaluate(element=>element.scrollTop);
  const native=emitters.get("local-codex")!;
  for(let index=0;index<12;index++) {
   native("item/agentMessage/delta",{threadId:"scroll-history",turnId:"scroll-13",itemId:"scroll-answer-13",delta:` streamtoken${index}`});
   native("item/completed",{threadId:"scroll-history",turnId:"scroll-13",item:{id:`live-tool-${index}`,type:"commandExecution",command:`printf update-${index}`,status:"completed",aggregatedOutput:`result-${index}`}});
  }
  await page.waitForTimeout(350);
  const afterAnchor=await anchor.boundingBox(),afterScroll=await viewport.evaluate(element=>element.scrollTop);
  assert.ok(beforeAnchor && afterAnchor);assert.ok(Math.abs(afterAnchor.y-beforeAnchor.y)<=2,`anchor shifted ${afterAnchor.y-beforeAnchor.y}`);
  assert.equal(await anchor.evaluate(element=>element===(window as any).__historyContinuityAnchor),true);
  await page.screenshot({path:join(output,touch?"touch-history-anchor.png":"desktop-history-anchor.png"),fullPage:true});
  await viewport.evaluate(element=>{element.scrollTop=element.scrollHeight;});
  await page.getByText(/streamtoken11/).first().waitFor({timeout:10000});
  assert.equal(await page.locator('[placeholder="Reconnecting…"]').count(),0);
  await page.screenshot({path:join(output,touch?"touch-live-history.png":"desktop-live-history.png"),fullPage:true});
  results.push({touch,oldPagesRetained:true,streamBodyRetained:true,scrollAnchorRetained:true,anchorDelta:afterAnchor.y-beforeAnchor.y,scrollOffsetDelta:afterScroll-beforeScroll,cachedPeerUpdates:true,toolSearchNavigation:true,answer:true,question:true,storedDetail:true,fts5Search:true,bm25Order:true,searchNavigation:true,errors});
  assert.deepEqual(errors,[]);
  await context.close();
 }
 assert.equal(sourceMethods.some(method=>method==="thread/resume"||method==="turn/start"),false);
 if(nativeDirectory) {assert.ok(sourceCursors.length>0);assert.equal(sourceCursors.some(cursor=>cursor?.startsWith("conversation-directory:") || cursor==="expired-directory-from-another-connection"),false);}
 await writeFile(join(output,"result.json"),JSON.stringify({nativeDirectory,results,sourceMethods,sourceCursors},null,2));
 console.log(JSON.stringify({passed:true,output,results,sourceMethods}));
} finally {await browser.close();await web.close();await backend.close();await host.close();await storage.close();await rm(directory,{recursive:true,force:true});}
