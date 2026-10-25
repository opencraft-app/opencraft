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
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const sidebarLayout=await SidebarLayoutStore.open({load:async()=>null,save:async()=>{}});
const threads=Array.from({length:60},(_,i)=>({id:'t'+i,title:'Scrolling conversation '+i,project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
const fixture=window.fixture={setThemePreference};const noop=()=>{};const client=new QueryClient();
const navigation={layout:'unified',actions:[{id:'shell.home',title:'Home',icon:'home',active:true,onInvoke:noop}],onOpenSettings:noop,account:{snapshot:{phase:'authenticated',name:'Synthetic employee',avatarUrl:null},onOpen:noop,onRefresh:async()=>{}}};
function App(){const[open,setOpen]=useState(false),[preview,setPreview]=useState(false),[conversation,setConversation]=useState(true);Object.assign(fixture,{setConversation});
return <QueryClientProvider client={client}><AppShell layoutScope='measurement' navigation={navigation} mainContentLayout='thread-edge-scroll' sidebarOpen={open} sidebarWidth={335} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={noop} rightPanel={<div>Preview</div>} rightPanelOpen={preview} rightPanelFullWidth={false} onRightPanelOpenChange={setPreview}
header={<AppShellHeader conversationHeader={conversation} headerAction={<ConversationTaskMenu scope="fixture" serverId="local" threadId="synthetic" title="Measurement" verifyConversation={async()=>{}} onOpenTasks={noop} onRename={async()=>{}}/>} navigationBrand={<span className="application-brand" data-probe-brand style={{whiteSpace:'nowrap',fontSize:14}}>OpenCraft</span>} title='Measurement' project={null} sidebarOpen={open} rightPanelOpen={preview} rightPanelFullWidth={false} showRightPanelAction={true} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>setPreview(v=>!v)} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={['sidebar-toggle','back','forward']}/>}
floatingSidebarHeader={()=>null} leftPanel={<Sidebar threads={threads} activeHostId='local' activeThreadId='t0' sidebarLayout={sidebarLayout} onSelectThread={noop} onNewTask={noop} onOpenSettings={noop} showFooter={false} showStart={false} showNewChat/>}><div data-scroll style={{height:'100%',overflowY:'auto'}}><div className='thread-scroll-surface' style={{paddingInline:20,paddingBottom:20}}><input aria-label='Draft' defaultValue='Keep draft'/>{Array.from({length:80},(_,i)=><p key={i}>Conversation content {i}</p>)}</div></div></AppShell></QueryClientProvider>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-newera-header", esbuild: { jsx: "automatic", target: "esnext" }, optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react-intl", "@radix-ui/react-tooltip", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@radix-ui/react-alert-dialog", "@deepseek-ai/cordis", "@radix-ui/react-context-menu", "marked", "mermaid", "motion/react", "react-dom", "sonner", "tslib"] }, server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [pluginBranding(process.cwd(), ["join.server"]), { name: "header-measurement-fixture", resolveId: id => id === "/header-fixture.tsx" ? id : null, load: id => id === "/header-fixture.tsx" ? source : null, configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url !== "/") return next(); res.setHeader("content-type","text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/header-fixture.tsx"></script>'); }); } }] });

let browser:any;const evidence:any[]=[];
try {
 await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const width of [320,390,820,1280])for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:true,isMobile:width<640});
 await context.addInitScript(()=>{(window as any).__name=(v:unknown)=>v});
 const page=await context.newPage(),errors:string[]=[];page.on('pageerror',(e:Error)=>{errors.push(e.message);console.error(e.stack)});
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
 // Real sidebar consumers: scrolling paint bleeds through the bottom safe
 // region while both independently floating actions keep their old clearance.
 for (const materialPath of ['css','lens']) for (const theme of ['light', 'dark']) {
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  if(materialPath==='css') await context.addInitScript(()=>{const supports=CSS.supports.bind(CSS);CSS.supports=((p:string,v?:string)=>p==='-webkit-backdrop-filter'?true:v===undefined?supports(p):supports(p,v)) as typeof CSS.supports;});
  const page=await context.newPage();await page.goto(vite.resolvedUrls!.local[0]!);await page.getByLabel('Draft').waitFor({timeout:60000});
  await page.evaluate(theme=>{(window as any).fixture.setThemePreference(theme);document.documentElement.dataset.uiDensity='touch';document.documentElement.style.setProperty('--safe-layout-inset-top','47px');document.documentElement.style.setProperty('--safe-layout-inset-bottom','34px');},theme);
  await page.getByRole('button',{name:'Show sidebar',exact:true}).click();await page.locator('.sidebar-new-chat:visible').waitFor();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.app-shell-floating-left-panel')!).opacity==='1');
  const geometry=await page.evaluate(()=>{
   const panel=document.querySelector('.app-shell-floating-left-panel__surface')!,track=document.querySelector('.shell-sidebar__scroll')!,create=document.querySelector('.shell-sidebar__floating-action .sidebar-new-chat')!,settings=document.querySelector('.shell-sidebar__rail-footer [data-surface=settings]')!;
   return{panelBottom:panel.getBoundingClientRect().bottom,trackBottom:track.getBoundingClientRect().bottom,newBottom:create.getBoundingClientRect().bottom,settingsBottom:settings.getBoundingClientRect().bottom,trackPadding:parseFloat(getComputedStyle(track).paddingBottom),frameEdges:panel.getAttribute('data-safe-layout'),actionEdges:create.parentElement!.getAttribute('data-safe-layout')};
  });
  assert.equal(geometry.panelBottom,844);assert.equal(geometry.trackBottom,844-88-34,'retain the later action-band exclusion contract');assert.equal(geometry.newBottom,844-34-16);assert.equal(geometry.settingsBottom,geometry.newBottom);assert.equal(geometry.trackPadding,0);assert.equal(geometry.frameEdges,'top left');assert.equal(geometry.actionEdges,'bottom');
  const oldInset=await page.addStyleTag({content:'.app-shell-floating-left-panel__surface{padding-bottom:34px!important}'});
  assert.equal(await page.locator('.shell-sidebar__scroll').evaluate(e=>e.getBoundingClientRect().bottom),844-88-34-34,'whole-frame inset double-consumes the device safe bottom');await oldInset.evaluate(e=>e.remove());
  // Sample 8px stripes behind the actual controls, not a synthetic glass div.
  // Both the CSS approximation and live optics must soften background detail.
  const stripes=await page.addStyleTag({content:'.shell-sidebar__column[data-navigation-layout=mobile]{position:relative}.glass-backdrop-probe{position:absolute;bottom:0;inset-inline:0;height:150px;z-index:1;pointer-events:none;background:repeating-linear-gradient(90deg,#fff 0 8px,#000 8px 16px)}'});
  await page.evaluate(()=>{const e=document.createElement('div');e.className='glass-backdrop-probe';document.querySelector('.shell-sidebar__column[data-navigation-layout=mobile]')!.append(e)});
  const energy=async(data:Buffer)=>page.evaluate(async url=>{
   const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);const {data:p}=ctx.getImageData(0,0,image.width,image.height);let sum=0,count=0;for(let y=8;y<14;y++)for(let x=15;x<image.width-15;x++){const i=(y*image.width+x)*4,j=i-4;sum+=Math.abs(p[i]!-p[j]!);count++}return sum/count;
  },'data:image/png;base64,'+data.toString('base64'));
  const hideForeground=await page.addStyleTag({content:'.shell-sidebar__floating-action .sidebar-new-chat > :not(.ui-liquid-glass), .shell-sidebar__rail-footer [data-surface=settings] > :not(.ui-liquid-glass){visibility:hidden!important}'});
  const samples=[];
  for(const selector of ['.sidebar-new-chat:visible','.shell-navigation__entrance[data-surface=settings]:visible']){
   const action=page.locator(selector);const lens=action.locator('.ui-liquid-glass');assert.equal(await lens.evaluate(e=>getComputedStyle(e).overflow),'visible','the optical background is not an ellipsis label');
   const softened=await action.screenshot();const remove=await page.addStyleTag({content:'.ui-liquid-glass::before{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'});const clear=await action.screenshot();await remove.evaluate(e=>e.remove());
   const before=await energy(clear),after=await energy(softened);assert(before>5);assert(after<before*.1,JSON.stringify({selector,before,after}));if(materialPath==='lens'){
    const frost=lens.locator('feGaussianBlur[result=frosted-glass]');assert.equal(Number(await frost.getAttribute('stdDeviation')),12);
    await frost.evaluate(e=>e.setAttribute('stdDeviation','0'));const oldEnergy=await energy(await action.screenshot());await frost.evaluate(e=>e.setAttribute('stdDeviation','12'));assert(oldEnergy>before*.1,'removing SVG frost restores the nearly clear transmission');assert(oldEnergy>after*2);samples.push({selector,before,after,oldEnergy});
   }else samples.push({selector,before,after});
  }
  await hideForeground.evaluate(e=>e.remove());await page.evaluate(()=>document.querySelector('.glass-backdrop-probe')!.remove());await stripes.evaluate(e=>e.remove());
  // Real native scrolling can reach the last row above the existing action row.
  for(let n=0;n<5 && await page.getByRole('button',{name:'Show more',exact:true}).count();n++){
   const count=await page.locator('.sidebar-activity-item').count();
   // Playwright scrolling the pager into view can itself trigger native end-pull
   // and retire the button. Invoke the mounted handler without a second scroll;
   // the actual scroll-to-end and last-row reachability are checked below.
   await page.getByRole('button',{name:'Show more',exact:true}).evaluate((e:HTMLButtonElement)=>e.click());
   await page.waitForFunction(count=>document.querySelectorAll('.sidebar-activity-item').length>count||!document.querySelector('.sidebar-activity-more'),count);
  }assert.equal(await page.locator('.sidebar-activity-item').count(),60);
  const end=await page.locator('.shell-sidebar__scroll').evaluate(async e=>{e.scrollTop=e.scrollHeight;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const row=[...e.querySelectorAll('.sidebar-activity-item')].pop()!;return{rowBottom:row.getBoundingClientRect().bottom,newTop:document.querySelector('.sidebar-new-chat')!.getBoundingClientRect().top}});assert(end.rowBottom<=end.newTop,JSON.stringify(end));
  await page.screenshot({path:output+'/sidebar-'+theme+'-'+materialPath+'-safe-bottom.png'});assert.equal(await page.getByLabel('Draft').inputValue(),'Keep draft');evidence.push({sidebar:{theme,materialPath,geometry,samples,end}});await context.close();
 }
 // Initial spacing is scrollable content, not a clipped system-area band.
 for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const page=await context.newPage();await page.goto(vite.resolvedUrls!.local[0]!);await page.getByLabel('Draft').waitFor({timeout:60000});
  await page.evaluate(theme=>{(window as any).fixture.setThemePreference(theme);document.documentElement.dataset.uiDensity='touch';document.documentElement.dataset.touchNewera='on';document.documentElement.style.setProperty('--safe-layout-inset-top','62px');},theme);
  const read=()=>page.evaluate(()=>{const scroller=document.querySelector('[data-scroll]')!,surface=document.querySelector('.thread-scroll-surface')!,header=document.querySelector('.app-shell-header')!,fade=document.querySelector('.main-content-top-fade')!,main=document.querySelector('.main-content-surface')!;return{mainTop:main.getBoundingClientRect().top,scrollTop:scroller.getBoundingClientRect().top,contentTop:surface.getBoundingClientRect().top,firstTop:surface.firstElementChild!.getBoundingClientRect().top,headerTop:header.getBoundingClientRect().top,bottom:main.getBoundingClientRect().bottom,fadeTop:fade.getBoundingClientRect().top,fadeHeight:fade.getBoundingClientRect().height,filter:getComputedStyle(fade).backdropFilter,mask:getComputedStyle(fade).maskImage,pointer:getComputedStyle(fade).pointerEvents}});
  await page.getByLabel('Draft').fill('Keep scroll-under draft');const editor=await page.getByLabel('Draft').elementHandle();
  const start=await read();assert.equal(start.scrollTop,0);assert.equal(start.fadeTop,0);assert.equal(start.headerTop,62);assert.equal(start.bottom,844);assert(start.firstTop>62+48);assert(start.fadeHeight>62+48);assert(start.filter.includes('blur(12px)'));assert.notEqual(start.mask,'none');assert.equal(start.pointer,'none');
  await page.locator('[data-scroll]').evaluate(e=>e.scrollTop=115);const scrolled=await read();assert.equal(scrolled.scrollTop,0);assert(scrolled.firstTop<62,'real content enters the status area');assert.equal(scrolled.headerTop,start.headerTop);assert.equal(scrolled.bottom,start.bottom);
  await page.screenshot({path:output+'/immersive-top-'+theme+'.png'});
  const old=await page.addStyleTag({content:'.app-shell-root.has-browser-safe-layout .main-content-surface{margin-block-start:0!important}'});assert.equal((await read()).scrollTop,62,'old outer allocation clips the top');await old.evaluate(e=>e.remove());
  await page.locator('[data-scroll]').evaluate(e=>e.scrollTop=0);assert.equal((await read()).firstTop,start.firstTop);assert(await editor!.evaluate(e=>e===document.querySelector('input')));assert.equal(await page.getByLabel('Draft').inputValue(),'Keep scroll-under draft');
  await page.evaluate(()=>document.documentElement.style.setProperty('--safe-layout-inset-top','47px'));const resized=await read();assert.equal(resized.scrollTop,0);assert.equal(resized.headerTop,47);assert.equal(resized.firstTop,start.firstTop-15);assert.equal(resized.bottom,844);
  await page.evaluate(()=>(window as any).fixture.setConversation(false));const ordinary=await read();assert.equal(ordinary.mainTop,47,'non-conversation routes keep the normal safe frame');assert(ordinary.scrollTop>=ordinary.mainTop);
  evidence.push({immersiveTop:{theme,start,scrolled,resized,ordinary}});await context.close();
 }
 const fallbackContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 await fallbackContext.addInitScript(()=>{const supports=CSS.supports.bind(CSS);CSS.supports=((property:string,value?:string)=>property==='-webkit-backdrop-filter'?true:value===undefined?supports(property):supports(property,value)) as typeof CSS.supports});
 const fallbackPage=await fallbackContext.newPage();await fallbackPage.goto(vite.resolvedUrls!.local[0]!);await fallbackPage.getByLabel('Draft').waitFor({timeout:60000});
 await fallbackPage.evaluate(()=>{document.documentElement.dataset.uiDensity='touch';document.documentElement.dataset.touchNewera='on'});
 const fallbackLenses=fallbackPage.locator('.app-shell-header .ui-liquid-glass:visible, .app-shell-touch-sidebar-toggle .ui-liquid-glass:visible');
 const fallback=await fallbackLenses.evaluateAll(es=>es.map(e=>({map:!!e.querySelector('feImage'),filter:getComputedStyle(e,'::before').backdropFilter,shadow:getComputedStyle(e).boxShadow,rim:getComputedStyle(e,'::before').boxShadow})));
 assert.equal(fallback.length,2);assert.ok(fallback.every(e=>!e.map&&e.filter.includes('blur(12px)')&&!e.filter.includes('url(')),'syntax-only URL engines must retain the working CSS fallback');
 assert.ok(fallback.every(e=>e.shadow!=='none'&&e.rim!=='none'),'CSS approximation keeps directional edge light and a soft contact shadow');
 await fallbackPage.screenshot({path:output+'/syntax-only-engine-fallback.png'});evidence.push({simulatedPrefixedEngineFallback:fallback});await fallbackContext.close();
 console.log(JSON.stringify({ok:true,evidence}));await writeFile(output+'/result.json',JSON.stringify({ok:true,evidence},null,2));
}finally{await browser?.close();await vite.close()}
