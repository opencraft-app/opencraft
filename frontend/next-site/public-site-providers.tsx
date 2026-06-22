'use client';

import { type ReactNode, useEffect } from 'react';

import { OpenClawProvider } from '@/contexts/openclaw-context';
import { RepositoryProvider } from '@/contexts/repository-context';
import { RuntimeConfigProvider } from '@/contexts/runtime-config-context';
import { SessionProvider } from '@/contexts/session-context';
import i18n from '@/i18n';

import type { PublicRouteLocale } from './public-locale';

type Locale = PublicRouteLocale['locale'];

export function PublicSiteLocaleBridge({ locale, children }: { locale: Locale; children: ReactNode }) {
  if (i18n.language !== locale) {
    void i18n.changeLanguage(locale);
  }

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
