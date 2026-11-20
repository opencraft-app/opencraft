import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/keyboard-clearance';
// The native geometry and a covering system bar are synthetic. The Shell,
// viewport owner, preference, menu, editor and CSS are the real implementation.
const source = `import React,{useEffect} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {AppShell} from '/apps/workbench-web/src/components/app-shell';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header';
import {ConversationTaskMenu} from '/apps/workbench-web/src/components/conversation-task-menu';
import {createIntlTestRoot} from '/tests/fixtures/intl-root';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {useTimelineViewportHost} from '/apps/workbench-web/src/timeline-viewport';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density';
import {captureViewportHistory} from '/apps/workbench-web/src/runtime/viewport-history';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
const noop=()=>{}, client=new QueryClient();
function App(){const preferences=useUiPreferencesRuntime();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);useTimelineViewportHost({kind:'browser',platform:'linux',safeArea:{left:0,right:0}});
window.fixture={preferences,setThemePreference,history:captureViewportHistory};
return <QueryClientProvider client={client}><AppShell floatingSidebarHeader={()=>null} layoutScope='clearance' mainContentLayout='thread-edge-scroll' sidebarOpen={false} sidebarWidth={275} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop} leftPanel={null}
header={<AppShellHeader conversationHeader title='Keyboard clearance' project={null} primaryAction={<ConversationTaskMenu scope='clearance' serverId='fixture' threadId='one' verifyConversation={async()=>{}} onOpenTasks={noop}/>} sidebarOpen={false} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={noop} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={[]}/>}
><div className='thread-scroll-layout'><div className='thread-scroll-plane' data-has-footer><div className='thread-scroll' data-thread-find-target='conversation'><div style={{height:1300}}>Conversation history</div></div><div className='thread-scroll-footer'><div className='thread-scroll-footer__content thread-layout-width'><OpenCraftComposer controller={controller} placeholder='Write a message' onSubmit={()=>false} onCancel={noop}/></div></div></div></div></AppShell></QueryClientProvider>}
createIntlTestRoot(document.getElementById('root'),undefined,window.fixtureLocale).render(<App/>);`;
const server=await createServer({root:process.cwd(),configFile:false,logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-keyboard-clearance',esbuild:{jsx:'automatic'},optimizeDeps:{entries:[]},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'keyboard-clearance-fixture',enforce:'pre',transform(code,id){if(id.endsWith('.scss'))return code.replace(/env\(safe-area-inset-bottom(?:,[^)]*)?\)/g,'var(--test-safe-bottom, 0px)')},resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(v){v.middlewares.use((req,res,next)=>{if(req.url==='/__opencraft_apphost_diagnostic'){res.statusCode=202;res.end('{}');return}if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><style>.app-shell-root,[data-timeline-fixed-reference]{translate:0 calc(0px - var(--fixture-native-pan, 0px))}</style><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser; const results=[];
try{
 await mkdir(output,{recursive:true});await server.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const theme of ['light','dark']) for(const locale of ['en-US','zh-CN']){
  const context=await browser.newContext({viewport:{width:402,height:690},hasTouch:true,isMobile:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.80'});
  await context.addInitScript(locale=>{
   const w=window as any;w.__name=(v:unknown)=>v;w.fixtureLocale=locale;
   const visual=Object.assign(new EventTarget(),{width:402,height:690,offsetTop:0,offsetLeft:0,pageTop:0,pageLeft:0,scale:1});let pan=0,base=690;
   Object.defineProperty(window,'visualViewport',{value:visual});Object.defineProperty(window,'scrollY',{get:()=>pan});Object.defineProperty(window,'innerHeight',{get:()=>visual.height});
   w.setNative=(height:number,top:number,layout=base,scale=1)=>{Object.defineProperty(document.documentElement,'clientHeight',{configurable:true,get:()=>base});base=layout;pan=top;document.documentElement.style.setProperty('--fixture-native-pan',top+'px');Object.assign(visual,{height,offsetTop:top,pageTop:top,scale});visual.dispatchEvent(new Event('resize'))};
  },locale);
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>{errors.push(error.message);console.error('PAGEERROR',error.message)});page.on('console',message=>{if(message.type()==='error')console.error('BROWSER',message.text())});page.on('response',r=>{if(r.status()>=400)console.error('HTTP',r.status(),r.url())});
  await page.goto(server.resolvedUrls!.local[0]!,{waitUntil:'commit'});const editor=page.locator('.opencraft-composer-editor');await editor.waitFor({timeout:45000});
  await page.evaluate(theme=>{const f=(window as any).fixture;f.setThemePreference(theme);return f.preferences.set('interface.touchFriendly','on')},theme);
  await editor.tap();await editor.fill('Keep this draft');await editor.evaluate(e=>(window as any).keptEditor=e);
  const measure=()=>page.evaluate(()=>{const c=document.querySelector('.opencraft-composer-shell')!.getBoundingClientRect(),s=document.querySelector('.opencraft-composer-submit')!.getBoundingClientRect(),h=document.querySelector('.app-shell-root')!.getBoundingClientRect();return {bottom:c.bottom,top:c.top,sendBottom:s.bottom,sendTop:s.top,shellTop:h.top,shellHeight:h.height,padding:getComputedStyle(document.querySelector('.thread-scroll-footer')!).paddingBottom,reduced:document.documentElement.dataset.timelineEditingViewportReduced}});
  await page.evaluate(()=>(window as any).setNative(447,243));await page.waitForFunction(()=>document.documentElement.dataset.timelineEditingViewportReduced==='true');
  const before=await measure();assert.equal(before.bottom,431,'captured faulty baseline');
  // The reported viewport ends at447, while the projected native bar begins at389.
  await page.evaluate(()=>{const bar=document.createElement('div');bar.id='native-bar';bar.style.cssText='position:fixed;inset:389px 0 0;background:#ddd;z-index:2147483647';bar.textContent='Synthetic system input bar / keyboard';document.body.append(bar)});
  const send=page.locator('.opencraft-composer-submit');assert.equal(await send.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),false,'negative control: original send is covered');
  await page.screenshot({path:output+'/'+theme+'-'+locale+'-before.png'});
  await page.getByRole('button',{name:locale==='zh-CN'?'会话操作':'Conversation actions',exact:true}).tap();
  await page.getByRole('menuitem',{name:locale==='zh-CN'?'抬高输入框（键盘遮挡时）':'Raise input above keyboard',exact:true}).tap();
  await editor.tap();await page.waitForFunction(()=>document.documentElement.dataset.keyboardClearance==='true'&&document.documentElement.dataset.timelineEditingViewportReduced==='true');
  const after=await measure();assert.equal(before.bottom-after.bottom,48);assert.ok(after.bottom<389);assert.ok(389-after.bottom<=16, "keep clearance close to the native bar");assert.equal(after.shellTop,0);assert.equal(after.shellHeight,447);
  assert.equal(await send.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),true);
  assert.equal(await editor.innerText(),'Keep this draft');assert.equal(await editor.evaluate(e=>e===(window as any).keptEditor&&document.activeElement===e),true);
  await page.screenshot({path:output+'/'+theme+'-'+locale+'-after.png'});
  await editor.fill(Array.from({length:40},(_,i)=>'Long draft line '+i).join('\n'));const long=await measure();assert.ok(long.top>=56,'long draft must stay below the header: '+JSON.stringify(long));assert.ok(long.sendBottom<389);await editor.fill('Keep this draft');
  await page.evaluate(()=>{(window as any).setNative(280,410)});await page.waitForFunction(()=>document.querySelector('.app-shell-root')!.getBoundingClientRect().height===280);
  const short=await measure();assert.equal(short.padding,'56px','short height caps clearance at40 plus ordinary16');
  await page.evaluate(()=>{(window as any).setNative(447,243,690,2)});await page.waitForFunction(()=>document.documentElement.dataset.timelineEditingViewportReduced==='false');assert.equal((await measure()).padding,'16px','zoom does not opt into compensation');
  await page.evaluate(()=>{document.querySelector('#native-bar')!.remove();(window as any).setNative(690,0,690)});await editor.blur();await page.waitForFunction(()=>document.documentElement.dataset.timelineEditingViewportReduced==='false');assert.equal((await measure()).padding,'16px','closed keyboard restores default');
  // Replay the normal sample with the preference off, preserving its safe area.
  await page.evaluate(async()=>{await (window as any).fixture.preferences.set('interface.keyboardClearance',false);document.documentElement.style.setProperty('--test-safe-bottom','34px');(window as any).setNative(379,397,776)});await editor.focus();await page.waitForFunction(()=>document.documentElement.dataset.timelineEditingViewportReduced==='true'&&document.documentElement.dataset.keyboardClearance==='false');
  const normal=await measure();assert.equal(normal.bottom,329,'normal captured layout unchanged');
  await page.evaluate(()=>{(window as any).fixture.preferences.set('interface.keyboardClearance',true);(window as any).fixture.preferences.set('interface.touchFriendly','off')});await page.waitForFunction(()=>document.documentElement.dataset.uiDensity==='compact');assert.equal((await measure()).padding,'16px','keyboard presentation uses ordinary footer gap');
  assert.deepEqual(errors,[]);results.push({theme,locale,before,after,long,short,normal,errors});await context.close();
 }
 await writeFile(output+'/result.json',JSON.stringify({results,boundary:'Real Web components with captured numeric viewport inputs and a synthetic native overlay; physical WeChat not verified.'},null,2));console.log('PASS keyboard clearance: negative control, actual menu, preserved editor/draft, captured normal and faulty geometry, short viewport, zoom, close, compact density');
}finally{await browser?.close();await server.close()}
