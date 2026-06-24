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
import { useSession } from "@/contexts/session-context";
import { isGlobal } from "@/lib/region";
import { oauthErrorMessage } from "@/lib/oauth";
import { captureProductEvent, PRODUCT_ANALYTICS_EVENTS, PRODUCT_ANALYTICS_LOCATIONS } from "@/observability/posthog";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { AGENTS_HOME_PATH } from "@/lib/agent-routes";

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

  const handleCreateClick = useCallback(() => {
    captureProductEvent(PRODUCT_ANALYTICS_EVENTS.LANDING_CTA_CLICKED, {
      location: PRODUCT_ANALYTICS_LOCATIONS.PUBLIC_LANDING,
    });
    navigateTo(AGENTS_HOME_PATH);
  }, [navigateTo]);
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
          onCreateClick={handleCreateClick}
          onLoginClick={authControls ? undefined : () => setShowLogin(true)}
          position="absolute"
          renderLink={renderLink}
          renderLanguageSwitcher={renderLanguageSwitcher}
        />
        <HeroSection onCreateClick={handleCreateClick} />
      </div>
      <BrandIconsSection />
      <FeatureSection />
      <CardsSection />
      <ProcessSection />
      <CtaSection onCreateClick={handleCreateClick} />
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
