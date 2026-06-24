"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Menu, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher, type LanguageSwitcherVariant } from "@/components/site/language-switcher";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import {
  isPublicSiteNavActive,
  PUBLIC_SITE_NAV_ITEMS,
  publicSiteHref,
  type PublicSiteLocale,
  type PublicSiteSection,
} from "@/lib/public-site-navigation";
import { DEFAULT_LOCALE, isGlobal } from "@/lib/region";
import { cn } from "@/lib/utils";

type HeaderPosition = "fixed" | "absolute" | "sticky";
export type HeaderAppearance = "solid" | "immersive";

type HeaderAuthSnapshot = {
  authReady: boolean;
  isAuthenticated: boolean;
};

export type PublicSiteHeaderLinkProps = {
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  href: string;
  onClick?: () => void;
  style?: CSSProperties;
};

export type RenderPublicSiteHeaderLink = (props: PublicSiteHeaderLinkProps) => ReactNode;

type RenderLanguageSwitcher = (options: {
  activeLocale: PublicSiteLocale;
  reloadAfterSwitch: boolean;
  variant: LanguageSwitcherVariant;
}) => ReactNode;

type PublicSiteHeaderProps = {
  appearance?: HeaderAppearance;
  authControls?: ReactNode;
  authSnapshot?: HeaderAuthSnapshot;
  className?: string;
  currentPath?: string;
  currentSection?: PublicSiteSection | "";
  locale?: PublicSiteLocale;
  localized?: boolean;
  onCreateClick?: () => void;
  onLoginClick?: () => void;
  position?: HeaderPosition;
  renderLink?: RenderPublicSiteHeaderLink;
  renderLanguageSwitcher?: RenderLanguageSwitcher;
  reloadLanguageAfterSwitch?: boolean;
  showNav?: boolean;
  showLanguageSwitcher?: boolean;
  showUnauthenticatedActions?: boolean;
};

const LOGO_URL = "/lightvela-logo.svg";

const positionClass: Record<HeaderPosition, string> = {
  absolute: "absolute left-0 top-0 z-50 w-full",
  fixed: "lw-fixed-top fixed inset-x-0 z-50",
  sticky: "sticky top-0 z-40",
};

const appearanceClass: Record<HeaderAppearance, string> = {
  immersive: "border-b border-transparent bg-transparent",
  solid: "border-b border-black/5 bg-white/90 backdrop-blur-[20px]",
};

const textClass: Record<HeaderAppearance, string> = {
  immersive: "text-black/90",
  solid: "text-black/90",
};

const secondaryButtonClass: Record<HeaderAppearance, string> = {
  immersive: "border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5",
  solid: "border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5",
};

const headerLinkBaseStyle: CSSProperties = {
  color: "rgba(0, 0, 0, 0.9)",
  textDecoration: "none",
};

const headerNavLinkStyle: CSSProperties = {
  ...headerLinkBaseStyle,
  alignItems: "center",
  display: "inline-flex",
  fontSize: 14,
  gap: 6,
};

const headerCopy: Record<PublicSiteLocale, {
  closeMenu: string;
  createNow: string;
  login: string;
  openMenu: string;
}> = {
  "en-US": {
    closeMenu: "Close menu",
    createNow: "Create Now",
    login: "Sign In",
    openMenu: "Open menu",
  },
  "zh-CN": {
    closeMenu: "关闭菜单",
    createNow: "立即创建",
    login: "登录",
    openMenu: "打开菜单",
  },
  "zh-SG": {
    closeMenu: "关闭菜单",
    createNow: "立即创建",
    login: "登录",
    openMenu: "打开菜单",
  },
};

function defaultHeaderLocale(): PublicSiteLocale {
  if (DEFAULT_LOCALE === "en-US") return "en-US";
  return isGlobal ? "zh-SG" : "zh-CN";
}

function headerLocaleFromLanguage(language: string | undefined): PublicSiteLocale {
  if (language?.startsWith("zh")) return isGlobal ? "zh-SG" : "zh-CN";
  return "en-US";
}

function useCurrentPath(explicitPath?: string): string {
  const [path, setPath] = useState(explicitPath ?? "/");

  useEffect(() => {
    if (explicitPath) {
      setPath(explicitPath);
      return;
    }
    if (typeof window !== "undefined") {
      setPath(window.location.pathname || "/");
    }
  }, [explicitPath]);

  return explicitPath ?? path;
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    if (!window.matchMedia) return true;
    return window.matchMedia("(min-width: 768px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia) return;
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isDesktop;
}

export function PublicSiteHeader({
  appearance = "solid",
  authControls,
  authSnapshot = { authReady: true, isAuthenticated: false },
  className,
  currentPath,
  currentSection = "",
  locale: explicitLocale,
  localized = isGlobal,
  onCreateClick,
  onLoginClick,
  position = "sticky",
  renderLink,
  renderLanguageSwitcher,
  reloadLanguageAfterSwitch = false,
  showNav = true,
  showLanguageSwitcher = isGlobal && Boolean(onLoginClick),
  showUnauthenticatedActions = true,
}: PublicSiteHeaderProps) {
  const { i18n } = useTranslation();
  const [hydrated, setHydrated] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const path = useCurrentPath(currentPath);
  const isDesktop = useIsDesktop();
  const locale: PublicSiteLocale = explicitLocale ?? (hydrated ? headerLocaleFromLanguage(i18n.language) : defaultHeaderLocale());
  const copy = headerCopy[locale];
  const { authReady, isAuthenticated } = authSnapshot;
  const authLoading = !authReady;
  const usesAuthControlsSlot = Boolean(authControls);

  useEffect(() => {
    setMenuOpen(false);
  }, [path]);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const navLinks = useMemo(() => (
    PUBLIC_SITE_NAV_ITEMS
      .filter((link) => !((isGlobal || localized) && link.cnOnly && locale !== "zh-CN"))
      .map((link) => ({
        href: publicSiteHref(link.href, locale, { localized }),
        label: link.label[locale],
        section: link.section,
      }))
  ), [locale, localized]);

  const isActive = (href: string, section: PublicSiteSection) => (
    currentSection ? currentSection === section : isPublicSiteNavActive(href, path)
  );

  const logoHref = publicSiteHref("/", locale, { localized });
  const textColorClass = textClass[appearance];
  const handleCreateClick = onCreateClick ?? onLoginClick;
  const createHref = "/agents";
  const loginHref = "/agents";
  const renderLanguage = (variant: LanguageSwitcherVariant) => (
    renderLanguageSwitcher
      ? renderLanguageSwitcher({ activeLocale: locale, reloadAfterSwitch: reloadLanguageAfterSwitch, variant })
      : <LanguageSwitcher activeLocale={locale} reloadAfterSwitch={reloadLanguageAfterSwitch} variant={variant} />
  );
  const renderHeaderLink: RenderPublicSiteHeaderLink = renderLink ?? (({
    ariaLabel,
    children,
    ...props
  }) => (
    <a {...props} aria-label={ariaLabel}>
      {children}
    </a>
  ));

  const renderNavLinks = (mobile = false) => navLinks.map((link) => {
    const active = isActive(link.href, link.section);
    const linkClassName = mobile
      ? cn(
          "lw-site-link lw-site-link--nav inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm transition-all duration-250 hover:bg-black/5",
          active ? "font-semibold text-black/90" : "font-normal text-black/90",
        )
      : cn(
          "lw-site-link lw-site-link--nav inline-flex items-center gap-1.5 text-[14px] transition-all duration-250 ease-out hover:-translate-y-[2px]",
          active ? "font-semibold text-black/90" : cn("font-normal", textColorClass),
        );

    return (
      <Fragment key={link.href}>
        {renderHeaderLink({
          href: link.href,
          className: linkClassName,
          onClick: mobile ? () => setMenuOpen(false) : undefined,
          style: mobile
            ? { ...headerLinkBaseStyle, alignItems: "center", display: "inline-flex" }
            : { ...headerNavLinkStyle, fontWeight: active ? 600 : 400 },
          children: link.label,
        })}
      </Fragment>
    );
  });

  return (
    <header
      className={cn("lw-public-site-header", positionClass[position], appearanceClass[appearance], className)}
    >
      <div className="relative mx-auto flex h-[60px] max-w-[1440px] items-center justify-between px-6 md:px-10 lg:px-[80px]">
        {renderHeaderLink({
          href: logoHref,
          className: "flex shrink-0 items-center",
          ariaLabel: "LightVela",
          style: { ...headerLinkBaseStyle, alignItems: "center", display: "flex", flexShrink: 0 },
          children: (
          <img src={LOGO_URL} alt="LightVela" className="h-8 w-auto object-contain" />
          ),
        })}

        {showNav && (
          <nav
            className="lw-public-site-header__nav absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-8 md:flex"
            aria-label="Primary navigation"
          >
            {renderNavLinks()}
          </nav>
        )}

        {authControls}

        {!usesAuthControlsSlot && showUnauthenticatedActions && authLoading && (
          <div data-testid="site-header-auth-loading" className="hidden shrink-0 items-center gap-3 md:flex" aria-hidden="true">
            <span className="h-[36px] w-[96px] rounded-[100px] bg-black/[0.06]" />
            <span className="h-[36px] w-[64px] rounded-[100px] bg-black/[0.04]" />
            {showLanguageSwitcher && <span className="h-[36px] w-[70px] rounded-[100px] bg-black/[0.04]" />}
          </div>
        )}

        {!usesAuthControlsSlot && showUnauthenticatedActions && !authLoading && !isAuthenticated && (
          <div className="hidden shrink-0 items-center gap-3 md:flex">
            {handleCreateClick ? (
              <button
                type="button"
                onClick={handleCreateClick}
                className="inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] border border-black/90 bg-black/90 px-5 font-heading text-sm font-medium text-white shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-all hover:-translate-y-[1px] hover:shadow-lg"
              >
                {copy.createNow}
              </button>
            ) : (
              <a
                href={createHref}
                className="inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] border border-black/90 bg-black/90 px-5 font-heading text-sm font-medium text-white shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-all hover:-translate-y-[1px] hover:shadow-lg"
              >
                {copy.createNow}
              </a>
            )}
            {onLoginClick ? (
              <button
                type="button"
                onClick={onLoginClick}
                className={cn(
                  "inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] px-4 font-heading text-sm font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors",
                  secondaryButtonClass[appearance],
                )}
              >
                {copy.login}
              </button>
            ) : (
              <a
                href={loginHref}
                className={cn(
                  "inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] px-4 font-heading text-sm font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors",
                  secondaryButtonClass[appearance],
                )}
              >
                {copy.login}
              </a>
            )}
            {showLanguageSwitcher && renderLanguage("dropdown")}
          </div>
        )}

        {!usesAuthControlsSlot && !authLoading && isAuthenticated && (
          <div className={cn("flex shrink-0 items-center gap-3", isDesktop ? "ml-0" : "ml-auto")}>
            {showLanguageSwitcher && isDesktop && renderLanguage("dropdown")}
            <UserAvatarMenu />
          </div>
        )}

        {(showNav || (!usesAuthControlsSlot && showUnauthenticatedActions)) && (
        <div className={cn("flex items-center gap-2 md:hidden", usesAuthControlsSlot || isAuthenticated ? "" : "ml-auto")}>
          {!usesAuthControlsSlot && showUnauthenticatedActions && !authLoading && !isAuthenticated && (
            onLoginClick ? (
              <button
                type="button"
                onClick={onLoginClick}
                className={cn(
                  "inline-flex h-[32px] cursor-pointer items-center justify-center rounded-[100px] px-3 font-heading text-[13px] font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors",
                  secondaryButtonClass[appearance],
                )}
              >
                {copy.login}
              </button>
            ) : (
              <a
                href={loginHref}
                className={cn(
                  "inline-flex h-[32px] cursor-pointer items-center justify-center rounded-[100px] px-3 font-heading text-[13px] font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors",
                  secondaryButtonClass[appearance],
                )}
              >
                {copy.login}
              </a>
            )
          )}
          <button
            type="button"
            className={cn("rounded-xl p-2 transition-colors hover:bg-black/5", textColorClass)}
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? copy.closeMenu : copy.openMenu}
          >
            {menuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
        )}
      </div>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute left-0 right-0 top-full border-b border-black/5 bg-white/95 shadow-lg backdrop-blur-[20px] md:hidden"
          >
            <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-6 py-4">
              {showNav && renderNavLinks(true)}

              {!usesAuthControlsSlot && showUnauthenticatedActions && !authLoading && !isAuthenticated && (
                <div className="border-t border-black/5 pt-3">
                  {handleCreateClick ? (
                    <button
                      type="button"
                      data-testid="site-header-mobile-create"
                      onClick={() => {
                        setMenuOpen(false);
                        handleCreateClick();
                      }}
                      className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-black/90 px-5 py-3 text-[14px] font-medium text-white"
                    >
                      {copy.createNow}
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  ) : (
                    <a
                      href={createHref}
                      data-testid="site-header-mobile-create"
                      className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-black/90 px-5 py-3 text-[14px] font-medium text-white"
                    >
                      {copy.createNow}
                      <ArrowRight className="h-4 w-4" />
                    </a>
                  )}
                </div>
              )}

              {showLanguageSwitcher && (
                <div className="border-t border-black/5 pt-3">
                  {renderLanguage("inline")}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
