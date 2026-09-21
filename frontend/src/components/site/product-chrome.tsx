import type { ReactNode } from "react";

import { LanguageSwitcher } from "@/components/site/language-switcher";
import { LegalFooter } from "@/components/site/legal-footer";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import { useSession } from "@/contexts/session-context";
import { AppLink } from "@/lib/app-navigation";
import { isGlobal } from "@/lib/region";
import { cn } from "@/lib/utils";

interface ProductReturnHomeHeaderProps {
  beforeUserMenu?: ReactNode;
  className?: string;
  reloadLanguageAfterSwitch?: boolean;
  renderLink?: RenderPublicSiteHeaderLink;
  showAccountLanguageSwitcher?: boolean;
  showDesktopUserMenu?: boolean;
  showLanguageSwitcher?: boolean;
}

const renderAppHeaderLink: RenderPublicSiteHeaderLink = ({
  ariaLabel,
  children,
  href,
  ...props
}) => (
  <AppLink to={href} aria-label={ariaLabel} {...props}>
    {children}
  </AppLink>
);

export function ProductReturnHomeHeader({
  beforeUserMenu,
  className,
  reloadLanguageAfterSwitch = false,
  renderLink = renderAppHeaderLink,
  showAccountLanguageSwitcher = false,
  showDesktopUserMenu = true,
  showLanguageSwitcher = isGlobal,
}: ProductReturnHomeHeaderProps) {
  const { authReady, isAuthenticated: isLoggedIn } = useSession();

  return (
    <PublicSiteHeader
      beforeUserMenu={beforeUserMenu}
      authSnapshot={{ authReady, isAuthenticated: isLoggedIn }}
      className={className}
      position="fixed"
      reloadLanguageAfterSwitch={reloadLanguageAfterSwitch}
      renderLink={renderLink}
      renderLanguageSwitcher={({ activeLocale, reloadAfterSwitch, variant }) => (
        <LanguageSwitcher activeLocale={activeLocale} reloadAfterSwitch={reloadAfterSwitch} variant={variant} />
      )}
      showAccountLanguageSwitcher={showAccountLanguageSwitcher}
      showLanguageSwitcher={showLanguageSwitcher}
      showDesktopUserMenu={showDesktopUserMenu}
      showNav={false}
      showUnauthenticatedActions={false}
    />
  );
}

export function ProductFooter() {
  return <LegalFooter icpPlacement="right" />;
}

interface ProductPageShellProps {
  afterFooter?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  header?: ReactNode;
}

export function ProductPageShell({
  afterFooter,
  children,
  className,
  footer = <ProductFooter />,
  header = <ProductReturnHomeHeader />,
}: ProductPageShellProps) {
  return (
    <div
      className={cn("landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden", className)}
      style={{ color: "var(--lw-fg)" }}
    >
      {header}
      {children}
      {footer}
      {afterFooter}
    </div>
  );
}
