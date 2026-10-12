import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = "/tmp/opencraft-sidebar-topology";
const source = `
import React,{useEffect,useState}from'react';import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();let mounts=0;const actions=[];
function Context(){const [expanded,setExpanded]=useState(true);useEffect(()=>{mounts++},[]);return <div style={{height:'100%',display:'flex',flexDirection:'column'}}><input aria-label='Sidebar filter' defaultValue='Keep filter'/><button onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>Local</button><div data-scroll-list style={{overflowY:'auto',flex:1,minHeight:0}}>{expanded?Array.from({length:80},(_,i)=><div key={i} style={{padding:12}}>Task {i}</div>):null}</div></div>}
function App(){const[open,setOpen]=useState(true);const[width,setWidth]=useState(275);const[context,setContext]=useState(true);const[accountName,setAccountName]=useState(null);
window.fixture={setOpen,setContext,setWidth,setAccountName,width,setThemePreference,mounts:()=>mounts,actions};
return <AppShell navigation={{layout:'unified',actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>actions.push('Chat')},{id:'kanban',title:'Kanban',icon:'columns',onInvoke:()=>actions.push('Kanban')}],settingsActive:false,onOpenSettings:()=>actions.push('Settings'),account:{snapshot:{phase:accountName?'authenticated':'anonymous',name:accountName,avatarUrl:null},onOpen:()=>actions.push('Sign in'),onRefresh:async()=>{},onSignOut:async()=>{}}}}
layoutScope='test' mainContentLayout='default' sidebarOpen={open} sidebarWidth={width} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={v=>v!==null&&setWidth(v)} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><button onClick={dock}>固定侧栏</button>}
leftPanel={context?<Context/>:null}>
<div style={{padding:28}} onClick={()=>actions.push('Main')}><h1>Workspace</h1><input aria-label='Main draft' defaultValue='Keep draft'/></div></AppShell>}
createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-sidebar-topology", esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query"] },
  plugins: [{ name: "shared-sidebar-fixture", resolveId: id => id === "/shared-probe.tsx" ? id : null, load: id => id === "/shared-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/shared-probe.tsx"></script>'); }); },
  }],
});

let browser: any;
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({headless:true, executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:"reduce"});
  const errors:string[]=[];page.on("pageerror",(e:Error)=>errors.push(e.message));
  // Old persisted pins and compact detents must not resurrect the second rail.
  await page.addInitScript("window.__name=value=>value;localStorage.setItem('opencraft.shell-navigation.v2',JSON.stringify({applications:true,account:true,railDetent:'compact'}))");
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
  await page.getByLabel("Sidebar filter").waitFor();
  assert.equal(await page.getByRole('button',{name:'Applications',exact:true}).count(),0);
  assert.equal(await page.getByRole('separator',{name:'Resize applications',exact:true}).count(),0);
  assert.equal(await page.locator('.app-shell-sidecar [data-sidecar-pane]').count(),1);
  const geometry=await page.evaluate(()=>{
    const rect=(selector:string)=>{const r=document.querySelector(selector)!.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};};
    return {sidebar:rect('.app-shell-sidecar'),navigation:rect('.shell-sidebar-navigation'),context:rect('[data-sidebar-content="context"]'),footer:rect('.shell-navigation__footer')};
  });
  assert.ok(Math.abs(geometry.sidebar.w-275)<1,JSON.stringify(geometry));
  assert.ok(geometry.context.y>=geometry.navigation.bottom-1,JSON.stringify(geometry));
  assert.ok(geometry.footer.y>=geometry.context.bottom-1,JSON.stringify(geometry));
  assert.ok(geometry.context.h>300,JSON.stringify(geometry));
  await page.getByLabel('Sidebar filter').fill('Preserve context');
  await page.getByLabel('Main draft').fill('Preserve draft');
  await page.evaluate(()=>{(window as any).originalContext=document.querySelector('[data-sidebar-content="context"]');document.querySelector('[data-scroll-list]')!.scrollTop=500;});
  const handle=await page.getByRole('separator',{name:'Resize sidebar',exact:true}).boundingBox();assert.ok(handle);
  await page.mouse.move(handle.x+1,handle.y+handle.height/2);await page.mouse.down();
  await page.mouse.move(handle.x+1+100,handle.y+handle.height/2);
  await page.waitForFunction(()=>document.querySelector('.app-shell-left-panel')!.getBoundingClientRect().width>350);
  const held=await page.evaluate(()=>({frame:document.querySelector('.app-shell-left-panel')!.getBoundingClientRect().width,content:document.querySelector('.shell-sidebar__column')!.getBoundingClientRect().width}));
  assert.ok(held.frame>350 && Math.abs(held.frame-held.content)<1,JSON.stringify(held));await page.mouse.up();
  await page.screenshot({path:`${output}/desktop.png`});
  await page.getByRole('button',{name:'Hide sidebar',exact:true}).click();
  await page.getByRole('button',{name:'Show sidebar',exact:true}).click();
  await page.getByLabel('Sidebar filter').waitFor();
  assert.equal(await page.getByLabel('Sidebar filter').inputValue(),'Preserve context');
  assert.equal(await page.getByLabel('Main draft').inputValue(),'Preserve draft');
  assert.equal(await page.evaluate(()=>(window as any).originalContext===document.querySelector('[data-sidebar-content="context"]')),true);
  assert.equal(await page.evaluate(()=>document.querySelector('[data-scroll-list]')!.scrollTop),500);
  // Application routes may omit context: destinations and footer still share the same sidebar.
  await page.evaluate(()=>(window as any).fixture.setContext(false));
  await page.getByLabel('Sidebar filter').waitFor({state:'detached'});
  assert.equal(await page.locator('.app-shell-sidecar [data-sidecar-pane]').count(),1);
  await page.getByRole('button',{name:'Kanban',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>(window as any).fixture.actions),['Kanban']);
  await page.evaluate(()=>(window as any).fixture.setContext(true));
  await page.getByLabel('Sidebar filter').waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Show sidebar',exact:true}).click();
  const floating=page.locator('.app-shell-floating-left-panel');await floating.waitFor();
  assert.equal(await floating.locator('.floating-sidebar-primary').count(),0);
  assert.equal(await floating.getByRole('separator',{name:'Resize sidebar',exact:true}).count(),1);
  await page.screenshot({path:`${output}/mobile.png`});
  const mobile=await floating.boundingBox();assert.ok(mobile && mobile.width<=366 && mobile.x>=0 && mobile.x+mobile.width<=390);
  await floating.getByRole('button',{name:'Kanban',exact:true}).click();await floating.waitFor({state:'hidden'});
  assert.equal(await page.getByLabel('Main draft').inputValue(),'Preserve draft');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,geometry,held,mobile,checks:'single pane; shared DOM/draft/scroll; held resize; context-free route; mobile navigation dismiss'}));
} finally {await browser?.close();await vite.close();}
