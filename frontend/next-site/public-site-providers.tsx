'use client';

import { type ReactNode, useEffect } from 'react';

import { OpenClawProvider } from '@/contexts/openclaw-context';
import { RepositoryProvider } from '@/contexts/repository-context';
import { RuntimeConfigProvider } from '@/contexts/runtime-config-context';
import { SessionProvider } from '@/contexts/session-context';
import i18n, { setLocale } from '@/i18n';
import { ProductAnalyticsBridge } from '@/observability/product-analytics-bridge';
import { RumUserBridge } from '@/observability/rum-user-bridge';
import { MaintenanceAnnouncementBanner } from '@/components/site/maintenance-announcement-banner';

import type { PublicRouteLocale } from './public-locale';

type Locale = PublicRouteLocale['locale'];
type I18nLocale = 'zh-CN' | 'en-US';

function i18nLocaleForPublicLocale(locale: Locale): I18nLocale {
  return locale.startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function PublicSiteLocaleBridge({ locale, children }: { locale: Locale; children: ReactNode }) {
  useEffect(() => {
    const targetLocale = i18nLocaleForPublicLocale(locale);
    if (i18n.language !== targetLocale) {
      setLocale(targetLocale);
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
          <OpenClawProvider>
            <MaintenanceAnnouncementBanner />
            {children}
          </OpenClawProvider>
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
