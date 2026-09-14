'use client';

import { lazy, Suspense } from 'react';

import { ProductReturnHomeHeader } from '@/components/site/product-chrome';
import type { AgentSectionId, AgentSettingsSectionId } from '@/lib/agent-routes';

import { AgentsRouteLoading, AppRouteShell } from './app-route-shell';

const AgentSettingsPage = lazy(() => import('@/pages/marketing/agent-settings-page').then(
  (module) => ({ default: module.AgentSettingsPage }),
));
const AgentsWorkbenchPage = lazy(() => import('@/pages/marketing/agents-workbench/AgentsWorkbenchPage').then(
  (module) => ({ default: module.AgentsWorkbenchPage }),
));

export function AgentsPageClient({
  initialSectionSlug,
  sectionId,
}: {
  initialSectionSlug?: string;
  sectionId?: AgentSectionId;
}) {
  const isWorkbench = sectionId === 'workbench';
  const productHeader = (
    <ProductReturnHomeHeader
      className={isWorkbench ? undefined : 'lv-agent-sidebar-header'}
      reloadLanguageAfterSwitch
      showDesktopUserMenu={isWorkbench}
    />
  );
  const loadingFallback = isWorkbench ? productHeader : <AgentsRouteLoading />;

  return (
    <AppRouteShell loadingFallback={loadingFallback}>
      <Suspense fallback={loadingFallback}>
        {productHeader}
        {isWorkbench ? (
          <AgentsWorkbenchPage />
        ) : (
          <AgentSettingsPage
            initialSectionSlug={initialSectionSlug}
            sectionId={sectionId as AgentSettingsSectionId | undefined}
            showHeader={false}
          />
        )}
      </Suspense>
    </AppRouteShell>
  );
}
