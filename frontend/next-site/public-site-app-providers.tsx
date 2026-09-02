'use client';

import { Suspense, type ReactNode } from 'react';

import { CookieConsentBanner } from '@/components/site/cookie-consent-banner';
import { OpenClawProvider } from '@/contexts/agent-context';
import { RepositoryProvider } from '@/contexts/repository-context';
import { RuntimeConfigProvider } from '@/contexts/runtime-config-context';
import { SessionProvider } from '@/contexts/session-context';
import '@/i18n/react-instance-registration';
import { DatongPageEffect } from '@/observability/datong-page-effect';
import { DatongTrackerBridge } from '@/observability/datong-tracker-bridge';
import { ProductAnalyticsBridge } from '@/observability/product-analytics-bridge';
import { RumUserBridge } from '@/observability/rum-user-bridge';

export function PublicSiteAppProviders({ children }: { children: ReactNode }) {
  return (
    <RepositoryProvider>
      <RuntimeConfigProvider>
        <SessionProvider>
          <RumUserBridge />
          <ProductAnalyticsBridge />
          <DatongTrackerBridge />
          <Suspense fallback={null}>
            <DatongPageEffect />
          </Suspense>
          <OpenClawProvider>
            <CookieConsentBanner />
            {children}
          </OpenClawProvider>
        </SessionProvider>
      </RuntimeConfigProvider>
    </RepositoryProvider>
  );
}
