import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const output=process.env.OPENCRAFT_THREAD_ACCESS_OUTPUT ?? '/data/output/join-thread-private-20261030/ui';
const source=`
import React,{useState} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {ConversationTaskMenu} from '/apps/workbench-web/src/components/conversation-task-menu.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
setThemePreference(new URL(location.href).searchParams.get('theme')||'light');
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async()=>{}});
const query=new QueryClient(),reader=new URL(location.href).searchParams.has('reader');
let snapshot={serverId:'server',threadId:'thread',creatorActorId:'human',accessMode:'shared',revision:1,canChangeAccess:!reader};
window.mutations=[];window.fail=false;
const port={read:async()=>({...snapshot}),set:async(accessMode,expectedRevision)=>{
  window.mutations.push({accessMode,expectedRevision});
  if(window.fail)throw Error('synthetic save failure');
  snapshot={...snapshot,accessMode,revision:snapshot.revision+1};
  await query.invalidateQueries({queryKey:['thread-access']});return {...snapshot};
}};
const actions={onReadAccess:port.read,onSetAccess:(_,mode,rev)=>port.set(mode,rev),onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{}};
const threads=[{id:'thread',title:'隐私验收会话',project:'workspace',status:'ready',updatedAt:Date.now()/1000,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}];
function App(){return <main style={{padding:24,maxWidth:600}}>
<h1>会话私有权限</h1><div style={{width:320,height:280,display:'flex'}}><Sidebar threads={threads} activeHostId='local' activeThreadId='thread' sidebarLayout={layout} threadActions={actions} threadCapabilities={()=>({rename:true,fork:true,archive:true,delete:true})} onSelectThread={()=>{}} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div>
<p>会话顶部操作</p><ConversationTaskMenu access={port} scope='header' serverId='server' threadId='thread' title='隐私验收会话' verifyConversation={async()=>{}} onOpenTasks={()=>{}} onRename={async()=>{}} />
</main>}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<QueryClientProvider client={query}><App/></QueryClientProvider>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',cacheDir:'node_modules/.vite-thread-access',
  resolve:{dedupe:['react','react-dom']},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','@radix-ui/react-context-menu','@radix-ui/react-dropdown-menu','@tanstack/react-query','hoist-non-react-statics','react-is','scheduler']},
  esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'thread-access-fixture',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,
    configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/?'))return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');});}}]});
let browser:any;const evidence:any[]=[];
try{
  await mkdir(output,{recursive:true});await vite.listen();
  const pw=await import('playwright');browser=await pw.chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  for(const touch of [false,true])for(const reader of [false,true]){
    const context=await browser.newContext({viewport:{width:touch?390:1100,height:844},hasTouch:touch,isMobile:touch});
    const page=await context.newPage(),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.addInitScript('window.__name=v=>v');
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?theme=${touch?'dark':'light'}${reader?'&reader':''}`);
    // Locale supplies the actual accessible label.
    const trigger=page.locator('.sidebar-activity-item__menu-trigger');await trigger.waitFor();
    await trigger.focus();await trigger.click();
    if(reader){await page.getByRole('menuitem',{name:'重命名',exact:true}).waitFor();assert.equal(await page.getByRole('menuitem',{name:'设为私有（仅自己）',exact:true}).count(),0);}
    else{
      await page.getByRole('menuitem',{name:'设为私有（仅自己）',exact:true}).waitFor();
      await page.screenshot({path:`${output}/${touch?'touch-dark':'desktop-light'}-private-menu.png`});
      await page.getByRole('menuitem',{name:'设为私有（仅自己）',exact:true}).click();
      await trigger.focus();await trigger.click();await page.getByRole('menuitem',{name:'恢复共享',exact:true}).waitFor();
      await page.screenshot({path:`${output}/${touch?'touch-dark':'desktop-light'}-shared-menu.png`});
      await page.keyboard.press('Escape');
      await page.locator('.conversation-toolbar button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem',{name:'恢复共享',exact:true}).waitFor();
      await page.getByRole('menuitem',{name:'恢复共享',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=> (window as any).mutations),[{accessMode:'private',expectedRevision:1},{accessMode:'shared',expectedRevision:2}]);
      await page.evaluate(()=>{(window as any).fail=true;});
      await trigger.focus();await trigger.click();await page.getByRole('menuitem',{name:'设为私有（仅自己）',exact:true}).click();
      await page.getByText('访问权限修改未确认，请刷新后重试。',{exact:true}).waitFor();
    }
    assert.deepEqual(errors,[]);evidence.push({touch,reader,pageErrors:errors,mutations:await page.evaluate(()=>(window as any).mutations)});await context.close();
  }
  await writeFile(`${output}/result.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify({status:'passed',output,states:evidence.length}));
}finally{await browser?.close();await vite.close();}
