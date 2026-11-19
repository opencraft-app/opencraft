import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Run from an assembled workspace. Uses actual Shell, sidebar row, menu owner,
// badge and Radix behavior; only the employee snapshot is synthetic.
const root=process.cwd();
const output=process.env.OPENCRAFT_PARTICIPANTS_OUTPUT ?? path.join(root,'.local/participants-hover');
fs.mkdirSync(output,{recursive:true});
const {createServer}=await import(pathToFileURL(root+'/node_modules/vite/dist/node/index.js'));
const {chromium}=await import(pathToFileURL(root+'/node_modules/playwright/index.mjs'));
const badgeSource=process.env.OPENCRAFT_PARTICIPANTS_SOURCE;
const fixture=`
import React,{useState}from'react';
import{createParticipantsBadge}from'/products/join/plugins/tencentoa/src/participants-view.tsx';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{SidebarActivityItem}from'/apps/workbench-web/src/components/sidebar-activity-item.tsx';
import{SidebarThreadBadge}from'/apps/workbench-web/src/components/sidebar-thread-menu.tsx';
import{SidebarThreadMenuStore}from'/apps/workbench-web/src/components/sidebar-thread-menu-state.ts';
import{WorkbenchPresentationRootProvider}from'/apps/workbench-web/src/components/workbench-presentation-root.tsx';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();setThemePreference(new URLSearchParams(location.search).get('theme')||'light');
const snapshot={phase:'ready',data:{creator:'skipzhang',participants:['skipzhang']}};
const contribution=createParticipantsBadge({subscribe:()=>()=>{},watch:()=>()=>{},getSnapshot:()=>snapshot});
const menus=new SidebarThreadMenuStore(),noop=()=>{};
window.control={changes:[],close:()=>menus.close()};
function App(){const[shown,show]=useState(true),[threadId,changeThread]=useState('thread-one');
window.control.show=show;window.control.changeThread=changeThread;
const badge=shown?<SidebarThreadBadge store={menus} contribution={contribution} hostId='fixture' threadId={threadId}
onOpenChange={open=>{window.control.changes.push({open,threadId});menus.update({hostId:'fixture',threadId,kind:'badge'},open)}}/>:null;
return <AppShell navigation={{layout:'unified',account:{snapshot:{phase:'authenticated',name:'Fixture',avatarUrl:null},onOpen:noop,onRefresh:async()=>{}},actions:[],onOpenSettings:noop}}
layoutScope='participants-hover' mainContentLayout='default' windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}
sidebarOpen sidebarWidth={300} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop}
header={<span>Participants interaction</span>} floatingSidebarHeader={()=>null}
leftPanel={<div className='sidebar'><SidebarActivityItem active selected={false} pending={false} title='多管家群聊能力'
status='ready' unread={false} project={null} tooltip='' badge={badge} badgePlacement='title' onInvoke={menus.close}/>
<SidebarActivityItem active={false} selected={false} pending={false} title='另一个会话' status='ready' unread={false} project={null} tooltip='' onInvoke={menus.close}/></div>}>
<main style={{padding:24}}><label>Draft<input aria-label='Draft' defaultValue='Keep my draft'/></label><button>Other action</button></main>
</AppShell>}
const target=document.getElementById('root');createIntlTestRoot(target,undefined,'zh-CN').render(<WorkbenchPresentationRootProvider target={target}><App/></WorkbenchPresentationRootProvider>);
`;
const server=await createServer({root,configFile:false,cacheDir:path.join(output,'vite'),logLevel:'error',
  resolve:{dedupe:['react','react-dom','react-intl','@radix-ui/react-popover']},esbuild:{jsx:'automatic',target:'esnext'},
  server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root,...(badgeSource?[path.dirname(badgeSource)]:[])]}},
  optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react-intl','@radix-ui/react-popover','@radix-ui/react-dropdown-menu','@radix-ui/react-context-menu','motion/react','@tanstack/react-query','tslib']},
  plugins:[{name:'participants-hover-fixture',resolveId:id=>id==='/hover-fixture.tsx'?id:null,load:id=>id==='/hover-fixture.tsx'?fixture:badgeSource&&id.endsWith('/products/join/plugins/tencentoa/src/participants-view.tsx')?fs.readFileSync(badgeSource,'utf8'):null,
    configureServer(s){s.middlewares.use((req,res,next)=>{if(req.headers.accept?.includes('text/html')){res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/hover-fixture.tsx"></script>')}else next()})}}]});
let browser,activePage;
try{
  await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  const url='http://127.0.0.1:'+server.httpServer.address().port;
  for(const theme of ['light','dark']){
    const context=await browser.newContext({viewport:{width:1100,height:760}}),page=await context.newPage();
    activePage=page;page.on('console',m=>{if(m.type()==='error')console.error('browser console',m.text())});page.on('requestfailed',r=>console.error('request failed',r.url(),r.failure()));page.on('response',r=>{if(r.status()>=400)console.error('bad response',r.status(),r.url())});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
    await page.goto(url+'/?theme='+theme);
    const badge=page.locator('.ioa-participants__badge'),popup=page.locator('.ioa-participants__popover');
    await badge.waitFor();const draft=page.getByRole('textbox',{name:'Draft'});
    await draft.focus();await badge.hover();await page.waitForTimeout(250);
    assert.equal(await popup.count(),0,'a fast pass must not open');
    await page.mouse.move(800,500);await page.waitForTimeout(700);assert.equal(await popup.count(),0,'leaving cancels pending hover');
    await badge.hover();await page.waitForTimeout(350);assert.equal(await popup.count(),0,'deliberate hover still waits');
    await popup.waitFor();assert.equal(await draft.evaluate(el=>el===document.activeElement),true,'hover must not take draft focus');
    await page.screenshot({path:path.join(output,theme+'-hover.png')});
    await popup.hover();await page.waitForTimeout(250);assert.equal(await popup.count(),1,'crossing into popup keeps preview');
    await page.mouse.move(800,500);await popup.waitFor({state:'hidden'});
    await badge.hover();await page.waitForTimeout(100);await badge.click();
    assert.equal(await popup.count(),1,'explicit click does not wait for hover');
    await page.mouse.move(800,500);await page.waitForTimeout(750);assert.equal(await popup.count(),1,'clicked preview remains pinned');
    await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
    await badge.focus();await page.keyboard.press('Enter');assert.equal(await popup.count(),1,'keyboard opens immediately');
    await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
    await badge.hover();await page.waitForTimeout(100);await badge.dispatchEvent('wheel',{deltaY:100});
    await page.waitForTimeout(700);assert.equal(await popup.count(),0,'scrolling cancels pending preview');
    await page.mouse.move(800,500);await badge.hover();await page.waitForTimeout(100);
    const changes=await page.evaluate(()=>window.control.changes.length);
    await page.evaluate(()=>window.control.changeThread('thread-two'));await page.waitForTimeout(700);
    assert.equal(await page.evaluate(()=>window.control.changes.length),changes,'identity replacement cancels stale timer');
    await page.mouse.move(800,500);await badge.hover();await page.waitForTimeout(100);
    await page.evaluate(()=>window.control.show(false));await page.waitForTimeout(700);
    assert.equal(await page.evaluate(()=>window.control.changes.length),changes,'unmount cancels timer');
    assert.equal(await draft.inputValue(),'Keep my draft');assert.deepEqual(errors,[]);
    console.log(JSON.stringify({theme,actualShell:true,actualSidebarRow:true,mouseDelay:600,passThroughCancelled:true,clickAndKeyboardImmediate:true,draftFocusPreserved:true,scrollAndLifecycleCancelled:true}));
    await context.close();
  }
  const context=await browser.newContext({viewport:{width:1100,height:760},hasTouch:true});const page=await context.newPage();
  await page.goto(url);const badge=page.locator('.ioa-participants__badge'),popup=page.locator('.ioa-participants__popover');await badge.waitFor();
  await badge.dispatchEvent('pointerenter',{pointerType:'touch'});await page.waitForTimeout(700);assert.equal(await popup.count(),0,'touch contact never schedules hover');
  await badge.tap();assert.equal(await popup.count(),1,'touch opens immediately');await context.close();
  console.log(JSON.stringify({touch:true,hoverSuppressed:true,tapImmediate:true,provider:'synthetic',externalWrites:0}));
}catch(error){await activePage?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(await activePage?.locator('body').innerText());throw error;}finally{await browser?.close();await server.close();}
