import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {useAsyncNotices} from '/apps/workbench-web/src/components/async-notices.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
function App(){const[right,setRight]=useState(false);const notices=useAsyncNotices();window.headerFixture={setRight,notices};return <AppShell
 navigation={{settingsActive:false,actions:[],account:{snapshot:{name:'Test user',phase:'ready',avatarUrl:null,planLabel:'',usageRemainingPercent:100},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}},onOpenSettings:()=>{}}}
 header={<AppShellHeader title='Conversation' project={null} headerActionCount={1}
 headerAction={<button className='chrome-button' aria-label='Conversation actions'>…</button>}
 sidebarOpen={false} rightPanelOpen={right} rightPanelFullWidth={false}
 onToggleSidebar={()=>{}} onToggleRightPanel={()=>setRight(!right)} onHome={()=>{}}
 canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
 floatingSidebarHeader={()=>null} leftPanel={null} rightPanel={<p>Preview</p>} rightPanelOpen={right} rightPanelFullWidth={false}
 sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={()=>{}} onSidebarExpand={()=>{}} onSidebarResizeEnd={()=>{}}
 windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onRightPanelOpenChange={setRight}>
 <input aria-label='Draft'/></AppShell>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:"error",resolve:{dedupe:["react","react-dom"]},esbuild:{jsx:"automatic",target:"esnext"},server:{host:"127.0.0.1",port:0},plugins:[{name:"notification-header-fixture",resolveId:id=>id==="/probe.tsx"?id:null,load:id=>id==="/probe.tsx"?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/")return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/probe.tsx"></script>')})}}]});
let browser:any;
try {
  await vite.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]) {
    const page=await browser.newPage({viewport:{width,height:844},hasTouch:width===390,isMobile:width===390});
    const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript('window.__name = value => value');
    await page.goto(vite.resolvedUrls!.local[0]!);
    await page.getByRole('button',{name:'Conversation actions',exact:true}).waitFor();
    assert.equal(await page.locator('.notice-center-trigger').count(),0);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    for(const open of [false,true,false]) {
      await page.evaluate(open=>(window as any).headerFixture.setRight(open),open);
      await page.waitForFunction(()=>{
        const measure=document.querySelector('.app-shell-header__end-measure')!.getBoundingClientRect();
        const actions=document.querySelector('.app-shell-header__end-slot .app-shell-header__end-actions')!.getBoundingClientRect();
        const buttons=document.querySelectorAll('.app-shell-header__end-slot .chrome-button');
        const menu=buttons[0]!.getBoundingClientRect(),toggle=buttons[1]!.getBoundingClientRect();
        return Math.abs(measure.width-actions.width)<1 && buttons.length===2 && menu.width>0 && menu.right<=toggle.left+1;
      });
      const toggles = await page.evaluate(() => {
        const left = document.querySelector<HTMLButtonElement>('.app-shell-header button[data-app-shell-sidebar-trigger]')!;
        const right = document.querySelector<HTMLButtonElement>('.app-shell-header__end-slot button.app-shell-header__right-panel-toggle')!;
        const style = (element: HTMLElement) => { const css = getComputedStyle(element); return {color:css.color,background:css.backgroundColor,width:css.width,height:css.height}; };
        return {left:style(left),right:style(right)};
      });
      assert.deepEqual(toggles.right,toggles.left,'left and right panel entrances share neutral colors and hit target in both visibility states');
      await page.waitForTimeout(250);
      const toggle=await page.locator('button.app-shell-header__right-panel-toggle').boundingBox();
      const menu=await page.getByRole('button',{name:'Conversation actions',exact:true}).boundingBox();
      assert.ok(toggle && menu && menu.x+menu.width<=toggle.x+1 && toggle.x+toggle.width<=width+1,`menu and panel control remain accessible: ${JSON.stringify({width,open,toggle,menu})}`);
    }
    await page.evaluate(()=>(window as any).headerFixture.notices.error({key:'test',message:'Action failed'}));
    await page.getByText('Action failed',{exact:true}).waitFor();
    assert.equal(await page.locator('.notice-center-trigger').count(),0);
    await page.getByLabel('Draft').fill('Still usable');
    assert.equal(await page.getByLabel('Draft').inputValue(),'Still usable','Toast does not block page editing');
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log(JSON.stringify({ok:true,realAppShellHeader:true,widths:[390,1440],reservedSlots:1,bell:false,nonmodalToast:true}));
} finally { await browser?.close();await vite.close(); }
