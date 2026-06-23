'use client';

import { ProductReturnHomeHeader } from '@/components/site/product-chrome';
import { AgentSettingsPage } from '@/pages/marketing/agent-settings-page';
import type { AgentSectionId } from '@/router/paths';

import { AgentsRouteLoading, AppRouteShell } from './app-route-shell';

export function AgentsPageClient({ sectionId }: { sectionId?: AgentSectionId }) {
  return (
    <AppRouteShell loadingFallback={<AgentsRouteLoading />}>
      <ProductReturnHomeHeader reloadLanguageAfterSwitch />
      <AgentSettingsPage sectionId={sectionId} showHeader={false} />
    </AppRouteShell>
  );
}
