'use client';

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { PricingModal } from '@next-site/pricing-modal';
import { PAY_RETURN_QUERY_KEY } from '@next-site/subscribe-page';
import { DEFAULT_PUBLIC_ROUTE_LOCALE, publicRouteLocaleFromLang } from '@next-site/public-locale';
import { LocaleOverrideProvider } from '@/i18n/t';
import { localeDefinition } from '@/i18n/locales.config';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { REOPEN_PRICING_MODAL_EVENT } from './use-post-login-redirect';

export type OpenPricingModal = (options?: {
  locale?: PublicSiteLocale;
  localized?: boolean;
  /** 支付回跳接棒：弹窗打开后直接进入「等发货 → 建实例 → 跳控制台」。 */
  resumePayReturn?: boolean;
}) => void;

/** 国内站页头、国际站静态首页页头及移动菜单中的「定价」始终进入完整页面。 */
const TOP_NAV_SELECTOR = '.lw-public-site-header__nav, #lightvela-intl-home .nav__links, .home-mobile-menu nav';
/** 静态首页的试用 CTA；产品栏第一项为「1 个月免费试用」，第二项「定价」不在此列。 */
const HOME_TRIAL_SELECTOR = '#lightvela-intl-home .hero__cta a, #lightvela-intl-home .cta__acts a, #lightvela-intl-home .foot__cta a, #lightvela-intl-home .foot__links-grid > div:nth-child(2) li:first-child a';

const isSubscribeHref = (href: string): boolean => {
  const path = href.split('?')[0]?.split('#')[0] ?? '';
  return /(^|\/)subscribe(\/|$)/.test(path);
};

/** 带查询参数或锚点的订阅链接承载积分包、升配、支付回跳等整页意图。 */
const isPlainPricingHref = (href: string): boolean => {
  try {
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin && isSubscribeHref(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
};

/**
 * 仅免费试用入口在当前页面打开定价弹窗；其余订阅链接保留完整定价页，
 * 用户可直接关闭并留在原页面。链接 href 保持不变，作为无 JS / 爬虫场景的兜底。
 */
export function PublicSitePricingModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState<PublicSiteLocale | undefined>(undefined);
  const [localized, setLocalized] = useState(false);
  const [resumePayReturn, setResumePayReturn] = useState(false);

  const openPricingModal = useCallback<OpenPricingModal>((options) => {
    const routeLocale = typeof window === 'undefined'
      ? DEFAULT_PUBLIC_ROUTE_LOCALE
      : publicRouteLocaleFromLang(window.location.pathname.split('/')[1] ?? '') ?? DEFAULT_PUBLIC_ROUTE_LOCALE;
    setLocale(options?.locale ?? routeLocale.locale);
    setLocalized(options?.localized ?? routeLocale.localized);
    setResumePayReturn(options?.resumePayReturn ?? false);
    setOpen(true);
  }, []);

  const openRef = useRef<OpenPricingModal>(openPricingModal);
  openRef.current = openPricingModal;

  /*
   * 支付回跳接棒：收银台整页跳走再回来时，落地的是宿主页（首页 / 文档页…），
   * 既没有独立订阅页实例、弹窗也不在了 —— 用户付完钱看不到任何「开通中」。
   * 这里一进宿主页就把弹窗重新打开，并交给它等发货、建实例、跳控制台。
   *
   * 独立订阅页自己会接棒，不在这里重复开弹窗。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isSubscribeHref(window.location.pathname)) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(PAY_RETURN_QUERY_KEY) !== '1') return;
    openRef.current({ resumePayReturn: true });
  }, []);

  useEffect(() => {
    const reopenAfterLogin = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      event.detail.handled = true;
      openRef.current();
    };
    window.addEventListener(REOPEN_PRICING_MODAL_EVENT, reopenAfterLogin);
    return () => window.removeEventListener(REOPEN_PRICING_MODAL_EVENT, reopenAfterLogin);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.dataset.pricingModal === 'off') return;
      if (anchor.closest(TOP_NAV_SELECTOR)) return;
      if (anchor.dataset.pricingModal !== 'on' && !anchor.matches(HOME_TRIAL_SELECTOR)) return;
      if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href') ?? '';
      if (!href || !isPlainPricingHref(href)) return;

      event.preventDefault();
      openRef.current();
    };

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <>
      {children}
      <LocaleOverrideProvider locale={localeDefinition(locale ?? DEFAULT_PUBLIC_ROUTE_LOCALE.locale).i18nKey}>
        <PricingModal
          open={open}
          locale={locale}
          localized={localized}
          resumePayReturn={resumePayReturn}
          onOpenChange={setOpen}
        />
      </LocaleOverrideProvider>
    </>
  );
}
