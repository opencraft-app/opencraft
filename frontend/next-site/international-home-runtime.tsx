'use client';

import { useEffect } from 'react';

import { PublicHeaderAuthIsland } from '@next-site/public-header-auth-island';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

export const INTERNATIONAL_HOME_SCRIPT_SOURCES = [
  '/lightvela-intl-home/runtime.js',
  '/lightvela-intl-home/hero-chat.js',
  '/lightvela-intl-home/scene-wheel.js',
] as const;

export const INTERNATIONAL_HOME_ASSET_VERSION = '20260902-home-performance-v2';

function versionedInternationalHomeAsset(source: string) {
  return `${source}?v=${INTERNATIONAL_HOME_ASSET_VERSION}`;
}

export function InternationalHomeRuntime({ locale, markup }: { locale: PublicSiteLocale; markup: string }) {
  useEffect(() => {
    let cancelled = false;
    const mountedScripts: HTMLScriptElement[] = [];

    async function loadScripts() {
      document.querySelectorAll('script[data-lightvela-intl-home-script]').forEach((script) => script.remove());

      for (const source of INTERNATIONAL_HOME_SCRIPT_SOURCES) {
        if (cancelled) return;
        const scriptSource = versionedInternationalHomeAsset(source);

        await new Promise<void>((resolve) => {
          const script = document.createElement('script');
          script.src = scriptSource;
          script.dataset.lightvelaIntlHomeScript = scriptSource;
          script.dataset.lightvelaIntlHomeLocale = locale;
          script.onload = () => resolve();
          script.onerror = () => {
            console.error(`Failed to load international homepage script: ${scriptSource}`);
            resolve();
          };
          document.body.appendChild(script);
          mountedScripts.push(script);
        });
      }
    }

    void loadScripts();
    return () => {
      cancelled = true;
      mountedScripts.forEach((script) => script.remove());
    };
  }, [locale]);

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
          loginOnly
        />
      </div>
    </>
  );
}
