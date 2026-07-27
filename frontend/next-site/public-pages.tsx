'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AboutPage } from '@/pages/marketing/about-page';
import { ChangelogPage } from '@/pages/marketing/changelog-page';
import { LandingPageView } from '@/pages/marketing/landing-page';
import { SUBSCRIBE_PATH } from '@/lib/agent-routes';

import {
  DEFAULT_PUBLIC_ROUTE_LOCALE,
  type PublicRouteLocale,
} from './public-locale';
import { PublicHeaderAuthIsland } from './public-header-auth-island';
import { renderNextLanguageSwitcher } from './language-switcher';
import { PublicSiteLocaleBridge } from './public-site-providers';
import { renderNextPublicSiteHeaderLink } from './user-menu-link';

type NavigateOptions = {
  replace?: boolean;
};

function useNextSearch() {
  const [search, setSearch] = useState('');

  useEffect(() => {
    setSearch(window.location.search);
  }, []);

  return search;
}

// 产品应用壳路由前缀：这些路由由独立的 AppRouteShell 应用承载，
// 在 Next `output: 'export'`（静态导出）下，App Router 对动态段路由
// （如 /agents/[section]）的客户端软导航（router.push）会静默失败，
// 表现为「点击无反应、URL 不变」。因此跳入产品壳一律使用整页硬跳转。
const APP_SHELL_ROUTE_PREFIXES = ['/agents', '/account', SUBSCRIBE_PATH, '/plan-select'];

function isAppShellRoute(to: string): boolean {
  const path = to.split('?')[0].split('#')[0];
  return APP_SHELL_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function useNextNavigate() {
  const router = useRouter();

  return useCallback((to: string, options?: NavigateOptions) => {
    // 跳入产品壳路由（含 /agents/persona 等动态段）改用硬跳转，
    // 规避静态导出下动态路由软导航失效的问题。
    if (isAppShellRoute(to)) {
      if (typeof window !== 'undefined') {
        if (options?.replace) {
          window.location.replace(to);
        } else {
          window.location.assign(to);
        }
        return;
      }
    }
    if (options?.replace) {
      router.replace(to);
      return;
    }
    router.push(to);
  }, [router]);
}

export function PublicHomePage({
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  localized = DEFAULT_PUBLIC_ROUTE_LOCALE.localized,
}: Partial<PublicRouteLocale> = {}) {
  const locationSearch = useNextSearch();
  const navigateTo = useNextNavigate();
  const pathname = usePathname() || '/';

  return (
    <PublicSiteLocaleBridge locale={locale}>
      <LandingPageView
        authControls={(
          <PublicHeaderAuthIsland
            appearance="immersive"
            locale={locale}
            oauthError={new URLSearchParams(locationSearch).get('oauth_error')}
            showLanguageSwitcher
            promoteFreeTrial
          />
        )}
        locationSearch={locationSearch}
        navigateTo={navigateTo}
        currentPath={pathname}
        publicLocale={locale}
        publicLocalized={localized}
        renderLink={renderNextPublicSiteHeaderLink}
        renderLanguageSwitcher={renderNextLanguageSwitcher}
      />
    </PublicSiteLocaleBridge>
  );
}

export function PublicAboutPage({
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  localized = DEFAULT_PUBLIC_ROUTE_LOCALE.localized,
}: Partial<PublicRouteLocale> = {}) {
  const pathname = usePathname() || '/';

  return (
    <PublicSiteLocaleBridge locale={locale}>
      <AboutPage
        authControls={<PublicHeaderAuthIsland locale={locale} />}
        currentPath={pathname}
        publicLocale={locale}
        publicLocalized={localized}
        renderLink={renderNextPublicSiteHeaderLink}
        renderLanguageSwitcher={renderNextLanguageSwitcher}
      />
    </PublicSiteLocaleBridge>
  );
}

export function PublicChangelogPage({
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  localized = DEFAULT_PUBLIC_ROUTE_LOCALE.localized,
}: Partial<PublicRouteLocale> = {}) {
  const pathname = usePathname() || '/';

  return (
    <PublicSiteLocaleBridge locale={locale}>
      <ChangelogPage
        authControls={<PublicHeaderAuthIsland locale={locale} />}
        currentPath={pathname}
        publicLocale={locale}
        publicLocalized={localized}
        renderLink={renderNextPublicSiteHeaderLink}
        renderLanguageSwitcher={renderNextLanguageSwitcher}
      />
    </PublicSiteLocaleBridge>
  );
}
