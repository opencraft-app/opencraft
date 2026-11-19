// Acceptance fixture: actual renderer host and Views; synthetic service data only.
import React,{useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {IntlProvider} from 'react-intl';
import {ExtensionSupervisor} from '@opencraft/extension-runtime';
import {WorkbenchPresentationRootProvider} from '@opencraft/design-system-web/presentation-root';
import {loadTrustedRenderer} from '../../../../apps/workbench-web/src/runtime/trusted-renderer-host';
import '../../../../apps/workbench-web/src/styles/app.scss';
import {initializeAppearanceTheme} from '../../../../apps/workbench-web/src/appearance-theme';
initializeAppearanceTheme();
const renderers=new Map<string,React.ComponentType<any>>();
const supervisor=new ExtensionSupervisor({platform:'web',internalContributions:{platformViewRenderer:{prepare(_owner,value){const r=value as any;return {commit(){renderers.set(r.viewType,r.Component);return ()=>renderers.delete(r.viewType);}};}}}});
const calls:string[]=[];
async function request(method:string){calls.push(method);if(method==='opencraft/tasks/capabilities')return {version:1,storage:'sqlite-rows',supportedKinds:[]};if(method==='opencraft/tasks/list')return {tasks:[],members:[]};if(method==='project/list')return {data:[]};if(method==='thread/list')return {data:[]};throw Error('Unmocked fixture RPC: '+method);}
const client={connectionGeneration:1,initializeResult:{capabilities:{extensions:{}}},request,subscribeNotification:()=>()=>{},subscribeStatus:()=>()=>{}} as any;
const tasks={storageHostId:'fixture',request:(_id:string,method:string)=>request(method),listThreads:async()=>[],listProjects:async()=>[],readConversation:async()=>({title:'test',state:'idle'}),prepareConversation:async()=>{calls.push('prepareConversation');},pendingConversationLinks:()=>[],retryConversationLinks:async()=>{},subscribe:()=>()=>{}} as any;
const catalog=await (await fetch('/plugins.json')).json();
for(const plugin of catalog.plugins){const module=await import(/* @vite-ignore */ '/'+plugin.entry);const definition=await loadTrustedRenderer(module.default,{},()=>client,()=>tasks);await supervisor.activate(definition);}
const host={platform:'web',activeHostId:'fixture',profiles:[{hostId:'fixture',hostKind:'server',displayName:'Fixture',enabled:true}],currentUser:{providerId:'fixture',id:'one',name:'Test'},provisionHost:async()=>{throw Error('Not a deployment test');},removeHost:async()=>false,openView(){},pushViewResource(){},replaceViewResource(){}} as any;
function App(){const catalog=useSyncExternalStore(supervisor.contributions.subscribe,supervisor.contributions.getSnapshot);const [view,setView]=useState('opencraft.tasks.board');const View=renderers.get(view);return <IntlProvider locale="zh-CN" messages={{}} onError={()=>{}}><WorkbenchPresentationRootProvider target={document.body}><nav>{catalog.navigation.map(row=><button key={row.contribution.id} onClick={()=>setView((row.contribution.target as any).viewId)}>{row.contribution.title}</button>)}</nav><main>{View?<View host={host} activation={{viewId:view,resourceUri:null}} contribution={{id:view}} reportError={()=>{}}/>:null}</main></WorkbenchPresentationRootProvider></IntlProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
(window as any).workspacePluginProbe={calls,plugins:catalog.plugins.map((p:any)=>p.manifest.id),dispose:()=>supervisor.dispose()};
document.body.dataset.ready='true';
