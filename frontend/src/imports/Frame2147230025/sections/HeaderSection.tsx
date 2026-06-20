import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import "../motion.css";

import { LanguageSwitcher } from "@/components/site/language-switcher";
import { ProductHeaderButton, ProductHeaderShell } from "@/components/site/product-chrome";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { isGlobal, localizedPath } from "@/lib/region";

/** 顶部导航项配置（与现网 lightvela.com 保持一致）
 * 概览 → /  ·  更新日志 → /changelog（仅国内站）  ·  产品文档 → /docs/overview  ·  关于我们 → /about
 */
const NAV_LINKS = [
  { label: "概览", href: "/" },
  { label: "更新日志", href: "/changelog" },
  { label: "产品文档", href: "/docs/overview" },
  { label: "关于我们", href: "/about" },
];

function stripLocalePrefix(pathname: string): string {
  const normalized = pathname.replace(/^\/(en|zh)(?=\/|$)/, "") || "/";
  return normalized === "//" ? "/" : normalized;
}

function isNavLinkActive(href: string, pathname: string): boolean {
  const activePath = stripLocalePrefix(pathname);
  const activeHref = stripLocalePrefix(href);
  return activeHref === "/" ? activePath === "/" : activePath === activeHref || activePath.startsWith(`${activeHref}/`);
}

type HeaderAuthSnapshot = {
  authReady: boolean;
  isAuthenticated: boolean;
};

interface HeaderSectionProps {
  onLoginClick?: () => void;
  onCreateClick?: () => void;
  authSnapshot?: HeaderAuthSnapshot;
}

interface HeaderSectionContentProps extends HeaderSectionProps {
  authSnapshot: HeaderAuthSnapshot;
}

function HeaderAuthActions({
  authSnapshot,
  onCreateClick,
  onLoginClick,
}: {
  authSnapshot: HeaderAuthSnapshot;
  onCreateClick?: () => void;
  onLoginClick?: () => void;
}) {
  const t = useT();
  const { authReady, isAuthenticated } = authSnapshot;

  if (!authReady) {
    return (
      <div aria-hidden className="flex shrink-0 items-center gap-3" data-testid="landing-header-auth-loading">
        <span className="h-[36px] w-[96px] rounded-[100px] bg-black/[0.06]" />
        <span className="h-[36px] w-[64px] rounded-[100px] bg-black/[0.04]" />
        {isGlobal && <span className="h-[36px] w-[70px] rounded-[100px] bg-black/[0.04]" />}
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <>
        {isGlobal && <LanguageSwitcher />}
        <UserAvatarMenu />
      </>
    );
  }

  return (
    <>
      <ProductHeaderButton variant="primary" onClick={onCreateClick}>
        {t("立即创建")}
      </ProductHeaderButton>
      <ProductHeaderButton onClick={onLoginClick}>
        {t("登录")}
      </ProductHeaderButton>
      {isGlobal && <LanguageSwitcher />}
    </>
  );
}

export function HeaderSectionContent({ onLoginClick, onCreateClick, authSnapshot }: HeaderSectionContentProps) {
  const location = useLocation();
  const t = useT();
  const { i18n } = useTranslation();
  const locale = i18n.language === "zh-CN" ? "zh-CN" : "en-US";
  const sitePath = (href: string) => (href === "/" ? href : localizedPath(href, locale));

  const center = (
    <nav className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 gap-8 lg:flex">
      {NAV_LINKS.filter((link) => !(isGlobal && link.href === "/changelog")).map((link) => {
        const href = sitePath(link.href);
        const active = isNavLinkActive(link.href, location.pathname);
        return (
          <Link
            key={link.href}
            to={href}
            className={`lw-nav-link text-[14px] font-['PingFang_SC:Medium',sans-serif] no-underline transition-all duration-200 ease-out hover:-translate-y-[2px] hover:text-black ${
              active ? "lw-nav-link--active font-semibold text-black/90" : "text-[rgba(0,0,0,0.7)]"
            }`}
          >
            {t(link.label)}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <ProductHeaderShell
      position="absolute"
      appearance="immersive"
      center={center}
      actions={(
        <HeaderAuthActions
          authSnapshot={authSnapshot}
          onCreateClick={onCreateClick}
          onLoginClick={onLoginClick}
        />
      )}
    />
  );
}

export default function HeaderSection({ onLoginClick, onCreateClick, authSnapshot }: HeaderSectionProps = {}) {
  const liveSession = useSession();

  return (
    <HeaderSectionContent
      onLoginClick={onLoginClick}
      onCreateClick={onCreateClick}
      authSnapshot={authSnapshot ?? liveSession}
    />
  );
}
