import React from 'react';
import { createIntlTestRoot } from './intl-root';
import { initializeAppearanceTheme, setThemePreference } from '../../apps/workbench-web/src/appearance-theme';
import { createWebWorkbenchApplication } from '../../apps/workbench-web/src/runtime/web-workbench-application';
import { WorkbenchRoot } from '../../apps/workbench-web/src/workbench-root';
import { asHostId } from '@opencraft/chat-core';
import '../../apps/workbench-web/src/styles/app.scss';

initializeAppearanceTheme();
const theme = new URLSearchParams(location.search).get('theme');
if (theme !== null) setThemePreference(theme === 'dark' ? 'dark' : 'light');
const application = await createWebWorkbenchApplication({ hostProfileMode: 'configured', navigationMode: 'browser' });
const supervisor = application.supervisor;
if (supervisor.mode !== 'active') throw Error('Auth recovery fixture requires the real active Workbench');
await supervisor.registry.ensureConnected('local-codex');
// Browser navigation restores the selected draft from the URL after authentication.
if (!new URLSearchParams(location.search).has('draftId')) supervisor.commands.navigateToHome({ execution: { hostId: asHostId('local-codex'), workspace: { cwd: null, runtimeWorkspaceRoots: [] } }, mode: 'replace' });
(window as any).authRecovery = {
  snapshot: () => supervisor.registry.getRuntime('local-codex').getSnapshot(),
  dispose: () => application.dispose(),
};
createIntlTestRoot(document.getElementById('root')!).render(<WorkbenchRoot application={application} />);
