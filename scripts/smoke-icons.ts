import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_ICON_REPORT ?? "/tmp/opencraft-icons-evidence";
// Real navigation components; only the extension contribution source is synthetic.
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {WorkbenchIcon,workbenchIconRegistry} from '/apps/workbench-web/src/components/ui/workbench-icon.tsx';
import {SidebarNavigationItem} from '/apps/workbench-web/src/components/sidebar-navigation-item.tsx';
import {SettingsNavigation} from '/apps/workbench-web/src/components/settings-page.tsx';
import {SidebarToggleIcon} from '/apps/workbench-web/src/chrome-actions/sidebar-toggle-icon.tsx';
import {NewTaskIcon} from '/apps/workbench-web/src/chrome-actions/new-task-icon.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const pages=[['model','模型服务','brain'],['remote','远程连接','plug'],['account','Codex 账户','user-round-cog'],['voice','语音输入','microphone'],['identity','员工身份','user']];
const snapshot={settingsPages:pages.map(([id,title,icon])=>({contribution:{id,title,icon,viewId:id}}))};
const store={subscribe:()=>()=>{},getSnapshot:()=>snapshot};
function App(){const [section,setSection]=useState('appearance');const [open,setOpen]=useState(true);
window.fixture={setThemePreference};
return <main style={{height:'100vh',display:'grid',gridTemplateColumns:'260px 1fr',background:'var(--color-background-surface)',color:'var(--color-text)'}}>
<aside style={{padding:'16px 8px',background:'var(--color-background-elevated-secondary)',borderRight:'1px solid var(--color-border-subtle)'}}>
<div style={{display:'flex',gap:12,padding:'0 14px 24px'}}>
<button className='chrome-button' aria-label='Toggle sidebar' onClick={()=>setOpen(!open)}><SidebarToggleIcon sidebarOpen={open}/></button>
<button className='chrome-button' aria-label='Back'><WorkbenchIcon name='arrow-left' size={16}/></button>
<button className='chrome-button' aria-label='Forward' disabled><WorkbenchIcon name='arrow-right' size={16}/></button></div>
<nav className='sidebar-navigation'>{[['start','开始'],['tasks','任务'],['collaboration','Collaboration']].map(([name,title])=><SidebarNavigationItem key={name} title={title} icon={<WorkbenchIcon name={name}/>} onInvoke={()=>setSection(name)}/>)}</nav>
<SettingsNavigation section={section} onSectionChange={setSection} extensionContributions={store} profiles={[]} machines={[]} activeHostId='' onBack={()=>{}} presentation='sidebar' showArchivedConversations/>
</aside>
<section style={{padding:48,overflow:'auto'}}>
<p style={{color:'var(--color-text-secondary)',fontSize:12}}>OPENCRAFT / ICON SYSTEM</p>
<h1 style={{fontSize:30,fontWeight:500,margin:'12px 0'}}>清晰、轻盈、一致</h1>
<p style={{color:'var(--color-text-secondary)',marginBottom:36}}>18px navigation · 16px action · 14px detail</p>
<div style={{display:'grid',gridTemplateColumns:'repeat(6,minmax(76px,1fr))',gap:1,background:'var(--color-border-subtle)',border:'1px solid var(--color-border-subtle)',borderRadius:12,overflow:'hidden'}}>
{Object.keys(workbenchIconRegistry).map(name=><div key={name} style={{display:'grid',justifyItems:'center',gap:16,padding:'24px 4px',background:'var(--color-background-surface)'}}><WorkbenchIcon name={name}/><span style={{fontSize:10,color:'var(--color-text-secondary)'}}>{name}</span></div>)}
</div><div style={{display:'flex',gap:20,alignItems:'center',marginTop:28}}><NewTaskIcon/><WorkbenchIcon name='start'/><WorkbenchIcon name='start' size={14}/><span style={{fontSize:12}}>同一语义，同一图形</span></div>
</section></main>}
createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:"error",
  resolve:{dedupe:["react","react-dom"]},cacheDir:"node_modules/.vite-icons",
  esbuild:{jsx:"automatic"},server:{host:"127.0.0.1",port:0,hmr:false},
  plugins:[{name:"icon-fixture",resolveId:id=>id==="/icons-probe.tsx"?id:null,
    load:id=>id==="/icons-probe.tsx"?source:null,
    configureServer(server){server.middlewares.use((req,res,next)=>{
      if(req.url!=="/")return next();res.setHeader("content-type","text/html");
      res.end('<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/icons-probe.tsx"></script></body></html>');
    });}}]});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(output,{recursive:true});await vite.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  const errors:string[]=[];
  for(const dpr of [1,2]) {
    const page=await browser.newPage({viewport:{width:1100,height:1000},deviceScaleFactor:dpr});
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`);
    await page.getByRole('button',{name:'语音输入',exact:true}).waitFor();
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
      const metrics=await page.locator('aside button svg').evaluateAll(nodes=>nodes.map(svg=>{
        const rect=svg.getBoundingClientRect();const style=getComputedStyle(svg);
        return {width:rect.width,height:rect.height,stroke:style.strokeWidth,hidden:svg.getAttribute('aria-hidden')};
      }));
      assert(metrics.every(m=>m.width===m.height && [16,18].includes(m.width)),JSON.stringify(metrics));
      assert(metrics.every(m=>m.stroke==='1.8px'),JSON.stringify(metrics));
      const navigation=await page.locator('.sidebar-navigation-item svg').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));
      assert(navigation.every(size=>size===18));
      const alignment=await page.locator('aside .sidebar-navigation-item, aside .settings-page__navigation-list button').evaluateAll(nodes=>nodes.map(row=>{
        const svg=row.querySelector('svg')!.getBoundingClientRect();
        const label=row.querySelector('span:not(.sidebar-navigation-item__icon)')!.getBoundingClientRect();
        return {center:svg.x+svg.width/2,label:label.x};
      }));
      assert(alignment.every(m=>m.center===alignment[0].center && m.label===alignment[0].label),JSON.stringify(alignment));
      // Navigation entries must resolve to distinct, meaningful artwork.
      const symbols=await page.locator('aside [data-workbench-icon]').evaluateAll(nodes=>nodes.map(n=>n.innerHTML));
      assert.equal(new Set(symbols).size,symbols.length);
      assert.equal(await page.locator('aside .lucide-circle-help').count(),0);
      await page.screenshot({path:`${output}/icons-${theme}-${dpr}x.png`});
    }
    const voice=page.getByRole('button',{name:'语音输入',exact:true});
    const before=await voice.boundingBox();await voice.click();assert.equal(await voice.getAttribute('aria-current'),'page');assert.deepEqual(await voice.boundingBox(),before);
    const toggle=page.getByRole('button',{name:'Toggle sidebar'});const toggleBefore=await toggle.boundingBox();await toggle.click();assert.deepEqual(await toggle.boundingBox(),toggleBefore);
    assert.equal(await toggle.locator('svg').getAttribute('data-sidebar-toggle-icon-state'),'hidden');
    await page.close();
  }
  assert.deepEqual(errors,[]);await writeFile(`${output}/result.json`,JSON.stringify({passed:true,dpr:[1,2],themes:['light','dark'],checks:['navigation sizing','stroke weight','selection geometry','toggle geometry','page errors']},null,2));
  console.log(`Icon visual checks passed: ${output}`);
} finally {await browser?.close();await vite.close();}
