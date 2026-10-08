'use client';

import { memo, useEffect, useRef, useState } from 'react';

import { PublicHeaderAuthIsland } from '@next-site/public-header-auth-island';
import { HomeMobileNavigation } from '@next-site/home-mobile-navigation';
import { PublicSiteLocaleBridge } from '@next-site/public-site-providers';
import { MaintenanceAnnouncementBanner } from '@/components/site/maintenance-announcement-banner';
import { BrowserLanguageSuggestion } from '@/components/site/browser-language-suggestion';
import { useOpenClaw } from '@/contexts/agent-context';
import { useSession } from '@/contexts/session-context';
import {
  getCtaCopy,
  journeyHref,
  resolveCtaCopyKey,
  resolveCtaRoute,
  type CtaCopyKey,
} from '@/lib/cta-journey';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { PUBLIC_SITE_LOCALES } from '@/lib/public-site-routing';
import { isGlobal } from '@/lib/region';
import { getPassStatus } from '@/lib/billing-flow';

export const INTERNATIONAL_HOME_SCRIPT_SOURCES = [
  '/lightvela-intl-home/runtime.js',
  '/lightvela-intl-home/hero-chat.js',
  '/lightvela-intl-home/scene-wheel.js',
  '/lightvela-intl-home/assets/feature-motion.js',
] as const;

export const INTERNATIONAL_HOME_ASSET_VERSION = '20261008-play-card-v117';

/** Homepage motion mode: GSAP-driven on the global site, CSS-only on the domestic site. */
const MOTION_MODE_GSAP = 'gsap';
const MOTION_MODE_CSS = 'css';

function versionedInternationalHomeAsset(source: string) {
  return `${source}?v=${INTERNATIONAL_HOME_ASSET_VERSION}`;
}

const InternationalHomeMarkup = memo(function InternationalHomeMarkup({ markup }: { markup: string }) {
  return <div dangerouslySetInnerHTML={{ __html: markup }} />;
});

/**
 * 首页 CTA 锚点：Hero 主 CTA、中部 CTA、页脚 CTA。
 * 三者共用同一套状态判断，保证同一用户状态下文案一致、路径一致（issue #73 红线）。
 * 国内站（zh-CN）的 Hero 片段带 data 标记，其余语种与页脚走 class 选择器。
 */
const HOME_CTA_SELECTORS = [
  '[data-domestic-home-hero-cta]',
  '.hero__cta a',
  '.cta__acts a',
  '.foot__cta a',
];

function collectCtaAnchors(): HTMLAnchorElement[] {
  const anchors = HOME_CTA_SELECTORS.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>(selector)),
  );
  return Array.from(new Set(anchors));
}

/** 只替换按钮文字，保留箭头等图标节点。 */
function applyCtaLabel(anchor: HTMLAnchorElement, label: string) {
  const markedLabel = anchor.querySelector<HTMLElement>('[data-domestic-home-hero-cta-label]');
  if (markedLabel) {
    markedLabel.textContent = label;
    return;
  }
  const textNode = Array.from(anchor.childNodes).find(
    (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim(),
  );
  if (textNode) {
    textNode.nodeValue = label;
    return;
  }
  anchor.textContent = label;
}

/** 读取锚点自身的文案节点，忽略箭头等图标节点。 */
function readCtaAnchorLabel(anchor: HTMLAnchorElement): string {
  const markedLabel = anchor.querySelector<HTMLElement>('[data-domestic-home-hero-cta-label]');
  const marked = markedLabel?.textContent?.trim();
  if (marked) return marked;

  const textNode = Array.from(anchor.childNodes).find(
    (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim(),
  );
  return textNode?.nodeValue?.trim() ?? '';
}

/**
 * 从静态片段里读取该语种已审定的官方 CTA 文案，不自行翻译：
 * 片段里指向 `/subscribe` 的按钮就是「订阅前」文案，指向 `/agents` 的就是「订阅后」文案
 * （例如 en-US 的 `Free trial` / `My AI Companion`，ja-JP 的 `無料で開始` / `私のAIパートナー`）。
 *
 * 这样译文的唯一来源是官方静态片段：新增语种、或官方改译文，都不需要改这里的代码。
 * 必须在改写 href / 文案之前读取，否则会读到上一次改写后的结果。
 */
function readOfficialCtaLabels(): Partial<Record<CtaCopyKey, string>> {
  const labels: Partial<Record<CtaCopyKey, string>> = {};

  for (const anchor of collectCtaAnchors()) {
    const href = anchor.getAttribute('href') ?? '';
    const label = readCtaAnchorLabel(anchor);
    if (!label) continue;

    if (href.includes('subscribe')) {
      if (!labels.startFree) labels.startFree = label;
    } else if (href.includes('agents')) {
      if (!labels.myCompanion) labels.myCompanion = label;
    }
  }

  return labels;
}

export function InternationalHomeRuntime({ locale, markup }: { locale: PublicSiteLocale; markup: string }) {
  const { authReady, isAuthenticated, session } = useSession();
  const { bots, hasResolvedPasses, isSubscribed, latestPass, passesError, passesLoading } = useOpenClaw();
  const officialCtaLabelsRef = useRef<Partial<Record<CtaCopyKey, string>>>({});
  const [readyCtaKey, setReadyCtaKey] = useState<string | null>(null);
  const entitlementReady = !isAuthenticated || (hasResolvedPasses && !passesLoading && !passesError);
  const passStatus = latestPass ? getPassStatus(latestPass) : null;
  const hasLapsedPass = passStatus === 'expired' || passStatus === 'isolated';
  const ctaKey = JSON.stringify([locale, authReady, isAuthenticated, entitlementReady, isSubscribed, hasLapsedPass, bots.length, session?.user?.id]);

  // 先于下面的改写 effect 执行：抢在 href / 文案被改写前，从片段里取出该语种官方文案。
  useEffect(() => {
    officialCtaLabelsRef.current = readOfficialCtaLabels();
  }, [locale, markup]);

  useEffect(() => {
    let cancelled = false;
    const mountedScripts: HTMLScriptElement[] = [];

    function loadScripts() {
      document.querySelectorAll('script[data-lightvela-intl-home-script]').forEach((script) => script.remove());
      const home = document.getElementById('lightvela-intl-home');
      if (home) home.dataset.homeMotionMode = isGlobal ? MOTION_MODE_GSAP : MOTION_MODE_CSS;

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

  useEffect(() => {
    const root = document.getElementById('lightvela-intl-home');
    if (!root) return;
    let cancelled = false;
    let stopMotion: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      const loadMotion = isGlobal
        ? import('./international-home-motion').then(({ mountInternationalHomeMotion }) => mountInternationalHomeMotion)
        : import('./domestic-home-mascot-motion').then(({ mountDomesticHomeMascotMotion }) => mountDomesticHomeMascotMotion);
      void loadMotion.then((mountMotion) => {
        if (!cancelled && root.isConnected) stopMotion = mountMotion(root);
      }).catch((error: unknown) => {
        console.error('Failed to load homepage motion', error);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stopMotion?.();
    };
  }, [locale, markup]);

  useEffect(() => {
    if (!authReady || !entitlementReady) return;

    const journeyState = {
      isAuthenticated,
      isSubscribed,
      hasBots: bots.length > 0,
      hasLapsedPass,
    };
    const ctaHref = journeyHref(resolveCtaRoute(journeyState), locale, { localized: isGlobal });
    // 优先用片段里的官方译文，取不到（例如片段没有对应按钮）才回退到兜底文案表。
    const copyKey = resolveCtaCopyKey(journeyState);
    const ctaLabel = officialCtaLabelsRef.current[copyKey] ?? getCtaCopy(locale, journeyState);

    // CTA 落点已由 ctaHref 表达：未订阅新用户 → /subscribe，曾有套餐的老用户 → /agents。
    // 因此这里只改写 href 与文案，
    // 不再拦截点击强制登录（登录入口保留在 Header 的「登录 / Sign In」按钮，见 public-header-auth-island）。
    for (const anchor of collectCtaAnchors()) {
      anchor.setAttribute('href', ctaHref);
      applyCtaLabel(anchor, ctaLabel);
    }
    setReadyCtaKey(ctaKey);
  }, [authReady, bots.length, ctaKey, entitlementReady, hasLapsedPass, isAuthenticated, isSubscribed, locale, markup, session?.user?.id]);

  return (
    <>
      <link
        rel="stylesheet"
        href={versionedInternationalHomeAsset('/lightvela-intl-home/style.css')}
        precedence="lightvela-intl-home"
      />
      <link
        rel="stylesheet"
        href={versionedInternationalHomeAsset('/lightvela-intl-home/assets/hermes-home.css')}
        precedence="lightvela-intl-home-companions"
      />
      <PublicSiteLocaleBridge locale={locale}>
        <MaintenanceAnnouncementBanner />
      </PublicSiteLocaleBridge>
      {locale === PUBLIC_SITE_LOCALES.EN_US && <BrowserLanguageSuggestion />}
      {/* The fragment is generated from a reviewed, repository-owned static source. */}
      {/* 国际站静态片段的 Hero 和页脚默认写着「我的智能体」。权益就绪并完成 CTA 改写前隐藏入口。 */}
      <div className={authReady && entitlementReady && readyCtaKey === ctaKey ? undefined : '[&_.hero__cta]:invisible [&_.foot__cta]:invisible'}>
        <InternationalHomeMarkup markup={markup} />
      </div>
      <div className="international-home-header-actions-layer">
        <PublicHeaderAuthIsland
          appearance="immersive"
          locale={locale}
          showLanguageSwitcher
          showProductEntry={!isGlobal}
          loginOnly
          promoteFreeTrial={false}
        />
        <HomeMobileNavigation locale={locale} />
      </div>
    </>
  );
}
