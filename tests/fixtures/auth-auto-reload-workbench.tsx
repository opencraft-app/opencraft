import React from 'react';
import { createIntlTestRoot } from './intl-root';
import { initializeAppearanceTheme, setThemePreference } from '../../apps/workbench-web/src/appearance-theme';
import { createWebWorkbenchApplication } from '../../apps/workbench-web/src/runtime/web-workbench-application';
import { WorkbenchRoot } from '../../apps/workbench-web/src/workbench-root';
import { asHostId } from '@opencraft/chat-core';
import { ClientLocalDocuments } from '@opencraft/document-storage/client-local-documents';
import '../../apps/workbench-web/src/styles/app.scss';

const draftRead = Promise.withResolvers<void>();
const draftRecoveryProbe = { reads: 0, lastSaved: null as string | null, release: () => draftRead.resolve() };
if (sessionStorage.getItem('opencraft.test.hold-draft-read') === '1') {
  sessionStorage.removeItem('opencraft.test.hold-draft-read');
  const nativeRead = ClientLocalDocuments.prototype.read;
  ClientLocalDocuments.prototype.read = async function (id) {
    if (this.name === 'conversation-draft') {
      draftRecoveryProbe.reads++;
      await draftRead.promise;
    }
    return nativeRead.call(this, id);
  };
  const nativeWrite = ClientLocalDocuments.prototype.write;
  ClientLocalDocuments.prototype.write = async function (id, value) {
    await nativeWrite.call(this, id, value);
    if (this.name === 'conversation-draft') draftRecoveryProbe.lastSaved = value;
  };
}

initializeAppearanceTheme();
const theme = new URLSearchParams(location.search).get('theme');
if (theme !== null) setThemePreference(theme === 'dark' ? 'dark' : 'light');
const application = await createWebWorkbenchApplication({ hostProfileMode: 'configured', navigationMode: 'browser' });
const supervisor = application.supervisor;
if (supervisor.mode !== 'active') throw Error('Auth recovery fixture requires the real active Workbench');
await supervisor.registry.ensureConnected('local-codex');
// Browser navigation restores the selected draft from the URL after authentication.
if (location.pathname === '/' && !new URLSearchParams(location.search).has('draftId')) supervisor.commands.navigateToHome({ execution: { hostId: asHostId('local-codex'), workspace: { cwd: null, runtimeWorkspaceRoots: [] } }, mode: 'replace' });
(window as any).authRecovery = {
  snapshot: () => supervisor.registry.getRuntime('local-codex').getSnapshot(),
  draftRecoveryProbe,
  dispose: () => application.dispose(),
};
createIntlTestRoot(document.getElementById('root')!).render(<WorkbenchRoot application={application} />);
