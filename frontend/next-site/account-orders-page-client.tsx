'use client';

import { AccountOrdersPage } from '@/pages/marketing/account-orders-page';

import { AccountOrdersRouteLoading, AppRouteShell } from './app-route-shell';

export function AccountOrdersPageClient() {
  return (
    <AppRouteShell loadingFallback={<AccountOrdersRouteLoading />}>
      <AccountOrdersPage />
    </AppRouteShell>
  );
}
