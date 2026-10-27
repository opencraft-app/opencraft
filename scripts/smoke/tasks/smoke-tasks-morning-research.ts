import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TasksService} from "../../../plugins/tasks/src/server";
import {TasksSqliteStore} from "../../../plugins/tasks/src/sqlite";
import {AI_FOLLOW_UP_PREFIX} from "../../../plugins/tasks/src/ai-follow-up-model";
import {RESEARCH_HANDOFF_PREFIX} from "../../../plugins/tasks/src/research-handoff";
import {TASKS} from '@opencraft/appserver-protocol';
const output=process.env.OPENCRAFT_SMOKE_OUTPUT??'/tmp/morning-research-ui';await mkdir(output,{recursive:true});
const isolated=await mkdtemp(join(tmpdir(),'morning-overview-'));let timestamp=Date.now();const now=timestamp;
const service=new TasksService(join(isolated,'tasks.sqlite'),undefined,new TasksSqliteStore(join(isolated,'tasks.sqlite'),()=>timestamp));
function create(id:string,aiResearch='proactive',status:import('@opencraft/appserver-protocol').TaskStatus='backlog'){service.handle(TASKS.create,{id,title:id,description:'Evidence',status,projectServerId:null,projectId:null,aiResearch,aiResearchReason:aiResearch==='unassessed'?'':'Recorded basis: '+id})}
function handoff(id:string,hours:number,mode='proactive'){timestamp=now-hours*3600000;create(id,mode,'in_progress');service.handle(TASKS.progress,{taskId:id,eventId:'report-'+id,text:RESEARCH_HANDOFF_PREFIX+JSON.stringify({output:'Report with evidence: '+id+'\n'+('Verified report and supporting evidence. '.repeat(24)),decision:'Approve option A? Recommendation: A',nextStep:'Design A after judgment'})});const task=service.handle(TASKS.read,{id}) as import('@opencraft/appserver-protocol').TaskDetail;service.handle(TASKS.move,{id,expectedRevision:task.revision,status:'in_review',beforeId:null})}
create('Queued research');create('Running research','proactive','in_progress');create('Context request','needs_context');create('Unassessed','unassessed');create('Triage decision','needs_decision','in_review');create('No handoff','proactive','in_review');
handoff('Oldest handoff',80);handoff('Overdue handoff',74,'needs_decision');handoff('Recent handoff',1);handoff('Hidden context handoff',100,'needs_context');handoff('Completed',100);let completed=service.handle(TASKS.read,{id:'Completed'}) as import('@opencraft/appserver-protocol').TaskDetail;service.handle(TASKS.move,{id:'Completed',expectedRevision:completed.revision,status:'done',beforeId:null});
for (const [id,name] of [['owner-a','林'],['owner-b','周']]) service.handle(TASKS.members,{id,name,expectedRevision:null});
for (const [id,assigneeId] of [['Oldest handoff','owner-a'],['Overdue handoff','owner-b'],['Recent handoff','owner-a']]) {
 let task=service.handle(TASKS.read,{id}) as import('@opencraft/appserver-protocol').TaskDetail;
 service.handle(TASKS.properties,{id,expectedRevision:task.revision,assigneeId});
 task=service.handle(TASKS.read,{id}) as import('@opencraft/appserver-protocol').TaskDetail;
 service.handle(TASKS.attach,{id,expectedRevision:task.revision,serverId:'server-test',threadId:'thread-'+id});
}
let multiple=service.handle(TASKS.read,{id:'Overdue handoff'}) as import('@opencraft/appserver-protocol').TaskDetail;
service.handle(TASKS.attach,{id:multiple.id,expectedRevision:multiple.revision,serverId:'server-second',threadId:'thread-second'});
create('Ready delivery','unassessed','in_review');service.handle(TASKS.progress,{taskId:'Ready delivery',eventId:'ready-delivery',text:AI_FOLLOW_UP_PREFIX+JSON.stringify({lane:'ready',summary:'CI and review reported passed',artifact:'PR #42'})});
create('Automatic review','unassessed','in_review');service.handle(TASKS.progress,{taskId:'Automatic review',eventId:'auto-review',text:AI_FOLLOW_UP_PREFIX+JSON.stringify({lane:'review',summary:'Automatic checks running',artifact:'PR #43'})});
timestamp=now;service.handle(TASKS.progress,{taskId:'Oldest handoff',eventId:'wording-update',text:'Wording update must not reset the clock'});
let failReads=false;let mutations=0;
const source=`
import React from 'react';import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createTasksView} from '/plugins/tasks/src/view.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {AsyncNoticesProvider,useAsyncNotices} from '/apps/workbench-web/src/components/async-notices.tsx';
import '/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const request=async(_,method,params)=>{const res=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,params})});const result=await res.json();if(result.error)throw Object.assign(new Error(result.error.message),result.error);return result.value};
const ports={followUpDwellSince:${now}-2*3600000,storageHostId:'local',request,listThreads:async()=>[],listProjects:async()=>[],readConversation:async()=>({title:'Linked conversation',state:'idle'}),subscribe:()=>()=>{}};
const View=createTasksView(ports,new AbortController().signal);
const host={platform:'web',activeHostId:'local',profiles:[{hostId:'local',hostKind:'local',displayName:'Local',enabled:true}],openView(){},pushViewResource(){},replaceViewResource(){},openConversation(serverId,threadId){window.openedConversations??=[];window.openedConversations.push({serverId,threadId});if(window.failNavigation)throw new Error("Simulated navigation failure")},provisionHost:async()=>{},removeHost:async()=>false};
function App(){const notices=useAsyncNotices();return <View host={host} contribution={{id:'tasks'}} activation={{viewId:'tasks',resourceUri:null}} reportError={notices.error}/>}
createIntlTestRoot(document.getElementById('root'),undefined,new URLSearchParams(location.search).get('locale')??'en-US').render(<AsyncNoticesProvider><App/></AsyncNoticesProvider>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(server){server.middlewares.use(async(req,res,next)=>{
if(req.url==='/rpc'){try{let body='';for await(const chunk of req)body+=chunk;const {method,params}=JSON.parse(body);if(failReads&&method===TASKS.events)throw new Error('Simulated unavailable authority');if(![TASKS.capabilities,TASKS.list,TASKS.read,TASKS.events,TASKS.event].includes(method))mutations++;res.setHeader('content-type','application/json');res.end(JSON.stringify({value:service.handle(method,params)}));}catch(e:any){res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:e.code,message:'Request failed'}}));}return;}
if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="/fixture.tsx"></script>');})}}]});
let browser:any;const checks=[];
try{await vite.listen();const {chromium}=await import('playwright');browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
for(const width of [1440,390,320])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:1000},hasTouch:width<600});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({colorScheme:theme});await page.addInitScript('window.__name=v=>v;localStorage.setItem("opencraft.appearance-theme","system")');await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?locale=zh-CN');await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
 const entry=page.getByRole('button',{name:'晨会总览',exact:true});await entry.waitFor();const headingBounds=await entry.boundingBox();assert.ok(headingBounds&&headingBounds.x>=0&&headingBounds.x+headingBounds.width<=width);await page.locator('[data-task-id="Queued research"]').waitFor({state:'attached'});await page.getByRole('searchbox',{name:'搜索任务…',exact:true}).fill('Queued');
 const before=await page.locator('[data-task-id="Queued research"]').elementHandle();
 await entry.click();await page.getByRole('region',{name:'产品核心数据',exact:true}).waitFor();assert.equal(await page.locator('.tasks-morning__metric').count(),4);
 assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),0,'Morning is reserved for future risk and exploration content');
 await page.getByRole('heading',{name:'风险与关键探索',exact:true}).waitFor();
 await page.getByRole('button',{name:'返回任务',exact:true}).click();
 await page.getByRole('radio',{name:'AI 跟进',exact:true}).click();
 assert.equal(await page.getByRole('radio',{name:'AI 跟进',exact:true}).getAttribute('aria-checked'),'true');
 assert.equal(await page.locator('.tasks-morning__metrics').count(),0,'Business metrics do not belong to AI follow-up');
 await page.getByText('停留 2 小时',{exact:true}).first().waitFor();assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),12);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__column h3').allTextContents(),['Todo','Working','Needs you','In review','Ready to merge']);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__count').allTextContents(),['3','1','4','3','1']);
 assert.equal(await page.locator('.tasks-ai-follow-up__column--needs [data-ai-follow-up-task-id="Oldest handoff"]').count(),1);
 assert.equal(await page.locator('.tasks-ai-follow-up__column--ready [data-ai-follow-up-task-id="Ready delivery"]').count(),1);
 assert.equal(await page.locator('[data-ai-follow-up-task-id="Completed"]').count(),0);
 await page.getByText('待审阅 · 方式未核实',{exact:true}).first().waitFor();
 const bounds=await page.locator('.tasks-ai-follow-up').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,body:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(bounds.scroll<=bounds.width+1&&bounds.body<=bounds.viewport+1,JSON.stringify({width,theme,bounds}));

 const pairedSearch=page.getByRole('searchbox',{name:'搜索跟进事项',exact:true});
 const pairedOwner=page.getByRole('combobox',{name:'按 Owner 筛选',exact:true});
 // A real long member option must not displace the input from the filter row.
 await pairedOwner.locator('option[value="member:owner-a"]').evaluate(node=>{node.textContent='一位名字很长的成员 — Long localized owner name';});
 const searchBounds=await pairedSearch.boundingBox(),ownerBounds=await pairedOwner.locator("..").boundingBox();
 assert.ok(searchBounds&&ownerBounds&&Math.abs(searchBounds.y-ownerBounds.y)<1,'follow-up search/Owner stay on one row with long values '+JSON.stringify({width,theme,searchBounds,ownerBounds}));
 assert.ok(searchBounds.width>=ownerBounds.width,'Owner leaves useful search capacity');
 if(width<600)assert.ok(searchBounds.height>=44&&ownerBounds.height>=44,'follow-up pair retains touch targets');
 const inputNode=await pairedSearch.elementHandle();await pairedSearch.focus();
 for(const nextWidth of [width<600?1440:320,width]){
  await page.setViewportSize({width:nextWidth,height:1000});
  assert.equal(await pairedSearch.evaluate((node,original)=>node===original&&node===document.activeElement,inputNode),true,'follow-up resize preserves input/focus');
 }
 const card=page.locator('[data-ai-follow-up-task-id="Oldest handoff"]');
 assert.equal(await card.locator('h4').innerText(),'Oldest handoff');
 const title=card.locator('h4');
 assert.equal(await title.evaluate(el=>el.closest('button,a,[role="button"]')!==null),false,'Reading text must not be an implicit detail button');
 const content=card.locator('.tasks-ai-follow-up__content');
 assert.equal(await content.locator('button,a,[role="button"]').count(),0);
 assert.equal(await content.evaluate(el=>getComputedStyle(el).userSelect),'text','Body supports selecting and copying text');
 const background=await content.evaluate(el=>getComputedStyle(el).backgroundColor);
 if(width<600)await title.tap();else {await title.hover();await title.click({clickCount:3});assert.match(await page.evaluate(()=>getSelection()?.toString()??''),/Oldest handoff/);}
 assert.equal(await content.evaluate(el=>getComputedStyle(el).backgroundColor),background,'Hover does not paint the body as a button');
 assert.notEqual(await title.evaluate(el=>getComputedStyle(el).cursor),'pointer');
 await card.locator('.tasks-ai-follow-up__owner').click();
 assert.equal(await page.locator('.tasks-editor').count(),0,'Reading or selecting content/Owner must not open details');
 const chat=card.getByRole('button',{name:'进入会话：Oldest handoff',exact:true});
 assert.equal(await page.getByRole('button',{name:/^查看详情：/}).count(),0,'No detail action in this view');
 assert.equal(await card.locator('footer button').count(),1,'Chat is the sole explicit card action');
 assert.match(await chat.getAttribute('class')??'',/--quiet/);
 assert.equal(await chat.locator('svg').count(),1);
 assert.equal(await card.locator('.tasks-kind').count(),1,'Original task-kind badge is shared');
 const frame=page.locator('.tasks-ai-follow-up__column--needs');
 assert.equal(await frame.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px','Lane has no outer frame');
 assert.equal(await frame.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 assert.equal(await card.locator('footer').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
 assert.equal(await card.locator('.tasks-ai-follow-up__state').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
 assert.equal(await chat.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','Chat is a lightweight text action');

 assert.equal(await card.locator('.tasks-ai-follow-up__decision p').innerText(),'Approve option A? Recommendation: A');
 assert.doesNotMatch(await card.innerText(),/Verified report|Design A after judgment/);
 const filter=page.getByRole('combobox',{name:'按 Owner 筛选',exact:true});
 await filter.selectOption('member:owner-a');assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),2);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__count').allTextContents(),['0','0','2','0','0']);
 assert.equal(await page.locator('[data-ai-follow-up-task-id="Overdue handoff"]').count(),0);
 await page.getByRole('radio',{name:'看板',exact:true}).click();await page.getByRole('radio',{name:'AI 跟进',exact:true}).click();
 assert.equal(await filter.inputValue(),'member:owner-a','Owner selection survives leaving the follow-up view');
 await page.getByText('停留 2 小时',{exact:true}).first().waitFor();assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),2);
 const cta=card.getByRole('button',{name:'进入会话：Oldest handoff',exact:true});
 if(width<600)await cta.tap();else {await cta.focus();await page.keyboard.press('Enter');}
 assert.deepEqual(await page.evaluate(()=>window.openedConversations),[{serverId:'server-test',threadId:'thread-Oldest handoff'}]);
 assert.equal(await page.locator('.tasks-editor').count(),0,'Conversation destination must not open task details');
 await filter.selectOption('unassigned');assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),9);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__count').allTextContents(),['3','1','1','3','1']);
 assert.equal(await page.getByText('未关联会话',{exact:true}).count(),0);
 const unlinked=page.locator('[data-ai-follow-up-task-id="Queued research"]');assert.equal(await unlinked.locator('button,a,[role="button"]').count(),0,'Unlinked cards have no action');
 await filter.selectOption('');
 assert.equal(await page.locator('[data-ai-follow-up-task-id="Running research"] .tasks-ai-follow-up__wait').count(),0);
 assert.equal(await page.locator('[data-ai-follow-up-task-id="Ready delivery"] .tasks-ai-follow-up__wait').count(),0,'Unassigned Ready has no clock');
 const multi=page.getByRole('button',{name:'选择关联会话：Overdue handoff',exact:true});
 if(width<600)await multi.tap();else await multi.click();
 await page.getByRole('menuitem',{name:'关联会话 1',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.openedConversations.at(-1)),{serverId:'server-second',threadId:'thread-second'});
 const first=await card.boundingBox();const second=await page.locator('[data-ai-follow-up-task-id="Overdue handoff"]').boundingBox();
 assert.ok(first&&second);assert.ok(second.y>first.y,'Items stack inside each collaboration lane');
 const todo=await page.locator('.tasks-ai-follow-up__column--todo').boundingBox();const working=await page.locator('.tasks-ai-follow-up__column--working').boundingBox();assert.ok(todo&&working);
 assert.ok(Math.abs(todo.y-working.y)<2&&working.x>todo.x,'Lanes stay parallel at every width');
 await page.getByRole('searchbox',{name:'搜索跟进事项'}).fill('Queued');assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),1);await page.getByRole('searchbox',{name:'搜索跟进事项'}).fill('');
 assert.equal(await page.locator('.tasks-editor').count(),0);

 await page.locator('.tasks-ai-follow-up').evaluate(el=>{(document.activeElement as HTMLElement)?.blur();el.scrollTop=0;el.querySelector('.tasks-ai-follow-up__board-scroll').scrollLeft=0;});
 await page.screenshot({path:join(output,`${width}-${theme}.png`)});
 await page.getByRole('radio',{name:'看板',exact:true}).click();assert.equal(await page.getByRole('searchbox',{name:'搜索任务…',exact:true}).inputValue(),'Queued');
 if(width===1440&&theme==='light'){failReads=true;await page.getByRole('radio',{name:'AI 跟进',exact:true}).click();await page.getByText('部分协作记录暂不可用；未推断执行或停留时间。',{exact:false}).waitFor();assert.equal(await page.locator('.tasks-ai-follow-up__wait').count(),0);failReads=false;await page.getByRole('button',{name:'重新核实',exact:true}).click();await page.getByText('停留 2 小时',{exact:true}).first().waitFor();}
 assert.deepEqual(errors,[]);checks.push({width,theme,passed:true});await page.close();
}
assert.equal(mutations,0);await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks,realReactAndSqlite:true,fixtureOnly:true,mutationsDuringBrowsing:mutations,paidInference:false},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{await browser?.close();await vite.close();service.close();}
