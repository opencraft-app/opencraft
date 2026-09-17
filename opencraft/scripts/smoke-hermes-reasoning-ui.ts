import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp("/tmp/opencraft-hermes-reasoning-ui-");
const source = `
import React from 'react';import{createRoot}from'react-dom/client';
import{CodexComposer}from'@opencraft/codex-composer';
import{createComposerController}from'@opencraft/composer-core';
import{projectComposerModelChoices}from'@opencraft/workbench-runtime';
import{mapHermesModelOptions}from'/plugins/lightvela-hermes/src/hermes-appserver-bridge/model-catalog.ts';
import'/apps/workbench-web/src/styles/app.scss';
const controller=createComposerController({type:'existing-thread',key:{hostId:'hermes',threadId:'thread'}},{now:Date.now,createId:()=>crypto.randomUUID()});
const models=projectComposerModelChoices(mapHermesModelOptions({model:'glm-5.3-flash',provider:'tokenhub',providers:[{slug:'tokenhub',name:'TokenHub',authenticated:true,models:['glm-5.3-flash'],capabilities:{'glm-5.3-flash':{reasoning:true,can_disable_reasoning:false}}}]}));
window.fixture={controller};createRoot(document.getElementById('root')).render(<div style={{width:720,margin:80}}><CodexComposer controller={controller} selectionCatalog={{models,permissionProfiles:[]}} onSubmit={async()=>{}} onCancel={()=>{}} /></div>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:"error",cacheDir:"node_modules/.vite-hermes-reasoning-ui",resolve:{dedupe:["react","react-dom"]},esbuild:{jsx:"automatic"},server:{host:"127.0.0.1",port:0},plugins:[{name:"hermes-reasoning-fixture",resolveId:id=>id==="/probe.tsx"?id:null,load:id=>id==="/probe.tsx"?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==="/favicon.ico"){res.statusCode=204;res.end();return;}if(req.url!=="/")return next();res.setHeader("content-type","text/html");res.end('<div id="root"></div><script type="module" src="/probe.tsx"></script>');});}}]});
await vite.listen();const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
try{const page=await browser.newPage({viewport:{width:1000,height:700}}),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));page.on("console",message=>{if(message.type()==="error")errors.push(message.text())});await page.addInitScript('window.__name=value=>value');await page.goto(vite.resolvedUrls!.local[0]!,{timeout:60000});const trigger=page.locator('.codex-composer-mode--intelligence');try{await trigger.waitFor({timeout:30000});}catch(error){throw new Error(`Composer did not mount: ${await page.locator('body').innerText()} | ${errors.join(' | ')}`,{cause:error})}await trigger.click();const menu=page.locator('.codex-composer-selection-menu--intelligence[role="menu"]');const text=await menu.innerText();assert.match(text,/glm-5\.3-flash/u);assert.match(text,/Light/u);assert.match(text,/High/u);assert.match(text,/Max/u);assert.doesNotMatch(text,/None|Minimal|Medium|Extra High|Ultra/u);await menu.screenshot({path:join(output,'glm-5.3-reasoning-menu.png')});await menu.getByText('Max',{exact:true}).click();const effort=await page.evaluate(()=>(window as any).fixture.controller.getSnapshot().draft.selections.effort);assert.equal(effort,'max');assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,effort,evidence:output}));}finally{await browser.close();await vite.close();}
