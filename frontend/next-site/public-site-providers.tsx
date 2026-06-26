'use client';

import { type ReactNode, useEffect, useLayoutEffect } from 'react';

import { OpenClawProvider } from '@/contexts/openclaw-context';
import { RepositoryProvider } from '@/contexts/repository-context';
import { RuntimeConfigProvider } from '@/contexts/runtime-config-context';
import { SessionProvider } from '@/contexts/session-context';
import i18n from '@/i18n';
import { ProductAnalyticsBridge } from '@/observability/product-analytics-bridge';
import { RumUserBridge } from '@/observability/rum-user-bridge';

import type { PublicRouteLocale } from './public-locale';

type Locale = PublicRouteLocale['locale'];

export function PublicSiteLocaleBridge({ locale, children }: { locale: Locale; children: ReactNode }) {
  useLayoutEffect(() => {
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [locale]);

  useEffect(() => {
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [locale]);

  return <>{children}</>;
}

export function PublicSiteAppProviders({ children }: { children: ReactNode }) {
  return (
    <RepositoryProvider>
      <RuntimeConfigProvider>
        <SessionProvider>
          <RumUserBridge />
          <ProductAnalyticsBridge />
          <OpenClawProvider>{children}</OpenClawProvider>
        </SessionProvider>
      </RuntimeConfigProvider>
    </RepositoryProvider>
  );
}

export function PublicSiteProviders({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <PublicSiteAppProviders>
      <PublicSiteLocaleBridge locale={locale}>{children}</PublicSiteLocaleBridge>
    </PublicSiteAppProviders>
  );
}
