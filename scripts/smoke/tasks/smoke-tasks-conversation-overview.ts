import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TasksService } from "../../../plugins/tasks/src/server";
import { TASKS } from "@opencraft/appserver-protocol";

// Real Tasks view/controller/SQLite, overview loader/model/chart/controls and theme.
// Synthetic native transport + verified people are the explicit external boundaries.
const output = process.env.OPENCRAFT_OVERVIEW_ARTIFACTS ?? await mkdtemp(join(tmpdir(), "conversation-overview-"));
const service = new TasksService(join(output, "tasks.sqlite"));
service.handle(TASKS.create, { id: "keep", title: "Preserve task filters", description: "Original draft", status: "backlog", projectServerId: null, projectId: null });
const before = JSON.stringify(service.handle(TASKS.list, {}));
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createTasksView} from '/plugins/tasks/src/view.tsx';
import {createConversationOverviewPort} from '/apps/workbench-web/src/runtime/conversation-overview.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme(); window.setFixtureTheme=setThemePreference;
const now=Math.floor(Date.now()/1000), fixture={fail:false, opened:[], reads:0}; window.fixture=fixture;
const threads=Array.from({length:36},(_,i)=>({id:'c'+i,name:'Conversation '+i,preview:'',cwd:'/work/project-'+i%3,createdAt:now-i%7*86400,updatedAt:now,status:i%6===2?{type:'active',activeFlags:[]}:i%6===3?{type:'active',activeFlags:['waitingOnUserInput']}:{type:'idle'},turns:[]}));
const people={id:'fixture.people',async read(_,ids){return ids.map(threadId=>({threadId,participants:threadId==='c0'?Array.from({length:28},(_,i)=>'person-'+i):['alice','bob'],creator:'creator',pending:false}))}};
const client={initializeResult:{},connectionGeneration:1,async request(method,params){fixture.reads++;if(fixture.fail)throw new Error('offline fixture');
if(method==='thread/list')return {data:threads.slice(params.archived?30:0,params.archived?36:30),nextCursor:null};
if(method==='opencraft/thread-pins/list')return {supported:true,data:threads.slice(0,3)};
const i=Number(params.threadId.slice(1));return {data:[{id:'last',status:i%6<2?'completed':i%6===4?'failed':i%6===5?'interrupted':'inProgress',completedAt:now}]};}};
const overview=createConversationOverviewPort({getClient:id=>id==='native'?client:null,participation:()=>people});
const request=async(_,method,params)=>{const res=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,params})});const result=await res.json();if(result.error)throw new Error(result.error);return result.value};
const ports={storageHostId:'native',request,listThreads:async()=>[],listProjects:async()=>[],readConversation:async()=>({title:'Conversation',state:'idle'}),subscribe:()=>()=>{},conversationOverview:overview};
const View=createTasksView(ports,new AbortController().signal);
const host={platform:'web',activeHostId:'native',profiles:[{hostId:'native',hostKind:'local',displayName:'Shared native',enabled:true},{hostId:'offline',hostKind:'remote-ssh',displayName:'Offline source',enabled:true}],openConversation:(...args)=>fixture.opened.push(args),openView(){},pushViewResource(){},replaceViewResource(){},provisionHost:async()=>{},removeHost:async()=>false};
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<View host={host} contribution={{id:'tasks'}} activation={{viewId:'tasks',resourceUri:null}} reportError={console.error}/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "overview-proof", resolveId: id => id === "/fixture.tsx" ? id : null, load: id => id === "/fixture.tsx" ? source : null, configureServer(server) { server.middlewares.use(async (req, res, next) => {
  if (req.url === "/rpc") { try { let body = ""; for await (const chunk of req) body += chunk; const { method, params } = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ value: service.handle(method, params) })); } catch { res.end(JSON.stringify({ error: "Fixture task read failed" })); } return; }
  if (req.url !== "/") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
}); } }] });
let browser: any;
const cases: unknown[] = [], errors: string[] = [];
try {
  await vite.listen();
  const pw = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  const { chromium } = pw.default ?? pw;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({viewport:{width,height:920},hasTouch:width===390}); page.on("pageerror",(e:Error)=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);
    await page.evaluate(t=>(window as any).setFixtureTheme(t),theme);
    const search=page.getByRole('searchbox',{name:'搜索任务…'}); await search.fill('Preserve');
    await page.getByRole('radio',{name:'任务统计 Beta',exact:true}).click();
    const overview=page.locator('.conversation-overview'); await page.waitForFunction(()=>document.querySelector('.conversation-overview')?.getAttribute('aria-busy')==='false');
    assert.deepEqual(await page.locator('.conversation-overview__metric > strong').allTextContents(),['36','6','12','3']);
    assert.equal(await search.isVisible(),false);
    assert.equal(await page.getByRole('table').count(),2);
    assert.equal(await page.locator('.conversation-overview__bucket').count(),7);
    assert.equal(await page.locator('.conversation-overview__table-wrap').first().locator('tbody tr').count(),20);
    await page.getByRole('button',{name:'查看更多人员'}).click(); assert.equal(await page.locator('.conversation-overview__table-wrap').first().locator('tbody tr').count(),31);
    await page.getByRole('button',{name:'收起',exact:true}).click();
    await page.getByRole('combobox',{name:'统计时间段'}).selectOption('today'); assert.equal(await page.locator('.conversation-overview__bucket').count(),1);
    await page.getByRole('combobox',{name:'统计时间段'}).selectOption('custom');
    assert.ok(await page.getByText('请选择有效的起止日期。',{exact:true}).isVisible());
    await page.getByLabel('开始日期',{exact:true}).fill('2026-10-01'); await page.getByLabel('结束日期',{exact:true}).fill('2026-10-02');
    await page.getByRole('combobox',{name:'统计时间段'}).selectOption('7d');
    await page.getByRole('combobox',{name:'数据来源'}).selectOption('offline'); assert.deepEqual(await page.locator('.conversation-overview__metric > strong').allTextContents(),['—','—','—','—']);
    await page.getByRole('combobox',{name:'数据来源'}).selectOption('all');
    await page.evaluate(()=>(window as any).fixture.fail=true);
    await page.getByRole('button',{name:'刷新统计'}).click();
    await page.waitForFunction(()=>document.querySelector('.conversation-overview')?.getAttribute('aria-busy')==='false');
    assert.deepEqual(await page.locator('.conversation-overview__metric > strong').allTextContents(),['36','6','12','3'],'Temporary disconnect retains last verified snapshot');
    assert.ok(await page.getByText('刷新失败，保留上次统计，请重试。',{exact:true}).isVisible());
    await page.evaluate(()=>(window as any).fixture.fail=false);
    await page.getByRole('button',{name:'刷新统计'}).click();
    await page.waitForFunction(()=>document.querySelector('.conversation-overview')?.getAttribute('aria-busy')==='false');
    const geometry=await overview.evaluate(node=>({width:node.clientWidth,scrollWidth:node.scrollWidth,overflow:getComputedStyle(node).overflowY,bg:getComputedStyle(node.querySelector('.conversation-overview__metric')!).backgroundColor}));
    assert.ok(geometry.scrollWidth<=geometry.width+1,'Only charts/tables may scroll horizontally'); assert.equal(geometry.overflow,'auto');
    assert.notEqual(geometry.bg,'rgba(0, 0, 0, 0)');
    await overview.evaluate(node=>node.scrollTop=0); await page.screenshot({path:join(output,`overview-${width}-${theme}.png`)});
    await page.getByRole('radio',{name:'看板',exact:true}).click(); assert.equal(await search.inputValue(),'Preserve');
    assert.equal(JSON.stringify(service.handle(TASKS.list,{})),before,'Statistics never mutate task data');
    cases.push({width,theme,metrics:true,period:true,peoplePagination:true,partialSource:true,refreshRetention:true,taskFiltersRetained:true,geometry}); await page.close();
  }
  assert.deepEqual(errors,[]); await writeFile(join(output,'receipt.json'),JSON.stringify({passed:true,cases,errors,syntheticTransport:true,realViewAndSQLite:true},null,2)); console.log(JSON.stringify({passed:true,output,cases}));
} catch(error) { for(const context of browser?.contexts()??[]) for(const page of context.pages()) await page.screenshot({path:join(output,'failure.png')}).catch(()=>{}); throw error; }
finally {await browser?.close();await vite.close();service.close();}
