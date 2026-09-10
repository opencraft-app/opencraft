'use client';

import { memo, useEffect } from 'react';

import { PublicHeaderAuthIsland } from '@next-site/public-header-auth-island';
import { HomeMobileNavigation } from '@next-site/home-mobile-navigation';
import { PublicSiteLocaleBridge } from '@next-site/public-site-providers';
import { MaintenanceAnnouncementBanner } from '@/components/site/maintenance-announcement-banner';
import { useSession } from '@/contexts/session-context';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

export const INTERNATIONAL_HOME_SCRIPT_SOURCES = [
  '/lightvela-intl-home/runtime.js',
  '/lightvela-intl-home/hero-chat.js',
  '/lightvela-intl-home/scene-wheel.js',
] as const;

export const INTERNATIONAL_HOME_ASSET_VERSION = '20260910-unified-header-hero-v30';

function versionedInternationalHomeAsset(source: string) {
  return `${source}?v=${INTERNATIONAL_HOME_ASSET_VERSION}`;
}

const InternationalHomeMarkup = memo(function InternationalHomeMarkup({ markup }: { markup: string }) {
  return <div dangerouslySetInnerHTML={{ __html: markup }} />;
});

export function InternationalHomeRuntime({ locale, markup }: { locale: PublicSiteLocale; markup: string }) {
  const { authReady, isAuthenticated } = useSession();

  useEffect(() => {
    let cancelled = false;
    const mountedScripts: HTMLScriptElement[] = [];

    function loadScripts() {
      document.querySelectorAll('script[data-lightvela-intl-home-script]').forEach((script) => script.remove());

      for (const source of INTERNATIONAL_HOME_SCRIPT_SOURCES) {
        if (cancelled) return;
        const scriptSource = versionedInternationalHomeAsset(source);

        const script = document.createElement('script');
        script.src = scriptSource;
        script.dataset.lightvelaIntlHomeScript = scriptSource;
        script.dataset.lightvelaIntlHomeLocale = locale;
        script.onerror = () => {
          console.error(`Failed to load international homepage script: ${scriptSource}`);
        };
        document.body.appendChild(script);
        mountedScripts.push(script);
      }
    }

    loadScripts();
    return () => {
      cancelled = true;
      document.dispatchEvent(new Event('lightvela-home-dispose'));
      mountedScripts.forEach((script) => script.remove());
    };
  }, [locale, markup]);

  /* Hero CTA 状态化：仅国内站 zh-CN 产物带 data-home-hero-cta 标记，
     未登录进入 /subscribe、登录态进入 /agents。国际站产物不带该标记，
     保持固定文案与链接不变（沿用 2026-09-04 fix-cn-home-cta 的约定）。
     文案与目标全部由产物的 data-* 提供，运行时不硬编码任何文案。 */
  useEffect(() => {
    if (!authReady) return;

    const heroAction = document.querySelector<HTMLAnchorElement>('[data-home-hero-cta]');
    const heroActionLabel = heroAction?.querySelector<HTMLElement>('[data-home-hero-cta-label]');
    if (!heroAction || !heroActionLabel) return;

    const { homeHeroCtaSignedLabel, homeHeroCtaSignedHref, homeHeroCtaAnonLabel, homeHeroCtaAnonHref } =
      heroAction.dataset;
    const label = isAuthenticated ? homeHeroCtaSignedLabel : homeHeroCtaAnonLabel;
    const href = isAuthenticated ? homeHeroCtaSignedHref : homeHeroCtaAnonHref;
    if (!label || !href) return;

    heroAction.href = href;
    heroActionLabel.textContent = label;
  }, [authReady, isAuthenticated]);

  return (
    <>
      <link
        rel="stylesheet"
        href={versionedInternationalHomeAsset('/lightvela-intl-home/style.css')}
        precedence="lightvela-intl-home"
      />
      <PublicSiteLocaleBridge locale={locale}>
        <MaintenanceAnnouncementBanner />
      </PublicSiteLocaleBridge>
      {/* The fragment is generated from a reviewed, repository-owned static source. */}
      <InternationalHomeMarkup markup={markup} />
      <div className="international-home-header-actions-layer">
        {/* 双站统一：头部只承载身份操作（语言切换 + 登录/头像），
            转化入口唯一收口到 Hero 主按钮，避免同页出现两个指向相同目标的入口。 */}
        <PublicHeaderAuthIsland
          appearance="immersive"
          locale={locale}
          showLanguageSwitcher
          showProductEntry={false}
          loginOnly
          promoteFreeTrial={false}
        />
        <HomeMobileNavigation locale={locale} />
      </div>
    </>
  );
}
