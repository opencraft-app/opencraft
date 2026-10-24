import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { TasksService } from "../../../plugins/tasks/src/server";
import { TASKS, type TaskDetail } from "@opencraft/appserver-protocol";
import { startHeadlessServer } from "../../headless-server.mjs";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root=process.cwd();
const directory=await mkdtemp(join(tmpdir(),"oc-task-team-"));
const artifacts=process.env.OPENCRAFT_TASKS_TEAM_ARTIFACTS ?? join(root,".local/tasks-team");
await mkdir(artifacts,{recursive:true});
await mkdir(join(directory,"agent"),{recursive:true});
const seed=new TasksService(join(directory,"agent/tasks.sqlite"));
const members=[{id:"alex",name:"Alex Chen"},{id:"mei",name:"林玫"},{id:"sam",name:"Sam Lee"}];
for(const member of members)seed.handle(TASKS.members,{...member,expectedRevision:null});
const statuses=["backlog","todo","in_progress","in_review","done","canceled"];
const titles=["统一任务维护接口与验收标准","梳理团队任务的负责人","让会话与任务保持关联","任务详情的交互与布局优化","成员信息维护与身份校验","整理晨会纪要中的待办事项","补齐关键路径的回归验证","优化卡片信息层级和阅读节奏","检查窄屏下的触控与键盘体验","完善 Agent 任务维护 Skill"];
for(let i=0;i<18;i++)seed.handle(TASKS.create,{id:`task-${i}`,title:titles[i%titles.length],description:"将讨论中的行动项整理为清晰的任务。\n\n验收：负责人明确，可回溯相关讨论，修改不会覆盖其他人的工作。",status:statuses[i%statuses.length],projectServerId:null,projectId:null,assigneeId:i%4===0?null:members[i%3]!.id,priority:i%4===0?"urgent":i%4===1?"high":i%4===2?"normal":"none",dueDate:i%3===0?"2026-10-10":i%3===1?"2026-12-15":null});
seed.close();
const server=await startHeadlessServer({root,dataDirectory:directory,webRoot:join(root,"apps/workbench-web/dist"),dshCapabilityPlugin:join(root,"apps/local-agent-host/src/dsh-capability-plugin.mjs"),codexExecutable:process.env.OPENCRAFT_CODEX_EXECUTABLE??"codex",port:0});
const socket=new WebSocket(server.url.replace(/^http/,"ws")+"/appserver",{origin:server.url});
await new Promise<void>((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
let seq=0;
const rpc=(method:string,params:unknown={}):Promise<any>=>new Promise((resolve,reject)=>{
 const id=++seq;const timer=setTimeout(()=>{socket.off("message",receive);reject(new Error("RPC timeout"));},15000);
 const receive=(data:WebSocket.RawData)=>{const frame=JSON.parse(String(data));if(frame.id!==id)return;clearTimeout(timer);socket.off("message",receive);frame.error?reject(frame.error):resolve(frame.result);};
 socket.on("message",receive);socket.send(JSON.stringify({jsonrpc:"2.0",id,method,params}));
});
const cli=async(command:string,p:unknown={})=>JSON.parse((await promisify(execFile)(process.execPath,[join(directory,"agent/task-agent/opencraft-tasks/scripts/tasks.mjs"),command,JSON.stringify(p)])).stdout);
// Native Codex and the task storage Host deliberately use different transports.
async function connectNative() {
 const ws=new WebSocket(server.url.replace(/^http/,"ws")+"/apphost",{origin:server.url});
 const pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 const wait=(id:string):Promise<any>=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Native RPC timed out: ${id}`));},20000);
  pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
 });
 ws.on("message",raw=>{const envelope=JSON.parse(String(raw));const frame=envelope.type==="host/frame"?JSON.parse(envelope.frame):envelope;
  const id=envelope.type==="host/frame"?frame.id:(envelope.requestId??envelope.type);const call=pending.get(id);if(!call)return;pending.delete(id);
  if(frame.error||frame.ok===false)call.reject(new Error("Native request failed"));else call.resolve(envelope.type==="host/frame"?frame.result:envelope);
 });
 const close=()=>{for(const call of pending.values())call.reject(new Error("Native client closed"));pending.clear();ws.close();};
 try {
  await new Promise<void>((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});
  let ready=wait("ready");ws.send(JSON.stringify({type:"hello",protocolVersion:2,rendererId:"tasks-team-native"}));await ready;
  ready=wait("connect");ws.send(JSON.stringify({type:"host/connect",requestId:"connect",hostId:"local-codex",leaseId:"tasks-team-native"}));const generation=(await ready).result.generation;
  let next=0;return {close,request:(method:string,params:unknown={}):Promise<any>=>{
   const id=`native:${++next}`,response=wait(id);ws.send(JSON.stringify({type:"host/send",requestId:`send:${id}`,hostId:"local-codex",leaseId:"tasks-team-native",generation,frame:JSON.stringify({id,method,params})}));return response;
  }};
 } catch(error) {close();throw error;}
}
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
const errors:string[]=[];
const page=await browser.newPage({viewport:{width:1680,height:1000}});page.setDefaultTimeout(15000);page.on("pageerror",(e:Error)=>errors.push(e.message));
await page.addInitScript(()=>localStorage.setItem("opencraft.appearance-theme","system"));
const executionGeometry:unknown[]=[];
async function checkExecutionRow(target:any,scenario:string,touch=false) {
 const button=target.getByRole("button",{name:"New conversation",exact:true});
 await button.scrollIntoViewIfNeeded();
 const select=await target.getByLabel("Execution connection",{exact:true}).boundingBox(),action=await button.boundingBox();
 assert.ok(select&&action);
 const stacked=action.y>=select.y+select.height;
 if(stacked)assert.ok(Math.abs(action.x-select.x)<=1,`${scenario}: stacked action starts at the connection edge`);
 else {
  assert.ok(action.x>=select.x+select.width,`${scenario}: action follows the connection control`);
  assert.ok(Math.abs(action.y+action.height-select.y-select.height)<=1,`${scenario}: control bottom edges align`);
 }
 if(touch)assert.ok(action.width>=44&&action.height>=44,`${scenario}: shared touch target remains available`);
 assert.ok(await target.locator('.tasks-editor__body').evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth));
 await button.focus();await target.keyboard.press("Shift+Tab");
 assert.equal(await target.getByLabel("Execution connection",{exact:true}).evaluate((el:Element)=>el===document.activeElement),true,"Keyboard order connects the selector to its action");
 await target.keyboard.press("Tab");
 assert.equal(await button.evaluate((el:Element)=>el===document.activeElement),true);
 executionGeometry.push({scenario,stacked,select,action});
 await target.screenshot({path:join(artifacts,`execution-${scenario}.png`),animations:"disabled"});
}
let native:Awaited<ReturnType<typeof connectNative>>|undefined;
try {
 await rpc("initialize",{clientInfo:{name:"tasks-team-smoke",version:"1"}});
 native=await connectNative();
 await native.request("initialize",{clientInfo:{name:"tasks-team-native",version:"1"},capabilities:{experimentalApi:true}});
 assert.deepEqual((await native.request("opencraft/codex/accounts/list")).accounts,[],"Native fixture cannot use a real account");
 const nativeThread=(await native.request("thread/start",{cwd:root,ephemeral:false})).thread;
 const nativeTitle="Codex task association fixture",nativeMessage="Native Codex task association history fixture";
 await native.request("thread/name/set",{threadId:nativeThread.id,name:nativeTitle});
 // An account-free local failure persists history without paid inference.
 await native.request("turn/start",{threadId:nativeThread.id,input:[{type:"text",text:nativeMessage,text_elements:[]}]});
 const providerCatalog=await rpc("runtime/providers/list");
 const provider=await rpc("runtime/providers/apply",{target:{kind:"create",id:"tasks-team-local"},expectedRevision:providerCatalog.creation.revision,displayName:"Tasks team local",baseURL:"http://127.0.0.1:9/v1",api:"openai-completions",models:[{id:"tasks-team-local",input:["text"],contextWindow:8192,maxTokens:1024}],credential:{kind:"replace",value:"synthetic-tasks-team-key"}});
 await rpc("runtime/providers/setEnabled",{provider:"tasks-team-local",enabled:true,expectedRevision:provider.revision});
 const dshModel=(await rpc("model/list")).data.find((model:any)=>model.model.includes("tasks-team-local"));assert.ok(dshModel);
 const dshThread=(await rpc("thread/start",{cwd:root,model:dshModel.model})).thread,dshTitle="DSH task association fixture";
 await rpc("thread/name/set",{threadId:dshThread.id,name:dshTitle});
 const skills=await rpc("skills/list",{cwds:[root],forceReload:true});assert.ok(skills.data.some((entry:any)=>entry.skills.some((skill:any)=>skill.name==="opencraft-tasks")));
 const nativeCatalog=await cli("conversations",{serverId:"local-codex"});
 assert.ok(Array.isArray(nativeCatalog.conversations));
 assert.ok(nativeCatalog.conversations.some((thread:any)=>thread.threadId===nativeThread.id),"CLI must return a real Codex thread, not a vacuous empty catalog");
 assert.ok(nativeCatalog.conversations.every((thread:any)=>thread.serverId==="local-codex" && typeof thread.threadId==="string"));
 await page.goto(server.url+"/views/opencraft.tasks.board");
 await page.locator('.tasks-card').first().waitFor();
 assert.equal(await page.locator('.tasks-card').count(),18);
 assert.equal(await page.locator('.main-content-frame').evaluate((el:Element)=>getComputedStyle(el).borderStartStartRadius),"0px");
 await page.screenshot({path:join(artifacts,"board-light.png")});
 await page.getByLabel("Assignee",{exact:true}).selectOption("member:alex");
 assert.ok(await page.locator('.tasks-card').count()<18);
 await page.getByLabel("Search tasks…",{exact:true}).fill("任务");
 assert.ok(await page.locator('.tasks-card').count()>0);
 await page.getByLabel("Search tasks…",{exact:true}).fill("no-matching-fixture");
 assert.equal(await page.locator('.tasks-card').count(),0);
 assert.ok((await page.locator(".tasks-filter-result").textContent())!.includes("No matching tasks"));
 await page.getByRole("button",{name:"Clear filters",exact:true}).click();
 await page.getByRole("radio",{name:"List",exact:true}).click();
 assert.equal(await page.locator('.tasks-row').count(),18);
 const list=await page.locator('.tasks-list').elementHandle();
 await page.screenshot({path:join(artifacts,"list-light.png")});
 await page.locator('[data-task-id="task-0"] .tasks-row__title').click();
 const dialog=page.getByRole("dialog",{name:"Task details",exact:true});
 await dialog.waitFor();
 const executionRow=page.locator('.tasks-editor__execution');
 await executionRow.evaluate((el:Element)=>el.classList.remove('tasks-editor__execution'));
 try {
  const beforeSelect=await page.getByLabel("Execution connection",{exact:true}).boundingBox();
  const beforeButton=await page.getByRole("button",{name:"New conversation",exact:true}).boundingBox();
  assert.ok(beforeSelect&&beforeButton&&Math.abs(beforeSelect.y+beforeSelect.height-beforeButton.y-beforeButton.height)>8,"The old row reproduces the visible alignment defect");
  await page.screenshot({path:join(artifacts,"execution-before.png"),animations:"disabled"});
 } finally {await page.getByLabel("Execution connection",{exact:true}).evaluate((el:Element)=>el.closest('.tasks-editor__fields')!.classList.add('tasks-editor__execution'));}
 const executionNode=await page.getByLabel("Execution connection",{exact:true}).elementHandle();
 for(const theme of ["light","dark"] as const)for(const width of [820,1024,1280,1680]) {
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
  await checkExecutionRow(page,`${width}-${theme}`);
  assert.ok(await executionNode!.evaluate((el:Element)=>el.isConnected),"Resize and theme changes preserve the execution selector node");
 }
 await page.emulateMedia({colorScheme:"light"});
 assert.equal(await page.locator('.tasks-overview').isVisible(),true,"Board remains mounted behind the dialog");
 // Radix deliberately keeps background aria-live announcements available.
 // Interactive task rows must still be hidden from assistive technology.
 await page.waitForFunction(()=>!!document.querySelector('.tasks-row__title')?.closest('[aria-hidden="true"]'));
 const box=await dialog.boundingBox();
 assert.ok(box && box.width<1680 && box.height<1000 && box.x>0 && box.y>0,"Detail is an inset card, leaving an outside dismissal area");
 await page.getByLabel("Title",{exact:true}).fill("Unsaved task zero");
 const beforeDismiss=await cli("read",{id:"task-0"});
 await page.mouse.click(8,500);
 await dialog.waitFor({state:"hidden"});
 assert.equal(await page.locator('[data-task-id="task-0"] .tasks-row__title').evaluate((el:Element)=>el===document.activeElement),true,"Outside dismissal restores opener focus");
 assert.ok(await list!.evaluate((el:Element)=>el.isConnected),"The same list node survives closing");
 assert.equal((await cli("read",{id:"task-0"})).title,beforeDismiss.title,"Dismissal does not save");
 await page.locator('[data-task-id="task-1"] .tasks-row__title').click();
 await page.getByLabel("Title",{exact:true}).fill("Unsaved task one");
 await page.keyboard.press("Escape");
 await dialog.waitFor({state:"hidden"});
 await page.locator('[data-task-id="task-0"] .tasks-row__title').click();
 assert.equal(await page.getByLabel("Title",{exact:true}).inputValue(),"Unsaved task zero","Reopening retains the task's draft");
 await page.locator(".tasks-editor").getByLabel("Assignee",{exact:true}).selectOption("mei");
 await page.getByLabel("Priority",{exact:true}).selectOption("high");
 await page.getByLabel("Due date",{exact:true}).fill("2026-12-20");
 await page.getByRole("button",{name:"Save",exact:true}).click();
 await page.waitForFunction(()=>!(document.querySelector('.tasks-editor select[aria-label="Assignee"]') as HTMLSelectElement)?.disabled);
 const saved=await cli("read",{id:"task-0"});assert.equal(saved.assigneeId,"mei");assert.equal(saved.priority,"high");assert.equal(saved.dueDate,"2026-12-20");
 await page.getByLabel("Title",{exact:true}).fill("Draft kept during concurrent change");
 await cli("properties",{id:saved.id,expectedRevision:saved.revision,assigneeId:"sam",priority:"urgent",dueDate:null});
 await page.getByRole("button",{name:"Load latest content",exact:true}).waitFor();
 assert.equal(await page.getByLabel("Title",{exact:true}).inputValue(),"Draft kept during concurrent change");
 assert.equal(await page.getByRole("button",{name:"Save",exact:true}).isDisabled(),true);
 await page.keyboard.press("Escape");
 await dialog.waitFor({state:"hidden"});
 await page.locator('[data-task-id="task-1"] .tasks-row__title').click();
 assert.equal(await page.getByLabel("Title",{exact:true}).inputValue(),"Unsaved task one","Drafts remain separate between tasks");
 await page.getByRole("button",{name:"Close task details",exact:true}).click();
 await page.locator('[data-task-id="task-0"] .tasks-row__title').click();
 assert.equal(await page.getByLabel("Title",{exact:true}).inputValue(),"Draft kept during concurrent change");
 assert.equal(await page.getByRole("button",{name:"Save",exact:true}).isDisabled(),true,"Reopening keeps the original CAS revision");
 await page.getByRole("button",{name:"Load latest content",exact:true}).click();
 assert.equal(await page.locator(".tasks-editor").getByLabel("Assignee",{exact:true}).inputValue(),"sam");
 await page.screenshot({path:join(artifacts,"detail-light.png")});
 await page.getByRole("button",{name:"Close task details",exact:true}).click();
 await page.getByRole("button",{name:"New task",exact:true}).click();
 await page.getByLabel("Title",{exact:true}).fill("Unsaved new task");
 await page.keyboard.press("Escape");
 await page.getByRole("button",{name:"New task",exact:true}).click();
 assert.equal(await page.getByLabel("Title",{exact:true}).inputValue(),"Unsaved new task");
 await page.getByRole("button",{name:"Close task details",exact:true}).click();
 await page.getByRole("radio",{name:"Board",exact:true}).click();
 await page.emulateMedia({colorScheme:"dark"});
 await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
 // Theme variables update before controls finish their native CSS transitions.
 // Await the painted surface, not just the root attribute, before capturing.
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.tasks-search')!).backgroundColor==="rgb(40, 40, 40)");
 await page.screenshot({path:join(artifacts,"board-dark.png")});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:join(artifacts,"board-mobile-dark.png")});
 assert.equal(await page.locator('.tasks-column:visible').count(),1);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 const mobileId=await page.locator('.tasks-card:visible').first().getAttribute('data-task-id');
 await page.locator('.tasks-card:visible .tasks-card__title').first().click();
 assert.ok(await page.getByRole("button",{name:"Save",exact:true}).first().isVisible());
 await page.screenshot({path:join(artifacts,"detail-mobile-dark.png")});
 await page.emulateMedia({colorScheme:"light"});
 await page.waitForFunction(()=>document.documentElement.dataset.theme==="light");
 await page.screenshot({path:join(artifacts,"detail-mobile-light.png")});
 const mobileTask=await cli("read",{id:mobileId});
 await page.getByLabel("Title",{exact:true}).fill("Mobile draft retained on conflict");
 await cli("properties",{id:mobileId,expectedRevision:mobileTask.revision,assigneeId:mobileTask.assigneeId,priority:mobileTask.priority==="high"?"low":"high",dueDate:mobileTask.dueDate});
 const latest=page.getByRole("button",{name:"Load latest content",exact:true});
 await latest.waitFor();
 const rect=await latest.boundingBox();assert.ok(rect && rect.y>=0 && rect.y+rect.height<=844,"Conflict recovery is visible without scrolling on mobile");
 assert.equal(await page.getByLabel("Title",{exact:true}).inputValue(),"Mobile draft retained on conflict");
 await page.screenshot({path:join(artifacts,"conflict-mobile-light.png")});
 await latest.click();
 await page.keyboard.press("Tab");assert.ok(await page.evaluate(()=>document.activeElement!==document.body));
 // Touch devices exercise the compact presentation, without synthetic business writes.
 const touch=await browser.newContext({viewport:{width:320,height:844},isMobile:true,hasTouch:true});
 try {
  const phone=await touch.newPage();phone.setDefaultTimeout(15000);phone.on("pageerror",(error:Error)=>errors.push(error.message));
  await phone.addInitScript(()=>localStorage.setItem("opencraft.appearance-theme","system"));
  await phone.goto(server.url+"/views/opencraft.tasks.board");await phone.locator('.tasks-card:visible').first().waitFor();
  for(const theme of ["light","dark"] as const)for(const width of [320,390,430]) {
   await phone.setViewportSize({width,height:width===320?568:844});await phone.emulateMedia({colorScheme:theme});
   await phone.waitForFunction(expected=>document.documentElement.dataset.theme===expected,theme);
   const trigger=phone.getByRole("button",{name:"Filters",exact:true}),panel=phone.locator('.tasks-filters');
   assert.equal(await panel.isVisible(),false,"Mobile filters start collapsed");
   const toolbar=await phone.locator('.tasks-toolbar').boundingBox();assert.ok(toolbar&&toolbar.height<=46,"Search, view switch and filter fit one row");
   const card=await phone.locator('.tasks-card:visible').first().boundingBox();
   const viewport=await phone.locator('.tasks-viewport').boundingBox();
   assert.ok(card&&viewport&&card.y-viewport.y<=150,"Mobile task chrome leaves at least the previous 54px to content");
   assert.equal(await phone.locator('.tasks-summary').count(),0,"The global statistics row is removed");
   const hit=await trigger.boundingBox();assert.ok(hit&&hit.width>=44&&hit.height>=44);
   assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await trigger.tap();assert.equal(await panel.isVisible(),true);
   assert.equal(await phone.locator('.tasks-summary').count(),0,"Expanded filters do not restore the removed statistics");
   if(width===390)await phone.screenshot({path:join(artifacts,`mobile-filters-${theme}.png`),animations:"disabled"});
   await phone.getByLabel("Assignee",{exact:true}).selectOption("unassigned");
   assert.ok(await phone.locator('.tasks-card:visible').count()<3,"Mobile filter operates on the real task query");
   await trigger.tap();assert.equal(await panel.isVisible(),false);assert.equal(await phone.locator('.tasks-summary').count(),0);assert.equal(await phone.locator('.tasks-filter-count').textContent(),"1");
   await phone.getByRole("button",{name:"Clear filters",exact:true}).tap();assert.equal(await phone.locator('.tasks-filter-count').count(),0);
   await phone.screenshot({path:join(artifacts,`mobile-controls-${width}-${theme}.png`),animations:"disabled"});
   await phone.setViewportSize({width,height:844});
   const title=phone.locator('.tasks-card:visible .tasks-card__title').first();await title.tap();
   const modal=phone.getByRole("dialog",{name:"Task details",exact:true});await modal.waitFor();
   const body=await phone.locator('.tasks-editor__body').boundingBox();
   for(const label of ["Priority","Task status"]) {const field=await modal.getByLabel(label,{exact:true}).boundingBox();assert.ok(field&&body&&field.y>=body.y&&field.y+field.height<=body.y+body.height,`${label} is reachable in the initial detail viewport`);}
   const close=await phone.getByRole("button",{name:"Close task details",exact:true}).boundingBox();assert.ok(close&&close.width>=44&&close.height>=44);
   assert.ok(await phone.locator('.tasks-editor__body').evaluate(el=>el.scrollWidth<=el.clientWidth));
   const input=phone.getByLabel("Title",{exact:true}),draftText=`Touch draft ${width} ${theme}`;await input.fill(draftText);
   await phone.screenshot({path:join(artifacts,`mobile-detail-${width}-${theme}.png`),animations:"disabled"});
   await checkExecutionRow(phone,`touch-${width}-${theme}`,true);
   await phone.touchscreen.tap(3,400);await modal.waitFor({state:"hidden"});await title.tap();assert.equal(await input.inputValue(),draftText);
   await phone.getByRole("button",{name:"Close task details",exact:true}).tap();
  }
  await phone.getByRole("radio",{name:"List",exact:true}).tap();
  assert.ok(await phone.locator('.tasks-list').isVisible(),"Compact list switch remains usable by touch");
  await phone.getByRole("radio",{name:"Board",exact:true}).tap();
  await phone.locator('.tasks-statuses').getByRole("radio",{name:/^In progress \d+$/}).tap();
  await phone.getByRole("button",{name:"New task",exact:true}).tap();
  assert.equal(await phone.getByRole("dialog").getByLabel("Task status",{exact:true}).inputValue(),"in_progress","Mobile top action creates in the selected status");
  await phone.getByRole("button",{name:"Close task details",exact:true}).tap();
  await phone.setViewportSize({width:1680,height:1000});
  assert.equal(await phone.getByLabel("Assignee",{exact:true}).isVisible(),true,"Desktop keeps filters visible even when compact disclosure is closed");
  assert.equal(await phone.getByRole("button",{name:"Filters",exact:true}).count(),0);
 } finally {await touch.close();}

 await page.setViewportSize({width:1680,height:1000});
 const source=page.getByLabel("Conversation connection",{exact:true}),threadChoice=page.getByLabel("Select conversation",{exact:true});
 assert.equal(await source.inputValue(),await page.getByLabel("Execution connection",{exact:true}).inputValue(),"Existing conversation selection defaults to the current chat Host");
 const search=page.getByLabel("Search conversations",{exact:true});
 await source.selectOption("local-codex");
 await search.fill("no-matching-native-task-fixture");
 await page.getByRole("option",{name:"No matching conversations on this connection",exact:true}).waitFor({state:"attached"});
 await search.fill(nativeTitle);
 assert.equal(await threadChoice.getAttribute("aria-busy"),"true");
 assert.equal(await page.getByRole("button",{name:"Link conversation",exact:true}).isDisabled(),true);
 await page.getByRole("option",{name:nativeTitle,exact:true}).waitFor({state:"attached"});
 await threadChoice.selectOption(nativeThread.id);
 await page.getByRole("button",{name:"Link conversation",exact:true}).click();
 const nativeLink=page.locator('.tasks-link').filter({hasText:nativeTitle});await nativeLink.waitFor();
 await source.selectOption("opencraft-server");
 assert.equal(await threadChoice.inputValue(),"","Switching Hosts immediately clears the previous Thread identity");
 await search.fill(dshTitle);
 await page.getByRole("option",{name:dshTitle,exact:true}).waitFor({state:"attached"});
 await threadChoice.selectOption(dshThread.id);await page.getByRole("button",{name:"Link conversation",exact:true}).click();
 const dshLink=page.locator('.tasks-link').filter({hasText:dshTitle});await dshLink.waitFor();
 const linked=await cli("read",{id:mobileId});
 assert.deepEqual(linked.conversations.map((link:any)=>[link.serverId,link.threadId]).sort(),[["local-codex",nativeThread.id],["opencraft-server",dshThread.id]].sort());
 assert.equal(linked.status,mobileTask.status,"Association does not change business progress");
 await nativeLink.getByRole("button",{name:"Unlink",exact:true}).click();await nativeLink.waitFor({state:"hidden"});
 assert.equal((await cli("read",{id:mobileId})).conversations[0].serverId,"opencraft-server","Unlinking Codex preserves DSH association");
 await source.selectOption("local-codex");await search.fill(nativeTitle);
 await page.getByRole("option",{name:nativeTitle,exact:true}).waitFor({state:"attached"});
 await threadChoice.selectOption(nativeThread.id);await page.getByRole("button",{name:"Link conversation",exact:true}).click();await nativeLink.waitFor();
 await page.screenshot({path:join(artifacts,"linked-codex-and-dsh.png")});
 await nativeLink.getByRole("button",{name:"Open conversation",exact:true}).click();
 await page.waitForURL((url:URL)=>url.pathname.includes(nativeThread.id));
 await page.getByText(nativeMessage,{exact:true}).waitFor();
 await page.goBack();await dialog.waitFor();await dshLink.waitFor();
 await dshLink.getByRole("button",{name:"Open conversation",exact:true}).click();
 await page.waitForURL((url:URL)=>url.pathname.includes(dshThread.id));
 assert.ok(await native.request("thread/read",{threadId:nativeThread.id,includeTurns:false}),"Unlink and navigation leave the native Thread readable");
 await page.goto(server.url+"/views/opencraft.tasks.board");
 await page.getByRole("radio",{name:"Board",exact:true}).click();
 const linkedCard=page.locator(`.tasks-card[data-task-id="${mobileId}"]`);
 await linkedCard.locator('.tasks-card__conversation').scrollIntoViewIfNeeded();
 const footerGeometry=await linkedCard.evaluate((el:Element)=>{
  const c=el.getBoundingClientRect(),a=el.querySelector('.tasks-avatar')!.getBoundingClientRect(),shortcut=el.querySelector('.tasks-card__conversation')!.getBoundingClientRect(),s=getComputedStyle(el);
  return {left:a.left-c.left,bottom:c.bottom-a.bottom,paddingLeft:parseFloat(s.paddingLeft),paddingBottom:parseFloat(s.paddingBottom),belowConversation:a.top>=shortcut.bottom,footerLast:el.lastElementChild?.classList.contains('tasks-meta--card')};
 });
 assert.ok(footerGeometry.belowConversation&&footerGeometry.footerLast,"Linked conversations precede the avatar footer");
 assert.ok(Math.abs(footerGeometry.left-footerGeometry.paddingLeft-1)<=1&&Math.abs(footerGeometry.bottom-footerGeometry.paddingBottom-1)<=1,"Linked task avatar stays at the bottom left");
 await page.getByRole("button",{name:"New task",exact:true}).click();
 const handoffTitle="Aligned action opens a native draft";
 await page.getByLabel("Title",{exact:true}).fill(handoffTitle);
 await page.getByLabel("Description",{exact:true}).fill("Review this task before sending. No automatic execution.");
 await page.getByLabel("Execution connection",{exact:true}).selectOption("local-codex");
 await page.getByRole("button",{name:"New conversation",exact:true}).focus();await page.keyboard.press("Enter");
 await page.waitForURL((url:URL)=>!url.pathname.startsWith('/views/'));
 const editor=page.locator('.opencraft-composer-editor[role="textbox"]:visible');await editor.waitFor();
 assert.match(await editor.innerText(),/Aligned action opens a native draft/);
 const handoffTask=(await cli("list",{search:handoffTitle})).tasks.find((task:any)=>task.title===handoffTitle);
 assert.ok(handoffTask);assert.equal((await cli("read",{id:handoffTask.id})).conversations.length,0,"The action saves the task and prepares a draft without starting a Thread or Turn");
 assert.deepEqual(errors,[]);
 await writeFile(join(artifacts,"execution-geometry.json"),JSON.stringify(executionGeometry,null,2));
 console.log(JSON.stringify({passed:true,cases:["real Workbench board/list/detail","square Shell seam","outside/Escape/button dismissal and focus return","background modality and list node continuity","separate unsaved existing/new task drafts","members and filters","atomic properties visible through CLI","CLI changes notify UI and retain stale draft on reopening","global DSH Skill discovery","desktop/mobile light/dark","keyboard and no page overflow","320/390/430px real touch light/dark compact controls and retained filters/drafts","real Codex and DSH catalogs/search/link/unlink/open","native Codex history restoration","cross-Host identity and progress preserved","current Host default and loading/empty feedback"],artifacts}));
} catch(error) {await page.screenshot({path:join(artifacts,"failure.png")});console.error(await page.locator('body').innerText());throw error;}
finally {native?.close();socket.close();await browser.close();await server.close();await rm(directory,{recursive:true,force:true});}
