export const source = `
import React, { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createIntlTestRoot } from '/tests/fixtures/intl-root';
import { AppShell } from '/apps/workbench-web/src/components/app-shell';
import { AppShellToolbarSelect } from '/apps/workbench-web/src/components/app-shell-toolbar-select';
import { ToolbarDock } from '/apps/workbench-web/src/components/toolbar-dock';
import { ChoiceSelect } from '@opencraft/design-system-web/choice-select';
import { ShareIcon, PaletteIcon, PermissionShieldIcon, EditIcon, PinIcon, ForkIcon, ArchiveIcon } from '@opencraft/design-system-web/action-icons';
import { useUiPreferencesRuntime } from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
import { bindInteractionDensity } from '/apps/workbench-web/src/runtime/interaction-density';
import { initializeAppearanceTheme, setThemePreference } from '/apps/workbench-web/src/appearance-theme';
import '/apps/workbench-web/src/styles/app.scss';
import '/apps/workbench-web/src/styles/context-menu.scss';
import '@opencraft/design-system-web/choice-select.web';
initializeAppearanceTheme();
const noop=()=>{}; const client=new QueryClient();
const names=['关联任务','分享链接','更改图标','设为私有（仅自己）','重命名','置顶','新建分支','归档'];
const icons=[ShareIcon,ShareIcon,PaletteIcon,PermissionShieldIcon,EditIcon,PinIcon,ForkIcon,ArchiveIcon];
function Fixture(){
 const preferences=useUiPreferencesRuntime(); const [value,setValue]=useState('gongfeng'); const [host,setHost]=useState('local');
 useEffect(()=>{window.fixture={setTouch:mode=>preferences.set('interface.touchFriendly',mode),setTheme:setThemePreference}; return bindInteractionDensity(document,preferences)},[preferences]);
 const actions=names.map((label,i)=>({id:'action-'+i,label,section:i<2?'collaboration':i<7?'conversation':'lifecycle',icon:React.createElement(icons[i],{size:16}),invoke:()=>window.invoked=label}));
 return <QueryClientProvider client={client}><AppShell layoutScope="touch-menu-rhythm" mainContentLayout="thread-edge-scroll"
 sidebarOpen={false} sidebarWidth={280} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
 windowChrome={{kind:'browser',platform:'darwin',safeArea:{left:0,right:0}}}
 rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop}
 header={<div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 16px',width:'100%'}}><span>连接器</span><ToolbarDock scope="touch-menu-rhythm" dockId="test-menu" actions={actions} label="会话操作" onActionTrigger={noop} returnFocus={()=>null}/></div>}
 floatingSidebarHeader={()=>null} leftPanel={null}>
 <section style={{padding:16,maxWidth:520}}><h2>资产</h2><p>记住什么、在哪干活、用什么账号，由你安排。</p>
 <AppShellToolbarSelect label="选择工作环境" title="工作环境" value={host} onValueChange={setHost} options={[{value:"local",label:"当前服务器",visual:"local"},{value:"remote",label:"独立云端环境",visual:"remote"},{value:"disabled",label:"暂不可用",visual:"remote",disabled:true}]} />
 <ChoiceSelect label="选择服务" value={value} onValueChange={setValue} options={[{value:'gongfeng',label:'工蜂'},{value:'github',label:'GitHub'},{value:'long',label:'仅用于当前助理的独立工作环境与代码账号'}]}/>
 <label>保留草稿<input aria-label="保留草稿" defaultValue="未保存的内容"/></label>
 </section></AppShell></QueryClientProvider>
}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<Fixture/>);
`;
