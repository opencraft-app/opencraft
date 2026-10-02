import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";

const { chromium, _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp(join(tmpdir(), "opencraft-skill-autocomplete-"));
const source = `
import React,{useMemo,useState} from 'react';import{createRoot}from'react-dom/client';
import{LocaleRuntime}from'@opencraft/i18n';import{IntlRuntimeProvider}from'@opencraft/i18n/react';
import{CodexComposer}from'@opencraft/codex-composer';import{createComposerController}from'@opencraft/composer-core';
import{searchAppServerSkills,compileSubmitIntent}from'@opencraft/composer-appserver';
import{buildCodexThemeCssProperties,zenCodeThemePalette}from'/packages/design-system/src/theme-engine.ts';
import'/apps/workbench-web/src/styles/app.scss';
document.documentElement.dataset.theme='light';for(const[k,v]of Object.entries(buildCodexThemeCssProperties('light',zenCodeThemePalette.light)))document.documentElement.style.setProperty(k,v);
let mode='ready',submitted=0,extra=0;const requests=[],pending=[],listeners=new Set();
const response=host=>({data:[{cwd:'/workspace/'+host,errors:[],skills:[
{name:'repo-review',path:'/workspace/'+host+'/review/SKILL.md',description:'Review repository changes',enabled:true,scope:'repo',interface:{displayName:host+' Review'}},
{name:'test-runner',path:'/workspace/'+host+'/tests/SKILL.md',description:'Run focused tests',enabled:true,scope:'user'},
{name:'release-review',path:'/workspace/'+host+'/release/SKILL.md',description:'Review release',enabled:true,scope:'system'},
{name:'disabled-skill',path:'/disabled/SKILL.md',description:'Hidden',enabled:false,scope:'user'},
...Array.from({length:extra},(_,i)=>({name:'added-'+i,path:'/workspace/'+host+'/added-'+i+'/SKILL.md',description:'Added live',enabled:true,scope:'user'}))]}]});
function App(){const[host,setHost]=useState('A');const[available,setAvailable]=useState(true);
const controller=useMemo(()=>createComposerController({type:'existing-thread',key:{hostId:host,threadId:'thread'}},{now:Date.now,createId:()=>crypto.randomUUID()}),[host]);
const catalog=useMemo(()=>available?{subscribeSkillsChanged:f=>{listeners.add(f);return()=>listeners.delete(f)},search(q,signal){requests.push({kind:q.kind,query:q.query,host,signal});const snapshot=response(host);const result=()=>q.kind==='skill'?searchAppServerSkills(snapshot,q.query,q.limit):[];
if(mode==='hold')return new Promise(resolve=>pending.push(()=>resolve(result())));if(mode==='error')throw Error('Synthetic catalog failure');return Promise.resolve(mode==='empty'?[]:result());}}:undefined,[host,available]);
window.fixture={locale:locale=>intlRuntime.update({localeOverride:locale}),refresh:n=>{extra=n;listeners.forEach(f=>f())},host:()=>host,mode:v=>mode=v,resolve:()=>{pending.splice(0).forEach(f=>f())},requests:()=>requests.map(({signal,...r})=>({...r,aborted:signal?.aborted})),submitted:()=>submitted,switchHost:()=>setHost('B'),unavailable:()=>setAvailable(false),compile:()=>compileSubmitIntent(controller.createSubmitIntent()).input,document:()=>controller.getSnapshot().draft.document,
codeBlock:()=>controller.dispatch({type:'set-document',document:{version:1,blocks:[{type:'code-block',language:'sh',text:'$'}]}}),
dark:()=>{document.documentElement.dataset.theme='dark';for(const[k,v]of Object.entries(buildCodexThemeCssProperties('dark',zenCodeThemePalette.dark)))document.documentElement.style.setProperty(k,v)}};
return <main style={{padding:40,paddingTop:320,maxWidth:900,margin:'auto'}}><button id='outside' style={{position:'fixed',top:16,left:16}}>Outside editor</button><CodexComposer controller={controller} catalog={catalog} shortcutCommands={host==='A'?[{name:'new',description:'New conversation'},{name:'compress',description:'Compress context'},{name:'status',description:'View status'},{name:'usage',description:'View usage'},{name:'stop',description:'Stop current task'},{name:'help',description:'All commands'}]:undefined} selectionCatalog={{models:[{id:'model',value:'model',label:'Model',description:null,isDefault:true,defaultEffort:null,efforts:[]}],permissionProfiles:[]}} onSubmit={async()=>{submitted++}} onCancel={()=>{}}/></main>}
const intlRuntime=new LocaleRuntime([{locale:'zh-CN',label:'简体中文',load:async()=> (await import('/apps/workbench-web/src/i18n/locales/zh-CN.json')).default}]);
createRoot(document.getElementById('root')).render(<IntlRuntimeProvider runtime={intlRuntime}><App/></IntlRuntimeProvider>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:"error",cacheDir:join("node_modules",`.vite-${basename(output)}`),resolve:{dedupe:["react","react-dom","react-intl"]},optimizeDeps:{include:["react","react-dom/client","react/jsx-runtime","react-intl"]},esbuild:{jsx:"automatic"},server:{host:"127.0.0.1",port:0,hmr:false},plugins:[{name:"skill-autocomplete-fixture",resolveId:id=>id==="/probe.tsx"?id:null,load:id=>id==="/probe.tsx"?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==="/favicon.ico"){res.statusCode=204;res.end();return}if(req.url!=="/")return next();res.setHeader('content-type','text/html');res.end('<title>Skill autocomplete verification</title><div id="root"></div><script type="module" src="/probe.tsx"></script>')})}}]});
let browser:any,desktop:any;const evidence:string[]=[];const errors:string[]=[];
try{
  await vite.listen();const url=`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;let page:any;
  if(process.env.OPENCRAFT_SKILL_ELECTRON_EXECUTABLE){
    const entry=join(output,'main.cjs');await writeFile(entry,`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(output,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:850,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`);
    desktop=await _electron.launch({executablePath:process.env.OPENCRAFT_SKILL_ELECTRON_EXECUTABLE,args:[entry],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=="ELECTRON_RUN_AS_NODE"))});page=await desktop.firstWindow();
  }else{browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});page=await browser.newPage({viewport:{width:1100,height:850}})}
  page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(60000);page.on('pageerror',(e:Error)=>{errors.push(e.message);console.error(e.message)});page.on('console',(m:any)=>{if(m.type()==='error')console.error(m.text())});await page.addInitScript('window.__name=value=>value');await page.goto(url,{waitUntil:'domcontentloaded'});console.log('Composer fixture loaded');
  const editor=page.locator('.codex-composer-editor');const list=page.getByRole('listbox',{name:'skill suggestions'});const options=list.getByRole('option');
  const fill=async(text:string)=>{await editor.fill('');await page.getByRole('listbox').waitFor({state:'hidden'});await editor.fill(text)};
  await page.getByRole('button',{name:'Commands'}).click();
  const commandMenu=page.locator('.codex-composer-shortcut-menu');
  await commandMenu.getByRole('menuitem').first().waitFor();
  assert.equal(await commandMenu.getByRole('menuitem').count(),6);
  await page.screenshot({path:join(output,'hermes-commands.png')});
  await commandMenu.getByRole('menuitem',{name:/\/usage/u}).click();
  await commandMenu.waitFor({state:'hidden'});
  assert.match(await editor.innerText(),/\/usage/u);
  assert.equal(await page.evaluate(()=>(window as unknown as {fixture:{submitted:()=>number}}).fixture.submitted()),0);
  await fill('/');
  const commandList=page.getByRole('listbox',{name:'command suggestions'});
  assert.equal(await commandList.getByRole('option').count(),6);
  assert.equal(await commandList.getByRole('option',{name:/\/usage/u}).count(),1);
  await commandList.getByRole('option').first().click();
  assert.deepEqual((await page.evaluate(()=>(window as unknown as {fixture:{compile:()=>Array<{type:string;text?:string}>}}).fixture.compile())).find((input)=>input.type==='text')?.text?.trim(),'/new');
  await page.evaluate(()=>(window as unknown as {fixture:{locale:(value:string)=>void}}).fixture.locale('zh-CN'));
  await page.getByRole('button',{name:'指令库'}).waitFor();
  await page.setViewportSize({width:375,height:700});
  const shortcutBounds=await page.getByRole('button',{name:'指令库'}).boundingBox();
  assert.ok(shortcutBounds && shortcutBounds.x>=0 && shortcutBounds.x+shortcutBounds.width<=375);
  await page.getByRole('button',{name:'指令库'}).click();
  await commandMenu.getByRole('menuitem').first().waitFor();
  await page.screenshot({path:join(output,'hermes-commands-narrow.png')});
  await page.keyboard.press('Escape');await commandMenu.waitFor({state:'hidden'});
  await page.setViewportSize({width:1100,height:850});
  await page.evaluate(()=>(window as unknown as {fixture:{locale:(value:string)=>void}}).fixture.locale('en-US'));
  evidence.push('Hermes shortcut menu and slash suggestions insert editable commands without sending; localized menu remains reachable at narrow width');
  await fill('$');console.log('Bare dollar entered');await options.nth(2).waitFor();assert.equal(await options.count(),3);assert.match(await options.first().innerText(),/A Review/u);
  assert.equal((await page.evaluate(()=>(window as any).fixture.requests())).at(-1).query,'');
  await page.keyboard.press('ArrowUp');assert.equal(await options.nth(2).getAttribute('aria-selected'),'true');await page.keyboard.press('ArrowDown');
  assert.equal(await options.first().getAttribute('aria-selected'),'true');
  assert.equal(await editor.getAttribute('aria-activedescendant'),await options.first().getAttribute('id'));
  if(await page.evaluate(()=>/Mac/u.test(navigator.platform))){await page.keyboard.press('Control+p');assert.equal(await options.nth(2).getAttribute('aria-selected'),'true');await page.keyboard.press('Control+n');assert.equal(await options.first().getAttribute('aria-selected'),'true')}
  await page.screenshot({path:join(output,'browse.png')});await page.keyboard.press('Enter');
  assert.equal(await editor.locator('[data-kind="skill"]').count(),1);
  assert.deepEqual((await page.evaluate(()=>(window as any).fixture.compile())).find((x:any)=>x.type==='skill'),{type:'skill',name:'repo-review',path:'/workspace/A/review/SKILL.md'});
  assert.equal(await page.evaluate(()=>(window as any).fixture.submitted()),0);evidence.push('bare dollar, source order, enabled only, wrap navigation, Enter inserts canonical protocol identity without sending');
  await fill('Please use $test');await options.first().waitFor();await page.keyboard.press('Tab');assert.equal(await editor.locator('[data-kind="skill"]').count(),1);assert.match(await editor.innerText(),/^Please use/u);
  await fill('$/workspace/A/release');await options.first().waitFor();await options.first().click();assert.equal(await editor.locator('[data-kind="skill"]').count(),1);evidence.push('inline Tab and path search mouse insertion');
  await fill('$');await options.first().waitFor();await page.keyboard.press('Escape');await list.waitFor({state:'hidden'});assert.equal(await editor.innerText(),'$');
  await editor.click();await page.waitForTimeout(80);assert.equal(await list.count(),0);await page.keyboard.type('test');await options.first().waitFor();
  await page.locator('#outside').click();await list.waitFor({state:'hidden'});evidence.push('Escape and blur preserve draft and suppress unchanged query; typing reopens');
  const countBefore=await page.evaluate(()=>(window as any).fixture.requests().length);await fill('@');await page.getByText('Type to search for files',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).fixture.requests().length),countBefore);
  await fill('mail$test');assert.equal(await list.count(),0);evidence.push('bare at-sign still query gated; dollar must have token boundary');
  await fill('Use ($');await options.first().waitFor();await page.keyboard.press('ControlOrMeta+a');await list.waitFor({state:'hidden'});
  await fill('$no-match');await page.getByText('No skills found',{exact:true}).waitFor();await page.keyboard.type(' word');await list.waitFor({state:'hidden'});evidence.push('bracket boundary, selected-text suppression and unmatched whitespace dismissal');
  await page.evaluate(()=>(window as any).fixture.mode('hold'));await fill('$');await page.getByText('Loading skills…',{exact:true}).waitFor();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>(window as any).fixture.submitted()),0);
  await page.keyboard.press('Escape');await page.evaluate(()=>(window as any).fixture.resolve());await page.waitForTimeout(80);assert.equal(await list.count(),0);evidence.push('held loading does not send; late result after Escape cannot reopen');
  await fill('$test');await page.getByText('Loading skills…',{exact:true}).waitFor();await editor.fill('$repo');await page.evaluate(()=>(window as any).fixture.resolve());await options.first().waitFor();assert.match(await options.first().innerText(),/A Review/u);assert.equal(await options.count(),1);evidence.push('late previous-query results cannot replace current query');
  await fill('$');await page.getByText('Loading skills…',{exact:true}).waitFor();await page.evaluate(()=>(window as any).fixture.switchHost());
  await page.waitForFunction(()=>(window as any).fixture.host()==='B');await editor.fill('$');
  assert.equal(await page.getByRole('button',{name:'Commands'}).count(),0);
  await editor.fill('/');await page.getByRole('listbox',{name:'command suggestions'}).getByRole('option').first().waitFor();
  assert.match(await page.getByRole('listbox',{name:'command suggestions'}).getByRole('option').first().innerText(),/\/plan/u);
  await editor.fill('$');
  await page.waitForFunction(()=>(window as any).fixture.requests().some((r:any)=>r.host==='B'&&r.query===''));
  await page.evaluate(()=>(window as any).fixture.resolve());await options.first().waitFor();assert.match(await options.first().innerText(),/B Review/u);evidence.push('Host/controller replacement fences stale results');
  await page.evaluate(()=>(window as any).fixture.mode('empty'));await fill('$');await page.getByText('No skills found',{exact:true}).waitFor();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>(window as any).fixture.submitted()),0);
  await page.evaluate(()=>(window as any).fixture.mode('error'));await fill('$');await page.getByText('Skills unavailable',{exact:false}).waitFor();await page.evaluate(()=>(window as any).fixture.mode('ready'));await page.getByRole('button',{name:'Retry',exact:true}).click();await options.first().waitFor();
  await page.evaluate(()=>(window as any).fixture.dark());await page.screenshot({path:join(output,'dark.png')});evidence.push('empty, failure, retry and dark theme');
  await page.evaluate(()=>(window as any).fixture.refresh(60));await options.nth(62).waitFor();assert.equal(await options.count(),63);assert.equal(await editor.innerText(),'$');
  await page.evaluate(()=>(window as any).fixture.refresh(0));await page.waitForFunction(()=>document.querySelectorAll('[role="option"]').length===3);evidence.push('open picker refreshes without editing draft; 63 entries are all browsable; deleted entries disappear');
  const beforeRefresh=await page.evaluate(()=>(window as any).fixture.requests().length);
  await page.evaluate(()=>{(window as any).fixture.mode('hold');(window as any).fixture.refresh(1)});
  await page.waitForFunction(count=>(window as any).fixture.requests().length>count,beforeRefresh);
  await page.evaluate(()=>(window as any).fixture.refresh(2));
  await page.waitForFunction(count=>(window as any).fixture.requests().length>count+1,beforeRefresh);
  await page.evaluate(()=>(window as any).fixture.resolve());await options.nth(4).waitFor();assert.equal(await options.count(),5);
  await page.evaluate(()=>{(window as any).fixture.mode('ready');(window as any).fixture.refresh(0)});await page.waitForFunction(()=>document.querySelectorAll('[role="option"]').length===3);evidence.push('catalog invalidation fences pre-change in-flight results');
  await page.evaluate(()=>(window as any).fixture.locale('zh-CN'));await list.getByText('技能',{exact:true}).waitFor();assert.match(await options.first().innerText(),/项目/u);assert.equal(await editor.innerText(),'$');
  await page.evaluate(()=>(window as any).fixture.locale('en-US'));evidence.push('localized Skill title/scope without losing draft');
  await editor.dispatchEvent('compositionstart');await editor.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,isComposing:true});assert.equal(await editor.locator('[data-kind="skill"]').count(),0);await editor.dispatchEvent('compositionend');evidence.push('IME Enter does not select or send');
  await page.evaluate(()=>(window as any).fixture.unavailable());await page.getByText('Skills unavailable',{exact:true}).waitFor();evidence.push('missing Host catalog is visible, not silent');
  await page.evaluate(()=>(window as any).fixture.codeBlock());await editor.locator('pre').waitFor();await editor.click();await page.keyboard.press('End');await page.keyboard.type('test');assert.equal(await list.count(),0);evidence.push('dollar in code blocks remains literal');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({output,platform:desktop?'electron':'chromium',evidence,errors}));
}finally{await writeFile(join(output,'report.json'),JSON.stringify({evidence,errors},null,2));await desktop?.close();await browser?.close();await vite.close()}
