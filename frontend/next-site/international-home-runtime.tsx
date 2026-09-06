'use client';

import { useEffect } from 'react';

import { PublicHeaderAuthIsland } from '@next-site/public-header-auth-island';
import { useSession } from '@/contexts/session-context';
import { AGENTS_HOME_PATH, SUBSCRIBE_PATH } from '@/lib/agent-routes';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';

export const INTERNATIONAL_HOME_SCRIPT_SOURCES = [
  '/lightvela-intl-home/runtime.js',
  '/lightvela-intl-home/hero-chat.js',
  '/lightvela-intl-home/scene-wheel.js',
] as const;

export const INTERNATIONAL_HOME_ASSET_VERSION = '20260906-home-rotator-v5';

function versionedInternationalHomeAsset(source: string) {
  return `${source}?v=${INTERNATIONAL_HOME_ASSET_VERSION}`;
}

export function InternationalHomeRuntime({ locale, markup }: { locale: PublicSiteLocale; markup: string }) {
  const { authReady, isAuthenticated } = useSession();
  const isDomesticHomepage = !isGlobal && locale === 'zh-CN';

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
      mountedScripts.forEach((script) => script.remove());
    };
  }, [locale]);

  useEffect(() => {
    if (!isDomesticHomepage || !authReady) return;

    const heroAction = document.querySelector<HTMLAnchorElement>('[data-domestic-home-hero-cta]');
    const heroActionLabel = heroAction?.querySelector<HTMLElement>('[data-domestic-home-hero-cta-label]');
    if (!heroAction || !heroActionLabel) return;

    heroAction.href = isAuthenticated ? AGENTS_HOME_PATH : SUBSCRIBE_PATH;
    heroActionLabel.textContent = isAuthenticated ? '开始使用' : '免费试用';
  }, [authReady, isAuthenticated, isDomesticHomepage]);

  return (
    <>
      <link
        rel="stylesheet"
        href={versionedInternationalHomeAsset('/lightvela-intl-home/style.css')}
        precedence="lightvela-intl-home"
      />
      {/* The fragment is generated from a reviewed, repository-owned static source. */}
      <div dangerouslySetInnerHTML={{ __html: markup }} />
      <div className="international-home-header-actions-layer">
        <PublicHeaderAuthIsland
          appearance="immersive"
          locale={locale}
          showLanguageSwitcher
          showProductEntry
          loginOnly={!isDomesticHomepage}
          promoteFreeTrial={isDomesticHomepage}
        />
      </div>
    </>
  );
}
