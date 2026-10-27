import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_MATERIAL_REPORT ?? await mkdtemp(join(tmpdir(), "opencraft-frost-"));
const compiledCss = process.env.OPENCRAFT_MATERIAL_CSS ? await readFile(process.env.OPENCRAFT_MATERIAL_CSS, "utf8") : null;
let source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import * as Menu from '@opencraft/design-system-web/dropdown-menu';
import {ModalSurface} from '/apps/workbench-web/src/components/modal/modal-surface.tsx';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '/apps/workbench-web/src/components/modal/modal.scss';
import '/apps/workbench-web/src/styles/context-menu.scss';
import '/frost-probe.scss';
function App(){const [open,setOpen]=useState(false),[presentation,setPresentation]=useState('dialog'),[appearance,setAppearance]=useState('default');
window.fixture={theme:(mode,custom)=>{document.documentElement.dataset.theme=mode;
const base=opencraftNeutralThemePalette[mode], definition=custom?{...base,surfaces:{popover:mode==='light'?'#f4e8df':'#25292c'}}:base;
for(const [key,value]of Object.entries(buildOpenCraftThemeCssProperties(mode,definition)))document.documentElement.style.setProperty(key,value);
},show:(kind='dialog',look='default')=>{setPresentation(kind);setAppearance(look);setOpen(true)}};
return <main><div className="scene"><span>CONVERSATION · 128,420</span></div><button id="open" onClick={()=>setOpen(true)}>Open panel</button>
<Menu.Root><Menu.Trigger id="menu">More</Menu.Trigger><Menu.Portal><Menu.Content className="workbench-context-menu" aria-label="Session actions"><Menu.Item className="workbench-context-menu__item">Session usage</Menu.Item><Menu.Item className="workbench-context-menu__item">Close</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>
<div className="frost-floating">+</div><div className="frost-search">Search</div>
{open&&<ModalSurface label="Session overview" presentation={presentation} appearance={appearance} onDismiss={()=>setOpen(false)}>
<section style={{padding:28}}><h2>Session overview</h2><p>Readable frost · 中性雾面玻璃</p><p>128,420 tokens</p><input aria-label="Draft" defaultValue="Keep this draft"/><button>Inspect turn</button></section></ModalSurface>}</main>}
createRoot(document.getElementById('root')).render(<App/>);`;
// The same real consumers can validate minified release CSS. Source-only checks
// cannot detect a minifier collapsing vendor aliases into an unsupported property.
if (compiledCss !== null) source = source.replaceAll(/^import '\/apps\/workbench-web\/.*\.scss';$/gm, '');
const styles = `@use '@opencraft/design-system/material.web' as material;
.scene{position:fixed;inset:0;z-index:-1;background:linear-gradient(35deg,#dda973,#a0c4b9 45%,#bd9cc3)}
.scene span{position:absolute;top:40%;left:8%;font-size:60px;opacity:.5}body{margin:0;color:var(--color-text)}main{padding:24px}.frost-floating{position:fixed;bottom:24px;left:24px;border-radius:50%;width:44px;height:44px;display:grid;place-items:center;@include material.floating}
.frost-search{position:fixed;bottom:24px;right:24px;padding:12px;border-radius:16px;@include material.surface(menu)}`;
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:"error",resolve:{dedupe:["react","react-dom"]},cacheDir:"node_modules/.vite-frost-probe",esbuild:{jsx:"automatic"},server:{host:"127.0.0.1",port:0,hmr:false},plugins:[{
  name:"frost-probe",resolveId:id=>["/frost-probe.tsx","/frost-probe.scss"].includes(id)?id:null,
  load:id=>id==="/frost-probe.tsx"?source:id==="/frost-probe.scss"?styles:null,
  configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==="/compiled.css" && compiledCss!==null){res.setHeader("content-type","text/css");res.end(compiledCss);return;}if(req.url!=="/")return next();res.setHeader("content-type","text/html");res.end('<html><head>'+(compiledCss!==null?'<link rel="stylesheet" href="/compiled.css"/>':'')+'<meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/frost-probe.tsx"></script></body></html>')})},
}]});
let browser: any;
const evidence: unknown[] = [], errors: string[] = [];
try {
  await mkdir(output,{recursive:true});await vite.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage();page.on('pageerror',(error:Error)=>errors.push(error.message));
  await page.addInitScript("window.__name=value=>value");
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
  await page.locator('#open').waitFor();
  const read=()=>page.locator('.modal-surface').evaluate((node:HTMLElement)=>{const style=getComputedStyle(node);return{fill:style.backgroundColor,filter:style.backdropFilter,shadow:style.boxShadow,width:node.getBoundingClientRect().width,view:innerWidth,focus:node.contains(document.activeElement)}});
  for(const width of [390,1280])for(const mode of ['light','dark'])for(const custom of [false,true]){
    await page.setViewportSize({width,height:844});
    await page.evaluate(({mode,custom}:any)=>(window as any).fixture.theme(mode,custom),{mode,custom});
    await page.locator('#open').click();await page.locator('.modal-surface').waitFor();
    const state=await read();assert(state.filter.includes('32px'));assert(state.width<=width);assert(state.focus);
    assert(custom?!state.fill.includes('color(srgb'):state.fill.includes(mode==='light'?'0.64':'0.62'),JSON.stringify(state));
    assert.equal(await page.locator('.modal-surface__scrim').evaluate((n:HTMLElement)=>getComputedStyle(n).backdropFilter),'none');
    await page.locator('.scene').evaluate((n:HTMLElement)=>n.style.background='');
    const before=await page.locator('.modal-surface').screenshot();
    await page.locator('.scene').evaluate((n:HTMLElement)=>n.style.background='#d6744c');
    const after=await page.locator('.modal-surface').screenshot();
    if(!custom)assert(!before.equals(after),'The real panel must transmit its actual backdrop');
    await page.locator('.scene').evaluate((n:HTMLElement)=>n.style.background='');
    await page.screenshot({path:join(output,`${mode}-${width}-${custom?'extension':'neutral'}.png`)});
    await page.locator('input').fill('Preserved draft');await page.setViewportSize({width,height:640});
    assert.equal(await page.locator('input').inputValue(),'Preserved draft');
    await page.keyboard.press('Escape');await page.locator('.modal-surface').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.activeElement?.id==='open');
    await page.locator('#menu').click();const menu=page.getByRole('menu');await menu.waitFor();
    assert((await menu.evaluate((n:HTMLElement)=>getComputedStyle(n).backdropFilter)).includes('32px'));
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');await menu.waitFor({state:'detached'});
    await page.waitForFunction(()=>document.activeElement?.id==='menu');
    assert(await page.locator('.frost-floating').evaluate((n:HTMLElement)=>getComputedStyle(n).boxShadow.split(/,(?![^()]*\))/).every(s=>s.includes('inset'))));
    evidence.push({width,mode,custom,...state});
  }
  // Existing opaque form/fullscreen policies remain independent of frost.
  for(const [presentation,appearance]of [['fullscreen','default'],['dialog','utility']]){
    await page.evaluate(([kind,look]:any)=>(window as any).fixture.show(kind,look),[presentation,appearance]);await page.locator('.modal-surface').waitFor();assert.equal((await read()).filter,'none');await page.keyboard.press('Escape');
  }
  // Exercise unsupported-filter, reduced-transparency and forced-colors branches
  // through Chromium's actual CSS media/supports evaluation, not source text.
  const cdp=await page.context().newCDPSession(page);
  for(const fallback of ['unsupported','reduced','forced']){
    if(fallback==='unsupported')await cdp.send('Emulation.setEmulatedVisionDeficiency',{type:'none'});
    await cdp.send('Emulation.setEmulatedMedia',{features:fallback==='reduced'?[{name:'prefers-reduced-transparency',value:'reduce'}]:fallback==='forced'?[{name:'forced-colors',value:'active'}]:[]});
    let interceptor: any;
    if(fallback==='unsupported'){
      // Reload the real styles with @supports declarations made false, as on an
      // older engine. All declarations and consumers remain the actual source.
      interceptor=async(route:any)=>{const response=await route.fetch();let body=await response.text();body=body.replaceAll('backdrop-filter:', 'unsupported-backdrop-filter:');await route.fulfill({response,body})};
      await page.route(/\.(scss|css)(\?|$)/,interceptor);await page.reload();await page.locator('#open').waitFor();
    }
    await page.evaluate(()=>(window as any).fixture.theme('dark',false));await page.locator('#open').click();await page.locator('.modal-surface').waitFor();
    const state=await read();assert.equal(state.filter,'none',fallback);assert(!state.fill.includes('color(srgb'),fallback);evidence.push({fallback,...state});
    await page.keyboard.press('Escape');if(interceptor){await page.unroute(/\.(scss|css)(\?|$)/,interceptor);await page.reload();await page.locator('#open').waitFor();}
  }
  assert.deepEqual(errors,[]);await writeFile(join(output,'report.json'),JSON.stringify({evidence,errors},null,2));console.log(JSON.stringify({output,scenarios:evidence.length,errors}));
} finally {await browser?.close();await vite.close();}
