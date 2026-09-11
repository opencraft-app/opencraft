'use client';

import { memo, useEffect } from 'react';

import { PublicHeaderAuthIsland } from '@next-site/public-header-auth-island';
import { HomeMobileNavigation } from '@next-site/home-mobile-navigation';
import { PublicSiteLocaleBridge } from '@next-site/public-site-providers';
import { MaintenanceAnnouncementBanner } from '@/components/site/maintenance-announcement-banner';
import { useOpenClaw } from '@/contexts/agent-context';
import { useSession } from '@/contexts/session-context';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

export const INTERNATIONAL_HOME_SCRIPT_SOURCES = [
  '/lightvela-intl-home/runtime.js',
  '/lightvela-intl-home/hero-chat.js',
  '/lightvela-intl-home/scene-wheel.js',
] as const;

export const INTERNATIONAL_HOME_ASSET_VERSION = '20260911-hero-cta-subscription-v31';

function versionedInternationalHomeAsset(source: string) {
  return `${source}?v=${INTERNATIONAL_HOME_ASSET_VERSION}`;
}

const InternationalHomeMarkup = memo(function InternationalHomeMarkup({ markup }: { markup: string }) {
  return <div dangerouslySetInnerHTML={{ __html: markup }} />;
});

export function InternationalHomeRuntime({ locale, markup }: { locale: PublicSiteLocale; markup: string }) {
  const { authReady, isAuthenticated } = useSession();
  const { isSubscribed, subscriptionReady } = useOpenClaw();

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

  /* Hero CTA 状态化：双站产物均带 data-home-hero-cta 标记。
     按「是否已订阅」而非「是否登录」分流，对应四态判定：
       1 未登录                  → 免费试用 → /subscribe
       2 已登录·未订阅（含过期）  → 免费试用 → /subscribe
       3 已登录·已订阅·未建 Agent → 我的智能体伙伴 → /agents
       4 已登录·已订阅·已有 Agent → 我的智能体伙伴 → /agents
     3 与 4 的文案和目标一致，故无需读取 bots，/agents 落地页自行处理空态。
     文案与目标全部由产物的 data-* 提供，运行时不硬编码任何文案。 */
  useEffect(() => {
    /* 订阅态未就绪时不改写，避免已订阅用户先闪一帧转化文案 */
    if (!authReady || !subscriptionReady) return;

    const heroAction = document.querySelector<HTMLAnchorElement>('[data-home-hero-cta]');
    const heroActionLabel = heroAction?.querySelector<HTMLElement>('[data-home-hero-cta-label]');
    if (!heroAction || !heroActionLabel) return;

    const { homeHeroCtaSignedLabel, homeHeroCtaSignedHref, homeHeroCtaAnonLabel, homeHeroCtaAnonHref } =
      heroAction.dataset;
    const entitled = isAuthenticated && isSubscribed;
    const label = entitled ? homeHeroCtaSignedLabel : homeHeroCtaAnonLabel;
    const href = entitled ? homeHeroCtaSignedHref : homeHeroCtaAnonHref;
    if (!label || !href) return;

    heroAction.href = href;
    heroActionLabel.textContent = label;
  }, [authReady, isAuthenticated, isSubscribed, subscriptionReady]);

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
