import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import sharp from "sharp";
import { pluginBranding } from "../../../apps/workbench-web/plugin-branding.vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_GESTURE_ARTIFACT_DIR ?? "/tmp/opencraft-mobile-sidebar-gesture";
import { readFileSync } from "node:fs";
import { DEFAULT_APPLICATION_BRANDING, isApplicationBranding } from "@opencraft/extension-contract";
// Trusted local test data; public probes run without any downstream checkout.
const fixtureBranding = process.env.OPENCRAFT_SMOKE_BRANDING_FILE
  ? JSON.parse(readFileSync(process.env.OPENCRAFT_SMOKE_BRANDING_FILE, "utf8"))
  : DEFAULT_APPLICATION_BRANDING;
assert.ok(isApplicationBranding(fixtureBranding));
const boundaryImage = process.env.OPENCRAFT_GESTURE_MODAL_ONLY === "1"
  ? "![Boundary preview](data:image/png;base64," + (await sharp({ create: { width: 900, height: 600, channels: 3, background: "#286fbb" } }).png().toBuffer()).toString("base64") + ")"
  : "";
const arbitrationScrollSelectors = ['.chat-code-block__scroller','.chat-table-scroller','.thread-shell-output__output > pre','.unregistered-rich-scroll','.unregistered-nested-inner'];
const arbitrationMarkdown = [
  "```text", "Reading a long code line: " + "column_value ".repeat(70), "```", "",
  "| " + Array.from({length:8},(_,i)=>"Field "+i).join(" | ") + " |",
  "| " + Array.from({length:8},()=>"---").join(" | ") + " |",
  ...Array.from({length:4},(_,row)=>"| "+Array.from({length:8},(_,i)=>"Cell_"+row+"_"+i+"_readable_value").join(" | ")+" |"),
].join("\n");
const source = `
import{bindInteractionDensity}from'/apps/workbench-web/src/runtime/interaction-density';
import React,{useState,useEffect,useSyncExternalStore} from 'react';
import {CommandBlock} from '/apps/workbench-web/src/components/conversation-renderers/activity/command-and-review-renderers.tsx';
import {WebChatDocument} from '@opencraft/chat-render-web';
import {WorkbenchPresentationRootProvider} from '/apps/workbench-web/src/components/workbench-presentation-root.tsx';
import appStyles from '/apps/workbench-web/src/styles/app.scss?inline';
import mediaStyles from '/packages/chat-render-web/src/renderers/media/image.scss?inline';

import {SettingsNavigation} from '/apps/workbench-web/src/components/settings-page.tsx';
import {createApplicationNavigation} from '/apps/workbench-web/src/runtime/workbench-navigation.ts';
import {ApplicationBrand} from '/apps/workbench-web/src/components/application-brand.tsx';
const joinBrand = ${JSON.stringify(fixtureBranding)};
const commandBlock={type:'command-execution',id:'gesture-command',sourceItemIds:['gesture-command'],callId:null,command:'tail -3 /fixture/artifact.log',cwd:'/fixture',processId:null,startedAtMs:null,turnInProgress:false,output:${JSON.stringify(Array.from({length:30},(_,i)=>`line ${i}: `+'column_value '.repeat(70)).join("\n"))},exitCode:0,durationMs:100,actions:[],automaticApprovalReviews:[],status:'complete'};
import * as Dialog from '@radix-ui/react-dialog';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
import {AppShellHeader,AppShellNavigationControls} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {MobileSidebarContentProbe} from '/tests/fixtures/mobile-sidebar-content.tsx';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const threads=Array.from({length:35},(_,i)=>({id:'thread-'+i,title:'协同对话标题字符完整显示测试'+i,project:'workspace',pinned:true,status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'fixture',connectionHostLabel:'Synthetic server',...legacyDirectServerProjectionFromHost({hostId:'fixture',hostKind:'remote-ssh',label:'Synthetic server'})}));
const stationaryProbe=${JSON.stringify(process.env.OPENCRAFT_GESTURE_INPLACE_ONLY === "1" || process.env.OPENCRAFT_GESTURE_STACK_ONLY === "1")};
const brand=<ApplicationBrand branding={joinBrand}/>;
let mounts=0;const actions=[];
const navigationRouter=createApplicationNavigation(null,{mode:'memory'});
const contributionSnapshot={settingsPages:[]};
const contributions={subscribe:()=>()=>{},getSnapshot:()=>contributionSnapshot};
function Context({showNewChat=true}){const[selected,setSelected]=useState('thread-0');window.selectFixtureThread=setSelected;useEffect(()=>{mounts++},[]);return <Sidebar showStart={false} showFooter={false} showNewChat={showNewChat} threads={threads} activeHostId='fixture' activeThreadId={selected} sidebarLayout={layout} onNewTask={()=>actions.push('New chat')} onOpenSettings={()=>{}} onSelectThread={(_host,id)=>actions.push(id)}/>}
function App(){const preferences=useUiPreferencesRuntime();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);const route=useSyncExternalStore(navigationRouter.subscribe,navigationRouter.getSnapshot).applicationRoute;const[open,setOpen]=useState(false),[modal,setModal]=useState(false),[showNewChat,setShowNewChat]=useState(true),[conversationHeader,setConversationHeader]=useState(false);window.fixture={setDensity:value=>preferences.set('interface.touchFriendly',value),sidebarOpen:()=>open,setOpen,setModal,setShowNewChat,setConversationHeader,setThemePreference,returnToChat:()=>navigationRouter.openChat(),route:()=>navigationRouter.getSnapshot().applicationRoute,mounts:()=>mounts,actions};
const navigation={layout:'unified',account:{snapshot:{phase:'authenticated',name:'Synthetic employee',avatarUrl:null},onOpen:()=>actions.push('Account'),onRefresh:async()=>{}},settingsActive:route.kind==='settings',onOpenSettings:()=>{actions.push('Settings');navigationRouter.openSettings();},actions:[...(stationaryProbe?[{id:'shell.search',title:'Search conversations',icon:'search',onInvoke:()=>setModal(true)}]:[]),{id:'shell.home',title:'Home',icon:'home',onInvoke:()=>actions.push('Home')},{id:'opencraft.tasks.navigation',title:'Tasks',icon:'columns',onInvoke:()=>actions.push('Tasks')},{id:'example.workspace.navigation',title:'Collaboration',icon:'messages',onInvoke:()=>actions.push('Collaboration')},{id:'skills',title:'Skills, extensions and cloud tools',icon:'sparkles',onInvoke:()=>actions.push('Skills')}]};
return <><Dialog.Root open={modal} onOpenChange={setModal}><Dialog.Portal container={presentationRoot}><Dialog.Overlay style={{position:'fixed',inset:0,zIndex:100}}/><Dialog.Content style={{position:'fixed',inset:40,zIndex:101,background:'white'}}><Dialog.Title>Gesture exclusion probe</Dialog.Title><Dialog.Description>Touches stay in the dialog.</Dialog.Description>${process.env.OPENCRAFT_GESTURE_ARBITRATION_ONLY === "1" ? `<div style={{height:200,overflow:'auto'}}><WebChatDocument documentId="modal-arbitration" allowWideBlocks={false} source={${JSON.stringify(arbitrationMarkdown)}}/></div>` : ""}</Dialog.Content></Dialog.Portal></Dialog.Root><AppShell sidebarTransientEnabled={${process.env.OPENCRAFT_GESTURE_SAFE_LAYOUT_ONLY === "1" ? "false" : "true"}} navigation={navigation} layoutScope={route.kind} mainContentLayout={conversationHeader?'thread-edge-scroll':'default'} sidebarOpen={open} sidebarWidth={335} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader conversationHeader={conversationHeader} navigationBrand={stationaryProbe ? brand : undefined} title='Workspace' project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={stationaryProbe} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={()=> stationaryProbe ? <AppShellNavigationControls brand={brand} hostRole='transient' sidebarOpen={false} canGoBack={false} canGoForward={false} onToggleSidebar={()=>{}} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} actions={['sidebar-toggle']}/> : <div style={{height:'100%',display:'flex',alignItems:'center',padding:12}}>Conversations</div>}
leftPanel={route.kind==='settings'?<SettingsNavigation section={route.slug} presentation='sidebar' extensionContributions={contributions} profiles={[]} machines={[]} activeHostId='' onBack={()=>navigationRouter.openChat()} onSectionChange={slug=>{actions.push('Settings:'+slug);navigationRouter.openSettings(slug);}}/>:<Context showNewChat={showNewChat}/>}>
<div style={{height:'100%',width:'100%',overflowY:'auto'}} data-main-scroll>
${process.env.OPENCRAFT_GESTURE_CONTENT_ONLY === "1" ? `<MobileSidebarContentProbe record={action=>actions.push(action)}/>` : ""}
${process.env.OPENCRAFT_GESTURE_MODAL_ONLY === '1' ? `<WebChatDocument documentId="modal-input-probe" source={${JSON.stringify(boundaryImage)}} />` : ''}
${process.env.OPENCRAFT_GESTURE_ARBITRATION_ONLY === "1" ? `<div data-gesture-rich style={{padding:16}}><WebChatDocument documentId="arbitration" allowWideBlocks={false} source={${JSON.stringify(arbitrationMarkdown)}}/><div data-gesture-command><CommandBlock block={commandBlock}/></div></div>` : ""}
<div data-gesture-pad style={{height:240,display:'grid',placeItems:'center'}}>Swipe in content</div>
<input aria-label='Draft' defaultValue='Keep this draft' style={{margin:12,width:'80%'}}/>
<pre data-horizontal style={{overflowX:'auto',whiteSpace:'pre',margin:12}}>A deliberately long code line that scrolls horizontally and keeps its own touch gestures. A deliberately long code line that scrolls horizontally.</pre>
<div data-editor contentEditable suppressContentEditableWarning style={{margin:12}}>Editable draft</div>
${process.env.OPENCRAFT_GESTURE_COMPOSITING_ONLY === "1" ? `<div className="composer-utility-scroll-area" data-overflow="true"><div className="composer-utility-scroll-area__content" style={{width:650}}>Masked horizontal composer utilities</div></div>` : ""}
{Array.from({length:30},(_,i)=><p key={i} style={{padding:12}}>Message {i}</p>)}
</div></AppShell></>}
const host=document.getElementById('root');
const shadow=new URLSearchParams(location.search).has('shadow')?host.attachShadow({mode:'open'}):null;
const presentationRoot=shadow?document.createElement('div'):host;
if(shadow){const style=document.createElement('style');style.textContent=appStyles+mediaStyles;shadow.append(style,presentationRoot);presentationRoot.style.cssText='width:100vw;height:100dvh';}
createIntlTestRoot(presentationRoot).render(<WorkbenchPresentationRootProvider target={presentationRoot}><App/></WorkbenchPresentationRootProvider>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), publicDir: "apps/workbench-web/public", logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-mobile-sidebar-gesture", esbuild: { jsx: "automatic", target: "esnext" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react-intl", "@radix-ui/react-dialog", "@radix-ui/react-tooltip", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@radix-ui/react-alert-dialog", "@deepseek-ai/cordis", "tslib"] },
  plugins: [pluginBranding(process.env.OPENCRAFT_SMOKE_BRANDING_WORKSPACE ?? process.cwd(), []), { name: "mobile-sidebar-gesture-fixture", resolveId: id => id === "/gesture-probe.tsx" ? id : null, load: id => id === "/gesture-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (new URL(req.url??"/","http://fixture").pathname !== "/") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><div id="root"></div><script type="module" src="/gesture-probe.tsx"></script>'); }); },
  }],
});
let browser: any;
const evidence: any[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const reducedMotion of (process.env.OPENCRAFT_GESTURE_MOTION ? [process.env.OPENCRAFT_GESTURE_MOTION] : ["no-preference", "reduce"])) for (const theme of ["light", "dark"]) for (const shadow of (process.env.OPENCRAFT_GESTURE_MODAL_ONLY === '1' ? [false,true] : [false])) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => { errors.push(e.message); console.error(e.stack); });
    page.on("requestfailed", request => console.error("fixture request failed", request.url(), request.failure()));
    page.on("console", message => { if (message.type() === "error") console.error("fixture console", message.text()); });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}${shadow?"?shadow=1":""}`, {timeout:60000});
    await page.waitForFunction(() => !!(window as any).fixture, null, { timeout: 30000 });
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    // Simulate notch/Home Indicator CSS env projections, which Chromium's mobile emulation leaves at zero.
    await page.evaluate(() => { document.documentElement.style.setProperty('--safe-layout-inset-top','47px'); document.documentElement.style.setProperty('--safe-layout-inset-bottom','34px'); });
    await page.waitForTimeout(250);
    if (process.env.OPENCRAFT_GESTURE_SAFE_LAYOUT_ONLY === '1') {
      const input = page.getByRole('textbox', { name: 'Draft', exact: true });
      await input.fill('Safe layout independent of sidebar');
      await input.evaluate(e => { (window as any).safeDraft = e; (e as HTMLInputElement).setSelectionRange(2, 8); });
      for (const width of [390, 1200]) {
        await page.setViewportSize({width, height:844});
        const geometry = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('.app-shell-root')!;
          const row = root.querySelector<HTMLElement>('.app-shell-row')!;
          const header = root.querySelector<HTMLElement>('.app-shell-header')!;
          return {mobile:root.classList.contains('has-mobile-sidebar-gestures'), edges:row.dataset.safeLayout,
            rootTop:root.getBoundingClientRect().top,rowTop:row.getBoundingClientRect().top,
            padding:getComputedStyle(row).paddingTop,headerTop:header.getBoundingClientRect().top};
        });
        assert.equal(geometry.mobile,false); assert.equal(geometry.edges,'top');
        assert.equal(geometry.rowTop,geometry.rootTop); assert.equal(geometry.padding,'47px');
        assert.equal(geometry.headerTop,47);
        evidence.push({theme,reducedMotion,width,geometry});
      }
      await page.evaluate(() => document.documentElement.style.setProperty('--safe-layout-inset-top','0px'));
      assert.equal(await page.locator('.app-shell-row').evaluate(e=>getComputedStyle(e).paddingTop),'0px');
      assert.equal(await input.evaluate(e=>e===(window as any).safeDraft),true);
      assert.equal(await input.inputValue(),'Safe layout independent of sidebar');
      assert.deepEqual(await input.evaluate(e=>[(e as HTMLInputElement).selectionStart,(e as HTMLInputElement).selectionEnd]),[2,8]);
      assert.deepEqual(errors,[]);await context.close();continue;
    }
    if (process.env.OPENCRAFT_GESTURE_COMPOSITING_ONLY !== '1') await page.evaluate(()=>{(window as any).touchReceipts=[];for(const type of ['touchstart','touchmove','touchend','touchcancel'])document.addEventListener(type,(e:Event)=>{const t=e as TouchEvent;const list=document.querySelector<HTMLElement>('.app-shell-floating-left-panel .shell-sidebar__scroll');if(list&&list.scrollTop>0)(window as any).lastSidebarScroll=list.scrollTop;(window as any).touchReceipts.push({type,cancelable:t.cancelable,prevented:t.defaultPrevented,target:(t.target as Element)?.className,x:t.touches[0]?.clientX,y:t.touches[0]?.clientY,open:document.querySelector('.app-shell-floating-left-panel')?.getBoundingClientRect().x,selection:window.getSelection()?.toString()});},false);});
    const cdp = await context.newCDPSession(page);
    const touch = async (type: string, x = 0, y = 250, second = false, timestamp?: number) => cdp.send("Input.dispatchTouchEvent", { type, ...(timestamp === undefined ? {} : { timestamp }), touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y, id: 1 }, ...(second ? [{ x: x + 20, y: y + 20, id: 2 }] : [])] });
    const drag = async (from: number, to: number, y = 250, slow = true) => {
      await touch('touchStart',from,y);
      for(let i=1;i<=8;i++){ await touch('touchMove',from+(to-from)*i/8,y); await page.waitForTimeout(20); }
      if(slow) await page.waitForTimeout(140);
      await touch('touchEnd'); await page.waitForTimeout(reducedMotion==='reduce'?50:650);
    };
    const panel = page.locator('.app-shell-floating-left-panel');
    const closed = async () => {if(await panel.count())console.log(JSON.stringify(await page.evaluate(()=>(window as any).touchReceipts.slice(-20))));assert.equal(await panel.count(),0);};
    const opened = async () => { const box=await panel.boundingBox(); assert.ok(box&&Math.abs(box.x)<1,JSON.stringify(box)); return box!; };
    const expandScrollFixture = async () => {
      // The production list is paginated. Exercise long-list scrolling through
      // its real action rather than assuming all fixture rows start mounted.
      const more=panel.getByRole('button',{name:'Show more',exact:true});
      while(await more.count()) {
        const before = await panel.locator('.sidebar-activity-item').count();
        await more.tap();
        // Wait for the transition's new rows before locating the next action;
        // the previous button may remain disabled until its final removal.
        await page.waitForFunction(before => document.querySelectorAll('.app-shell-floating-left-panel .sidebar-activity-item').length > before && !document.querySelector('.app-shell-floating-left-panel .sidebar-activity-pagination[aria-busy="true"]'), before, { timeout: 8000 });
      }
    };
    await closed();
    if (process.env.OPENCRAFT_GESTURE_MODAL_ONLY === '1') {
      const preview=page.getByRole('button',{name:'Boundary preview',exact:true});
      const dialog=page.locator('dialog[open]');
      const row=page.locator('.app-shell-row');
      const unchanged=async()=>{assert.equal(await panel.count(),0);assert(Math.abs(await row.evaluate(e=>e.getBoundingClientRect().x))<1);};
      for(const kind of ['native','radix']) {
        if(kind==='native')await preview.tap();else await page.evaluate(()=>(window as any).fixture.setModal(true));
        if(kind==='native')await dialog.waitFor();else await page.getByRole('dialog',{name:'Gesture exclusion probe'}).waitFor();
        // Start in letterboxing, not on image pixels. Verify held frames too.
        await touch('touchStart',65,90);
        for(let i=1;i<=8;i++){await touch('touchMove',65+28*i,90);await page.waitForTimeout(25);await unchanged();}
        await touch('touchEnd');await page.waitForTimeout(150);await unchanged();
        if(kind==='native'){await dialog.getByRole('button',{name:'Close image preview'}).click();await dialog.waitFor({state:'hidden'});}else await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        // The same contact revoked on modal open must never later commit.
        const pad=await page.locator('[data-gesture-pad]').boundingBox();assert.ok(pad);const shellY=pad.y+pad.height/2;
        await touch('touchStart',65,shellY);await touch('touchMove',135,shellY);await page.waitForTimeout(80);assert(await panel.count()>0);
        if(kind==='native')await preview.evaluate((e:HTMLElement)=>e.click());else await page.evaluate(()=>(window as any).fixture.setModal(true));
        await page.waitForTimeout(reducedMotion==='reduce'?100:650);await unchanged();
        await touch('touchMove',300,shellY);await touch('touchEnd');await page.waitForTimeout(150);await unchanged();
        if(kind==='native'){await dialog.getByRole('button',{name:'Close image preview'}).click();await dialog.waitFor({state:'hidden'});}else await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        await drag(65,320,shellY);await opened();await drag(200,45,shellY);await closed();
      }
      assert.deepEqual(errors,[]);await page.screenshot({path:`${output}/modal-${shadow?'shadow':'document'}-${theme}-${reducedMotion}.png`});
      evidence.push({theme,reducedMotion,shadow,nativeAndRadix:true,greyHeldFrames:true,heldContactRevoked:true,freshShellInputRestored:true,errors});await context.close();continue;
    }
    if (process.env.OPENCRAFT_GESTURE_ARBITRATION_ONLY === '1') {
      const row = page.locator('.app-shell-row');
      const main = page.locator('[data-main-scroll]');
      const measurements: any[] = [];
      await page.locator('[data-gesture-command] button[aria-expanded]').click();
      // Insert ordinary DOM after mount: no registration attribute or React hook.
      await page.locator('[data-gesture-rich]').evaluate((root:HTMLElement)=>{
        const reader=document.createElement('div');reader.className='unregistered-rich-scroll';reader.style.cssText='overflow:auto;white-space:nowrap;margin:16px 0;padding:8px';reader.textContent='Unregistered reader '+ 'column_value '.repeat(100);root.append(reader);
        const outer=document.createElement('div');outer.className='unregistered-nested-outer';outer.style.cssText='overflow:auto;margin:16px 0';
        const inner=document.createElement('div');inner.className='unregistered-nested-inner';inner.style.cssText='overflow:auto;width:700px;white-space:nowrap;padding:8px';inner.textContent='Nested reader '+ 'column_value '.repeat(150);outer.append(inner);root.append(outer);
        const exclusive=document.createElement('div');exclusive.className='unregistered-native-owner';exclusive.dataset.sidebarGesture='ignore';exclusive.style.cssText='overflow:auto;white-space:nowrap;width:240px;height:45px;margin:16px 0';exclusive.textContent='Native owner '+ 'column_value '.repeat(70);outer.append(exclusive);
      });
      const settle = async () => { await page.waitForTimeout(650); };
      const at = async (locator: any, offset = 120) => {
        await locator.scrollIntoViewIfNeeded();
        await locator.evaluate((node: HTMLElement, left: number) => { node.scrollLeft = left; }, offset);
        const box = await locator.boundingBox(); assert.ok(box && box.width > 150);
        const x = Math.max(40, box.x + 35), y = box.y + Math.min(box.height/2, 28);
        assert.equal(await locator.evaluate((node: HTMLElement) => node.scrollWidth > node.clientWidth+100), true);
        assert.equal(await locator.evaluate((node: HTMLElement) => getComputedStyle(node).touchAction), 'auto');
        return {x,y,left:await locator.evaluate((node: HTMLElement) => node.scrollLeft)};
      };
      if (process.env.OPENCRAFT_GESTURE_MOTION_PROBE === '1') {
        const scenes=[];
        for (const selector of arbitrationScrollSelectors) for (const delay of [60,85,180]) {
          const scroller=page.locator('[data-gesture-rich] '+selector),p=await at(scroller),t=Date.now()/1000;
          await touch('touchStart',p.x,p.y,false,t);await page.waitForTimeout(delay);
          await touch('touchMove',p.x+32,p.y+1,false,t+delay/1000);await page.waitForTimeout(20);
          assert.equal(await scroller.evaluate((e:HTMLElement)=>e.scrollLeft),p.left,'a delayed/coalesced first move cannot commit reading prematurely');
          assert.ok(Math.abs((await row.boundingBox())!.x)<1);
          await touch('touchMove',p.x+80,p.y+2,false,t+(delay+30)/1000);await page.waitForTimeout(20);
          assert.ok((await row.boundingBox())!.x>60,'measured fast motion wins before content moves');
          assert.equal(await scroller.evaluate((e:HTMLElement)=>e.scrollLeft),p.left);
          await touch('touchCancel');await settle();await closed();
          scenes.push({selector,delay,observedFastSegment:true,contentStable:true});
        }
        for (const selector of arbitrationScrollSelectors) {
          const scroller=page.locator('[data-gesture-rich] '+selector),p=await at(scroller),t=Date.now()/1000;
          await touch('touchStart',p.x,p.y,false,t);
          await touch('touchMove',p.x+32,p.y+1,false,t+.06);await page.waitForTimeout(20);
          await touch('touchMove',p.x+40,p.y+1,false,t+.17);await page.waitForTimeout(20);
          assert.ok(Math.abs((await scroller.evaluate((e:HTMLElement)=>e.scrollLeft))-(p.left-40))<2,'observed slow motion still commits reading');
          await touch('touchMove',p.x+100,p.y+1,false,t+.19);await page.waitForTimeout(20);
          assert.ok(Math.abs((await row.boundingBox())!.x)<1,'committed reading still cannot change owners');
          await touch('touchCancel');await settle();await closed();
          scenes.push({selector,slowReading:true,committedOwnerLocked:true});
        }
        assert.deepEqual(errors,[]);assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
        evidence.push({theme,reducedMotion,motionEvidence:scenes});await context.close();continue;
      }
      if (process.env.OPENCRAFT_GESTURE_REST_PROBE === '1') {
        const scenes=[];
        for (const selector of arbitrationScrollSelectors) for (const rest of [0,180]) {
          const scroller=page.locator('[data-gesture-rich] '+selector);
          const p=await at(scroller);const t=Date.now()/1000;
          await touch('touchStart',p.x,p.y,false,t);
          if(rest) await page.waitForTimeout(rest);
          for (const [i,dx] of [15,25,50,180].entries()) {
            await touch('touchMove',p.x+dx,p.y+1,false,t+rest/1000+.02*(i+1));
            await page.waitForTimeout(20);
          }
          const trace=await page.evaluate(()=>(window as any).touchReceipts);
          await writeFile(`${output}/${theme}-${reducedMotion}-${selector.slice(1)}-${rest}-trace.json`,JSON.stringify({trace,left:await scroller.evaluate((e:HTMLElement)=>e.scrollLeft),row:await row.boundingBox()},null,2));
          assert.ok((await row.boundingBox())!.x>100,'small initial samples and a rested contact must still reveal sidebar');
          assert.equal(await scroller.evaluate((e:HTMLElement)=>e.scrollLeft),p.left,'pending reservation never writes content');
          await touch('touchCancel');await settle();await closed();
          scenes.push({selector,rest,sidebar:true,contentStable:true});
        }
        for (const selector of arbitrationScrollSelectors) {
          const scroller=page.locator('[data-gesture-rich] '+selector),p=await at(scroller);
          await touch('touchStart',p.x,p.y);await page.waitForTimeout(180);
          await touch('touchMove',p.x+35,p.y+1);await page.waitForTimeout(20);
          assert.equal(await scroller.evaluate((e:HTMLElement)=>e.scrollLeft),p.left);
          await touch('touchEnd');await settle();await closed();
          assert.ok(Math.abs((await scroller.evaluate((e:HTMLElement)=>e.scrollLeft))-(p.left-35))<2,'a single motion sample finishes as local reading');
          scenes.push({selector,singleSampleReading:true});
        }
        assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
        assert.deepEqual(errors,[]);evidence.push({theme,reducedMotion,earlySamples:scenes});
        await context.close();continue;
      }
      for (const selector of arbitrationScrollSelectors) {
        const scroller = page.locator('[data-gesture-rich] '+selector);
        const p = await at(scroller);
        await touch('touchStart',p.x,p.y); await touch('touchMove',p.x+50,p.y+2);
        await page.waitForTimeout(35);
        const held = await row.boundingBox();
        assert.ok(held && held.x > 30, 'fast drag from overflowing rich content must move the sidebar');
        assert.equal(await scroller.evaluate((node: HTMLElement)=>node.scrollLeft),p.left,'navigation never scrolls content');
        await touch('touchMove',p.x+180,p.y+3); await touch('touchEnd'); await settle(); await opened();
        assert.equal(await scroller.evaluate((node: HTMLElement)=>node.scrollLeft),p.left);
        await page.keyboard.press('Escape'); await settle(); await closed();

        const slow = await at(scroller);
        await touch('touchStart',slow.x,slow.y); await page.waitForTimeout(125);
        await touch('touchMove',slow.x+25,slow.y); await page.waitForTimeout(100);
        await touch('touchMove',slow.x+35,slow.y); await page.waitForTimeout(30);
        const localLeft = await scroller.evaluate((node: HTMLElement)=>node.scrollLeft);
        assert.ok(Math.abs(localLeft-(slow.left-35))<2,'slow drag scrolls the same content');
        assert.ok(Math.abs((await row.boundingBox())!.x)<1,'content movement never moves sidebar');
        await touch('touchMove',slow.x+100,slow.y); await page.waitForTimeout(30);
        assert.ok(Math.abs((await row.boundingBox())!.x)<1,'later acceleration cannot steal a content contact');
        await touch('touchMove',slow.x+50,slow.y); await page.waitForTimeout(30);
        assert.ok(Math.abs((await scroller.evaluate((node: HTMLElement)=>node.scrollLeft))-(slow.left-50))<2,'content reversal retains its owner');
        await touch('touchCancel'); await settle(); await closed();

        const cancelled = await at(scroller);
        await touch('touchStart',cancelled.x,cancelled.y); await touch('touchMove',cancelled.x+55,cancelled.y);
        await page.waitForTimeout(25); assert.ok((await row.boundingBox())!.x>30);
        await touch('touchCancel'); await settle(); await closed();
        assert.equal(await scroller.evaluate((node: HTMLElement)=>node.scrollLeft),cancelled.left);

        const boundary = await at(scroller,0);
        await touch('touchStart',boundary.x,boundary.y); await page.waitForTimeout(120);
        await touch('touchMove',boundary.x+35,boundary.y); await page.waitForTimeout(25);
        assert.ok((await row.boundingBox())!.x>20,'an exhausted direction yields to the ordinary sidebar gesture');
        await touch('touchCancel'); await settle(); await closed();

        const vertical = await at(scroller);
        const beforeY = await main.evaluate((node: HTMLElement)=>node.scrollTop);
        await touch('touchStart',vertical.x+60,vertical.y); await touch('touchMove',vertical.x+61,vertical.y-40);
        await page.waitForTimeout(30); await touch('touchMove',vertical.x+61,vertical.y-90); await touch('touchEnd'); await settle();
        await closed();
        assert.ok(await main.evaluate((node: HTMLElement, before: number)=>node.scrollTop>before+10,beforeY),'rich content preserves native vertical reading');
        assert.equal(await scroller.evaluate((node: HTMLElement)=>node.scrollLeft),vertical.left);
        measurements.push({selector,held:held!.x,slowContentOffset:localLeft,vertical:true,cancel:true,boundary:true});
      }
      // Nested reading must select a readable parent before committing an owner.
      const inner=page.locator('.unregistered-nested-inner'),outer=page.locator('.unregistered-nested-outer');
      await outer.evaluate((e:HTMLElement)=>{e.scrollLeft=120});const nested=await at(inner,0);
      const nt=Date.now()/1000;await touch('touchStart',nested.x,nested.y,false,nt);
      await touch('touchMove',nested.x+25,nested.y,false,nt+.13);await touch('touchMove',nested.x+35,nested.y,false,nt+.24);await page.waitForTimeout(30);
      assert.equal(await inner.evaluate((e:HTMLElement)=>e.scrollLeft),0);
      assert.ok(Math.abs(await outer.evaluate((e:HTMLElement)=>e.scrollLeft)-85)<2,'exhausted inner reader yields to readable parent');
      assert.ok(Math.abs((await row.boundingBox())!.x)<1);await touch('touchCancel');await settle();
      // An exclusive child inside that reader stays native, without inherited CSS restrictions.
      const native=page.locator('.unregistered-native-owner');await outer.evaluate((e:HTMLElement)=>{e.scrollLeft=0});await native.scrollIntoViewIfNeeded();await native.evaluate((e:HTMLElement)=>{e.scrollLeft=120});
      assert.equal(await native.evaluate((e:HTMLElement)=>getComputedStyle(e).touchAction),'auto');
      const nb=(await native.boundingBox())!,nx=Math.max(40,nb.x+40),ny=nb.y+20;
      await touch('touchStart',nx,ny);await touch('touchMove',nx+50,ny);await page.waitForTimeout(35);await touch('touchMove',nx+100,ny);await touch('touchEnd');await settle();await closed();
      assert.ok(await native.evaluate((e:HTMLElement)=>e.scrollLeft)<100,'exclusive child keeps native horizontal pan');
      measurements.push({unregisteredDynamic:true,nestedParent:true,exclusiveChildNative:true});
      // Modal input restores native horizontal panning and revokes held navigation.
      const scroller=page.locator('[data-gesture-rich] .chat-code-block__scroller');
      const held=await at(scroller);
      await touch('touchStart',held.x,held.y); await touch('touchMove',held.x+55,held.y); await page.waitForTimeout(30);
      await page.evaluate(()=>(window as any).fixture.setModal(true)); await page.waitForTimeout(80);
      await touch('touchMove',held.x+170,held.y); await touch('touchEnd'); await settle();
      assert.ok(Math.abs((await row.boundingBox())!.x)<1,'opening a modal revokes navigation');
      const modalCode = page.getByRole('dialog').locator('.chat-code-block__scroller');
      assert.equal(await modalCode.evaluate((node: HTMLElement)=>getComputedStyle(node).touchAction),'auto','foreground modal keeps native panning');
      await modalCode.evaluate((node: HTMLElement)=>{node.scrollLeft=120});
      const modalBox=(await modalCode.boundingBox())!;
      await touch('touchStart',modalBox.x+180,modalBox.y+modalBox.height/2);
      await touch('touchMove',modalBox.x+130,modalBox.y+modalBox.height/2);await page.waitForTimeout(30);
      await touch('touchMove',modalBox.x+50,modalBox.y+modalBox.height/2);await touch('touchEnd');await page.waitForTimeout(100);
      assert.ok((await modalCode.evaluate((node: HTMLElement)=>node.scrollLeft))>140,'native horizontal reading works inside foreground dialog');
      assert.ok(Math.abs((await row.boundingBox())!.x)<1);
      await page.evaluate(()=>(window as any).fixture.setModal(false)); await settle();
      const edge=await at(scroller,120);const edgeBox=(await scroller.boundingBox())!;
      const edgeX=Math.max(edgeBox.x+1,20);assert.ok(edgeX<24,'fixture touches registered content in reserved edge');
      await touch('touchStart',edgeX,edge.y);await touch('touchMove',edgeX+100,edge.y);await touch('touchEnd');await settle();await closed();
      await scroller.evaluate((node: HTMLElement)=>{node.dataset.sidebarGesture='ignore'});
      assert.equal(await scroller.evaluate((node: HTMLElement)=>getComputedStyle(node).touchAction),'auto','exclusive owner on scrollport itself restores native input');
      await scroller.evaluate((node: HTMLElement)=>{delete node.dataset.sidebarGesture});
      // A touch content momentum writer is stopped by the next contact.
      const momentum=await at(scroller,120);
      await touch('touchStart',momentum.x+100,momentum.y); await touch('touchMove',momentum.x+50,momentum.y); await touch('touchMove',momentum.x,momentum.y); await touch('touchEnd');
      await page.waitForTimeout(30); await touch('touchStart',momentum.x,momentum.y);
      const stopped=await scroller.evaluate((node: HTMLElement)=>node.scrollLeft);
      await page.waitForTimeout(120);
      assert.ok(Math.abs((await scroller.evaluate((node: HTMLElement)=>node.scrollLeft))-stopped)<1,'new contact stops old content momentum');
      await touch('touchCancel');
      assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
      await page.screenshot({path:`${output}/${theme}-${reducedMotion}-arbitration.png`});
      await page.setViewportSize({width:1280,height:844}); await settle();
      assert.equal(await scroller.evaluate((node: HTMLElement)=>getComputedStyle(node).touchAction),'auto','desktop restores native panning');
      assert.deepEqual(errors,[]); evidence.push({theme,reducedMotion,arbitration:measurements,momentumCancelled:true,modalRevoked:true,desktopNative:true});
      await context.close(); continue;
    }
    if (process.env.OPENCRAFT_GESTURE_CONTENT_ONLY === '1') {
      const main = page.locator('[data-main-scroll]');
      const reason = page.locator('[data-swipe-reason] button');
      const inspected = page.locator('[data-swipe-inspected] .thread-activity-item__hit-target');
      const generated = page.locator('[data-swipe-generated] [data-testid="generated-image-preview"]');
      const sent = page.locator('[data-swipe-sent]').getByRole('button', { name: 'Open attached image' });
      const actions = () => page.evaluate(() => [...(window as any).fixture.actions]);
      const position = async (locator: any) => {
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        const box = await locator.boundingBox(); assert.ok(box);
        const x = Math.max(35, box.x + Math.min(20, box.width / 2));
        const y = box.y + box.height / 2;
        assert.ok(y > 65 && y < 800, 'actual target is in the content viewport');
        assert.equal(await locator.evaluate((node: Element, point: {x:number;y:number}) => node.contains(document.elementFromPoint(point.x,point.y)), {x,y}), true, `touch starts on the actual clickable renderer: ${await locator.evaluate((node: Element) => node.outerHTML.slice(0,200))} at ${JSON.stringify({x,y,box})}`);
        return {x,y};
      };
      // These all failed admission when every clickable element was excluded.
      for (const locator of [reason, inspected, generated, sent, page.locator('[data-swipe-action]'), page.locator('[data-swipe-link]'), page.locator('[data-swipe-role]')]) {
        const before = await actions(), {x,y} = await position(locator);
        console.log('content swipe target', await locator.evaluate((node: Element) => node.outerHTML.slice(0,150)),{x,y});
        const flickTime = Date.now()/1000;
        await touch('touchStart',x,y,false,flickTime); await touch('touchMove',x+Math.min(80,(364-x)*.4),y,false,flickTime+.02); await page.waitForTimeout(20);
        const held = await page.locator('.app-shell-row').evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41);
        assert.ok(held > 30, 'clickable content follows a held rightward gesture');
        await touch('touchMove',364,y,false,flickTime+.04); await touch('touchEnd',0,250,false,flickTime+.05); await page.waitForTimeout(650); await opened();
        assert.deepEqual(await actions(),before,'swiping does not invoke the action');
        assert.equal(await reason.getAttribute('aria-expanded'),'false','swiping never expands reasoning');
        assert.equal(await inspected.getAttribute('aria-expanded'),'false','swiping never expands inspected-image activity');
        assert.equal(await page.getByRole('dialog').count(),0,'swiping never opens an image preview');
        // A deliberate fresh touch immediately after a swipe must still work.
        await page.locator('.app-shell-mobile-page-dismiss').tap();
        await page.waitForTimeout(650); await closed();
      }
      await position(reason); await reason.tap(); assert.equal(await reason.getAttribute('aria-expanded'),'true');
      await reason.tap(); assert.equal(await reason.getAttribute('aria-expanded'),'false');
      await position(inspected); await inspected.tap(); assert.equal(await inspected.getAttribute('aria-expanded'),'true');
      const thumbnail=page.locator('[data-swipe-inspected] .thread-image-view__preview');
      const beforeThumbnail=await actions(), point=await position(thumbnail);
      await touch('touchStart',point.x,point.y); await touch('touchMove',300,point.y); await touch('touchMove',364,point.y); await touch('touchEnd'); await page.waitForTimeout(650); await opened();
      assert.deepEqual(await actions(),beforeThumbnail,'actual inspected-image thumbnail does not open on swipe');
      await touch('touchStart',365,400); await touch('touchEnd'); await page.waitForTimeout(650); await closed();
      await position(thumbnail); await thumbnail.tap(); assert.deepEqual(await actions(),[...beforeThumbnail,'inspected-image']);
      await inspected.tap();
      for (const locator of [generated, sent]) {
        await position(locator); await locator.tap(); await page.getByRole('dialog').waitFor();
        // Once a lightbox owns input, dragging its image cannot reveal the Shell.
        await drag(80,310,400); await closed();
        await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'detached'});
      }
      for (const [selector,action] of [['[data-swipe-action]','button'],['[data-swipe-link]','link'],['[data-swipe-role]','role-button']]) {
        const locator=page.locator(selector),before=await actions();
        await position(locator); await locator.tap(); assert.deepEqual(await actions(),[...before,action]);
      }
      // A sub-threshold tap still activates; canceled/vertical sequences do not reveal.
      const action=page.locator('[data-swipe-action]'), pointAction=await position(action),beforeSmall=await actions();
      await touch('touchStart',pointAction.x,pointAction.y); await touch('touchMove',pointAction.x+3,pointAction.y+1); await touch('touchEnd');
      assert.deepEqual(await actions(),[...beforeSmall,'button']); await closed();
      for(const selector of ['input','[data-editor]','[data-horizontal]','[data-swipe-ignore] button']) {
        const locator=page.locator(selector), point=await position(locator);
        await drag(point.x,320,point.y); await closed();
      }
      await position(reason); const pointReason=await position(reason);
      await touch('touchStart',pointReason.x,pointReason.y); await touch('touchMove',pointReason.x+90,pointReason.y); await touch('touchCancel'); await page.waitForTimeout(650); await closed();
      await position(reason); await reason.tap(); assert.equal(await reason.getAttribute('aria-expanded'),'true','fresh tap after cancellation works'); await reason.tap();
      await main.evaluate((node: HTMLElement)=>node.scrollTop=0);
      await touch('touchStart',100,250); await touch('touchMove',105,170); await touch('touchEnd'); await page.waitForTimeout(200); await closed();
      assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
      assert.deepEqual(errors,[]);
      await page.screenshot({path:`${output}/${theme}-${reducedMotion}-content.png`});
      evidence.push({theme,reducedMotion,clickableContent:true,heldFollow:true,noClickOnSwipe:true,realImagePreviews:true,nativeExclusions:true,draft:true});
      await context.close(); continue;
    }
    if (process.env.OPENCRAFT_GESTURE_COMPOSITING_ONLY === '1') {
      await page.locator('.app-shell-header [data-app-shell-sidebar-trigger]').tap();
      await page.waitForTimeout(650); await opened();
      await expandScrollFixture();
      await touch('touchStart',280,400); await touch('touchMove',220,400);
      await page.waitForTimeout(250);
      const before=await page.locator('.app-shell-row').getAttribute('style');
      const events: any[]=[];
      const collected=(chunk: any)=>events.push(...chunk.value);
      cdp.on('Tracing.dataCollected',collected);
      await cdp.send('Tracing.start',{categories:'devtools.timeline,cc',options:'record-continuously'});
      // Held direct manipulation with two reversals; no screenshots, DOM/style
      // reads, React updates or measurement observer in the sampled interval.
      for(let i=0;i<72;i++) {
        await touch('touchMove',190+65*Math.cos(i/71*Math.PI*4),400);
        await page.waitForTimeout(12);
      }
      const complete=new Promise<void>(resolve=>cdp.once('Tracing.tracingComplete',()=>resolve()));
      await cdp.send('Tracing.end'); await complete; cdp.off('Tracing.dataCollected',collected);
      const paints=events.filter(e=>e.name==='Paint'&&['DIV class=\'app-shell-row\'','DIV class=\'app-shell-floating-left-panel\''].includes(e.args?.data?.nodeName));
      const metrics={theme,reducedMotion,mode:'compositing',samples:72,shellPaints:paints.length,
        rasterTasks:events.filter(e=>e.name==='RasterTask').length};
      await writeFile(`${output}/${theme}-${reducedMotion}-compositing-trace.json`,JSON.stringify({traceEvents:events}));
      assert.ok(paints.length<6,`steady mobile movement must not repaint Shell layers: ${JSON.stringify(metrics)}`);
      assert.notEqual(await page.locator('.app-shell-row').getAttribute('style'),before,'foreground continues to follow the live gesture');
      assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
      await touch('touchCancel'); await page.waitForTimeout(650); await opened();
      await page.keyboard.press('Escape'); await page.waitForTimeout(650); await closed();
      assert.deepEqual(errors,[]); evidence.push(metrics); await context.close(); continue;
    }
    if (process.env.OPENCRAFT_SIDEBAR_SCROLL_ONLY === '1') {
      const entrance = page.locator('[data-app-shell-sidebar-trigger]').first();
      const open = async () => { await entrance.tap(); await page.waitForTimeout(650); await opened(); };
      const close = async () => { await page.locator('.app-shell-mobile-page-dismiss, .app-shell-floating-sidebar-dismiss').evaluate((e: HTMLElement) => e.click()); await page.waitForTimeout(650); await closed(); };
      const scroll = () => panel.locator('.shell-sidebar__scroll');
      const read = () => scroll().evaluate((e: HTMLElement) => e.scrollTop);
      const setScroll = async (top: number) => {
        await scroll().evaluate((e: HTMLElement, top: number) => { e.scrollTop = top; }, top);
        await page.waitForTimeout(80); assert.equal(await read(), top);
      };
      await open();
      await expandScrollFixture();
      await page.evaluate(() => { (window as any).savedSidebarNode = document.querySelector('[data-sidebar-content="context"]'); });
      // Each reopen creates a new outer mobile viewport; retain its logical receipt.
      for (const top of [500, 900, 0, 650]) {
        await setScroll(top); await close(); await open();
        assert.equal(await read(), top, 'reopened drawer restores actual viewport, including deliberate zero');
        assert.equal(await page.evaluate(() => (window as any).savedSidebarNode === document.querySelector('[data-sidebar-content="context"]')), true);
      }
      await setScroll(750);
      await page.locator('.app-shell-mobile-page-dismiss, .app-shell-floating-sidebar-dismiss').evaluate((e: HTMLElement) => e.click());
      await entrance.tap(); await page.waitForTimeout(650); await opened();
      assert.equal(await read(), 750, 'rapid reverse preserves receipt');
      await close();
      await page.evaluate(() => (window as any).selectFixtureThread('thread-30'));
      await open(); assert.equal(await read(), 750, 'hidden selection updates cannot steal the saved position');
      await setScroll(350);
      await page.evaluate(() => (window as any).fixture.setShowNewChat(false));
      await page.waitForTimeout(80); assert.equal(await read(), 350);
      await close(); await open(); assert.equal(await read(), 350);
      // Desktop's inner list and mobile's outer viewport have different coordinates.
      await page.setViewportSize({width:1300,height:844}); await page.waitForTimeout(700);
      const desktop = page.locator('.sidebar-activity-list');
      await desktop.evaluate((e: HTMLElement) => { e.scrollTop = 240; }); await page.waitForTimeout(80);
      assert.equal(await desktop.evaluate((e: HTMLElement) => e.scrollTop), 240);
      await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(700);
      if (!await panel.count()) await open();
      assert.equal(await read(), 350, 'responsive viewport keeps distinct mobile scroll coordinates');
      await page.screenshot({path:output+'/scroll-'+theme+'-'+reducedMotion+'.png'});
      assert.equal(await page.evaluate(() => (window as any).fixture.mounts()), 1);
      assert.equal(await page.getByRole('textbox',{name:'Draft',exact:true}).inputValue(), 'Keep this draft');
      assert.deepEqual(errors, []);
      evidence.push({theme,reducedMotion,case:'logical-mobile-scroll-owner',passed:true});
      await context.close(); continue;
    }
    if (process.env.OPENCRAFT_GESTURE_TOGGLE_RETURN_ONLY === '1') {
      const entrance = page.locator('.app-shell-header [data-app-shell-sidebar-trigger]');
      for (let cycle=0;cycle<3;cycle++) {
        await entrance.tap(); await page.waitForTimeout(650); await opened();
        const receipt = await page.evaluate(async () => {
          document.querySelector<HTMLButtonElement>('.app-shell-mobile-page-dismiss, .app-shell-floating-sidebar-dismiss')!.click();
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const control = document.querySelector<HTMLElement>('.app-shell-header [data-app-shell-sidebar-trigger]');
          return {exists:!!control,expanded:control?.getAttribute('aria-expanded'),width:control?.getBoundingClientRect().width ?? 0,
            exitSurface:!!document.querySelector('.app-shell-floating-left-panel')};
        });
        assert.ok(receipt.exists && receipt.expanded === 'false' && receipt.width > 0,JSON.stringify(receipt));
        if(reducedMotion !== 'reduce') assert.ok(receipt.exitSurface,'entrance returns before exit presence finishes');
        await page.waitForTimeout(650); await closed();
      }
      assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
      assert.deepEqual(errors,[]); evidence.push({theme,reducedMotion,toggleReturnFirstFrame:true,cycles:3});
      await context.close(); continue;
    }
    if (process.env.OPENCRAFT_GESTURE_STACK_ONLY === '1') {
      await page.evaluate(() => (window as any).fixture.setDensity('on'));
      const entrance=page.locator('.app-shell-header [data-app-shell-sidebar-trigger]');
      const row=page.locator('.app-shell-row');
      const paintGeometry = await row.evaluate(element => {
        const root = element.closest('.app-shell-root')!;
        const rect = element.getBoundingClientRect(), frame = root.getBoundingClientRect();
        const header = element.querySelector('.app-shell-header')!.getBoundingClientRect();
        return { top: rect.top, height: rect.height, rootTop: frame.top, rootHeight: frame.height,
          contentInset: getComputedStyle(element).paddingTop, headerTop: header.top };
      });
      assert.equal(paintGeometry.top, paintGeometry.rootTop, 'page paint starts at the viewport edge');
      assert.equal(paintGeometry.height, paintGeometry.rootHeight, 'page paint covers the complete viewport');
      assert.equal(await page.locator('.app-shell-row').getAttribute('data-safe-layout'), 'top');
      assert.equal(paintGeometry.contentInset, '47px', 'safe area insets content, not the page paint');
      assert.ok(paintGeometry.headerTop >= paintGeometry.rootTop + 47, 'controls remain below the safe area');
      const edgePixels = async () => {
        const {data, info} = await sharp(await page.screenshot()).ensureAlpha().raw().toBuffer({resolveWithObject:true});
        // Sample inside the exposed sidebar's safe areas, away from content and
        // the foreground shadow. Compare rendered material, not CSS declarations.
        return [2, 8, info.height - 9, info.height - 3].map(y => {
          const offset = (y * info.width + 4) * 4;
          return [...data.subarray(offset, offset + 4)];
        });
      };
      const assertEdges = (actual: number[][], expected: number[][]) => {
        assert.ok(actual.every((pixel, i) => pixel.every((value, c) => Math.abs(value - expected[i][c]) <= 1)),
          `sidebar safe-area material stays continuous: ${JSON.stringify({actual, expected})}`);
      };
      await page.evaluate(() => {
        (window as any).unsafeSidebarPaint = [];
        const sample = () => {
          const host = document.querySelector<HTMLElement>('.app-shell-floating-overlay-root[data-mobile-sidebar]');
          const foreground = document.querySelector<HTMLElement>('.app-shell-root.has-mobile-sidebar-gestures');
          if (!host || !foreground) return;
          const back = getComputedStyle(host), front = getComputedStyle(foreground);
          const panel = host.querySelector<HTMLElement>('.app-shell-floating-left-panel');
          const content = panel ? getComputedStyle(panel) : null;
          const contentPaints = content && content.visibility === 'visible'
            && content.display !== 'none' && Number(content.opacity) > 0;
          // aria-hidden/inert revoke input, not paint. Inspect the actual text
          // surface as well as its backing through the final removal frames.
          if ((back.backgroundImage !== 'none' || contentPaints)
            && !(Number(front.zIndex) > Number(back.zIndex)))
            (window as any).unsafeSidebarPaint.push({front:front.zIndex, back:back.zIndex,
              contentPaints, exiting:panel?.getAttribute('aria-hidden')});
        };
        new MutationObserver(sample).observe(document.body, {subtree:true, childList:true,
          attributes:true, attributeFilter:['style','data-mobile-sidebar-present','aria-hidden']});
        const frame = () => { sample(); requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      });
      await page.evaluate(() => {
        (window as any).pageTranslationViolations = [];
        const sample = () => {
          const panel = document.querySelector<HTMLElement>('.app-shell-floating-left-panel');
          const row = document.querySelector<HTMLElement>('.app-shell-row');
          if (panel && row) {
            const x = new DOMMatrixReadOnly(getComputedStyle(row).transform).m41;
            if (x < -0.01 || x > panel.clientWidth + 0.01)
              (window as any).pageTranslationViolations.push({x, maximum: panel.clientWidth});
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const assertForegroundOccludesRear = async () => {
        const front = await row.boundingBox(); assert.ok(front);
        const left = Math.ceil(front.x) + 24;
        const width = (page.viewportSize()!.width - 2) - left;
        assert.ok(width > 0, 'foreground retains a measurable dismiss strip');
        const crop = {left, top: 12, width, height: page.viewportSize()!.height - 24};
        const visible = await sharp(await page.screenshot()).extract(crop).ensureAlpha().raw().toBuffer();
        const previous = await panel.evaluate((e: HTMLElement) => { const value = e.style.visibility; e.style.visibility = 'hidden'; return value; });
        let hidden: Buffer;
        try { hidden = await sharp(await page.screenshot()).extract(crop).ensureAlpha().raw().toBuffer(); }
        finally { await panel.evaluate((e: HTMLElement, value: string) => { e.style.visibility = value; }, previous); }
        let changed = 0;
        for (let pixel = 0; pixel < visible.length; pixel += 4)
          if ([0,1,2,3].some(channel => Math.abs(visible[pixel+channel] - hidden[pixel+channel]) > 1)) changed++;
        assert.equal(changed, 0, 'covered foreground pixels must not depend on rear sidebar text');
        return {coveredPixels: visible.length / 4, changed};
      };
      const readStack=()=>page.evaluate(()=>{
        const panel=document.querySelector<HTMLElement>('.app-shell-floating-left-panel')!;
        const drawer=panel.getBoundingClientRect();
        const style=getComputedStyle(panel),matrix=new DOMMatrixReadOnly(style.transform);
        const page=document.querySelector('.app-shell-row')!.getBoundingClientRect();
        const peek=document.elementFromPoint(innerWidth-12,200);
        return {drawerLeft:drawer.left,drawerRight:drawer.right,layoutWidth:panel.clientWidth,scale:matrix.a,opacity:Number(style.opacity),wash:Number(getComputedStyle(document.querySelector('.app-shell-mobile-sidebar-wash')!).opacity),
          frontWash:Number(getComputedStyle(document.querySelector('.app-shell-mobile-page-wash')!).opacity),pageLeft:page.left,peek:innerWidth-page.left,
          radius:getComputedStyle(document.querySelector('.app-shell-row')!).borderTopLeftRadius,
          hit:peek?.classList.contains('app-shell-mobile-page-dismiss')};
      });
      for(const width of [320,390,430]) {
        await page.setViewportSize({width,height:844});await page.waitForTimeout(200);
        await page.evaluate(()=>(window as any).keptEntrance=document.querySelector('.app-shell-header [data-app-shell-sidebar-trigger]'));
        const material=await entrance.evaluate((e:HTMLElement)=>{const s=getComputedStyle(e);return {background:s.backgroundColor,shadow:s.boxShadow,border:s.borderWidth,width:e.clientWidth,height:e.clientHeight}});
        assert.equal(material.background,'rgba(0, 0, 0, 0)');assert.equal(material.shadow,'none');assert.equal(material.border,'0px');
        assert.ok(material.width>=44&&material.height>=44);
        const closedEdges=await edgePixels();
        await entrance.tap();await page.waitForTimeout(650);await opened();
        assert.equal(await panel.locator('[data-app-shell-sidebar-trigger]').count(),0,'drawer has no collapse button');
        const mark=panel.locator('.app-shell-header__window-controls .application-brand__mark');
        await mark.waitFor({state:'visible'});assert.equal(await mark.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0),true);
        const search=panel.locator('[data-action-id="shell.search.header"]');const searchBox=await search.boundingBox();assert.ok(searchBox&&searchBox.width>=44&&searchBox.height>=44);
        await search.tap();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});await opened();
        const stack=await readStack();assert.ok(Math.abs(stack.drawerRight-stack.pageLeft)<1&&stack.peek>=63&&parseFloat(stack.radius)>0&&stack.hit,JSON.stringify(stack));
        assert.equal(await page.getByLabel('Draft',{exact:true}).evaluate((e:HTMLElement)=>e.closest('main')?.inert),true);
        await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-stack.png`});
        const openEdges=await edgePixels();
        // Hold, reverse and cancel: the rear layer stays at the left anchor,
        // while its depth and the foreground travel read the same progress.
        await touch('touchStart',210,400);await touch('touchMove',140,400);await page.waitForTimeout(40);
        const a=await readStack();const aEdges=await edgePixels();await touch('touchMove',175,400);await page.waitForTimeout(40);const b=await readStack();
        const bEdges=await edgePixels();
        await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-held-material.png`});
        // The veil may tint the material, but must never introduce horizontal seams.
        for(const edges of [aEdges,bEdges]) {
          assertEdges(edges,edges.map(()=>edges[0]));
        }
        for(const sample of [a,b]) {
          assert.ok(Math.abs(sample.drawerLeft)<1,'sidebar never slides in from offscreen');
          assert.ok(sample.drawerRight>sample.pageLeft+20,'page uncovers the stationary rear layer');
          assert.ok(Math.abs(sample.frontWash + sample.wash - (reducedMotion==='reduce'?0:.65))<.002,'foreground and sidebar wash remain reciprocal');
          if(reducedMotion==='reduce') assert.ok(sample.scale===1&&sample.opacity===1&&sample.wash===0,'reduced motion skips depth');
          else assert.ok(sample.scale<1&&sample.scale>.9&&sample.opacity<1&&sample.opacity>.45&&sample.wash>0&&sample.wash<.65,JSON.stringify(sample));
        }
        if(reducedMotion!=='reduce') assert.ok(b.scale>a.scale&&b.opacity>a.opacity&&b.wash<a.wash,'reversing the close brings the sidebar forward');
        assert.ok(Math.abs(b.pageLeft-a.pageLeft-35)<2,JSON.stringify({a,b}));
        await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-held-depth.png`});
        evidence.push({theme,reducedMotion,width,heldDepth:[a,b],materialEdges:{open:openEdges,held:aEdges,reversed:bEdges}});
        await touch('touchMove',30,400);await page.waitForTimeout(40);
        const recessed=await readStack();
        if(reducedMotion!=='reduce') {
          assert.ok(recessed.scale<.96&&recessed.opacity<.8&&recessed.wash>.25,'partly covered sidebar has visible depth and wash');
          const veil=await page.locator('.app-shell-mobile-sidebar-wash').evaluate((e:HTMLElement)=>({z:getComputedStyle(e).zIndex,pointer:getComputedStyle(e).pointerEvents,background:getComputedStyle(e).backgroundImage}));
          assert.equal(veil.z,'3');assert.equal(veil.pointer,'none');assert.match(veil.background,/linear-gradient/);
        }
        await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-recessed-wash.png`});
        evidence.push({theme,reducedMotion,width,recessed});
        await touch('touchCancel');await page.waitForTimeout(650);await opened();
        await page.locator('.sidebar-activity-item').first().focus();await page.keyboard.press('Escape');
        await page.waitForTimeout(650);await closed();assert.equal(await entrance.evaluate((e:HTMLElement)=>e===document.activeElement),true,'Escape restores page entrance');
        assert.equal(await entrance.evaluate((e:HTMLElement)=>e===(window as any).keptEntrance),true,'page entrance retains its node');
        // Reopen during exit from the visible page surface, then finish closed.
        await entrance.tap();await page.waitForTimeout(650);
        await page.locator('.app-shell-mobile-page-dismiss').tap({position:{x:20,y:200}});
        await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));
        await entrance.evaluate((e:HTMLButtonElement)=>e.click());await page.waitForTimeout(650);await opened();
        await drag(220,55,400);await closed();
        await drag(70,width-30,250);await opened();
        await page.locator('.app-shell-mobile-page-dismiss').tap({position:{x:20,y:200}});await page.waitForTimeout(650);await closed();
        assertEdges(await edgePixels(),closedEdges);
        assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
        // Exercise the real floating conversation header, whose gaps are
        // transparent, with the same page/drawer owners as the generic route.
        await page.evaluate(() => (window as any).fixture.setConversationHeader(true));
        await entrance.tap(); await page.waitForTimeout(650); await opened();
        await touch('touchStart', width - 70, 400);
        await touch('touchMove', width - 170, 400); await page.waitForTimeout(60);
        const foregroundOcclusion = await assertForegroundOccludesRear();
        await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-foreground-occlusion.png`});
        await touch('touchCancel'); await page.waitForTimeout(650); await opened();
        await page.locator('.app-shell-mobile-page-dismiss').tap({position:{x:20,y:200}});
        await page.waitForTimeout(650); await closed();
        await page.evaluate(() => (window as any).fixture.setConversationHeader(false));
        evidence.push({theme,reducedMotion,width,material,stack,held:[a,b],sameEntrance:true,escape:true,gestureReopen:true,foregroundOcclusion});
      }
      assert.deepEqual(await page.evaluate(() => (window as any).unsafeSidebarPaint), [], 'sidebar content and backing never paint above the returned page during exit presence');
      assert.deepEqual(await page.evaluate(() => (window as any).pageTranslationViolations), [], 'mobile page never bounces outside its closed/open bounds');
      await page.setViewportSize({width:1280,height:844});await page.waitForTimeout(300);
      const desktop=page.locator('.app-shell-touch-sidebar-toggle button');await desktop.waitFor();
      await desktop.tap();await page.waitForTimeout(650);assert.equal(await row.evaluate((e:HTMLElement)=>getComputedStyle(e).transform),'none','desktop does not translate');
      await page.keyboard.press('Escape');await page.waitForTimeout(650);assert.equal(await desktop.evaluate((e:HTMLElement)=>e===document.activeElement),true);
      assert.equal(await page.evaluate(()=>(window as any).fixture.mounts()),1);assert.deepEqual(errors,[]);
      await context.close();continue;
    }
    if (process.env.OPENCRAFT_GESTURE_INPLACE_ONLY === '1') {
      await page.evaluate(() => (window as any).fixture.setDensity('on'));
      const control=page.locator('.app-shell-touch-sidebar-toggle button');
      await control.waitFor();
      for(const width of [1280]) {
        await page.setViewportSize({width,height:844}); await page.waitForTimeout(300);
        await page.evaluate(() => (window as any).sameToggle=document.querySelector('.app-shell-touch-sidebar-toggle button'));
        const before=await control.boundingBox(); assert.ok(before && before.width>=44);
        const right=await page.locator('.app-shell-header__end-slot .app-shell-header__right-panel-toggle').boundingBox();
        assert.ok(right && right.width>=44 && right.height>=44,'right control retains touch target');
        assert.ok(Math.abs(before.x-2)<1 && Math.abs(width-right.x-right.width-2)<1,
          JSON.stringify({width,left:before.x,right:width-right.x-right.width}));
        for(let cycle=0;cycle<3;cycle++) {
          for(const expanded of [true,false]) {
            await control.tap();
            const frames=await page.evaluate(async () => {
              const samples=[];
              for(let i=0;i<12;i++) {
                await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
                const button=document.querySelector<HTMLButtonElement>('.app-shell-touch-sidebar-toggle button')!;
                const box=button.getBoundingClientRect();
                samples.push({same:button===(window as any).sameToggle,expanded:button.getAttribute('aria-expanded'),x:box.x,y:box.y,
                  hittable:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===button});
              }
              return samples;
            });
            for(const frame of frames) {
              assert.ok(frame.same && frame.expanded===String(expanded) && frame.hittable,JSON.stringify({width,expanded,frame}));
              assert.ok(Math.abs(frame.x-before!.x)<1 && Math.abs(frame.y-before!.y)<1,'button stays in place throughout motion');
            }
            await page.waitForTimeout(650);
            if (cycle===0) await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-${expanded}.png`});
          }
        }
        // A second tap while the drawer is still exiting reverses intent.
        await control.tap(); await page.waitForTimeout(650);
        await control.tap();
        await page.evaluate(() => new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
        await control.tap();
        assert.equal(await control.getAttribute('aria-expanded'),'true','closing animation does not swallow reopen');
        await page.waitForTimeout(650); await control.tap(); await page.waitForTimeout(650);
        if (width===390) {
        await control.tap(); await page.waitForTimeout(650);
        await page.locator('.sidebar-activity-item').first().focus();
        await page.keyboard.press('Escape');
        assert.equal(await control.evaluate((button:HTMLElement)=>button===document.activeElement),true,'Escape restores logical focus to the stationary action');
        await page.waitForTimeout(650);
        }
        await page.locator('.app-shell-root').evaluate((root:HTMLElement)=>{
          root.style.setProperty('--shell-mobile-safe-left','22px');
          root.style.setProperty('--shell-mobile-safe-right','26px');
          window.dispatchEvent(new Event('resize'));
        });
        await page.waitForTimeout(100);
        const safeLeft=await control.boundingBox();
        const safeRight=await page.locator('.app-shell-header__end-slot .app-shell-header__right-panel-toggle').boundingBox();
        assert.ok(safeLeft && safeRight && Math.abs(safeLeft.x-22)<1 && Math.abs(width-safeRight.x-safeRight.width-26)<1,JSON.stringify({width,safeLeft,safeRight}));
        await page.locator('.app-shell-root').evaluate((root:HTMLElement)=>{
          root.style.removeProperty('--shell-mobile-safe-left');root.style.removeProperty('--shell-mobile-safe-right');
          window.dispatchEvent(new Event('resize'));
        });
        evidence.push({theme,reducedMotion,width,edgeInset:2,safeInsets:true,stationaryNode:true,hitTestEveryFrame:true,cycles:3,rapidReopen:true});
      }
      await page.evaluate(() => (window as any).fixture.setDensity('off'));
      await page.waitForFunction(()=>!document.querySelector('.app-shell-touch-sidebar-toggle'));
      assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
      assert.deepEqual(errors,[]);
      await context.close(); continue;
    }
    // Mobile action uses the real Shell portal/scroll/footer owners, not CSS-only markup.
    if (process.env.OPENCRAFT_GESTURE_FAB_ONLY === '1') {
      for (const width of [320,390,430]) {
        await page.setViewportSize({width,height:844}); await page.waitForTimeout(250);
        await drag(80,width-50); await opened();
        const button=panel.getByRole('button',{name:'New chat',exact:true});
        assert.equal(await button.count(),1,'one accessible creation action');
        assert.equal(await panel.locator('.sidebar-tasks > .sidebar-new-chat').count(),0,'mobile inline row removed');
        const before=await button.boundingBox();assert.ok(before);
        const initialViewport=await panel.locator('.shell-sidebar__scroll').boundingBox();assert.ok(initialViewport);
        assert.ok(initialViewport.y+initialViewport.height<=before.y,'initial list cannot paint behind the creation pill');
        await expandScrollFixture();
        assert.ok(before.height>=48 && before.width>=100,'comfortable pill touch target');
        const scroll=panel.locator('.shell-sidebar__scroll');
        await scroll.evaluate(e=>{e.scrollTop=0});await page.waitForTimeout(100);
        const home=panel.locator('[data-action-id="shell.home"]');
        const homeBefore=await home.boundingBox();assert.ok(homeBefore);
        await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight});await page.waitForTimeout(100);
        const homeAfter=await home.boundingBox();assert.ok(homeAfter);
        const scrollTop=await scroll.evaluate(e=>e.scrollTop);
        const viewport=await scroll.boundingBox();assert.ok(viewport);
        assert.ok(scrollTop>100,'fixture scrolls enough to hide navigation');
        assert.ok(Math.abs(homeBefore.y-homeAfter.y-scrollTop)<1,'Home scrolls with the shared viewport: '+JSON.stringify({homeBefore,homeAfter,scrollTop}));
        assert.ok(homeAfter.y+homeAfter.height<=viewport.y,'Home leaves the visible list instead of sticking over conversations');
        const after=await button.boundingBox();assert.ok(after);
        assert.ok(Math.abs(after.y-before.y)<1,'action stays fixed as conversations scroll');
        const footer=await panel.locator('.shell-sidebar__rail-footer').boundingBox();assert.ok(footer);
        const settings=panel.getByRole('button',{name:'Settings',exact:true});
        assert.equal(await settings.count(),1,'one accessible settings action');
        const gear=await settings.boundingBox();assert.ok(gear);
        // Translucent actions cannot hide text: the scrolling viewport itself
        // must stop above them, including before the list reaches its end.
        assert.ok(viewport.y+viewport.height<=Math.min(before.y,gear.y),
          'native list viewport stays above floating glass: '+JSON.stringify({viewport,before,gear}));
        assert.ok(gear.width>=48&&gear.height>=48,'settings retains a comfortable touch target');
        assert.ok(gear.x>=after.x+after.width+8,'settings floats to the right without overlapping creation');
        assert.ok(Math.abs(gear.y-after.y)<1,'floating actions share a baseline');
        assert.equal(await panel.locator('[data-surface="account"],.sidebar-account__avatar').count(),0,'no mobile avatar or hidden account entrance');
        const plate=await panel.locator('.shell-sidebar__rail-footer').evaluate(e=>({background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderTopWidth}));
        assert.deepEqual(plate,{background:'rgba(0, 0, 0, 0)',border:'0px'},'no bottom plate or divider');
        assert.ok(gear.y+gear.height<=844-34,'settings respects the simulated bottom safe area');
        const last=await panel.locator('.sidebar-activity-item').last().boundingBox();assert.ok(last);
        assert.ok(last.y+last.height<=after.y,'last conversation scrolls fully above action');
        const pagination=await panel.locator('.sidebar-activity-pagination').last().boundingBox();assert.ok(pagination);
        assert.ok(pagination.y+pagination.height<=Math.min(after.y,gear.y),'final pagination remains fully above glass actions');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-fab.png`});
        const prior=await page.evaluate(()=>(window as any).fixture.actions.length);
        await button.tap();await page.waitForTimeout(650);await closed();
        assert.deepEqual(await page.evaluate(n=>(window as any).fixture.actions.slice(n),prior),['New chat'],'one shared action and drawer dismissal');
        assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
        await drag(80,width-50);await opened();
        const settingsPrior=await page.evaluate(()=>(window as any).fixture.actions.length);
        await panel.getByRole('button',{name:'Settings',exact:true}).tap();await page.waitForTimeout(650);await opened();
        await panel.getByRole('navigation',{name:'Settings sections'}).waitFor({state:'visible'});
        assert.deepEqual(await page.evaluate(n=>(window as any).fixture.actions.slice(n),settingsPrior),['Settings'],'one settings entrance intent, drawer retained for categories');
        assert.deepEqual(await page.evaluate(()=>(window as any).fixture.route()),{kind:'settings',slug:'appearance'});
        await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-settings-categories.png`});
        const category=width===320?'Appearance':'Chat';
        await panel.getByRole('button',{name:category,exact:true}).tap();await page.waitForTimeout(650);await closed();
        assert.deepEqual(await page.evaluate(()=>(window as any).fixture.route()),{kind:'settings',slug:category.toLowerCase()});
        await page.evaluate(()=>(window as any).fixture.returnToChat());
        assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
        evidence.push({theme,reducedMotion,width,button:after,gear,footer,last,passed:true});
      }
      // Non-chat destinations can omit creation; settings remains reachable.
      await page.setViewportSize({width:390,height:844});
      await drag(80,340);await opened();
      await page.evaluate(()=>(window as any).fixture.setShowNewChat(false));
      await panel.locator('.sidebar-new-chat').waitFor({state:'detached'});
      const standaloneSettings=panel.getByRole('button',{name:'Settings',exact:true});
      await standaloneSettings.waitFor({state:'visible'});
      const settingsPrior=await page.evaluate(()=>(window as any).fixture.actions.length);
      await standaloneSettings.tap();await page.waitForTimeout(650);await opened();
      assert.deepEqual(await page.evaluate(n=>(window as any).fixture.actions.slice(n),settingsPrior),['Settings']);
      await panel.getByRole('button',{name:'Appearance',exact:true}).tap();await page.waitForTimeout(650);await closed();
      assert.deepEqual(await page.evaluate(()=>(window as any).fixture.route()),{kind:'settings',slug:'appearance'},'choosing already selected category still dismisses');
      await page.evaluate(()=>(window as any).fixture.returnToChat());
      await page.evaluate(()=>(window as any).fixture.setShowNewChat(true));
      await page.setViewportSize({width:1280,height:900});
      await page.evaluate(()=>(window as any).fixture.setOpen(true));await page.waitForTimeout(700);
      assert.equal(await page.locator('.shell-sidebar__floating-action').count(),0,'desktop has no floating action');
      await page.getByRole('button',{name:'Synthetic employee',exact:true}).waitFor({state:'visible'});
      assert.equal(await page.locator('.shell-sidebar__rail-footer [data-surface="settings"]').count(),1,'desktop rail settings remains available');
      await page.locator('.sidebar-tasks > .sidebar-new-chat').waitFor({state:'visible'});
      assert.equal(await page.getByRole('button',{name:'New chat',exact:true}).count(),1,'desktop inline action remains unique');
      const desktopPrior=await page.evaluate(()=>(window as any).fixture.actions.length);
      await page.getByRole('button',{name:'New chat',exact:true}).click();
      assert.deepEqual(await page.evaluate(n=>(window as any).fixture.actions.slice(n),desktopPrior),['New chat']);
      await page.locator('.shell-sidebar__rail-footer [data-surface="settings"]').click();
      await page.getByRole('navigation',{name:'Settings sections'}).waitFor({state:'visible'});
      assert.deepEqual(await page.evaluate(()=>(window as any).fixture.route()),{kind:'settings',slug:'appearance'},'desktop retains default Appearance');
      assert.equal(await page.evaluate(()=>(window as any).fixture.sidebarOpen()),true,'desktop rail stays docked');
      assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
      assert.deepEqual(errors,[]);await context.close();continue;
    }
    // Bounded check for the normal-width policy; the full gesture suite remains separate.
    if (process.env.OPENCRAFT_GESTURE_WIDTH_ONLY === '1') {
      const widths = [];
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({width,height:844}); await page.waitForTimeout(250);
        await drag(80,width-50); const box=await opened();
        assert.ok(Math.abs(box.width-Math.floor(Math.min(335,width-64)*0.90))<1, JSON.stringify({viewport:width,actual:box.width}));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'drawer does not overflow the screen');
        widths.push({viewport:width,drawer:box.width,gutter:width-box.width});
        await page.screenshot({path:`${output}/${theme}-${reducedMotion}-${width}-width.png`});
        await drag(Math.min(285,box.width-20),65,400); await closed();
      }
      assert.equal(await page.getByLabel('Draft',{exact:true}).inputValue(),'Keep this draft');
      assert.deepEqual(errors,[]); evidence.push({theme,reducedMotion,widths,passed:true});
      await context.close(); continue;
    }
    // Slow partial opening follows the finger then returns to closed.
    await touch('touchStart',120); await touch('touchMove',160); await page.waitForTimeout(70);
    const foreground=page.locator('.app-shell-row');
    const held1=await foreground.boundingBox(); assert.ok(held1&&held1.x>0);
    assert.ok(Math.abs((await panel.boundingBox())!.x)<1,'rear layer stays anchored during a partial reveal');
    await touch('touchMove',200); await page.waitForTimeout(70);
    const held2=await foreground.boundingBox(); assert.ok(Math.abs((held2!.x-held1!.x)-40)<2,'Held drag must follow finger delta');
    await page.waitForTimeout(140);await touch('touchEnd');await page.waitForTimeout(650);await closed();
    // Wrong direction, screen edge and vertical gestures never reveal.
    await drag(250,80);await closed();await drag(10,220);await closed();
    await touch('touchStart',140);await touch('touchMove',145,170);await touch('touchMove',280,160);await touch('touchEnd');await page.waitForTimeout(200);await closed();
    await page.locator('[data-main-scroll]').evaluate((e: HTMLElement)=>e.scrollTop=0);
    // Input owners retain their own touch input; ordinary readers need no opt-in.
    for(const selector of ['input','[data-editor]']) {
      const rect=await page.locator(selector).boundingBox();assert.ok(rect);
      await drag(Math.max(60,rect!.x+50),Math.min(320,rect!.x+180),rect!.y+rect!.height/2);await closed();
    }
    // A browser/system cancellation or second finger restores the starting intent.
    await touch('touchStart',100);await touch('touchMove',230);await page.waitForTimeout(50);await touch('touchCancel');await page.waitForTimeout(650);await closed();
    await touch('touchStart',100);await touch('touchMove',230);await touch('touchStart',230,250,true);await touch('touchEnd');await page.waitForTimeout(650);await closed();
    await page.evaluate(()=>(window as any).fixture.setModal(true));
    await page.getByRole('dialog').waitFor();await drag(80,310);await closed();
    await page.evaluate(()=>(window as any).fixture.setModal(false));
    // Rotate/resize during a held opening: cancel without leaving an orphan overlay.
    await touch('touchStart',100);await touch('touchMove',230);await page.setViewportSize({width:430,height:844});
    await page.waitForTimeout(250);await touch('touchEnd');await page.waitForTimeout(650);await closed();
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);
    // A short, fast right flick may commit without crossing the distance threshold.
    await touch('touchStart',100);await touch('touchMove',165);await touch('touchEnd');await page.waitForTimeout(650);await opened();
    await drag(285,65,400);await closed();
    await drag(80,310);const full=await opened();assert.ok(full.width<390&&full.width>=230,'Drawer leaves a backdrop gutter');
    assert.equal(await page.getByLabel('Draft', { exact: true }).inputValue(),'Keep this draft');
    const safe=await page.evaluate(()=>{
      const surface=document.querySelector('.app-shell-floating-left-panel__surface')!,header=document.querySelector('.app-shell-floating-left-panel__header')!,footer=document.querySelector('.app-shell-floating-left-panel .shell-sidebar__rail-footer')!;
      return {paddingTop:getComputedStyle(surface).paddingTop,paddingBottom:getComputedStyle(surface).paddingBottom,headerTop:header.getBoundingClientRect().top,footerBottom:footer.getBoundingClientRect().bottom,windowHeight:innerHeight};
    });
    const top=await panel.evaluate((root:Element)=>{
      const box=(selector:string)=>root.querySelector(selector)!.getBoundingClientRect();
      const actions=[...root.querySelectorAll('.shell-navigation__items--applications > button')].map(e=>e.getBoundingClientRect());
      const nav={height:actions.at(-1)!.bottom-actions[0]!.top,bottom:actions.at(-1)!.bottom},list=box('.shell-sidebar__context'),column=box('.shell-sidebar__column');
      return {navHeight:nav.height,listWidth:list.width,columnWidth:column.width,listTop:list.top,navBottom:nav.bottom,
        labels:[...root.querySelectorAll('.shell-navigation__item-label')].map(e=>({width:e.clientWidth,scroll:e.scrollWidth})),
        hits:[...root.querySelectorAll('.shell-sidebar-navigation button,.shell-navigation__footer--unified > button')].map(e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}))};
    });
    assert.ok(top.navHeight>=4*44 && top.listTop>=top.navBottom && Math.abs(top.listWidth-top.columnWidth)<1,JSON.stringify(top));
    assert.ok(top.labels.every((r:any)=>r.scroll<=r.width+1),'mobile labels remain complete');
    assert.ok(top.hits.every((r:any)=>r.w>=44 && r.h>=44),'top rail touch targets');
    assert.equal(safe.paddingTop,'47px');assert.equal(safe.paddingBottom,'34px');assert.ok(safe.headerTop>=47&&safe.footerBottom<=safe.windowHeight-34);
    const mounts=await page.evaluate(()=>(window as any).fixture.mounts());
    await expandScrollFixture();
    const scroll=panel.locator('.shell-sidebar__scroll');await scroll.evaluate((e:HTMLElement)=>{e.scrollTop=500;(window as any).keptSidebar=document.querySelector('.sidebar-panel')});
    // Vertical swipe inside list scrolls without moving drawer or navigating rows.
    await touch('touchStart',160,550);await touch('touchMove',160,450);await touch('touchMove',160,350);await touch('touchEnd');await page.waitForTimeout(250);await opened();
    assert.ok(await scroll.evaluate((e:HTMLElement)=>e.scrollTop)>500);
    await drag(285,65,400);await closed();
    // Native inertia may advance slightly between a touchstart and acquisition.
    // Preserve the last connected-tree scroll receipt, not a pre-gesture sample.
    const scrollPosition=await page.evaluate(()=>(window as any).lastSidebarScroll);
    await drag(80,310);await opened();
    assert.equal(await scroll.evaluate((e:HTMLElement)=>e.scrollTop),scrollPosition);
    assert.equal(await page.evaluate(()=>(window as any).fixture.mounts()),mounts);
    assert.equal(await scroll.evaluate(()=>document.querySelector('.sidebar-panel')===(window as any).keptSidebar),true);
    assert.deepEqual(await page.evaluate(()=>(window as any).fixture.actions),[],'Swipes must not select rows or invoke controls');
    await page.screenshot({path:`${output}/${theme}-${reducedMotion}-open.png`});
    // Short close returns open; held reverse resumes from the actual position.
    await touch('touchStart',240,400);await touch('touchMove',180,400);await page.waitForTimeout(50);
    const closing=await foreground.boundingBox();await touch('touchMove',220,400);await page.waitForTimeout(50);
    const reversed=await foreground.boundingBox();assert.ok(Math.abs(reversed!.x-closing!.x-40)<2);
    await page.waitForTimeout(140);await touch('touchEnd');await page.waitForTimeout(650);await opened();
    // Backdrop taps and button toggles share the same completion path, immediately after a swipe.
    await page.locator('.app-shell-mobile-page-dismiss, .app-shell-floating-sidebar-dismiss').tap({position:{x:20,y:400}});await page.waitForTimeout(650);await closed();
    await page.locator('[data-chrome-action-id=sidebar-toggle]').first().tap();await page.waitForTimeout(650);await opened();
    await drag(285,65,400);await closed();
    for(const width of [320,430]) {
      await page.setViewportSize({width,height:844});await page.waitForTimeout(250);
      await drag(80,width-50);const box=await opened();assert.ok(box.width<=width-24);
      const row=page.locator('.sidebar-activity-item').first();
      const beforeSelect=await page.evaluate(()=>(window as any).fixture.actions.length);
      await row.tap();await page.waitForTimeout(650);await closed();
      assert.equal(await page.evaluate(()=>(window as any).fixture.actions.length),beforeSelect+1);
      await drag(80,width-50);await opened();
      await page.locator('.sidebar-activity-item').first().tap();await page.waitForTimeout(650);await closed();
      assert.equal(await page.evaluate(()=>(window as any).fixture.actions.length),beforeSelect+2,'Reselecting the same conversation also dismisses');
    }
    await page.setViewportSize({width:1280,height:844});
    await page.evaluate(()=>(window as any).fixture.setOpen(true));await page.waitForTimeout(650);
    await page.locator('.sidebar-activity-item').first().tap();
    assert.equal(await page.evaluate(()=>(window as any).fixture.sidebarOpen()),true,'Desktop selection retains docked sidebar');
    console.log('Mobile gesture and selection dismissal checks passed:',theme,reducedMotion);
    assert.deepEqual(errors,[]);evidence.push({theme,reducedMotion,held:[held1,held2],safe,mounts,scrollPosition,passed:true});
    await context.close();
  }
  console.log(process.env.OPENCRAFT_GESTURE_SAFE_LAYOUT_ONLY === '1' ? 'Browser-host safe layout stays active without transient sidebar across widths, themes and motion preferences' : process.env.OPENCRAFT_GESTURE_STACK_ONLY === '1' ? 'Mobile page stack, plugin mark, plain entrance, held reversal/cancel, Escape and reopen passed in light/dark and normal/reduced motion' : process.env.OPENCRAFT_GESTURE_INPLACE_ONLY === '1' ? 'Touch sidebar button retains its node, position and hit target throughout open/close; compact fallback and draft preserved' : process.env.OPENCRAFT_GESTURE_TOGGLE_RETURN_ONLY === '1' ? 'Sidebar entrance returns on first closing frame in light/dark and normal/reduced motion; draft and exit lifetime preserved' : process.env.OPENCRAFT_GESTURE_FAB_ONLY === '1' ? 'Mobile creation/settings geometry, hidden account, no plate, scroll, shared actions and desktop fallback passed' : process.env.OPENCRAFT_GESTURE_WIDTH_ONLY === '1' ? 'Real touch sidebar normal-width, screen clamp, reveal/dismiss and draft checks passed' : 'Real touch sidebar follow/cancel/reverse, scroll/draft preservation and safe-area checks passed');
} finally { await writeFile(`${output}/result.json`,JSON.stringify(evidence,null,2));await browser?.close();await vite.close(); }
