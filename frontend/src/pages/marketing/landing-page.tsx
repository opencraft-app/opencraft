/**
 * LightVela 官网落地页
 * UI 实现：feature/iztzhou-lightvela（Figma 导出）
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { LegalFooter } from "@/components/site/legal-footer";
import { LightVelaFooter, type RenderFooterLink } from "@/components/site/lightvela-footer";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import type { RenderUserMenuLink } from "@/components/site/user-avatar-menu";
import { isGlobal } from "@/lib/region";
import { captureProductEvent } from "@/observability/posthog";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { AGENTS_HOME_PATH } from "@/router/paths";

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
  currentPath?: string;
  locationSearch?: string;
  navigateTo: (to: string, options?: LandingNavigateOptions) => void;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  renderLanguageSwitcher?: (options: { activeLocale: PublicSiteLocale; reloadAfterSwitch: boolean; variant: LanguageSwitcherVariant }) => ReactNode;
  renderLink?: RenderPublicSiteHeaderLink;
  renderUserMenuLink?: RenderUserMenuLink;
};

export const LandingPageView = ({
  authControls,
  currentPath,
  locationSearch = "",
  navigateTo,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
  renderUserMenuLink,
}: LandingPageViewProps) => {
  const oauthError = useMemo(() => new URLSearchParams(locationSearch).get("oauth_error"), [locationSearch]);

  useEffect(() => {
    if (!oauthError) return;
    navigateTo("/", { replace: true });
    // The header auth island reads the same query during hydration and owns the login modal.
  }, [navigateTo, oauthError]);

  const handleCreateClick = useCallback(() => {
    captureProductEvent("landing_cta_clicked", {
      location: "public_landing",
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
          currentPath={currentPath}
          locale={publicLocale}
          localized={publicLocalized}
          onCreateClick={handleCreateClick}
          position="absolute"
          renderLink={renderLink}
          renderLanguageSwitcher={renderLanguageSwitcher}
          renderUserMenuLink={renderUserMenuLink}
        />
        <HeroSection onCreateClick={handleCreateClick} />
      </div>
      <BrandIconsSection />
      <FeatureSection />
      <CardsSection />
      <ProcessSection />
      <CtaSection onCreateClick={handleCreateClick} />
      {isGlobal ? <LightVelaFooter renderLink={renderFooterLink} /> : <LegalFooter icpPlacement="right" />}
    </div>
  );
};

export const LandingPage = () => {
  const [locationSearch, setLocationSearch] = useState("");

  useEffect(() => {
    setLocationSearch(window.location.search);
  }, []);

  const navigateTo = useCallback(
    (to: string, options?: LandingNavigateOptions) => {
      if (options?.replace) {
        window.history.replaceState(null, "", to);
        setLocationSearch(window.location.search);
        return;
      }
      window.location.assign(to);
    },
    [],
  );

  return <LandingPageView locationSearch={locationSearch} navigateTo={navigateTo} />;
};
