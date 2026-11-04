import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_VISUALIZATION_OUTPUT ?? ".local/inline-visualization";
const artifact = process.env.OPENCRAFT_VISUALIZATION_FILE ? await readFile(process.env.OPENCRAFT_VISUALIZATION_FILE, "utf8") : null;
const fragment = `<div id="chart"><h2>Inline diagram</h2><button class="btn" id="change">Change view</button><p id="value">Initial view</p></div><script>document.getElementById('change').onclick=()=>{document.getElementById('value').textContent='Updated view';};try{parent.document.body.dataset.escaped='yes'}catch{};fetch('https://example.com/blocked').catch(()=>{});</script>`;
const ref = '\uE200visualize\uE202{"path":"/workspace/output/diagram.html","title":"Inline diagram"}\uE201';
const fixture = `import React from 'react';import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';import{WebChatDocument,WebChatRenderRuntimeProvider,createWebChatRenderRuntime}from'@opencraft/chat-render-web';import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';import'/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();const runtime=await createWebChatRenderRuntime();const loader=async({signal})=>{await new Promise(r=>setTimeout(r,20));signal?.throwIfAborted();const source=URL.createObjectURL(new Blob([${JSON.stringify(artifact ?? fragment)}]));return{source,release:()=>URL.revokeObjectURL(source)}};function App(){const[source,setSource]=React.useState(${JSON.stringify(ref)});const[theme,setTheme]=React.useState('light');window.fixture={setSource,setTheme:t=>{setThemePreference(t);setTheme(t)}};return <WebChatRenderRuntimeProvider runtime={runtime}><main style={{maxWidth:736,margin:'auto'}}><textarea aria-label="Draft" defaultValue="Keep draft"/><WebChatDocument documentId="message" hostId="fixture-host" conversationId="fixture-thread" source={source} theme={theme} loadMediaSource={loader}/></main></WebChatRenderRuntimeProvider>}createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ root:process.cwd(),configFile:false,logLevel:'error',cacheDir:'node_modules/.vite-visualization',resolve:{dedupe:['react','react-dom','react-intl']},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react-intl','marked']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?fixture:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser;
try {
 await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true});
 const results=[];
 for(const touch of [false,true])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width:touch?390:1280,height:900},hasTouch:touch});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${vite.httpServer!.address()!.port}`);
  await page.waitForFunction(()=>!!(window as any).fixture);await page.evaluate(t=>(window as any).fixture.setTheme(t),theme);
  const frame=page.frameLocator('iframe[title="Inline diagram"]');
  if(!artifact){await frame.locator('#change').waitFor();if(touch)await frame.locator('#change').tap();else await frame.locator('#change').click();assert.equal(await frame.locator('#value').textContent(),'Updated view');await page.evaluate(()=>(window as any).fixture.setTheme('dark'));assert.equal(await frame.locator('#value').textContent(),'Updated view');await page.evaluate(t=>(window as any).fixture.setTheme(t),theme);}
  else {await frame.locator('#vela-split-diagram').waitFor();if(touch)await frame.locator('#vela-update-button').tap();else await frame.locator('#vela-update-button').click();assert.equal(await frame.locator('#vela-update-button').getAttribute('aria-pressed'),'true');}
  if(!artifact){assert.ok(await frame.locator('#value').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));}
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  assert.equal(await page.locator('body').getAttribute('data-escaped'),null);
  assert.equal(await page.locator('textarea').inputValue(),'Keep draft');
  const bounds=await page.locator('iframe').boundingBox();assert.ok(bounds && bounds.x>=0 && bounds.width<=(touch?390:1280));
  await page.screenshot({path:`${output}/${touch?'touch':'mouse'}-${theme}.png`,fullPage:true});
  if(!artifact){await page.evaluate(()=>(window as any).fixture.setSource('Before\n\uE200visualize\uE202{"path":'));await page.waitForFunction(()=>document.querySelector('iframe')===null);assert.ok(!(await page.locator('main').textContent())?.includes('visualize'));await page.evaluate(s=>(window as any).fixture.setSource(s),ref);await frame.locator('#change').waitFor();}
  assert.deepEqual(errors,[]);results.push({touch,theme,bounds});await page.close();
 }
 await writeFile(`${output}/result.json`,JSON.stringify({passed:true,artifact:!!artifact,results},null,2));console.log(JSON.stringify({passed:true,cases:results.length,artifact:!!artifact}));
}finally{await browser?.close();await vite.close();}
