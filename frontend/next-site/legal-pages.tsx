'use client';

import type { ReactNode } from 'react';

import { CookiePolicyPage } from '@/pages/marketing/cookie-policy-page';
import { OpenSourceLicensesPage } from '@/pages/marketing/open-source-licenses-page';
import { PrivacyPolicyPage } from '@/pages/marketing/privacy-policy-page';

import {
  DEFAULT_PUBLIC_ROUTE_LOCALE,
  type PublicRouteLocale,
} from './public-locale';
import { PublicSiteLocaleBridge } from './public-site-providers';

type LegalPageProps = Partial<PublicRouteLocale>;

function withLegalLocale({
  children,
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
}: LegalPageProps & { children: ReactNode }) {
  return (
    <PublicSiteLocaleBridge locale={locale}>
      {children}
    </PublicSiteLocaleBridge>
  );
}

export function PublicPrivacyPolicyPage(props: LegalPageProps = {}) {
  return withLegalLocale({ ...props, children: <PrivacyPolicyPage /> });
}

export function PublicCookiePolicyPage(props: LegalPageProps = {}) {
  return withLegalLocale({ ...props, children: <CookiePolicyPage /> });
}

export function PublicOpenSourceLicensesPage(props: LegalPageProps = {}) {
  return withLegalLocale({ ...props, children: <OpenSourceLicensesPage /> });
}
