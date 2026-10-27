import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const source=`
import React from 'react';import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {buildOpenCraftThemeCssProperties,longingThemePalette} from '@opencraft/design-system/theme-engine';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import '/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const mode=new URLSearchParams(location.search).get('mode');document.documentElement.dataset.theme=mode;
Object.entries(buildOpenCraftThemeCssProperties(mode,longingThemePalette[mode])).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});const preferences=await openWorkbenchUiPreferences();
const rows=Array.from({length:44},(_,i)=>({id:'row'+i,title:'Conversation '+i,pinned:i<8,project:'workspace',status:'ready',connectionHostId:'host',connectionHostLabel:'Local',updatedAt:Date.now()/1000-i,...legacyDirectServerProjectionFromHost({hostId:'host',hostKind:'local',label:'Local'})}));
createIntlTestRoot(document.getElementById('root')).render(<UiPreferencesProvider runtime={preferences}><div className={'app-shell-root has-unified-sidebar'+(new URLSearchParams(location.search).get('layout')==='mobile'?' app-shell-floating-overlay-root':'')} data-mobile-sidebar={new URLSearchParams(location.search).get('layout')==='mobile'?true:undefined}><div className='shell-sidebar__column' data-navigation-layout={new URLSearchParams(location.search).get('layout')} style={{pointerEvents:'auto',width:320,height:'100vh',gridTemplateColumns:'minmax(0,1fr)',gridTemplateRows:'minmax(0,1fr)'}}><div className='shell-sidebar__scroll'><Sidebar threads={rows} activeHostId='host' activeThreadId='row8' sidebarLayout={layout} onSelectThread={()=>{}} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div></div></div></UiPreferencesProvider>);`;
const output=await mkdtemp(join(tmpdir(),'sidebar-heading-plane-'));const evidence:unknown[]=[];
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-sidebar-heading-plane',optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react-intl','@radix-ui/react-dialog','@radix-ui/react-dropdown-menu','@radix-ui/react-popover']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser:any;
try {
 await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const touch of [false,true])for(const mode of ['light','dark']){
  const page=await browser.newPage({viewport:{width:touch?390:1000,height:720},hasTouch:touch,isMobile:touch});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript('window.__name=x=>x');
  await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?mode='+mode+'&layout='+(touch?'mobile':'desktop'));
  const recent=page.getByRole('region',{name:'Recent',exact:true});const heading=recent.locator('.sidebar-thread-group-heading');await heading.waitFor({timeout:60000});await page.evaluate(()=>document.fonts.ready);await page.mouse.move(900,20);
  await page.screenshot({path:join(output,`${touch}-${mode}-rest.png`)});
  for(let i=0;i<2;i++)await recent.getByRole('button',{name:'Show more',exact:true}).click();
  const track=page.locator(touch?'.shell-sidebar__scroll':'.sidebar-activity-list');
  await track.evaluate(el=>{const h=el.querySelector('[aria-label="Recent"] .sidebar-thread-group-heading')!;el.scrollTop+=h.getBoundingClientRect().top-el.getBoundingClientRect().top+150});
  await page.waitForFunction(()=>{const group=document.querySelector('[aria-label="Recent"]')!;return group.querySelector('.sidebar-thread-group-heading')!.getBoundingClientRect().bottom-group.querySelector('.sidebar-activity-group__items')!.getBoundingClientRect().top>100;});
  const before=await heading.screenshot();
  await recent.locator('.sidebar-activity-group__items').evaluate(el=>(el as HTMLElement).style.background='rgb(255, 0, 255)');
  const marked=await heading.screenshot();
  const change=await page.evaluate(async([a,b])=>{
   const decode=async(s:string)=>{const i=new Image();i.src='data:image/png;base64,'+s;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d')!;g.drawImage(i,0,0);return g.getImageData(0,0,c.width,c.height).data;};
   const aa=await decode(a),bb=await decode(b);let changed=0;for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])changed++;return changed;
  },[before.toString('base64'),marked.toString('base64')]);
  assert.equal(change,0,'rows, selection and avatars cannot change the sticky label plane');
  const geometry=await recent.evaluate(el=>{const h=el.querySelector('.sidebar-thread-group-heading')!,items=el.querySelector('.sidebar-activity-group__items')!;const hr=h.getBoundingClientRect(),ir=items.getBoundingClientRect();return {expected:Math.min(ir.height,Math.max(0,hr.bottom-ir.top)),actual:parseFloat(getComputedStyle(items).getPropertyValue('--sidebar-heading-occlusion')),filter:getComputedStyle(h).backdropFilter,background:getComputedStyle(h).backgroundColor};});
  assert.equal(geometry.filter,'none');assert.equal(geometry.background,'rgba(0, 0, 0, 0)');assert.ok(Math.abs(geometry.actual-geometry.expected)<1);
  await recent.locator('.sidebar-activity-group__items').evaluate(el=>(el as HTMLElement).style.removeProperty('background'));
  await page.screenshot({path:join(output,`${touch}-${mode}-scrolled.png`)});
  const first=await recent.locator('.sidebar-activity-item').first().elementHandle();
  await heading.getByRole('button').click();assert.equal(await heading.getByRole('button').getAttribute('aria-expanded'),'false');await heading.getByRole('button').click();assert.equal(await recent.locator('.sidebar-activity-item').first().evaluate((el,old)=>el===old,first),true);
  await page.setViewportSize({width:touch?420:900,height:650});await page.waitForTimeout(80);assert.deepEqual(errors,[]);evidence.push({touch,mode,change,geometry,disclosure:true,rowIdentity:true,resize:true});await page.close();
 }
 console.log(JSON.stringify({passed:evidence.length,output,evidence}));
} finally {await writeFile(join(output,'report.json'),JSON.stringify(evidence,null,2));await browser?.close();await vite.close();}
