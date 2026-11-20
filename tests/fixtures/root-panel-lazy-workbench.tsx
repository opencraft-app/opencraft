import React from 'react';
import { createIntlTestRoot } from './intl-root';
import { initializeAppearanceTheme, setThemePreference } from '../../apps/workbench-web/src/appearance-theme';
import { createWebWorkbenchApplication } from '../../apps/workbench-web/src/runtime/web-workbench-application';
import { WorkbenchRoot } from '../../apps/workbench-web/src/workbench-root';
import { asHostId } from '@opencraft/chat-core';
import '../../apps/workbench-web/src/styles/app.scss';

initializeAppearanceTheme();
setThemePreference(new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
const application = await createWebWorkbenchApplication({ hostProfileMode: 'configured', navigationMode: 'memory' });
const supervisor = application.supervisor;
if (supervisor.mode !== 'active') throw Error('Auth recovery fixture requires the real active Workbench');
await supervisor.registry.ensureConnected('local-codex');
supervisor.commands.navigateToHome({ execution: { hostId: asHostId('local-codex'), workspace: { cwd: null, runtimeWorkspaceRoots: [] } }, mode: 'replace' });
(window as any).authRecovery = {
  snapshot: () => supervisor.registry.getRuntime('local-codex').getSnapshot(),
  dispose: () => application.dispose(),
};

let mounts = 0, unmounts = 0, loads = 0;
const panels = application.panelRuntime.panels;
const owner = () => supervisor.conversationActivation.scopeIdFor(supervisor.coordinator.getSnapshot().location);
const kind = 'fixture.resident-root-panel';
panels.register({kind, createTab: ({id}) => ({id:String(id),kind,region:'right',title:'Resident proof',closable:true,preview:false})});
function ResidentProof() {
  React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
  return <iframe title="Resident root panel" srcDoc="<script>window.residencyToken=Math.random().toString(36)</script><p>Retained viewer</p>" onLoad={() => { loads++; }} />;
}
application.panelRuntime.renderers.register({kind, residency:'while-tab-open', Component:ResidentProof});
(window as any).rootPanelProof = {
  open(id='resident-one') { panels.open(owner(),kind,{id}); },
  hide() { panels.dispatch(owner(),{type:'set-region-open',region:'right',open:false}); },
  show() { panels.dispatch(owner(),{type:'set-region-open',region:'right',open:true}); },
  close(id='resident-one') { panels.close(owner(),'right',id); },
  state() { return {mounts,unmounts,loads,tabs:panels.getOwnerSnapshot(owner()).right.tabs.length}; },
};
createIntlTestRoot(document.getElementById('root')!).render(<WorkbenchRoot application={application} />);
