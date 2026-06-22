'use client';

import { ProductReturnHomeHeader } from '@/components/site/product-chrome';
import { OpenClawSettingsPage } from '@/pages/marketing/openclaw-settings-page';

import { AgentsRouteLoading, AppRouteShell } from './app-route-shell';

export function AgentsPageClient({ sectionSlug }: { sectionSlug?: string }) {
  return (
    <AppRouteShell loadingFallback={<AgentsRouteLoading />}>
      <ProductReturnHomeHeader reloadLanguageAfterSwitch />
      <OpenClawSettingsPage sectionSlug={sectionSlug} showHeader={false} />
    </AppRouteShell>
  );
}
