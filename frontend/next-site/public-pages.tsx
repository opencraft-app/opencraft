'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AboutPage } from '@/pages/marketing/about-page';
import { ChangelogPage } from '@/pages/marketing/changelog-page';
import { LandingPageView } from '@/pages/marketing/landing-page';

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

function useNextNavigate() {
  const router = useRouter();

  return useCallback((to: string, options?: NavigateOptions) => {
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
