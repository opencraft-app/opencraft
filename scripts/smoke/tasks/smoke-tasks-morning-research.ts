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
function create(id:string,aiResearch='proactive',status:import('@opencraft/appserver-protocol').TaskStatus='backlog'){service.handle(TASKS.create,{id,title:id,description:'Original task context: background, scope and next step.\n\nKeep this full description.',acceptanceCriteria:'Original acceptance: verify the main path and preserve existing data.',status,projectServerId:null,projectId:null,aiResearch,aiResearchReason:aiResearch==='unassessed'?'':'Recorded basis: '+id})}
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
for (const [id,priority] of [['Oldest handoff','urgent'],['Overdue handoff','high'],['Recent handoff','normal'],['Queued research','low']]) {
 const task=service.handle(TASKS.read,{id}) as import('@opencraft/appserver-protocol').TaskDetail;
 service.handle(TASKS.properties,{id,expectedRevision:task.revision,priority});
}
service.handle(TASKS.progress,{taskId:'Oldest handoff',eventId:'explicit-judge',text:AI_FOLLOW_UP_PREFIX+JSON.stringify({lane:'needs',summary:'Report remains in original activity',artifact:'Evidence retained',decision:'Approve option A? Recommendation: A',roundId:'scope',judgeId:'owner-b'})});
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
for(const width of [1440])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:1000},hasTouch:width<600});const errors:string[]=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message)});page.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text())});await page.emulateMedia({colorScheme:theme});await page.addInitScript('window.__name=v=>v;localStorage.setItem("opencraft.appearance-theme","system")');page.setDefaultNavigationTimeout(120_000); await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?locale=zh-CN');await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
 assert.equal(await page.getByRole('button',{name:'晨会总览',exact:true}).count(),0,'Morning reviewing removed');
 await page.locator('[data-ai-follow-up-task-id="Queued research"]').waitFor();
 await page.getByRole('radio',{name:'列表',exact:true}).click();
 await page.locator('[data-task-id="Queued research"]').waitFor({state:'attached'});
 await page.getByRole('searchbox',{name:'搜索任务…',exact:true}).fill('Queued');
 await page.getByRole('radio',{name:'看板',exact:true}).click();
 assert.equal(await page.locator('.tasks-morning__metrics').count(),0,'Business metrics do not belong to AI follow-up');
 await page.getByText('停留 2 小时',{exact:true}).first().waitFor();assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),13);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__column h3').allTextContents(),['Todo','推进中','需要介入','审阅验证','准备交付','已结束']);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__count').allTextContents(),['3','1','4','3','1','1']);
 assert.equal(await page.locator('.tasks-ai-follow-up__column--needs [data-ai-follow-up-task-id="Oldest handoff"]').count(),1);
 assert.equal(await page.locator('.tasks-ai-follow-up__column--ready [data-ai-follow-up-task-id="Ready delivery"]').count(),1);
 assert.equal(await page.locator('[data-ai-follow-up-task-id="Completed"]').count(),1);
 await page.locator('[data-ai-follow-up-task-id="No handoff"] .tasks-ai-follow-up__handling').filter({hasText:'暂不需处理'}).waitFor();
 const bounds=await page.locator('.tasks-ai-follow-up').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,body:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(bounds.scroll<=bounds.width+1&&bounds.body<=bounds.viewport+1,JSON.stringify({width,theme,bounds}));

 const pairedSearch=page.getByRole('searchbox',{name:'搜索事项',exact:true});
 const pairedOwner=page.getByRole('combobox',{name:'按负责人筛选',exact:true});
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
 assert.equal(await title.locator('button').count(),1,'The title explicitly opens the original task details');
 const content=card.locator('.tasks-ai-follow-up__content');
 assert.equal(await content.locator('button,a,[role="button"]').count(),1,'Only the title is actionable within the card body');
 assert.equal(await content.evaluate(el=>getComputedStyle(el).userSelect),'text','Body supports selecting and copying text');
 const background=await content.evaluate(el=>getComputedStyle(el).backgroundColor);
 const titleAction=title.getByRole('button',{name:'打开事项：Oldest handoff',exact:true});
 if(width<600)await titleAction.tap();else {await titleAction.focus();await page.keyboard.press('Enter');}
 const description=page.getByRole('textbox',{name:'说明',exact:true}),criteria=page.getByRole('textbox',{name:'验收标准',exact:true});
 assert.equal(await description.inputValue(),'Original task context: background, scope and next step.\n\nKeep this full description.');
 assert.equal(await criteria.inputValue(),'Original acceptance: verify the main path and preserve existing data.');
 await page.screenshot({path:join(output,`details-${width}-${theme}.png`)});
 const original=await description.inputValue();await description.fill(original+'\nDraft retained across grouping.');
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 assert.equal(await titleAction.evaluate(el=>el===document.activeElement),true,'Closing returns focus to the title');
 await page.getByRole('radio',{name:'按优先级',exact:true}).click();
 await page.getByRole('button',{name:'打开事项：Oldest handoff',exact:true}).click();
 assert.equal(await description.inputValue(),original+'\nDraft retained across grouping.');
 await description.fill(original);await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 await page.getByRole('radio',{name:'按协作',exact:true}).click();
 assert.equal(await content.evaluate(el=>getComputedStyle(el).backgroundColor),background,'The body never paints as a large button');
 assert.equal(await titleAction.evaluate(el=>getComputedStyle(el).cursor),'pointer');
 if(width<600)assert.ok((await titleAction.boundingBox()).height>=44,'Title retains a touch target');
 await card.locator('.tasks-ai-follow-up__owner').click();
 await page.locator('.tasks-editor').waitFor();
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 assert.equal(await titleAction.evaluate(el=>el===document.activeElement),true,'Card body opens details and returns focus');
 const chat=card.getByRole('button',{name:'进入会话：Oldest handoff',exact:true});
 assert.equal(await page.getByRole('button',{name:/^查看详情：/}).count(),0,'No detail action in this view');
 assert.equal(await card.locator('footer button').count(),1,'Chat is the sole explicit card action');
 assert.match(await chat.getAttribute('class')??'',/--quiet/);
 assert.equal(await chat.locator('svg').count(),1);
 assert.equal(await card.locator('.tasks-kind,.tasks-ai-follow-up__decision,.tasks-ai-follow-up__judge,.tasks-ai-follow-up__unknown').count(),0,'Only the six requested fields remain on cards');assert.match(await card.locator('.tasks-ai-follow-up__priority').innerText(),/P0/);assert.match(await card.locator('.tasks-ai-follow-up__handling').innerText(),/周/);assert.equal(await card.locator('.tasks-ai-follow-up__owner').getAttribute('title'),'处理人：周');
 const frame=page.locator('.tasks-ai-follow-up__column--needs');
 assert.equal(await frame.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px','Lane has no outer frame');
 assert.equal(await frame.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 assert.equal(await card.locator('footer').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
 assert.equal(await card.locator('.tasks-ai-follow-up__state').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
 assert.equal(await chat.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','Chat is a lightweight text action');

 assert.doesNotMatch(await card.innerText(),/Approve option A|Report remains|Evidence retained/,'Decision and summary remain in original activity, not cards');
 assert.doesNotMatch(await card.innerText(),/Verified report|Design A after judgment/);
 const filter=page.getByRole('combobox',{name:'按负责人筛选',exact:true});
 await filter.selectOption('member:owner-a');
 const selectedSearch=await pairedSearch.boundingBox(),selectedOwner=await pairedOwner.locator('..').boundingBox();
 assert.ok(selectedSearch&&selectedOwner&&Math.abs(selectedSearch.y-selectedOwner.y)<1&&selectedSearch.width>=selectedOwner.width,'selected long Owner remains paired without crowding search');
 assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),2);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__count').allTextContents(),['0','0','2','0','0','0']);
 assert.equal(await page.locator('[data-ai-follow-up-task-id="Overdue handoff"]').count(),0);
 await page.getByRole('radio',{name:'按优先级',exact:true}).click();
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__column h3').allTextContents(),['P0 · 紧急','P1 · 高','P2 · 普通','P3 · 低','未设置']);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__count').allTextContents(),['1','0','1','0','0']);
 assert.equal(await filter.inputValue(),'member:owner-a');
 await page.getByRole('radio',{name:'列表',exact:true}).click();await page.getByRole('radio',{name:'看板',exact:true}).click();
 assert.equal(await page.getByRole('radio',{name:'按优先级',exact:true}).getAttribute('aria-checked'),'true','Grouping survives leaving the view');
 assert.equal(await page.locator('.tasks-ai-follow-up__column--urgent [data-ai-follow-up-task-id="Oldest handoff"]').count(),1);
 await page.getByRole('radio',{name:'按协作',exact:true}).click();

 assert.equal(await filter.inputValue(),'member:owner-a','Owner selection survives leaving the follow-up view');
 await page.getByText('停留 2 小时',{exact:true}).first().waitFor();assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),2);
 const cta=card.getByRole('button',{name:'进入会话：Oldest handoff',exact:true});
 if(width<600)await cta.tap();else {await cta.focus();await page.keyboard.press('Enter');}
 assert.deepEqual(await page.evaluate(()=>window.openedConversations),[{serverId:'server-test',threadId:'thread-Oldest handoff'}]);
 assert.equal(await page.locator('.tasks-editor').count(),0,'Conversation destination must not open task details');
 await filter.selectOption('unassigned');assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),10);
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__count').allTextContents(),['3','1','1','3','1','1']);
 assert.equal(await page.getByText('未关联会话',{exact:true}).count(),0);
 const unlinked=page.locator('[data-ai-follow-up-task-id="Queued research"]');assert.equal(await unlinked.locator('button:disabled').count(),1,'Unlinked cards expose only a disabled chat action');
 await unlinked.getByRole('button',{name:'打开事项：Queued research',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'说明',exact:true}).inputValue(),'Original task context: background, scope and next step.\n\nKeep this full description.');
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();

 await filter.selectOption('');
 await page.getByRole('radio',{name:'按优先级',exact:true}).click();
 assert.deepEqual(await page.locator('.tasks-ai-follow-up__count').allTextContents(),['1','1','1','1','9']);
 assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),13,'No task lost or duplicated between grouping dimensions');
 await page.screenshot({path:join(output,`priority-${width}-${theme}.png`)});
 await page.getByRole('radio',{name:'按流程',exact:true}).click();
 assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),13);
 assert.equal(await page.locator('.tasks-ai-follow-up__column--done [data-ai-follow-up-task-id="Completed"]').count(),1);
 assert.equal(await page.locator('.tasks-ai-follow-up__column--in_review [data-ai-follow-up-task-id="Oldest handoff"]').count(),1);
 await page.getByRole('button',{name:'Agent 读取',exact:true}).click();
 const readSelect=page.getByRole('combobox',{name:'选择事项',exact:true});await readSelect.selectOption('Oldest handoff');
 const read=JSON.parse(await page.getByRole('region',{name:'事项结构化信息',exact:true}).innerText());
 assert.equal(read.id,'Oldest handoff');assert.equal(read.workflowStatus,'in_review');assert.equal(read.ownerId,'owner-a');assert.equal(read.collaboration.currentHumanActorId,'owner-b');assert.equal(read.collaboration.group,'needs');assert.equal(read.collaboration.executionState,'unknown');assert.equal(read.access.grantsExecution,false);assert.equal(read.clock.startedAt,now-2*3600000);
 await page.screenshot({path:join(output,`agent-${width}-${theme}.png`)});
 await page.keyboard.press('Escape');assert.equal(await page.locator('.tasks-work-board-reader').count(),0);

 await page.getByRole('searchbox',{name:'搜索事项'}).fill('Oldest');
 await page.getByRole('radio',{name:'按协作',exact:true}).click();
 assert.equal(await page.getByRole('searchbox',{name:'搜索事项'}).inputValue(),'Oldest');
 assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),1);
 await page.getByRole('searchbox',{name:'搜索事项'}).fill('');
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
 await page.getByRole('searchbox',{name:'搜索事项'}).fill('Queued');assert.equal(await page.locator('[data-ai-follow-up-task-id]').count(),1);await page.getByRole('searchbox',{name:'搜索事项'}).fill('');
 assert.equal(await page.locator('.tasks-editor').count(),0);

 await page.locator('.tasks-ai-follow-up').evaluate(el=>{(document.activeElement as HTMLElement)?.blur();el.scrollTop=0;el.querySelector('.tasks-ai-follow-up__board-scroll').scrollLeft=0;});
 await page.screenshot({path:join(output,`${width}-${theme}.png`)});
 await page.getByRole('radio',{name:'列表',exact:true}).click();assert.equal(await page.getByRole('searchbox',{name:'搜索任务…',exact:true}).inputValue(),'Queued');
 if(width===1440&&theme==='light'){failReads=true;await page.getByRole('radio',{name:'看板',exact:true}).click();await page.getByText('部分协作记录暂不可用，处理要求与停留时间待核实。',{exact:false}).waitFor();assert.equal(await page.locator('.tasks-ai-follow-up__wait').count(),0);failReads=false;await page.getByRole('button',{name:'重新核实',exact:true}).click();await page.getByText('停留 2 小时',{exact:true}).first().waitFor();}
 assert.deepEqual(errors,[]);checks.push({width,theme,passed:true});await page.close();
}
// Real task rows fill two lanes; verify native scrolling rather than style alone.
for(let i=0;i<18;i++){create('Long Todo '+i,'unassessed','todo');create('Long Working '+i,'proactive','in_progress');}
const scrollChecks=[];
for(const width of [1200])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<600});
 await page.emulateMedia({colorScheme:theme});await page.addInitScript('window.__name=v=>v;localStorage.setItem("opencraft.appearance-theme","system")');
 page.setDefaultNavigationTimeout(120_000); await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?locale=zh-CN');
 const first=page.locator('.tasks-ai-follow-up__column--todo .tasks-ai-follow-up__cards'),second=page.locator('.tasks-ai-follow-up__column--working .tasks-ai-follow-up__cards');
 await page.locator('[data-ai-follow-up-task-id="Long Working 17"]').waitFor({state:'attached'});
 for(const el of [first,second])assert.equal(await el.evaluate(e=>e.scrollHeight>e.clientHeight),true,'Each populated lane has a bounded native scrollport');
 const header=page.locator('.tasks-ai-follow-up__column--todo header'),top=(await header.boundingBox()).y;
 async function scrollLane(el:any){
  await el.scrollIntoViewIfNeeded();const box=await el.boundingBox();assert.ok(box&&box.height>100);
  if(width<600){const cdp=await page.context().newCDPSession(page);const x=Math.min(width-35,box.x+box.width/2),y=box.y+Math.min(box.height-30,280);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   for(let n=1;n<=8;n++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-n*22}]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  }else{await page.mouse.move(box.x+box.width/2,box.y+Math.min(box.height-20,120));await page.mouse.wheel(0,360);}
  await page.waitForFunction(e=>e.scrollTop>0,await el.elementHandle());
  await el.evaluate(e=>new Promise<void>(resolve=>{let last=e.scrollTop,stable=0;function sample(){const next=e.scrollTop;stable=next===last?stable+1:0;last=next;if(stable>=10)resolve();else requestAnimationFrame(sample);}requestAnimationFrame(sample);}));
 }
 await scrollLane(first);const saved=await first.evaluate(e=>e.scrollTop);assert.equal(await second.evaluate(e=>e.scrollTop),0,'First lane does not move its neighbor');
 assert.ok(Math.abs((await header.boundingBox()).y-top)<1,'Lane header stays fixed');
 await scrollLane(second);assert.equal(await first.evaluate(e=>e.scrollTop),saved,'Second lane does not move the first');
 assert.equal(await page.locator('.tasks-ai-follow-up').evaluate(e=>e.scrollTop),0);assert.equal(await page.evaluate(()=>document.scrollingElement.scrollTop),0);
 assert.equal(await page.locator('.tasks-editor').count(),0,'Scrolling must not open a task');
 await page.getByRole('radio',{name:'按优先级',exact:true}).click();await page.getByRole('radio',{name:'按协作',exact:true}).click();
 assert.equal(await first.evaluate(e=>e.scrollTop),saved,'Grouping restores the lane position');
 await page.screenshot({path:join(output,`scroll-${width}-${theme}.png`)});scrollChecks.push({width,theme,passed:true});await page.close();
}

create('完整展示较长的产品需求标题：支持在手机上直接阅读任务范围、验收目标和下一步，不截断关键文字','unassessed','todo');
const mobileChecks=[];
for(const width of [320,390,430,1440])for(const theme of ['light','dark']){
 const narrowPane=width===1440;const page=await browser.newPage({viewport:{width,height:900},hasTouch:!narrowPane});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.emulateMedia({colorScheme:theme});await page.addInitScript('window.__name=v=>v;localStorage.setItem("opencraft.appearance-theme","system")');
 page.setDefaultNavigationTimeout(120_000); await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?locale=zh-CN');
 if(narrowPane)await page.locator('.tasks-viewport').evaluate(el=>{el.style.width='390px';});
 await page.locator('.tasks-ai-follow-up[data-compact]').waitFor();await page.locator('.tasks-ai-follow-up__feedback').waitFor({state:'hidden'});
 const board=page.locator('.tasks-ai-follow-up'),tabs=page.locator('.tasks-ai-follow-up__lane-tabs');
 assert.equal(await page.locator('.tasks-ai-follow-up__column:visible').count(),1,'Only one full lane is shown');
 assert.equal(await tabs.getByRole('radio').count(),6,'All collaboration categories remain available');
 const bounds=await board.boundingBox(),card=page.locator('[data-ai-follow-up-task-id="Queued research"]');
 const box=await card.boundingBox();assert.ok(bounds&&box&&box.x>=bounds.x&&box.x+box.width<=bounds.x+bounds.width+1,'A whole card fits the container');
 const longTitle=page.locator('.tasks-ai-follow-up__column--todo h4').filter({hasText:'完整展示较长'});assert.ok(await longTitle.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Long titles wrap without truncation');
 assert.equal(await page.locator('.tasks-ai-follow-up__board-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'No sideways card scrolling');
 assert.ok(await card.locator('h4 button').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>=16,'Title uses readable shared prominence');
 assert.equal(await card.getByText('未关联会话',{exact:true}).count(),1,'Missing chat is passive text');
 await card.locator('.tasks-ai-follow-up__priority').click();
 const description=page.getByRole('textbox',{name:'说明',exact:true});assert.match(await description.inputValue(),/Original task context/);
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 const todo=page.locator('.tasks-ai-follow-up__column--todo .tasks-ai-follow-up__cards');
 async function scrollLane(el:any){const b=await el.boundingBox();assert.ok(b);if(narrowPane){await page.mouse.move(b.x+b.width/2,b.y+120);await page.mouse.wheel(0,330);}else{const cdp=await page.context().newCDPSession(page);const x=b.x+b.width/2,y=b.y+Math.min(b.height-20,220);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let n=1;n<=7;n++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-n*20}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
 await page.waitForFunction(e=>e.scrollTop>64,await el.elementHandle());await el.evaluate(e=>new Promise<void>(resolve=>{let last=e.scrollTop,stable=0;function sample(){const n=e.scrollTop;stable=n===last?stable+1:0;last=n;if(stable>=10)resolve();else requestAnimationFrame(sample);}requestAnimationFrame(sample);}));}
 await scrollLane(todo);const saved=await todo.evaluate(el=>el.scrollTop);assert.equal(await page.locator('.tasks-ai-follow-up__toolbar').isVisible(),false,'Reading returns toolbar space to the cards');
 assert.equal(await page.locator('.tasks-editor').count(),0,'Swiping never opens details');
 await tabs.locator('button[data-value="working"]').click();await tabs.locator('button[data-value="todo"]').click();assert.equal(await todo.evaluate(el=>el.scrollTop),saved,'Switching lanes restores its own scroll');
 await page.getByRole('radio',{name:'列表',exact:true}).click();await page.getByRole('radio',{name:'看板',exact:true}).click();assert.equal(await todo.evaluate(el=>el.scrollTop),saved,'Returning to the board restores position');
 await page.getByRole('button',{name:'筛选',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('combobox',{name:'按负责人筛选',exact:true}).selectOption('member:owner-a');await dialog.getByRole('button',{name:'查看结果',exact:true}).click();
 assert.match(await page.getByRole('button',{name:'筛选',exact:true}).innerText(),/1/);
 await tabs.locator('button[data-value="needs"]').click();assert.equal(await page.locator('.tasks-ai-follow-up__column:visible [data-ai-follow-up-task-id]').count(),2);
 const linked=page.locator('[data-ai-follow-up-task-id="Oldest handoff"]');await linked.locator('.tasks-ai-follow-up__owner').click();const original=await description.inputValue();await description.fill(original+'\nMobile draft kept.');await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 await page.getByRole('button',{name:'看板分组',exact:true}).click();await page.getByRole('menuitemradio',{name:'按优先级',exact:true}).click();
 await linked.locator('h4 button').click();assert.equal(await description.inputValue(),original+'\nMobile draft kept.');await description.fill(original);await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 await linked.getByRole('button',{name:'进入会话：Oldest handoff',exact:true}).click();assert.equal(await page.locator('.tasks-editor').count(),0,'Chat is independent');
 assert.deepEqual(await page.evaluate(()=>window.openedConversations.at(-1)),{serverId:'server-test',threadId:'thread-Oldest handoff'});
 await page.getByRole('button',{name:'筛选',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'清除筛选',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'查看结果',exact:true}).click();assert.doesNotMatch(await page.getByRole('button',{name:'筛选',exact:true}).innerText(),/1/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
 await page.screenshot({path:join(output,`mobile-${width}-${theme}.png`)});mobileChecks.push({width,theme,narrowPane,passed:true});await page.close();
}
assert.equal(mutations,0);await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks,scrollChecks,mobileChecks,realReactAndSqlite:true,fixtureOnly:true,mutationsDuringBrowsing:mutations,paidInference:false},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{await browser?.close();await vite.close();service.close();}
