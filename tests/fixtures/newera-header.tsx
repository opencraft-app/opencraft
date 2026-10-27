import React,{useState}from'react';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{ConversationTaskMenu}from'../../apps/workbench-web/src/components/conversation-task-menu.tsx';
import{createIntlTestRoot}from'./intl-root.tsx';
import{AppShell}from'../../apps/workbench-web/src/components/app-shell.tsx';
import{Sidebar}from'../../apps/workbench-web/src/components/sidebar.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{AppShellHeader}from'../../apps/workbench-web/src/components/app-shell-header.tsx';
import{initializeAppearanceTheme,setThemePreference}from'../../apps/workbench-web/src/appearance-theme.ts';
import'../../apps/workbench-web/src/styles/app.scss';
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
