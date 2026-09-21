'use client';

import { AccountPage, PlansBillingPage } from '@/pages/marketing/account-page';

import { AccountRouteLoading, AppRouteShell } from './app-route-shell';

export function AccountPageClient() {
  return (
    <AppRouteShell loadingFallback={<AccountRouteLoading />} showAuthGateFooter={false}>
      <AccountPage />
    </AppRouteShell>
  );
}

export function PlansBillingPageClient() {
  return (
    <AppRouteShell loadingFallback={<AccountRouteLoading />}>
      <PlansBillingPage />
    </AppRouteShell>
  );
}
