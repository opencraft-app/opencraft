import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { createWorkbenchWebConfig } from "../../../apps/workbench-web/vite.config";
import { WebSocketServer } from "ws";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp("/tmp/opencraft-scheduled-tasks-page-");
const counts: Record<string, number> = {};
const stamp = Date.now() + 3_600_000;
let paused = false, failList = false;
let createdPlan: any = null, createdName = "Created schedule", loseSaveAck = true;
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {ScheduledTasksPage} from '/apps/workbench-web/src/components/scheduled-tasks-page.tsx';
import {ScheduledTaskCatalogContext} from '/apps/workbench-web/src/runtime/scheduled-task-catalog-context.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const config=document.createElement('script');config.id='opencraft-deployment-config';config.type='application/json';config.textContent=JSON.stringify({hosts:[{hostId:'fixture-host',label:'Schedule fixture',kind:'remote-ssh',url:location.origin.replace('http','ws')+'/fixture-rpc'}],builtinAgents:false,hypernode:false});document.head.append(config);
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const supervisor=application.supervisor;
await supervisor.extensions.activate({manifest:{manifestVersion:1,id:'example.plugins',name:'Plugins fixture',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},activate(api){api.views.register({id:'example.plugins.view',title:'Plugins',viewType:'example.plugins'});api.settings.registerPage({id:'example.plugins',title:'Plugins',viewId:'example.plugins.view',icon:'plug',order:303,management:{familyId:'example.plugins',scope:'host',entryPoint:'workbench'}});api.internal.register('platformViewRenderer',{viewType:'example.plugins',Component:()=>React.createElement('div',null,'Plugins')});}});
await supervisor.registry.ensureConnected('fixture-host');
const longTitle='每个工作日整理项目进展与待办事项，并在执行前核对需要人工确认的问题';
const syntheticPort={request:async()=>({schedule:null,runs:[]})};
function Composition(){
 const [mode,setMode]=React.useState('mixed');window.compositionMode=setMode;
 const task=(threadId,status='paused',needsReview=false)=>({threadId,status,needsReview,nextRunAt:1893456000000});
 const group=(key,hostLabel,phase,schedules)=>({hostId:key,scope:key,hostLabel,phase,schedules,cached:schedules.length>0,port:phase==='offline'?null:syntheticPort,retry:async()=>{}});
 const primary=group('a','项目服务器',mode==='refreshing'?'loading':mode==='failure'?'error':'ready',[task('long','active'),task('review','active',true),task('paused')]);
 const hosts=mode==='empty'?[group('empty','项目服务器','ready',[])]:mode==='loading'?[group('load','项目服务器','loading',[])]:mode==='unsupported'?[group('none','旧服务器','unsupported',[])]:[primary,group('b','项目服务器','offline',[task('cached')]),group('c','测试服务器','ready',[]),group('d','待连接服务器','loading',[])];
 return <ScheduledTaskCatalogContext.Provider value={{scheduleCatalogs:hosts,threads:[{id:'long',connectionHostId:'a',title:longTitle},{id:'review',connectionHostId:'a',title:'核对昨日执行结果'},{id:'paused',connectionHostId:'a',title:'每周汇总'},{id:'cached',connectionHostId:'b',title:'缓存中的任务'}],discovery:null,retryDiscovery:async()=>{},openConversation:async(host,id)=>{window.compositionOpened=host+':'+id;return true;}}}><ScheduledTasksPage/></ScheduledTaskCatalogContext.Provider>;
}
await supervisor.extensions.activate({manifest:{manifestVersion:1,id:'example.schedule-composition',name:'Composition fixture',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},activate(api){api.views.register({id:'example.schedule-composition.view',title:'Composition fixture',viewType:'example.schedule-composition'});api.settings.registerPage({id:'example.schedule-composition',title:'Composition fixture',viewId:'example.schedule-composition.view',layout:'document',icon:'calendar',order:305,management:{familyId:'example.schedule-composition',scope:'host',entryPoint:'workbench'}});api.internal.register('platformViewRenderer',{viewType:'example.schedule-composition',Component:Composition});}});
const nav=supervisor.navigation;nav.openSettings('opencraft.schedules');
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={route:()=>nav.getSnapshot().applicationRoute,open:()=>nav.openSettings('opencraft.schedules'),back:()=>nav.back(),forward:()=>nav.forward(),composition:()=>nav.openSettings('example.schedule-composition'),theme:setThemePreference,registry:supervisor.registry};document.body.dataset.ready='true';
`;
const feedbackSource = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {ScheduledTasksPage} from '/apps/workbench-web/src/components/scheduled-tasks-page.tsx';
import {ScheduledTaskCatalogContext} from '/apps/workbench-web/src/runtime/scheduled-task-catalog-context.ts';
import {AsyncNoticesContext} from '/apps/workbench-web/src/components/async-notices-context.ts';
import '/apps/workbench-web/src/styles/app.scss';
const notices={error:()=>{document.body.dataset.error='true';}};
const host={hostId:'fixture',hostLabel:'Fixture',scope:'fixture',phase:'ready',cached:true,port:null,retry:async()=>{},schedules:[{threadId:'retained',status:'paused',nextRunAt:1,needsReview:false}]};
function Proof(){const [discovery,setDiscovery]=React.useState(null);window.failDiscovery=()=>setDiscovery('error');
return <AsyncNoticesContext.Provider value={notices}><ScheduledTaskCatalogContext.Provider value={{scheduleCatalogs:[host],threads:[],discovery,retryDiscovery:async()=>{},openConversation:async()=>true}}><ScheduledTasksPage/></ScheduledTaskCatalogContext.Provider></AsyncNoticesContext.Provider>;}
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<Proof/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: output + "/vite", logLevel: "error",
  optimizeDeps: { ...createWorkbenchWebConfig({ mode: "development", command: "serve" }, { pluginBranding: false }).optimizeDeps, entries: [] },
  define: { 'process.env.NEXT_PUBLIC_REGION': '"cn"', 'process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""', 'import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"' },
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "schedule-catalog-proof", resolveId: id => ["/proof.tsx", "/feedback-proof.tsx"].includes(id) ? id : null, load: id => id === "/proof.tsx" ? source : id === "/feedback-proof.tsx" ? feedbackSource : null,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/" && req.url !== "/feedback") return next(); res.setHeader("content-type", "text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="'+(req.url === "/feedback" ? "/feedback-proof.tsx" : "/proof.tsx")+'"></script>'); }); } }] });
const ws = new WebSocketServer({ noServer: true });
const thread = { id: "scheduled-thread", name: "Synthetic scheduled conversation", preview: "Catalog fixture", cwd: "/synthetic", createdAt: 1, updatedAt: 1, historyMode: "legacy", status: { type: "idle" }, turns: [] };
function summaries() { return [...(createdPlan ? [{threadId:"new-schedule-thread",status:"active",nextRunAt:createdPlan.nextRunAt,needsReview:false}] : []),{ threadId: thread.id, status: paused ? "paused" : "active", nextRunAt: stamp, needsReview: false }, { threadId: "not-paginated", status: "paused", nextRunAt: stamp + 1, needsReview: false }]; }
const plan = () => ({ id: "schedule", threadId: thread.id, prompt: "Synthetic prompt", nextRunAt: stamp, intervalMinutes: 60, timeZone: "UTC", status: paused ? "paused" : "active", revision: paused ? 2 : 1, createdBy: null, updatedAt: 1 });
ws.on("connection", socket => socket.on("message", raw => {
  const { id, method, params } = JSON.parse(String(raw)); if (id == null) return;
  counts[method] = (counts[method] ?? 0) + 1;
  let result: unknown = {};
  if (method === "initialize") result = { serverInfo: { name: "fixture", version: "1" }, capabilities: { extensions: { "opencraft/conversation-schedules": { version: 1, summary: true, calendar: true } } } };
  else if (method === "thread/list") result = { data: [thread], nextCursor: null };
  else if (method === "thread/read" || method === "thread/resume") result = { thread: params.threadId === "new-schedule-thread" ? { ...thread, id: params.threadId, name: createdName } : params.threadId === "not-paginated" ? { ...thread, id: params.threadId, name: "Unlisted native conversation" } : thread };
  else if (method === "thread/loaded/list") result = { data: [] };
  else if (method === "thread/items/list" || method === "thread/turns/list") result = { data: [], nextCursor: null };
  else if (method === "model/list" || method === "project/list" || method === "skills/list" || method === "permissionProfile/list") result = { data: [] };
  else if (method === "account/read") result = { account: null, requiresOpenaiAuth: false };
  else if (method === "config/read") result = { config: {}, origins: {}, layers: [] };
  else if (method === "opencraft/schedules/list") {
    if (failList) { socket.send(JSON.stringify({ id, error: { code: -32000, message: "Synthetic unavailable" } })); return; }
    result = { schedules: summaries() };
  } else if (method === "thread/start") result = { thread: { ...thread, id: "new-schedule-thread" } };
  else if (method === "thread/name/set") { createdName = params.name; result = {}; }
  else if (method === "opencraft/schedules/save") { createdPlan = { ...params, id: "new-schedule", status: "active", revision: 1, updatedAt: Date.now(), createdBy: null }; if (loseSaveAck) { loseSaveAck = false; socket.send(JSON.stringify({ id, error: { code: -32000, message: "Synthetic lost acknowledgement" } })); return; } result = {schedule:createdPlan,runs:[]}; }
  else if (method === "opencraft/schedules/read") result = { schedule: params.threadId === "new-schedule-thread" ? createdPlan : plan(), runs: [] };
  else if (method === "opencraft/schedules/action") { assert.equal(params.action, "pause"); paused = true; result = { schedule: plan(), runs: [] }; for (const client of ws.clients) client.send(JSON.stringify({ method: "opencraft/schedules/changed", params: {} })); }
  socket.send(JSON.stringify({ id, result }));
}));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen(); vite.httpServer!.on("upgrade", (request, socket, head) => { if (request.url === "/fixture-rpc") ws.handleUpgrade(request, socket, head, connection => ws.emit("connection", connection, request)); });
  const url = vite.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let page = await context.newPage(); const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  console.log("fixture", url);
  await page.goto(url); console.log("page loaded"); await page.locator('body[data-ready="true"]').waitFor({ timeout: 90_000 });
  console.log("application ready");
  let catalog = page.locator(".scheduled-tasks-page"); await catalog.getByText(thread.name, { exact: true }).waitFor();
  const inset = await catalog.evaluate(el => {
    const viewport = el.closest('.settings-page__viewport')!.getBoundingClientRect(), content = el.getBoundingClientRect();
    return { left: content.left - viewport.left, right: viewport.right - content.right, width: content.width };
  });
  assert.ok(inset.left >= 14 && inset.right >= 14 && inset.width <= 760, 'document inset/reading width: '+JSON.stringify(inset));
  await catalog.getByText("Unlisted native conversation", { exact: true }).waitFor();
  assert.equal(await catalog.locator(".scheduled-tasks-page__row").count(), 2, "task without paginated thread metadata remains visible");
  assert.equal(counts["opencraft/schedules/read"] ?? 0, 0, "catalog has no per-row schedule reads");
  const ids = await page.locator('.shell-sidebar-navigation [data-action-id]').evaluateAll(elements => elements.map(el => el.getAttribute("data-action-id")));
  assert.ok(ids.indexOf("opencraft.schedules") === ids.indexOf("example.plugins") + 1, JSON.stringify(ids));
  await catalog.getByRole("button", { name: /^管理定时任务：/ }).first().click();
  const dialog = page.getByRole("dialog"); await dialog.getByText("Synthetic prompt", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "暂停", exact: true }).click(); await dialog.getByText("已暂停", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "完成", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  assert.equal(counts["opencraft/schedules/action"], 1);
  await catalog.getByText("任务已暂停", { exact: true }).first().waitFor();
  console.log("management passed");
  await catalog.getByRole("button", { name: /^打开会话：/ }).first().click();
  await page.waitForFunction(() => (window as any).proof.route().kind === "conversation");
  await page.evaluate(() => (window as any).proof.back());
  await catalog.getByText(thread.name, { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "back restores the catalog route without a modal");
  console.log("navigation passed");
  const beforeFailure = await catalog.locator(".scheduled-tasks-page__list").boundingBox();
  failList = true; for (const client of ws.clients) client.send(JSON.stringify({ method: "opencraft/schedules/changed", params: {} }));
  await page.getByText("无法刷新定时任务。", { exact: true }).first().waitFor();
  await catalog.getByText("Unlisted native conversation", { exact: true }).waitFor();
  assert.equal(await catalog.locator(".scheduled-tasks-page__row").count(), 2, "refresh failure preserves known tasks");
  assert.equal(await catalog.getByText("无法刷新定时任务。", { exact: true }).count(), 0, "error is delivered by Toast outside the catalog");
  const afterFailure = await catalog.locator(".scheduled-tasks-page__list").boundingBox();
  assert.deepEqual(afterFailure, beforeFailure, "error Toast does not shift catalog geometry");
  failList = false; await catalog.getByRole("button", { name: "刷新", exact: true }).first().click();
  await catalog.getByRole("button", { name: /^管理定时任务：/ }).first().waitFor();
  const closeToast = page.locator('.workbench-notices button[data-close-button]'); if (await closeToast.count()) await closeToast.first().click();
  console.log("failure recovery passed");
  const evidence = [];
  for (const theme of ["light", "dark"]) for (const width of [1440, 390, 320]) {
    console.log("matrix",theme,width);
    await page.setViewportSize({ width, height: 920 }); await page.evaluate(theme => (window as any).proof.theme(theme), theme);
    await page.waitForTimeout(150);
    const geometry = await catalog.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, page: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry)); assert.ok(geometry.page <= geometry.viewport + 1);
    await page.screenshot({ path: `${output}/${theme}-${width}.png` }); evidence.push({ theme, width, geometry });
  }
  console.log("desktop matrix passed");
  const touchContext=await browser.newContext({viewport:{width:390,height:920},hasTouch:true,isMobile:true});
  page=await touchContext.newPage();page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
  await page.goto(url);await page.locator('body[data-ready="true"]').waitFor({timeout:90_000});
  await page.evaluate(() => (window as any).proof.composition());
  catalog=page.locator('.scheduled-tasks-page');
  await catalog.getByText("每周汇总", { exact: true }).waitFor();
  assert.equal(await catalog.locator('.scheduled-tasks-page__group').count(), 4);
  assert.equal(await catalog.locator('.scheduled-tasks-page__header').getByRole('button', { name: '刷新', exact: true }).count(), 0, 'refresh leaves the page header');
  assert.equal(await catalog.locator('.scheduled-tasks-page__group-heading').getByRole('button', { name: '刷新', exact: true }).count(), 4, 'each server heading exposes the same catalog refresh');
  assert.equal(await catalog.getByText('已连接', {exact:true}).count(), 0, 'healthy connectivity is not repeated');
  assert.ok((await catalog.getByRole('button', { name: '刷新', exact: true }).allTextContents()).every(text=>!text.trim()), 'refresh uses only an icon');
  assert.equal(await catalog.locator('.settings-control-group,.settings-control-notice').count(), 0, 'catalog has no nested settings cards');
  await catalog.locator('[data-state="paused"]').first().getByText('任务已暂停', {exact:true}).waitFor();
  await catalog.getByText('暂停期间不会自动执行，可在「管理任务」中恢复。', {exact:true}).first().waitFor();
  const mixedEvidence = [];
  for (const theme of ['light','dark']) for (const width of [1440,390,320]) {
    await page.setViewportSize({width,height:920}); await page.evaluate(theme => (window as any).proof.theme(theme),theme);
    await page.waitForTimeout(100);
    const geometry = await catalog.evaluate(el => {
      const rect=el.getBoundingClientRect(), viewport=el.closest('.settings-page__viewport')!.getBoundingClientRect();
      const actions=[...el.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}));
      const title=el.querySelector('h2')!.getBoundingClientRect(), refresh=el.querySelector('button')!.getBoundingClientRect();
      const cards=[...el.querySelectorAll<HTMLElement>('.scheduled-tasks-page__group:first-child .scheduled-tasks-page__row')].map(card=>{
        const box=card.getBoundingClientRect(), style=getComputedStyle(card);
        return {x:box.x,y:box.y,right:box.right,bottom:box.bottom,width:box.width,border:parseFloat(style.borderTopWidth),radius:parseFloat(style.borderTopLeftRadius)};
      });
      return {left:rect.left-viewport.left,right:viewport.right-rect.right,width:rect.width,scroll:el.scrollWidth,client:el.clientWidth,actions,titleRight:title.right,refreshLeft:refresh.left,cards};
    });
    assert.ok(geometry.left>=14 && geometry.right>=14 && geometry.width<=760, JSON.stringify(geometry));
    assert.ok(geometry.scroll<=geometry.client+1);
    assert.equal(geometry.cards.length,3);
    assert.ok(geometry.cards.every(c=>c.border>=1 && c.radius>0), 'each task has its own visible card boundary');
    if(width===1440) assert.equal(geometry.cards[0]!.y,geometry.cards[1]!.y,'wide catalog arranges tasks in columns');
    else assert.ok(geometry.cards[1]!.y>=geometry.cards[0]!.bottom,'narrow catalog stacks complete cards');
    assert.ok(geometry.cards.every((a,i)=>geometry.cards.every((b,j)=>i===j || a.right<=b.x+1 || b.right<=a.x+1 || a.bottom<=b.y+1 || b.bottom<=a.y+1)),'cards do not overlap');
    assert.ok(geometry.actions.every(a=>a.width>0), 'wrapped header actions remain reachable');
    assert.ok(geometry.actions.every(a=>a.width>=44 && a.height>=44), 'touch targets use the shared 44px capacity');
    await page.screenshot({path: output+'/mixed-'+theme+'-'+width+'.png'}); mixedEvidence.push({theme,width,geometry});
  }
  await page.setViewportSize({width:390,height:920});
  const firstTitle=catalog.getByRole('button',{name:'打开会话：每个工作日整理项目进展与待办事项，并在执行前核对需要人工确认的问题',exact:true});
  await firstTitle.tap();
  assert.equal(await page.evaluate(()=>(window as any).compositionOpened),'a:long','touch opens the exact host/thread');
  const manage=catalog.getByRole('button',{name:/^管理定时任务：/}).first();
  await manage.tap(); await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).tap();
  await page.getByRole('dialog').waitFor({state:'detached'});
  await page.waitForFunction(el=>document.activeElement===el,await manage.elementHandle());
  assert.equal(await manage.evaluate(el=>document.activeElement===el),true,'manager returns focus to its independent action');
  const listBefore=await catalog.locator('.scheduled-tasks-page__list').first().boundingBox();
  for(const mode of ['refreshing','failure','mixed']) {
    await page.evaluate(mode=>(window as any).compositionMode(mode),mode);await page.waitForTimeout(100);
    assert.deepEqual(await catalog.locator('.scheduled-tasks-page__list').first().boundingBox(),listBefore,'cached rows keep geometry during '+mode);
  }
  for(const mode of ['empty','loading','unsupported']) {
    await page.evaluate(mode=>(window as any).compositionMode(mode),mode);
    await catalog.getByRole('status').waitFor();
    assert.equal(await catalog.locator('.scheduled-tasks-page__row').count(),0);
    await page.screenshot({path:output+'/state-'+mode+'.png'});
  }
  await page.evaluate(()=>(window as any).compositionMode('mixed'));
  const keyboard=await browser.newPage({viewport:{width:1000,height:900}});
  await keyboard.goto(url);await keyboard.locator('body[data-ready="true"]').waitFor({timeout:90_000});
  const keyboardCatalog=keyboard.locator('.scheduled-tasks-page');await keyboardCatalog.locator('.scheduled-tasks-page__destination').first().waitFor();
  await keyboardCatalog.getByRole('button',{name:'刷新',exact:true}).first().focus();await keyboard.keyboard.press('Tab');
  assert.equal(await keyboardCatalog.locator('.scheduled-tasks-page__destination').first().evaluate(el=>document.activeElement===el),true);
  const focusStyle=await keyboardCatalog.locator('.scheduled-tasks-page__destination').first().evaluate(el=>({style:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth}));
  assert.notEqual(focusStyle.style,'none');assert.ok(parseFloat(focusStyle.width)>0);

  const create = keyboardCatalog.getByRole('button', {name:'新建定时任务',exact:true});
  await create.click();
  const createDialog = keyboard.getByRole('dialog', {name:'新建定时任务',exact:true});
  await createDialog.getByLabel('名称', {exact:true}).fill('原生 Agent 每日汇总');
  await createDialog.getByLabel('任务说明',{exact:true}).fill('整理项目进展，生成每日摘要');
  await createDialog.getByRole('button',{name:'周期',exact:true}).click();
  await createDialog.getByRole('button',{name:'添加时刻',exact:true}).click();
  await createDialog.getByText('高级设置',{exact:true}).click();
  const creationEvidence=[];
  for (const theme of ['light','dark']) for (const width of [1440,390,320]) {
    await keyboard.setViewportSize({width,height:720});await keyboard.evaluate(theme=>(window as any).proof.theme(theme),theme);
    const geometry=await createDialog.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,rect:el.getBoundingClientRect().toJSON(),viewport:innerWidth}));
    assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify(geometry));
    assert.ok(geometry.rect.left>=0 && geometry.rect.right<=geometry.viewport+1,JSON.stringify(geometry));
    const button=createDialog.getByRole('button',{name:'创建任务',exact:true});await button.scrollIntoViewIfNeeded();assert.equal(await button.isEnabled(),true);
    await keyboard.screenshot({path:output+'/create-'+theme+'-'+width+'.png'});creationEvidence.push({theme,width,geometry});
  }
  await createDialog.getByRole('button',{name:'创建任务',exact:true}).click();
  await keyboard.getByText('未能确认创建结果。已保留草稿及已确认的新会话；重试会先核对服务器状态。',{exact:true}).waitFor();
  assert.equal(counts['thread/start'],1);assert.ok(createdPlan?.calendar?.times.length===2);
  assert.equal(await createDialog.getByLabel('名称',{exact:true}).inputValue(),'原生 Agent 每日汇总');
  await createDialog.getByRole('button',{name:'创建任务',exact:true}).click();
  await createDialog.waitFor({state:'detached'});
  assert.equal(counts['thread/start'],1,'save acknowledgement loss never duplicates a thread');
  assert.equal(counts['opencraft/schedules/save'],1,'retry reconciles an accepted save');
  assert.equal(counts['turn/start']??0,0,'creation does not submit a first turn');
  await keyboard.waitForFunction(el=>document.activeElement===el,await create.elementHandle());
  assert.equal(await create.evaluate(el=>document.activeElement===el),true,'creation restores focus');
  await keyboard.locator('.scheduled-tasks-page__destination').filter({hasText:'原生 Agent 每日汇总'}).waitFor();
  await keyboard.reload();
  await keyboard.locator('.scheduled-tasks-page__destination').filter({hasText:'原生 Agent 每日汇总'}).waitFor();
  const headingWidth=await keyboard.locator('.scheduled-tasks-page__header > :first-child').evaluate(el=>el.getBoundingClientRect().width);
  assert.ok(headingWidth>200,'narrow catalog heading retains its reading width: '+headingWidth);
  await keyboard.screenshot({path:output+'/created-name-after-reload-320.png'});
  console.log(JSON.stringify({creationEvidence,createdPlan,counts,nativeNameAfterReload:true,headingWidth}));
  await keyboard.close();
  await page.goto(url + "feedback");
  await page.locator(".scheduled-tasks-page__row").waitFor();
  const discoveryBefore = await page.locator(".scheduled-tasks-page__list").boundingBox();
  await page.evaluate(() => (window as any).failDiscovery());
  await page.locator('body[data-error="true"]').waitFor();
  assert.deepEqual(await page.locator(".scheduled-tasks-page__list").boundingBox(), discoveryBefore, "discovery failure uses the notice port without inserting layout");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ evidence, mixedEvidence, counts, errors }, null, 2));
  console.log(JSON.stringify({ output, scenarios: evidence.length + mixedEvidence.length, counts, passed: true }));
} finally { await browser?.close(); for (const client of ws.clients) client.terminate(); ws.close(); await vite.close(); }
