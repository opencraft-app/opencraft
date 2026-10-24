import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SEARCH_ARTIFACTS ?? ".local/content-search";
const fixture = `
import React,{useState,useMemo} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {Conversation} from '/apps/workbench-web/src/components/conversation.tsx';
import {Context} from '@deepseek-ai/cordis';
import {TimelineBlockRendererProvider,TimelineBlockRendererRegistryService} from '@opencraft/timeline-render-react';
import {BuiltinTimelineRendererPlugin} from '/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import {createConversationKey,createDefaultTimelineProjectorRegistry,projectTimeline} from '@opencraft/chat-core';
import {ConversationSearch} from '/apps/workbench-web/src/components/conversation-search.tsx';
import {createAppServerContentSearchSource} from '/apps/workbench-web/src/runtime/conversation-content-search.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();window.calls=[];window.selected=[];
const ctx=new Context();await ctx.plugin(TimelineBlockRendererRegistryService);await ctx.plugin(BuiltinTimelineRendererPlugin);
const registry=createDefaultTimelineProjectorRegistry();
const makeTurn=id=>({id,status:'complete',items:[{id:id==='old-turn'?'old-user':id+'-user',type:'userMessage',payload:{type:'userMessage',content:[{type:'text',text:'Question '+id}]}},{id:id==='old-turn'?'old-answer':id+'-answer',type:'agentMessage',payload:{type:'agentMessage',text:id==='old-turn'?'正文 matching historical answer':'Long reply '+('historical content '.repeat(30)),phase:'final_answer'}}]});

const threads=[{id:'title',title:'Title match',updatedAt:5,connectionHostId:'a',serverOrigin:{label:'Alpha'},interactionAvailable:true}];
const sources=['a','b','broken','unsupported','offline'].map((id,index)=>{
 let fail=true;return createAppServerContentSearchSource({key:id,hostId:id,label:['Alpha','Beta','Broken','Unsupported','Offline'][index],available:id!=='offline',supported:id!=='unsupported',assertCurrent:()=>{},
 protocol:{request:async(method,params)=>{window.calls.push({id,method,params});
 if(id==='broken'&&fail&&params.searchTerm==='正文'){fail=false;throw new Error('synthetic network failure')}
 if(method==='thread/searchOccurrences')return {data:[{turnId:'old-turn',itemId:'old-answer'}],nextCursor:null};
 if(params.searchTerm==='stale')await new Promise(resolve=>setTimeout(resolve,700));
 if(params.searchTerm==='empty'||id==='broken')return {data:[],nextCursor:null};
 return {data:[{thread:{id:params.cursor?'older':'same',name:params.searchTerm==='stale'?'Stale result':'Unrelated title',updatedAt:index+1},snippet:'正文 body match '+(params.cursor?'older':params.searchTerm)+' <img src=x onerror=alert(1)>'}],nextCursor:id==='a'&&!params.cursor?'older':null};}},
 project:thread=>({id:thread.id,title:thread.name,updatedAt:thread.updatedAt,connectionHostId:id,serverOrigin:{label:id==='a'?'Alpha':'Beta'},interactionAvailable:true})})});
function App(){const[open,setOpen]=useState(false);const[target,setTarget]=useState(null);const[hydrated,setHydrated]=useState(false);
const source=useMemo(()=>{const anchor={id:'old-anchor',turnKey:'old-turn',itemId:'old-user',isLoaded:false,order:0,label:'Old question',isHeartbeat:false};let snapshot={revision:0,generation:'fixture',phase:'empty',completeness:'partial',anchors:[],error:null};const listeners=new Set();return {beginResume:()=>setTimeout(()=>{snapshot={...snapshot,revision:1,phase:'ready',completeness:'complete',anchors:[anchor]};for(const fn of listeners)fn()},150),getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},prepare:async()=>{},loadPreview:async()=>null,prepareTarget:async()=>{setHydrated(true);return {turnKey:'old-turn',itemId:'old-user',projectionRevision:1,anchorId:anchor.id,generation:'fixture',targetVersion:'fixture'}},dispose:()=>{}}},[]);
const timeline=useMemo(()=>projectTimeline({key:createConversationKey('fixture','thread'),revision:hydrated?1:0,authoritative:true,phase:'live',turns:[...(hydrated?[makeTurn('old-turn')]:[]),...Array.from({length:35},(_,n)=>makeTurn('recent-'+n))]},registry),[hydrated]);
window.fixture={setThemePreference};return <><textarea aria-label='Composer draft' defaultValue='Keep draft'/><button onClick={()=>setOpen(true)}>Search</button><ConversationSearch enabled open={open} onOpenChange={setOpen} threads={threads} loading={false} sources={sources} onSelectThread={(host,id,target)=>{window.selected.push({host,id,target});source.beginResume();setTarget(target)}}/><div style={{height:'70vh'}}><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><Conversation timeline={timeline} scrollPolicy=${JSON.stringify(process.env.OPENCRAFT_SEARCH_SCROLL_POLICY ?? 'natural')} onVisibleContentReady={()=>document.documentElement.dataset.conversationReady='true'} navigationSource={source} searchTarget={target}/></TimelineBlockRendererProvider></div></>};
createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ configFile:false, root:process.cwd(), logLevel:'error', resolve:{dedupe:['react','react-dom']},
  cacheDir:'node_modules/.vite-content-search-smoke', esbuild:{jsx:'automatic',target:'esnext'}, server:{host:'127.0.0.1',port:0},
  plugins:[{name:'content-search-smoke',resolveId:id=>id==='/content-probe.tsx'?id:null,load:id=>id==='/content-probe.tsx'?fixture:null,
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/content-probe.tsx"></script>');});}}] });
let browser:any;
try {
 await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 const errors:string[]=[];
 for(const mobile of [false,true]) for(const theme of ['light','dark']){
  if(process.env.OPENCRAFT_SEARCH_CASE && process.env.OPENCRAFT_SEARCH_CASE!==theme+'-'+(mobile?'touch':'desktop'))continue;
  console.log(JSON.stringify({mobile,theme,step:'start'}));
  const page=await browser.newPage({viewport:{width:mobile?390:1200,height:mobile?844:900},hasTouch:mobile,reducedMotion:'reduce'});
  page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript('window.__name=value=>value');
  await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);await page.waitForFunction(()=>document.documentElement.dataset.conversationReady==='true');await page.evaluate(()=>document.fonts.ready);await page.getByRole('button',{name:'Search',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Search conversations',exact:true});const input=dialog.getByRole('combobox');
  await page.evaluate(theme=>window.fixture.setThemePreference(theme),theme);
  await input.fill('stale');await page.waitForFunction(()=>window.calls.some(x=>x.params.searchTerm==='stale'));
  await input.fill('正文');await dialog.locator('.conversation-search__snippet').first().waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-search__sources > div')].some(x=>x.textContent.includes('Message search failed')));
  await dialog.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.conversation-search__sources')?.textContent?.includes('Message search failed'));
  assert.equal(await dialog.getByRole('option').count(),2);assert.equal(await dialog.locator('img').count(),0);
  assert.equal(await dialog.getByText('Stale result',{exact:true}).count(),0);
  assert.match(await dialog.textContent()??'',/Title search only/);assert.match(await dialog.textContent()??'',/Not connected/);
  await dialog.getByRole('button',{name:'Load more matches',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[role="option"]').length===3);
  await page.screenshot({path:output+'/'+theme+'-'+(mobile?'touch':'desktop')+'.png'});
  await dialog.getByRole('option').filter({hasText:'older'}).click();await dialog.waitFor({state:'hidden'});
  const selected=await page.evaluate(()=>window.selected[0]);assert.equal(selected.host,'a');assert.equal(selected.id,'older');assert.equal(selected.target.itemId,'old-answer');
  const historical=page.locator('[data-content-search-unit-key="old-user"]');await historical.waitFor();
  await page.waitForFunction(()=>{const e=document.querySelector('[data-content-search-unit-key="old-user"]');const r=e?.getBoundingClientRect();return r&&r.top>=document.querySelector('.thread-scroll').getBoundingClientRect().top-1&&r.top<document.querySelector('.thread-scroll').getBoundingClientRect().bottom},null,{timeout:10000}).catch(async error=>{await page.screenshot({path:output+'/position-failed.png'});console.log(await page.evaluate(()=>({target:document.querySelector('[data-content-search-unit-key=old-user]')?.getBoundingClientRect().toJSON(),viewport:document.querySelector('.thread-scroll')?.getBoundingClientRect().toJSON(),notice:document.querySelector('.conversation-search-position')?.textContent,scrollTop:document.querySelector('.thread-scroll')?.scrollTop})));throw error});
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.conversation-search-position').count(),0);
  assert.ok(await historical.evaluate(e=>{const r=e.getBoundingClientRect(),v=e.closest('.thread-scroll').getBoundingClientRect();return r.top>=v.top-1&&r.top<v.bottom}));
  assert.equal(await page.getByLabel('Composer draft').inputValue(),'Keep draft');
  await page.getByRole('button',{name:'Search',exact:true}).click();await input.fill('empty');
  await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent?.includes('incomplete'));
  assert.equal(await dialog.getByRole('option').count(),0);assert.equal(await dialog.getByText('No matching conversations',{exact:true}).count(),0);
  const calls=await page.evaluate(()=>window.calls);assert.ok(calls.every(x=>['thread/search','thread/searchOccurrences'].includes(x.method)));assert.ok(calls.every(x=>!['unsupported','offline'].includes(x.id)));
  await page.keyboard.press('Escape');await page.close();
 }
 assert.deepEqual(errors,[]);console.log('Conversation body-search dialog: light/dark desktop/touch, stale queries, duplicates, snippet safety, retry, paging, unsupported/offline, locators and drafts passed');
}finally{await browser?.close();await vite.close()}
