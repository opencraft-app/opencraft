'use client';

import { SubscribePage } from '@/pages/marketing/subscribe-page';

import { AppRouteShell, ProductSetupRouteLoading } from './app-route-shell';

export function SubscribePageClient() {
  return (
    <AppRouteShell loadingFallback={<ProductSetupRouteLoading />}>
      <SubscribePage />
    </AppRouteShell>
  );
}
