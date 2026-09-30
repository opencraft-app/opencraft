'use client';

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { PricingModal } from '@next-site/pricing-modal';
import { PAY_RETURN_QUERY_KEY } from '@next-site/subscribe-page';
import { DEFAULT_PUBLIC_ROUTE_LOCALE, publicRouteLocaleFromLang } from '@next-site/public-locale';
import { LocaleOverrideProvider } from '@/i18n/t';
import { localeDefinition } from '@/i18n/locales.config';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

export type OpenPricingModal = (options?: {
  locale?: PublicSiteLocale;
  localized?: boolean;
  /** 支付回跳接棒：弹窗打开后直接进入「等发货 → 建实例 → 跳控制台」。 */
  resumePayReturn?: boolean;
}) => void;

/** 顶部导航「价格」所在容器：其中的订阅链接保持跳独立页，不改为弹窗。 */
const SITE_HEADER_SELECTOR = '.lw-public-site-header';

const isSubscribeHref = (href: string): boolean => {
  const path = href.split('?')[0]?.split('#')[0] ?? '';
  return /(^|\/)subscribe(\/|$)/.test(path);
};

/**
 * 转化入口拦截：除顶部导航「价格」外，指向订阅页的链接在当前页面打开定价弹窗，
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
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.dataset.pricingModal === 'off') return;
      if (anchor.closest(SITE_HEADER_SELECTOR)) return;

      const href = anchor.getAttribute('href') ?? '';
      if (!href || !isSubscribeHref(href)) return;

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
