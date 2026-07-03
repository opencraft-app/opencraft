/**
 * LightVela 官网落地页
 * UI 实现：feature/iztzhou-lightvela（Figma 导出）
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { LegalFooter } from "@/components/site/legal-footer";
import { LightVelaFooter, type RenderFooterLink } from "@/components/site/lightvela-footer";
import { LoginModal } from "@/components/site/login-modal";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { useRealnamePhoneVerificationEnabled } from "@/contexts/runtime-config-context";
import { useSession } from "@/contexts/session-context";
import { REALNAME_LEVEL } from "@/domain/types";
import { useT } from "@/i18n/t";
import { isCN, isGlobal } from "@/lib/region";
import { oauthErrorMessage } from "@/lib/oauth";
import { captureProductEvent, PRODUCT_ANALYTICS_EVENTS, PRODUCT_ANALYTICS_LOCATIONS } from "@/observability/posthog";
import { DATONG_PAGE_IDS } from "@/observability/datong";
import { trackDatongClick } from "@/observability/datong-tracker";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import {
  AGENTS_HOME_PATH,
  SUBSCRIBE_PATH,
  ACCOUNT_PATH,
  REALNAME_REQUIRED_QUERY_KEY,
  getAgentCreatingPath,
} from "@/lib/agent-routes";

import HeroSection from "@/imports/Frame2147230025/sections/HeroSection";
import BrandIconsSection from "@/imports/Frame2147230025/sections/BrandIconsSection";
import FeatureSection, { CardsSection } from "@/imports/Frame2147230025/sections/FeatureSection";
import ProcessSection from "@/imports/Frame2147230025/sections/ProcessSection";
import CtaSection from "@/imports/Frame2147230025/sections/CtaSection";

type LandingNavigateOptions = {
  replace?: boolean;
};

type LandingPageViewProps = {
  authControls?: ReactNode;
  authSnapshot?: {
    authReady: boolean;
    isAuthenticated: boolean;
  };
  currentPath?: string;
  locationSearch?: string;
  navigateTo: (to: string, options?: LandingNavigateOptions) => void;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  renderLanguageSwitcher?: (options: { activeLocale: PublicSiteLocale; reloadAfterSwitch: boolean; variant: LanguageSwitcherVariant }) => ReactNode;
  renderLink?: RenderPublicSiteHeaderLink;
};

export const LandingPageView = ({
  authControls,
  authSnapshot,
  currentPath,
  locationSearch = "",
  navigateTo,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
}: LandingPageViewProps) => {
  const t = useT();
  const { isAuthenticated, session } = useSession();
  const { bots, isSubscribed } = useOpenClaw();
  const realnamePhoneVerificationEnabled = useRealnamePhoneVerificationEnabled();
  const oauthError = useMemo(() => new URLSearchParams(locationSearch).get("oauth_error"), [locationSearch]);
  const oauthInitialError = useMemo(() => oauthErrorMessage(oauthError), [oauthError]);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    if (!oauthError) return;
    if (!authControls) {
      setShowLogin(true);
    }
    navigateTo("/", { replace: true });
  }, [authControls, navigateTo, oauthError]);

  const handleCreateClick = useCallback((origin: 'hero' | 'header' | 'footer' = 'hero') => {
    captureProductEvent(PRODUCT_ANALYTICS_EVENTS.LANDING_CTA_CLICKED, {
      location: PRODUCT_ANALYTICS_LOCATIONS.PUBLIC_LANDING,
    });
    const target = !isAuthenticated
      ? AGENTS_HOME_PATH
      : !isSubscribed
        ? SUBSCRIBE_PATH
        : bots.length > 0
          ? AGENTS_HOME_PATH
          : getAgentCreatingPath(true);
    trackDatongClick(`${origin}_create_now_btn`, {
      pgid: DATONG_PAGE_IDS.HOME,
      params: {
        has_bots: bots.length > 0,
        target,
      },
    });
    // 未登录：进入创建流程入口（产品壳内会引导登录）
    if (!isAuthenticated) {
      navigateTo(AGENTS_HOME_PATH);
      return;
    }
    // 国内站：已登录用户在进入创建流程前，必须先完成实名认证。
    // 未实名则跳转账号管理页，并通过 query 触发页面顶部的实名提醒 tips。
    if (isCN) {
      const user = session?.user;
      const realnameVerified = realnamePhoneVerificationEnabled
        ? user?.realnameLevel === REALNAME_LEVEL.PHONE_3FA
        : Boolean(user?.realnameVerified);
      if (!realnameVerified) {
        navigateTo(`${ACCOUNT_PATH}?${REALNAME_REQUIRED_QUERY_KEY}=1`);
        return;
      }
    }
    // 已登录但未订阅：先去订阅页
    if (!isSubscribed) {
      navigateTo(SUBSCRIBE_PATH);
      return;
    }
    // 已登录且已订阅：有智能体则进 agent 默认页（/agents），
    // 没有智能体则进入创建流程，而不是直接跳到人设设置页。
    navigateTo(bots.length > 0 ? AGENTS_HOME_PATH : getAgentCreatingPath(true));
  }, [navigateTo, isAuthenticated, isSubscribed, bots.length, session?.user, realnamePhoneVerificationEnabled]);

  // 首页主按钮文案：
  //   - 未登录 → 「立即创建」
  //   - 已登录但未订阅 → 「立即创建」（点击去订阅）
  //   - 已登录且已订阅但无智能体 → 「立即创建」（点击进创建流程）
  //   - 已登录且已订阅且有智能体 → 「我的智能体伙伴」（点击进 agent 主页）
  const showAgentPartnerLabel = isAuthenticated && isSubscribed && bots.length > 0;
  const ctaLabel = showAgentPartnerLabel ? t("我的智能体伙伴") : t("立即创建");
  const renderFooterLink: RenderFooterLink | undefined = renderLink
    ? ({ "aria-label": ariaLabel, children, className, href, onClick }) =>
        renderLink({ ariaLabel, children, className, href, onClick })
    : undefined;

  return (
    <div className="w-full bg-white overflow-x-hidden">
      <div className="relative">
        <PublicSiteHeader
          appearance="immersive"
          authControls={authControls}
          authSnapshot={authSnapshot}
          currentPath={currentPath}
          locale={publicLocale}
          localized={publicLocalized}
          onCreateClick={() => handleCreateClick('header')}
          onLoginClick={authControls ? undefined : () => setShowLogin(true)}
          position="absolute"
          renderLink={renderLink}
          renderLanguageSwitcher={renderLanguageSwitcher}
        />
        <HeroSection onCreateClick={() => handleCreateClick('hero')} ctaLabel={ctaLabel} />
      </div>
      <BrandIconsSection />
      <FeatureSection />
      <CardsSection />
      <ProcessSection />
      <CtaSection onCreateClick={() => handleCreateClick('footer')} ctaLabel={ctaLabel} />
      {isGlobal ? <LightVelaFooter renderLink={renderFooterLink} /> : <LegalFooter icpPlacement="right" />}
      {!authControls ? (
        <LoginModal
          open={showLogin}
          onClose={() => setShowLogin(false)}
          initialError={oauthInitialError}
        />
      ) : null}
    </div>
  );
};

export const LandingPage = () => {
  const location = useLocation();
  const { authReady, isAuthenticated } = useSession();

  const navigateTo = useCallback(
    (to: string, options?: LandingNavigateOptions) => {
      if (options?.replace) {
        window.history.replaceState(null, "", to);
        return;
      }
      window.location.assign(to);
    },
    [],
  );

  return (
    <LandingPageView
      authSnapshot={{ authReady, isAuthenticated }}
      locationSearch={location.search}
      navigateTo={navigateTo}
    />
  );
};
