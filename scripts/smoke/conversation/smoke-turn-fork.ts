import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_FORK_ARTIFACTS ?? ".local/turn-fork";
const fixture = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {ConversationTurn} from '/apps/workbench-web/src/components/conversation.tsx';
import {ConversationDocumentContext} from '/apps/workbench-web/src/components/conversation/document-context.ts';
import {ConversationEntryMotionContext} from '/apps/workbench-web/src/components/conversation/entry-motion.ts';
import {Context} from '@deepseek-ai/cordis';
import {TimelineBlockRendererProvider,TimelineBlockRendererRegistryService} from '@opencraft/timeline-render-react';
import {BuiltinTimelineRendererPlugin} from '/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import {createConversationKey,createDefaultTimelineProjectorRegistry,projectTimeline,groupTimelineFramesByTurn} from '@opencraft/chat-core';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const ctx=new Context();await ctx.plugin(TimelineBlockRendererRegistryService);await ctx.plugin(BuiltinTimelineRendererPlugin);
const turns=groupTimelineFramesByTurn(projectTimeline({key:createConversationKey('fixture','parent'),revision:1,authoritative:true,phase:'live',turns:['first','middle','last','running'].map((id,index)=>({id,status:index===3?'streaming':'complete',items:[{id:id+'-user',type:'userMessage',payload:{content:[{type:'text',text:'Question '+id}]}},{id:id+'-reply',type:'agentMessage',payload:{text:'Answer '+id,phase:'final_answer'}}]}))},createDefaultTimelineProjectorRegistry()));
window.calls=[];
function App(){const[capable,setCapable]=useState(true);window.fixture={setCapable,setThemePreference};return <><textarea aria-label='Draft' defaultValue='Keep draft'/><ConversationEntryMotionContext.Provider value={false}><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><ConversationDocumentContext.Provider value={{conversationId:'parent',hostId:'fixture',cwd:null,theme:'light',onForkTurn:capable?id=>{window.calls.push(id);return new Promise((resolve,reject)=>{window.resolveFork=resolve;window.rejectFork=reject})}:undefined}}>{turns.map(turn=><ConversationTurn key={turn.turnKey} turn={turn} isMostRecentTurn={turn.turnId==='running'} threadDetailLevel='STEPS_COMMANDS' activityCollapsedById={{}} onActivityCollapsedChange={()=>{}}/>)}</ConversationDocumentContext.Provider></TimelineBlockRendererProvider></ConversationEntryMotionContext.Provider></>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ configFile:false, root:process.cwd(), logLevel:"error", resolve:{dedupe:["react","react-dom"]}, cacheDir:"node_modules/.vite-turn-fork", esbuild:{jsx:"automatic",target:"esnext"}, server:{host:"127.0.0.1",port:0}, plugins:[{name:"turn-fork-fixture",resolveId:id=>id==="/probe.tsx"?id:null,load:id=>id==="/probe.tsx"?fixture:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/")return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="max-width:800px;margin:auto;padding:20px"></div><script type="module" src="/probe.tsx"></script>')})}}] });
let browser: any;
try {
  await vite.listen(); await mkdir(output,{recursive:true});
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  for(const touch of [false,true])for(const theme of ['light','dark']) {
    const context=await browser.newContext({viewport:{width:touch?390:1100,height:844},hasTouch:touch,isMobile:touch});
    const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.goto(vite.resolvedUrls!.local[0]!);
    const buttons=page.getByRole('button',{name:'Branch from here',exact:true});await buttons.first().waitFor();
    await page.getByText('Answer middle',{exact:true}).waitFor();
    await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
    assert.equal(await buttons.count(),3);
    const middle=page.locator('[data-turn-key="middle"]').getByRole('button',{name:'Branch from here',exact:true});
    if(!touch)await middle.hover();
    await page.waitForFunction(()=>{const el=document.querySelector('[data-turn-key="middle"] [data-turn-fork]');let opacity=1;for(let n=el;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);return opacity>0.9});
    if(touch)await middle.tap();else await middle.click();
    await page.waitForFunction(()=>(window as any).calls.length===1);
    assert.equal(await middle.isDisabled(),true);assert.equal(await middle.getAttribute('aria-busy'),'true');
    await page.evaluate(()=>{const button=document.querySelector('[data-turn-key="middle"] button[aria-label="Branch from here"]') as HTMLButtonElement;button.click();button.click()});
    assert.deepEqual(await page.evaluate(()=>(window as any).calls),['middle']);
    await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'-pending.png',fullPage:true});
    await page.evaluate(()=>(window as any).rejectFork(new Error('Fixture fork rejected')));
    await page.getByRole('alert').filter({hasText:'Fixture fork rejected'}).waitFor();
    assert.equal(await middle.isEnabled(),true);assert.equal(await page.getByRole('textbox',{name:'Draft'}).inputValue(),'Keep draft');
    const first=page.locator('[data-turn-key="first"]').getByRole('button',{name:'Branch from here',exact:true});
    if(touch)await first.tap();else await first.click();
    await page.waitForFunction(()=>(window as any).calls.length===2);
    await page.evaluate(()=>(window as any).resolveFork());
    await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
    await page.evaluate(()=>(window as any).fixture.setCapable(false));
    await page.waitForFunction(()=>document.querySelectorAll('button[aria-label="Branch from here"]').length===0);
    assert.deepEqual(await page.evaluate(()=>(window as any).calls),['middle','first']);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({touch,theme,passed:true,exactHistoricalIds:['middle','first'],streamingForks:0}));
    await context.close();
  }
} finally {await browser?.close();await vite.close();}
