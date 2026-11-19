export const source = `
import React,{useEffect,useState} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root';
import {AppShell} from '/apps/workbench-web/src/components/app-shell';
import {ConversationTaskMenu} from '/apps/workbench-web/src/components/conversation-task-menu';
import {ThreadRowMenu,useThreadActionOwner} from '/apps/workbench-web/src/components/thread-management';
import {ConversationAppearanceProvider} from '/apps/workbench-web/src/components/conversation-appearance';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const client=new QueryClient();const noop=()=>{};
const done=async()=>{};const taskPort={request:async()=>({tasks:[]})};
const access={read:async()=>({accessMode:'shared',revision:1,canChangeAccess:true}),set:async()=>({accessMode:'private',revision:2,canChangeAccess:true})};
function SidebarExample(){
 const [open,setOpen]=useState(null);const owner=useThreadActionOwner({onRename:done,onFork:done,onArchive:done,onDelete:done,onCopyReference:done,onSetPinned:done});
 return <div style={{padding:16}}><div className="sidebar-brand"><strong>OpenCraft</strong></div><div className="sidebar-thread-group-heading">今天</div>
 <ThreadRowMenu target={{hostId:'local',threadId:'demo',title:'docker 标准化分发'}} owner={owner}
 capabilities={{rename:true,archive:true,fork:true,delete:false,pin:true,reference:true}} openMenuKind={open}
 onOpenMenuChange={(kind,value)=>setOpen(value?kind:null)}><button type="button" className="sidebar-activity-item"><span>docker 标准化分发</span></button></ThreadRowMenu>
 <p style={{color:'var(--color-text-secondary)'}}>turn 通知能力</p></div>;
}
function Fixture(){const preferences=useUiPreferencesRuntime();const [kind,setKind]=useState('chat');
 useEffect(()=>{window.fixture={setTouch:x=>preferences.set('interface.touchFriendly',x),setTheme:setThemePreference,setKind};return bindInteractionDensity(document,preferences)},[preferences]);
 return <ConversationAppearanceProvider scope="menu-refinement" routeKey="menu-refinement"><AppShell layoutScope="menu-refinement" mainContentLayout="thread-edge-scroll"
 sidebarOpen={false} sidebarWidth={280} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
 windowChrome={{kind:'browser',platform:'darwin',safeArea:{left:0,right:0}}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop}
 floatingSidebarHeader={()=>null} leftPanel={null}
 header={<div style={{padding:12,display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%'}}><span>turn 通知能力</span>{kind==='chat'?<ConversationTaskMenu scope="menu-refinement" serverId="local" threadId="demo" title="turn 通知能力"
 appearanceHostId="local" shareUrl="https://example.test/conversation" port={taskPort} access={access} verifyConversation={done} onOpenTasks={noop}
 onRename={done} onSetPinned={async()=>{window.invoked='pin'}} onFork={done} onArchive={done} project="OpenCraft" workspaceDirectory="/workspace" schedules={{request:async()=>({schedules:[]})}} im={{fetcher:fetch,openSettings:noop}}/>:null}</div>}>
 {kind==='sidebar'?<SidebarExample/>:<section style={{padding:20}}><p>移动端大小还可以了，不精致，字体也不精致。</p><p>保留现在的点击尺寸，收细菜单层级与材质。</p><textarea aria-label="保留草稿" defaultValue="未发送的草稿"/></section>}
 </AppShell></ConversationAppearanceProvider>;
}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);
`;
