import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { pluginBranding } from "../../apps/workbench-web/plugin-branding.vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_NEWERA_HEADER_OUTPUT ?? "/tmp/opencraft-newera-header";
const source = `
import React,{useState}from'react';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{ConversationTaskMenu}from'/apps/workbench-web/src/components/conversation-task-menu.tsx';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const fixture=window.fixture={setThemePreference};const noop=()=>{};const client=new QueryClient();
const navigation={layout:'unified',actions:[{id:'shell.home',title:'Home',icon:'home',active:true,onInvoke:noop}],onOpenSettings:noop,account:{snapshot:{phase:'authenticated',name:'Synthetic employee',avatarUrl:null},onOpen:noop,onRefresh:async()=>{}}};
function App(){const[open,setOpen]=useState(false),[preview,setPreview]=useState(false),[conversation,setConversation]=useState(true);Object.assign(fixture,{setConversation});
return <QueryClientProvider client={client}><AppShell layoutScope='measurement' navigation={navigation} mainContentLayout='thread-edge-scroll' sidebarOpen={open} sidebarWidth={335} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={noop} rightPanel={<div>Preview</div>} rightPanelOpen={preview} rightPanelFullWidth={false} onRightPanelOpenChange={setPreview}
header={<AppShellHeader conversationHeader={conversation} headerAction={<ConversationTaskMenu scope="fixture" serverId="local" threadId="synthetic" title="Measurement" verifyConversation={async()=>{}} onOpenTasks={noop} onRename={async()=>{}}/>} navigationBrand={<span className="application-brand" data-probe-brand style={{whiteSpace:'nowrap',fontSize:14}}>OpenCraft</span>} title='Measurement' project={null} sidebarOpen={open} rightPanelOpen={preview} rightPanelFullWidth={false} showRightPanelAction={true} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>setPreview(v=>!v)} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={['sidebar-toggle','back','forward']}/>}
floatingSidebarHeader={()=>null} leftPanel={<div>Sidebar</div>}><div data-scroll style={{height:'100%',overflowY:'auto'}}><div style={{padding:'90px 20px 20px'}}><input aria-label='Draft' defaultValue='Keep draft'/>{Array.from({length:80},(_,i)=><p key={i}>Conversation content {i}</p>)}</div></div></AppShell></QueryClientProvider>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-newera-header", esbuild: { jsx: "automatic", target: "esnext" }, optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react-intl", "@radix-ui/react-tooltip", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@radix-ui/react-alert-dialog", "@deepseek-ai/cordis", "@radix-ui/react-context-menu", "marked", "mermaid", "motion/react", "react-dom", "sonner", "tslib"] }, server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [pluginBranding(process.cwd(), ["join.server"]), { name: "header-measurement-fixture", resolveId: id => id === "/header-fixture.tsx" ? id : null, load: id => id === "/header-fixture.tsx" ? source : null, configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url !== "/") return next(); res.setHeader("content-type","text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/header-fixture.tsx"></script>'); }); } }] });

let browser:any;const evidence:any[]=[];
try {
 await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const width of [320,390,820,1280])for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:true,isMobile:width<640});
 await context.addInitScript(()=>{(window as any).__name=(v:unknown)=>v});
 const page=await context.newPage(),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
 await page.goto(vite.resolvedUrls!.local[0]!);await page.getByLabel('Draft').waitFor({timeout:60000});await page.evaluate(()=>{document.documentElement.dataset.uiDensity='touch';document.documentElement.dataset.touchNewera='on'});await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);await page.waitForTimeout(350);
 const controls=page.locator('.app-shell-header__window-controls button:visible, .app-shell-header__end-actions button:visible, .app-shell-touch-sidebar-toggle button:visible');
 assert.equal(await controls.count(),3,'sidebar, menu and preview');assert.equal(await page.locator('.thread-header-title').isVisible(),false);assert.equal(await page.locator('.app-shell-header__right-panel-toggle').last().isVisible(),true);
 const bounds=await controls.evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{x:r.x,y:r.y,width:r.width,height:r.height,filter:s.backdropFilter,shadow:s.boxShadow}}));
 for(const b of bounds){assert.ok(b.width>=44&&b.height>=44,JSON.stringify({width,bounds}));assert.ok(b.x>=12&&b.x+b.width<=width-12&&b.y>=0);assert.equal(b.filter,'none','glyph/action planes must not filter their content')}
 assert.ok(bounds.some(b=>b.x>width-90),'menu on trailing edge');
 const lenses=page.locator('.app-shell-header .ui-liquid-glass:visible, .app-shell-touch-sidebar-toggle .ui-liquid-glass:visible');
 assert.equal(await lenses.count(),2,'one circular lens and one shared trailing lens');
 const group=page.locator('.app-shell-header__end-slot .app-shell-header__action-group');
 assert.equal(await group.locator('button').count(),2);
 const optics=await lenses.evaluateAll(es=>es.map(e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e,'::before');return {width:b.width,height:b.height,filter:s.backdropFilter,rim:s.boxShadow,map:!!e.querySelector('feDisplacementMap')}}));
 for(const lens of optics){assert.ok(lens.width>=44&&lens.height>=44);assert.notEqual(lens.filter,'none');assert.notEqual(lens.rim,'none');}
 assert.ok(optics.some(lens=>lens.width>lens.height*1.8),'trailing actions share one capsule');

 const fade=await page.locator('.main-content-top-fade').evaluate(e=>{const s=getComputedStyle(e);return{display:s.display,opacity:s.opacity,pointer:s.pointerEvents,background:s.backgroundImage}});assert.equal(await page.locator('.main-content-frame').evaluate(e=>getComputedStyle(e).marginTop),'0px');assert.equal(fade.display,'block');assert.equal(fade.opacity,'1');assert.equal(fade.pointer,'none');
 await page.getByLabel('Draft').fill('Retained draft');await page.evaluate(()=>{(window as any).editor=document.querySelector('input')});
 const trigger=page.getByRole('button',{name:'Conversation actions',exact:true});await page.getByRole('button',{name:'Open preview panel',exact:true}).click();
 await page.getByRole('button',{name:'Close preview panel',exact:true}).click();
 await trigger.click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Show sidebar',exact:true}).click();await page.waitForTimeout(450);await page.getByRole('button',{name:width<640?'Close sidebar':'Hide sidebar',exact:true}).click();await page.waitForTimeout(450);
 await page.locator('[data-scroll]').evaluate((e:HTMLElement)=>e.scrollTop=220);assert.ok(await page.locator('[data-scroll]').evaluate(e=>e.scrollTop)>200);
 await page.screenshot({path:output+'/'+width+'-'+theme+'.png'});
 if(width===390&&theme==='light'){
  const diagnostic=await page.addStyleTag({content:'.main-content-top-fade{visibility:hidden!important}[data-scroll]{position:relative!important}[data-optical-digits]{position:absolute;inset:0 0 auto;height:1800px;background:white;color:#171717;font:22px/48px system-ui;text-align:right;word-spacing:12px;pointer-events:none}'});
  await page.locator('[data-scroll]').evaluate(e=>{const digits=document.createElement('div');digits.dataset.opticalDigits='';digits.innerHTML=Array.from({length:38},(_,i)=>'<div>'+Array.from({length:7},(_,j)=>(i*7+j)%31+1).join(' ')+'</div>').join('');e.append(digits)});
  const lens=group.locator('.ui-liquid-glass');
  const originalMap=await lens.locator('feImage').getAttribute('href');
  const frames:Buffer[]=[];
  for(let step=0;step<18;step++){
   await page.locator('[data-scroll]').evaluate((e:HTMLElement,top)=>e.scrollTop=top,160+step*7);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   frames.push(await group.screenshot({path:output+'/scroll-'+String(step).padStart(2,'0')+'.png',animations:'allow'}));
   assert.equal(await lens.locator('feImage').getAttribute('href'),originalMap,'scroll must not rebuild the geometry lookup');
  }
  assert.ok(frames.slice(1).every((frame,i)=>!frame.equals(frames[i]!)),'every scroll position must update live transmitted pixels');
  const refracted=await group.screenshot({path:output+'/lens-refraction.png'});
  await lens.locator('feDisplacementMap').evaluate(e=>e.setAttribute('scale','0'));
  const flat=await group.screenshot({path:output+'/lens-flat-comparison.png'});
  assert.ok(!refracted.equals(flat),'curved lookup must change actual composited pixels at equal scattering');
  await lens.locator('feDisplacementMap').evaluate(e=>e.setAttribute('scale','24'));
  await lens.locator('feFlood').evaluate(e=>e.setAttribute('flood-opacity','0'));
  const unadapted=await group.screenshot({path:output+'/lens-no-adaptation.png'});
  assert.ok(!refracted.equals(unadapted),'live local-detail adaptation must affect rendered pixels');
  await lens.locator('feFlood').evaluate(e=>e.setAttribute('flood-opacity','.65'));
  await page.locator('[data-optical-digits]').evaluate(e=>e.remove());
  await diagnostic.evaluate(e=>e.remove());
  evidence.push({continuousOptics:{frames:frames.length,unchangedGeometry:true,refractionComparison:true,localDetailComparison:true}});
 }

 if(width===390){
  const cdp=await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  assert.ok((await lenses.evaluateAll(es=>es.map(e=>getComputedStyle(e,'::before').backdropFilter))).every(v=>v==='none'));
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});await cdp.detach();
 }

 if(width===390){await page.emulateMedia({forcedColors:'active'});assert.ok((await lenses.evaluateAll(es=>es.map(e=>getComputedStyle(e,'::before').backdropFilter))).every(v=>v==='none'));await page.emulateMedia({forcedColors:'none'});}

 await page.evaluate(()=>document.documentElement.dataset.touchNewera='off');assert.equal(await page.locator('.thread-header-title').isVisible(),true);assert.equal(await page.locator('.app-shell-header__right-panel-toggle').last().isVisible(),true);
 await trigger.click();assert.equal(await page.getByRole('menuitem',{name:'Open preview panel',exact:true}).count(),0);await page.keyboard.press('Escape');
 await page.evaluate(()=>{document.documentElement.dataset.uiDensity='compact';document.documentElement.dataset.touchNewera='on'});await page.waitForTimeout(100);assert.equal(await page.locator('.thread-header-title').isVisible(),true);
 await page.evaluate(()=>{document.documentElement.dataset.uiDensity='touch';(window as any).fixture.setConversation(false)});await page.waitForTimeout(100);assert.equal(await page.locator('.thread-header-title').isVisible(),true);
 assert.equal(await page.evaluate(()=>(window as any).editor===document.querySelector('input')),true);assert.equal(await page.getByLabel('Draft').inputValue(),'Retained draft');assert.deepEqual(errors,[]);
 evidence.push({width,theme,bounds,optics,fade,errors});await context.close();
 }
 // Desktop uses the same material at the existing compact action size.
 // Exercise real hover: a root-prefixed caller of hover-capable would compile
 // to an unreachable nested :root and silently lose this feedback.
 for (const theme of ['light', 'dark']) {
  const desktop=await browser.newContext({viewport:{width:1440,height:900},hasTouch:false});
  const page=await desktop.newPage();await page.addInitScript(()=>{(window as any).__name=(v:unknown)=>v});
  await page.goto(vite.resolvedUrls!.local[0]!);await page.getByLabel('Draft').waitFor({timeout:60000});
  await page.evaluate(theme=>{(window as any).fixture.setThemePreference(theme);document.documentElement.dataset.uiDensity='compact'},theme);
  const toggle=page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').last();
  const bounds=await toggle.boundingBox();assert.equal(bounds?.width,28);assert.equal(bounds?.height,28);
  assert.equal(await toggle.locator('.ui-liquid-glass').evaluate(e=>getComputedStyle(e).display),'block');
  const normal=await toggle.evaluate(e=>getComputedStyle(e).backgroundColor);await toggle.hover();
  const hover=await toggle.evaluate(e=>getComputedStyle(e).backgroundColor);assert.notEqual(hover,normal,'desktop glass actions retain hover feedback');
  await page.evaluate(()=>{document.documentElement.dataset.touchInteraction=''});
  assert.equal(await toggle.evaluate(e=>getComputedStyle(e).backgroundColor),normal,'touch input suppresses sticky hover');
  await page.evaluate(()=>{delete document.documentElement.dataset.touchInteraction});await page.mouse.move(700,450);
  const group=page.locator('.app-shell-header__end-slot .app-shell-header__action-group > .ui-liquid-glass');
  assert.equal((await group.boundingBox())?.height,28,'the backdrop must fit compact actions without moving the header group');
  await toggle.click();await page.waitForTimeout(400);const current=page.locator('.shell-sidebar-navigation [data-action-id="shell.home"]:visible');assert.equal(await current.getAttribute('aria-current'),'page');assert.notEqual(await current.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','current navigation remains distinguishable above glass');
  const account=page.locator('.shell-sidebar__rail-footer [data-surface="account"]:visible');await account.click();
  assert.equal(await account.getAttribute('data-state'),'open');await page.waitForFunction((e:HTMLElement)=>getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)',await account.elementHandle());assert.notEqual(await account.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','open account entrance remains distinguishable above glass');await page.keyboard.press('Escape');
  await page.screenshot({path:output+'/1440-'+theme+'-desktop.png'});
  evidence.push({desktop:{theme,width:1440,compactSize:28,hoverFeedback:true,touchHoverSuppressed:true}});await desktop.close();
 }
 const fallbackContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 await fallbackContext.addInitScript(()=>{const supports=CSS.supports.bind(CSS);CSS.supports=((property:string,value?:string)=>property==='-webkit-backdrop-filter'?true:value===undefined?supports(property):supports(property,value)) as typeof CSS.supports});
 const fallbackPage=await fallbackContext.newPage();await fallbackPage.goto(vite.resolvedUrls!.local[0]!);await fallbackPage.getByLabel('Draft').waitFor({timeout:60000});
 await fallbackPage.evaluate(()=>{document.documentElement.dataset.uiDensity='touch';document.documentElement.dataset.touchNewera='on'});
 const fallbackLenses=fallbackPage.locator('.app-shell-header .ui-liquid-glass:visible, .app-shell-touch-sidebar-toggle .ui-liquid-glass:visible');
 const fallback=await fallbackLenses.evaluateAll(es=>es.map(e=>({map:!!e.querySelector('feImage'),filter:getComputedStyle(e,'::before').backdropFilter,shadow:getComputedStyle(e).boxShadow,rim:getComputedStyle(e,'::before').boxShadow})));
 assert.equal(fallback.length,2);assert.ok(fallback.every(e=>!e.map&&e.filter.includes('blur(4px)')&&!e.filter.includes('url(')),'syntax-only URL engines must retain the working CSS fallback');
 assert.ok(fallback.every(e=>e.shadow!=='none'&&e.rim!=='none'),'CSS approximation keeps directional edge light and a soft contact shadow');
 await fallbackPage.screenshot({path:output+'/syntax-only-engine-fallback.png'});evidence.push({simulatedPrefixedEngineFallback:fallback});await fallbackContext.close();
 console.log(JSON.stringify({ok:true,evidence}));await writeFile(output+'/result.json',JSON.stringify({ok:true,evidence},null,2));
}finally{await browser?.close();await vite.close()}
