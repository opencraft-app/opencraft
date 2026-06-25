'use client';

import { ProductReturnHomeHeader } from '@/components/site/product-chrome';
import { AgentSettingsPage } from '@/pages/marketing/agent-settings-page';
import { AgentsWorkbenchPage } from '@/pages/marketing/agents-workbench/AgentsWorkbenchPage';
import type { AgentSectionId, AgentSettingsSectionId } from '@/lib/agent-routes';

import { AgentsRouteLoading, AppRouteShell } from './app-route-shell';

export function AgentsPageClient({
  initialSectionSlug,
  sectionId,
}: {
  initialSectionSlug?: string;
  sectionId?: AgentSectionId;
}) {
  const isWorkbench = sectionId === 'workbench';
  const loadingFallback = isWorkbench ? null : <AgentsRouteLoading />;

  return (
    <AppRouteShell loadingFallback={loadingFallback}>
      <ProductReturnHomeHeader reloadLanguageAfterSwitch />
      {isWorkbench ? (
        <AgentsWorkbenchPage />
      ) : (
        <AgentSettingsPage
          initialSectionSlug={initialSectionSlug}
          sectionId={sectionId as AgentSettingsSectionId | undefined}
          showHeader={false}
        />
      )}
    </AppRouteShell>
  );
}
