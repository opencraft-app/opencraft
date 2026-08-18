'use client';

import { Suspense, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { OpenClawProvider } from '@/contexts/agent-context';
import { RepositoryProvider } from '@/contexts/repository-context';
import { RuntimeConfigProvider } from '@/contexts/runtime-config-context';
import { SessionProvider } from '@/contexts/session-context';
import { LocaleOverrideProvider, type I18nLocale } from '@/i18n/t';
import { MaintenanceAnnouncementBanner } from '@/components/site/maintenance-announcement-banner';
import { DatongPageEffect } from '@/observability/datong-page-effect';
import { DatongTrackerBridge } from '@/observability/datong-tracker-bridge';
import { ProductAnalyticsBridge } from '@/observability/product-analytics-bridge';
import { RumUserBridge } from '@/observability/rum-user-bridge';
import { CookieConsentBanner } from '@/components/site/cookie-consent-banner';
import { DEFAULT_LOCALE, readLocaleFromPath } from '@/lib/region';
import { PUBLIC_SITE_LOCALES } from '@/lib/public-site-routing';

import type { PublicRouteLocale } from './public-locale';

type Locale = PublicRouteLocale['locale'];

function i18nLocaleForPublicLocale(locale: Locale): I18nLocale {
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return PUBLIC_SITE_LOCALES.ID_ID;
  if (locale === PUBLIC_SITE_LOCALES.ZH_HANT) return PUBLIC_SITE_LOCALES.ZH_HANT;
  return locale.startsWith('zh') ? PUBLIC_SITE_LOCALES.ZH_CN : PUBLIC_SITE_LOCALES.EN_US;
}

/**
 * 把路由 locale 转成 i18n locale 并通过 Context 注入。
 *
 * 关键：使用 **Context override** 而不是修改 i18n 单例的 `language`。
 * 原因：
 *   - 组件树里 `useT()` → `useTranslation({ lng })` → `i18n.getFixedT(lng)`
 *     直接指定语言，同步生效、与全局 `i18n.language` 无关。
 *   - Next.js SSR 是长驻进程 + 多请求，改全局单例会有并发污染；用 Context
 *     则每次 render 隔离。
 *   - SSR HTML 与客户端 hydration 都用同一 locale 走翻译，避免文案 mismatch。
 */
export function PublicSiteLocaleBridge({ locale, children }: { locale: Locale; children: ReactNode }) {
  const targetLocale = i18nLocaleForPublicLocale(locale);
  return <LocaleOverrideProvider locale={targetLocale}>{children}</LocaleOverrideProvider>;
}

function PublicSiteAnnouncementBanner() {
  const pathname = usePathname() || '/';
  const bannerLocale: I18nLocale = readLocaleFromPath(pathname) ?? DEFAULT_LOCALE;

  return (
    <LocaleOverrideProvider locale={bannerLocale}>
      <MaintenanceAnnouncementBanner />
    </LocaleOverrideProvider>
  );
}

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
            <PublicSiteAnnouncementBanner />
            <CookieConsentBanner />
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
