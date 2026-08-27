/**
 * LightVela 官网落地页
 * UI 实现：feature/iztzhou-lightvela（Figma 导出）
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { LegalFooter } from "@/components/site/legal-footer";
import { LightVelaFooter, FooterLinkColumns, FOOTER_SURFACE_CLASS, type RenderFooterLink } from "@/components/site/lightvela-footer";
import { LoginModal } from "@/components/site/login-modal";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import { useOpenClaw } from "@/contexts/agent-context";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";
import { oauthErrorMessage } from "@/lib/oauth";
import { captureProductEvent, PRODUCT_ANALYTICS_EVENTS, PRODUCT_ANALYTICS_LOCATIONS } from "@/observability/posthog";
import { DATONG_PAGE_IDS } from "@/observability/datong";
import { trackDatongClick } from "@/observability/datong-tracker";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { useZhHantDeep } from "@/lib/zh-hant";
import {
  AGENT_SECTION_PATH_BY_ID,
  AGENTS_HOME_PATH,
  SUBSCRIBE_PATH,
  getAgentCreatingPath,
} from "@/lib/agent-routes";

import HeroSection from "@/imports/Frame2147230025/sections/HeroSection";
import BrandIconsSection from "@/imports/Frame2147230025/sections/BrandIconsSection";
import FeatureSection, { CardsSection } from "@/imports/Frame2147230025/sections/FeatureSection";
import ProcessSection from "@/imports/Frame2147230025/sections/ProcessSection";
import CtaSection from "@/imports/Frame2147230025/sections/CtaSection";
import { OverviewAutomationTasksSection } from "./scenario-tasks/OverviewAutomationTasksSection";
import { getOverviewScenarioTaskPacks } from "./scenario-tasks/scenario-packs";

const NO_INSTALLED_SCENARIOS: ReadonlySet<string> = new Set();

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
  const { isAuthenticated } = useSession();
  const { bots, isSubscribed } = useOpenClaw();
  const oauthError = useMemo(() => new URLSearchParams(locationSearch).get("oauth_error"), [locationSearch]);
  const oauthInitialError = useMemo(() => oauthErrorMessage(oauthError), [oauthError]);
  const rawOverviewScenarioTaskPacks = useMemo(
    () => getOverviewScenarioTaskPacks(publicLocale ?? (isGlobal ? "en-US" : "zh-CN")),
    [publicLocale],
  );
  const overviewScenarioTaskPacks = useZhHantDeep(rawOverviewScenarioTaskPacks);
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
      ? SUBSCRIBE_PATH
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
    // 未登录：跳订阅套餐页（未登录可浏览静态价格，点「订阅」时再引导登录）
    if (!isAuthenticated) {
      navigateTo(SUBSCRIBE_PATH);
      return;
    }
    // 功能点1：首页「创建」不再前置实名认证，已登录用户直接进入后续流程。
    // 实名引导下沉到订阅套餐页点「订阅」按钮时通过 tips 提示，降低前置门槛、提升转化。
    // 已登录但未订阅：先去订阅页
    if (!isSubscribed) {
      navigateTo(SUBSCRIBE_PATH);
      return;
    }
    // 已登录且已订阅：有智能体则进 agent 默认页（/agents），
    // 没有智能体则进入创建流程，而不是直接跳到人设设置页。
    navigateTo(bots.length > 0 ? AGENTS_HOME_PATH : getAgentCreatingPath(true));
  }, [navigateTo, isAuthenticated, isSubscribed, bots.length]);

  // 首页主按钮文案：
  //   - 未开通套餐（!isSubscribed，含未登录）→ 「免费试用」（转化引导，降低开通决策门槛）
  //   - 已登录且已订阅但无智能体 → 「立即创建」（点击进创建流程）
  //   - 已登录且已订阅且有智能体 → 「我的智能体伙伴」（点击进 agent 主页）
  const showAgentPartnerLabel = isAuthenticated && isSubscribed && bots.length > 0;
  const ctaLabel = showAgentPartnerLabel
    ? t("我的智能体伙伴")
    : !isSubscribed
      ? t("免费试用")
      : t("立即创建");
  const renderFooterLink: RenderFooterLink | undefined = renderLink
    ? ({ "aria-label": ariaLabel, children, className, href, onClick }) =>
        renderLink({ ariaLabel, children, className, href, onClick })
    : undefined;
  const handleOverviewAutomationClick = useCallback(() => {
    navigateTo(AGENT_SECTION_PATH_BY_ID.automations);
  }, [navigateTo]);

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
          showLanguageSwitcher
        />
        <HeroSection onCreateClick={() => handleCreateClick('hero')} ctaLabel={ctaLabel} />
      </div>
      <BrandIconsSection />
      <FeatureSection />
      <CardsSection />
      <OverviewAutomationTasksSection
        packs={overviewScenarioTaskPacks}
        installedScenarioIds={NO_INSTALLED_SCENARIOS}
        myTasksHref={AGENT_SECTION_PATH_BY_ID.automations}
        onEnable={handleOverviewAutomationClick}
      />
      <ProcessSection />
      <CtaSection onCreateClick={() => handleCreateClick('footer')} ctaLabel={ctaLabel} />
      {isGlobal ? (
        <LightVelaFooter renderLink={renderFooterLink} />
      ) : (
        <>
          {/*
            国内站页脚：分栏导航（产品 / 公司 / 社区）+ 原有紧凑法律行。
            LegalFooter 只承载版权与备案信息，栏目导航与国际站共用 FooterLinkColumns 的数据源。
          */}
          <div className={`w-full ${FOOTER_SURFACE_CLASS} pb-10`}>
            <div className="mx-auto max-w-[1440px] px-6 md:px-10 lg:px-16">
              <FooterLinkColumns renderLink={renderFooterLink} />
            </div>
          </div>
          <LegalFooter icpPlacement="right" showLinks={false} />
        </>
      )}
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
