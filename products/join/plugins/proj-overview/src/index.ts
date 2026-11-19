import { createDeferredView } from "@opencraft/extension-react";
import type { TrustedExtensionDefinition } from '@opencraft/extension-runtime';
import type { GetClient } from './reader';
export const PROJ_OVERVIEW_ID = 'join.proj-overview';
export function createProjectOverviewExtension(getClient: GetClient): TrustedExtensionDefinition {
    return {
        manifest: { manifestVersion: 1, id: PROJ_OVERVIEW_ID, name: 'Proj Overview', version: '0.1.0', apiVersion: 1, trust: 'trusted', platforms: ['web'], activationEvents: ['onStartupFinished'] },
        activate(api) { api.views.register({ id: PROJ_OVERVIEW_ID, title: 'Proj Overview', viewType: PROJ_OVERVIEW_ID, platforms: ['web'] }); api.navigation.register({ id: PROJ_OVERVIEW_ID + '.navigation', title: 'Proj Overview', surface: 'applications', target: { kind: 'view', viewId: PROJ_OVERVIEW_ID }, icon: 'chart', order: 36, platforms: ['web'] }); api.internal.register('platformViewRenderer', { viewType: PROJ_OVERVIEW_ID, Component: createDeferredView(async () => {
              const { createProjectOverviewView } = await import('./view');
              api.signal.throwIfAborted();
              return createProjectOverviewView(getClient, api.signal);
            }) }); }
    };
}
