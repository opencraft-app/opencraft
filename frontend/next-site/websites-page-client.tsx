'use client';

import { WebsitePage } from '@/pages/app/website-page';

import { AccountRouteLoading, AppRouteShell } from './app-route-shell';

export function WebsitesPageClient() {
  return (
    <AppRouteShell loadingFallback={<AccountRouteLoading />}>
      <WebsitePage />
    </AppRouteShell>
  );
}
