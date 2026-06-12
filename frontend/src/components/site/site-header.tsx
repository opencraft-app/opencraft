import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { BrandMark } from "@/components/site/brand-mark";
import { LanguageSwitcher } from "@/components/site/language-switcher";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";
import { cn } from "@/lib/utils";

type NavLink = {
  label: string;
  href: string;
  comingSoon?: boolean;
};

interface SiteHeaderProps {
  onLoginClick: () => void;
  className?: string;
  fixed?: boolean;
  reloadLanguageAfterSwitch?: boolean;
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

function useNavLinks(): NavLink[] {
  const t = useT();
  return [
    { label: t("概览"), href: "/" },
    ...(!isGlobal ? [{ label: t("更新日志"), href: "/changelog" }] : []),
    { label: t("产品文档"), href: "/docs" },
    { label: t("关于我们"), href: "/about" },
  ];
}

function isLinkActive(href: string, pathname: string): boolean {
  if (href === "#") return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader({
  onLoginClick,
  className,
  fixed = false,
  reloadLanguageAfterSwitch = false,
}: SiteHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { authReady, isAuthenticated } = useSession();
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const t = useT();
  const navLinks = useNavLinks();
  const authLoading = !authReady;
  const isLoggedIn = authReady && isAuthenticated;

  useEffect(() => {
    setMenuOpen(false);
  }, [location]);

  const renderLinkContent = (link: NavLink) => (
    <>
      {link.label}
      {link.comingSoon && (
        <span className="inline-flex h-[16px] items-center justify-center whitespace-nowrap rounded-bl-none rounded-br-[4px] rounded-tl-[4px] rounded-tr-[4px] bg-[#202020] px-1.5 text-[10px] font-normal leading-none text-white">
          {t("即将上线")}
        </span>
      )}
    </>
  );

  return (
    <header
      className={cn(
        "lw-landing-navbar border-b border-black/5 bg-white/90 backdrop-blur-[20px]",
        fixed ? "lw-fixed-top fixed inset-x-0 z-50" : "sticky top-0 z-40",
        className,
      )}
    >
      <div className="mx-auto flex h-[60px] max-w-[1440px] items-center px-6 md:px-10 lg:px-[80px]">
        <BrandMark to="/" />

        <nav className="lw-landing-navbar__nav hidden flex-1 items-center justify-center gap-6 md:flex">
          {navLinks.map((link) => {
            const active = isLinkActive(link.href, location.pathname);
            const linkClassName = cn(
              "lw-site-link lw-site-link--nav inline-flex items-center gap-1.5 text-[14px] transition-all duration-250 ease-out hover:-translate-y-[2px]",
              active ? "font-semibold text-black/90" : "font-normal text-black/90",
            );

            if (link.href === "#") {
              return (
                <a key={link.label} href={link.href} className={linkClassName}>
                  {renderLinkContent(link)}
                </a>
              );
            }

            return (
              <Link key={link.label} to={link.href} className={linkClassName}>
                {renderLinkContent(link)}
              </Link>
            );
          })}
        </nav>

        {authLoading && (
          <div
            data-testid="site-header-auth-loading"
            className="hidden shrink-0 items-center gap-3 md:flex"
            aria-hidden="true"
          >
            <span className="h-[36px] w-[96px] rounded-[100px] bg-black/[0.06]" />
            <span className="h-[36px] w-[64px] rounded-[100px] bg-black/[0.04]" />
            {isGlobal && <span className="h-[36px] w-[70px] rounded-[100px] bg-black/[0.04]" />}
          </div>
        )}

        {!authLoading && !isLoggedIn && (
          <div className="hidden shrink-0 items-center gap-3 md:flex">
            <button
              type="button"
              onClick={onLoginClick}
              className="inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] bg-black/90 px-5 font-heading text-sm font-medium text-white shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-all hover:-translate-y-[1px] hover:shadow-lg"
            >
              {t("立即创建")}
            </button>
            <button
              type="button"
              onClick={onLoginClick}
              className="inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] border border-[#E6E9EF] bg-[#F5F5F5] px-4 font-heading text-sm font-medium text-black/90 shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors hover:bg-black/5"
            >
              {t("登录")}
            </button>
            {isGlobal && <LanguageSwitcher reloadAfterSwitch={reloadLanguageAfterSwitch} />}
          </div>
        )}

        {!authLoading && isLoggedIn && (
          <div className={cn("flex shrink-0 items-center gap-3", isDesktop ? "ml-0" : "ml-auto")}>
            {isGlobal && isDesktop && <LanguageSwitcher reloadAfterSwitch={reloadLanguageAfterSwitch} />}
            <UserAvatarMenu />
          </div>
        )}

        <div className={cn("flex items-center gap-2 md:hidden", isLoggedIn ? "" : "ml-auto")}>
          {!authLoading && !isLoggedIn && (
            <button
              type="button"
              onClick={onLoginClick}
              className="inline-flex h-[32px] cursor-pointer items-center justify-center rounded-[100px] border border-[#E6E9EF] bg-[#F5F5F5] px-3 font-heading text-[13px] font-medium text-black/90 shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors hover:bg-black/5"
            >
              {t("登录")}
            </button>
          )}
          <button
            type="button"
            className="rounded-xl p-2 text-black/90 transition-colors hover:bg-black/5"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? t("关闭菜单") : t("打开菜单")}
          >
            {menuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
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
              {navLinks.map((link) => {
                const active = isLinkActive(link.href, location.pathname);
                const linkClassName = cn(
                  "lw-site-link lw-site-link--nav inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm transition-all duration-250 hover:bg-black/5",
                  active ? "font-semibold text-black/90" : "font-normal text-black/90",
                );

                if (link.href === "#") {
                  return (
                    <a key={link.label} href={link.href} className={linkClassName} onClick={() => setMenuOpen(false)}>
                      {renderLinkContent(link)}
                    </a>
                  );
                }

                return (
                  <Link key={link.label} to={link.href} className={linkClassName} onClick={() => setMenuOpen(false)}>
                    {renderLinkContent(link)}
                  </Link>
                );
              })}

              {!authLoading && !isLoggedIn && (
                <div className="border-t border-black/5 pt-3">
                  <button
                    type="button"
                    data-testid="site-header-mobile-create"
                    onClick={() => {
                      setMenuOpen(false);
                      onLoginClick();
                    }}
                    className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-black/90 px-5 py-3 text-[14px] font-medium text-white"
                  >
                    {t("立即创建")}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              )}

              {isGlobal && (
                <div className="border-t border-black/5 pt-3">
                  <LanguageSwitcher variant="inline" reloadAfterSwitch={reloadLanguageAfterSwitch} />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
