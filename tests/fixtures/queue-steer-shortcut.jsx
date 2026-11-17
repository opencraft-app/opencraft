import React, {useEffect, useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createConversationKey} from '@opencraft/chat-core';
import {createComposerController, composerDocumentToPlainText} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {restoreQueuedInput,compileSubmitIntent} from '@opencraft/composer-appserver';
import {bindInteractionDensity} from '../../apps/workbench-web/src/runtime/interaction-density';
import {useUiPreferencesRuntime} from '../../apps/workbench-web/src/runtime/ui-preferences-runtime';
import {AppShell} from '../../apps/workbench-web/src/components/app-shell';
import {AppShellHeader} from '../../apps/workbench-web/src/components/app-shell-header';
import {useTimelineViewportHost} from '../../apps/workbench-web/src/timeline-viewport';
import {initializeAppearanceTheme, setThemePreference} from '../../apps/workbench-web/src/appearance-theme';
import '/apps/workbench-web/src/styles/app.scss';
const mode = new URLSearchParams(location.search).get('mode') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.opencraftWindowType = 'browser';
initializeAppearanceTheme(); setThemePreference(mode);
const chrome = {kind: 'browser', platform: 'linux', safeArea: {left: 0, right: 0}};
const noop = () => {};
const documentFor = text => ({version:1, blocks:[{type:'paragraph', children:text ? [{type:'text',text}] : []}]});
const makeController = id => createComposerController({type:'existing-thread',key:createConversationKey('probe',id)}, {now:Date.now,createId:()=>crypto.randomUUID()});
const item = (id, preview) => ({id,preview,state:'queued',operation:'idle',actionable:true,editableContent:{document:documentFor(preview),attachments:[],context:[]}});
const actions = [];
let release, editedInput;
function App() {
  useTimelineViewportHost(chrome);
  const preferences = useUiPreferencesRuntime();
  useEffect(() => bindInteractionDensity(document, preferences), [preferences]);
  const [controller,setController] = useState(()=>makeController('one'));
  const [rows,setRows] = useState(()=>[item('top','First queued message'),item('next','Second queued message')]);
  const [config,setConfig] = useState({mode:'queue',streaming:true,supported:true,disabled:false,submissionDisabled:false,hold:false});
  window.fixture = {
    controller, actions, config, configure: patch=>setConfig(c=>({...c,...patch})),
    replaceRows:setRows, item, release:()=>release?.(),
    nativeImage(){setRows([{...item('image','Queued image'),editableContent:restoreQueuedInput([{type:'image',fileId:'uploaded-image-1'}])}])},
    editedInput:()=>editedInput,
    switchThread:()=>{setController(makeController('two'));setRows([item('new-top','New thread queue')])},
    attachment:lifecycle=>controller.dispatch({type:'add-attachment',attachment:{id:'file',name:'notes.txt',mimeType:'text/plain',size:3,uri:lifecycle==='ready'?'data:text/plain,abc':null,lifecycle,error:null}}),
  };
  return <AppShell layoutScope="thread" mainContentLayout="thread-edge-scroll" navigation={{layout: "unified", actions: [], account: null, onOpenSettings: noop}}
    header={<AppShellHeader conversationHeader title="Queued messages" project={null} sidebarOpen={false} rightPanelOpen={false} rightPanelFullWidth={false}
      onToggleSidebar={noop} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={["sidebar-toggle"]} />}
    windowChrome={chrome} sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
    floatingSidebarHeader={() => null} leftPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop} rightPanel={null}>
    <main style={{maxWidth:900,margin:'32px auto',padding:12}}><OpenCraftComposer
    controller={controller} placeholder='Write a message' isStreaming={config.streaming}
    defaultFollowUpAction={config.mode} supportsQueuedSteer={config.supported}
    disabled={config.disabled} submissionDisabled={config.submissionDisabled}
    queuedSubmissions={rows}
    onSubmit={(intent,context)=>{
      actions.push({type:'submit',action:context.followUpAction,text:composerDocumentToPlainText(intent.document),attachments:intent.attachments.length});
      if(context.followUpAction==='queue')setRows(previous=>[...previous,item('added',composerDocumentToPlainText(intent.document))]);
      return true;
    }}
    onUpdateQueuedSubmission={async(id,intent)=>{editedInput=compileSubmitIntent(intent).input;actions.push({type:'edit',id,text:composerDocumentToPlainText(intent.document)})}}
    onRetryUnconfirmedSteer={async (id,turnId)=>{
      actions.push({type:'retry',id,turnId});
      if(config.hold)await new Promise(resolve=>release=resolve);
      if(config.retryFail)throw new Error('synthetic transport failure');
      setRows(previous=>previous.filter(row=>row.id!==id));
    }}
    onSteerQueuedSubmission={async id=>{
      actions.push({type:'queue-steer',id});
      if(config.hold)await new Promise(resolve=>release=resolve);
      setRows(previous=>previous.filter(row=>row.id!==id));
    }} onCancel={()=>actions.push({type:'cancel'})}/></main></AppShell>;
}
createIntlTestRoot(document.getElementById('root'),undefined,new URL(location.href).searchParams.get('locale')||'en-US').render(<App/>);
