'use client';

import { AccountPage } from '@/pages/marketing/account-page';

import { AccountRouteLoading, AppRouteShell } from './app-route-shell';

export function AccountPageClient() {
  return (
    <AppRouteShell loadingFallback={<AccountRouteLoading />}>
      <AccountPage />
    </AppRouteShell>
  );
}
