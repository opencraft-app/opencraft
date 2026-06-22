'use client';

import { PlanSelectPage } from '@/pages/app/plan-select-page';

import { AppRouteShell, PlanSelectRouteShell, ProductSetupRouteLoading } from './app-route-shell';

export function PlanSelectPageClient() {
  return (
    <AppRouteShell loadingFallback={<ProductSetupRouteLoading />}>
      <PlanSelectRouteShell>
        <PlanSelectPage />
      </PlanSelectRouteShell>
    </AppRouteShell>
  );
}
