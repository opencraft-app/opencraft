// Acceptance only: real manager, renderer bridge, Settings Views and brand; synthetic APIs.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import { ExtensionSupervisor, ExtensionManager, provideExtensionInstallationRepository, createPersistentExtensionInstallations } from '@opencraft/extension-runtime';
import { readServerInstalledExtensions, serverInstalledBuiltins } from '../../../../apps/workbench-web/src/runtime/server-installed-extensions';
import { openIndexedDbExtensionPersistence } from '../../../../apps/workbench-web/src/runtime/indexeddb-extension-persistence';
import { ApplicationBrandingRegistry, applyApplicationBranding } from '../../../../apps/workbench-web/src/runtime/application-branding';
import { ApplicationBrand } from '../../../../apps/workbench-web/src/components/application-brand';
import { WorkbenchPresentationRootProvider } from '@opencraft/design-system-web/presentation-root';
import '../../../../apps/workbench-web/src/styles/app.scss';
import { initializeAppearanceTheme } from '../../../../apps/workbench-web/src/appearance-theme';
initializeAppearanceTheme();

const branding = new ApplicationBrandingRegistry();
const renderers = new Map<string, { Component: React.ComponentType<any> }>();
const supervisor = new ExtensionSupervisor({platform:'web', activationTimeoutMs:1000, internalContributions:{
  applicationBranding: branding.createAdapter(),
  platformViewRenderer:{ prepare(_owner, value) { const r=value as {viewType:string;Component:React.ComponentType<any>};
    return {commit(){renderers.set(r.viewType,r);return()=>{if(renderers.get(r.viewType)===r)renderers.delete(r.viewType);}}}; } },
}});
const context = new Context();
await context.plugin(provideExtensionInstallationRepository(await createPersistentExtensionInstallations(await openIndexedDbExtensionPersistence('vela-instance-fixture'))));
const manager = new ExtensionManager({installations:context.extensionInstallations,supervisor,
  builtins:serverInstalledBuiltins(readServerInstalledExtensions()),loader:{load(){throw Error('No URL plugins in this test');}}});
await manager.restore();
const host = {platform:'web',activeHostId:'fixture',profiles:[],provisionHost:async()=>{throw Error('No real provisioning');},removeHost:async()=>false,openView(){},pushViewResource(){},replaceViewResource(){}};
function App(){
  const contribution=useSyncExternalStore(branding.subscribe,branding.getSnapshot).contribution;
  const catalog=useSyncExternalStore(supervisor.contributions.subscribe,supervisor.contributions.getSnapshot);
  const [selected,select]=useState('join.support-review.view');
  useEffect(()=>contribution?applyApplicationBranding(document,contribution):undefined,[contribution]);
  const Component=renderers.get(selected)?.Component;
  return <WorkbenchPresentationRootProvider target={document.body}><div style={{padding:20,minHeight:'100vh',background:'var(--color-background)'}}>
    <header>{contribution?<ApplicationBrand branding={contribution}/>:<strong>OpenCraft</strong>}<span data-testid="core-ready">核心可用</span></header>
    <nav>{catalog.navigation.map(row=><button key={row.contribution.id} onClick={()=>select((row.contribution.target as {viewId:string}).viewId)}>{row.contribution.title}</button>)}</nav>
    {Component?<Component contribution={{id:selected}} host={host} activation={{viewId:selected,resourceUri:null}}/>:<p>可选择功能入口</p>}
  </div></WorkbenchPresentationRootProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
(window as any).instanceProbe={
  state:()=>({brand:branding.getSnapshot().contribution,plugins:manager.getSnapshot().extensions.map(row=>({id:row.installation.extensionId,status:row.status})),navigation:supervisor.contributions.getSnapshot().navigation.map(row=>row.contribution),styles:document.querySelectorAll('style').length}),
  enable:(id:string,value:boolean)=>manager.setEnabled(id,value),
};
document.body.dataset.ready='true';
