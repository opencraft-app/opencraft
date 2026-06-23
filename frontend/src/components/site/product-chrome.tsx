import type { ReactNode } from "react";

import { LanguageSwitcher } from "@/components/site/language-switcher";
import { LegalFooter } from "@/components/site/legal-footer";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import type { RenderUserMenuLink } from "@/components/site/user-avatar-menu";
import { useSession } from "@/contexts/session-context";
import { AppLink } from "@/lib/app-navigation";
import { isGlobal } from "@/lib/region";
import { cn } from "@/lib/utils";

interface ProductReturnHomeHeaderProps {
  reloadLanguageAfterSwitch?: boolean;
  renderLink?: RenderPublicSiteHeaderLink;
  renderUserMenuLink?: RenderUserMenuLink;
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

const renderAppUserMenuLink: RenderUserMenuLink = ({ children, href, ...props }) => (
  <AppLink to={href} {...props}>
    {children}
  </AppLink>
);

export function ProductReturnHomeHeader({
  reloadLanguageAfterSwitch = false,
  renderLink = renderAppHeaderLink,
  renderUserMenuLink = renderAppUserMenuLink,
}: ProductReturnHomeHeaderProps) {
  const { isAuthenticated: isLoggedIn } = useSession();

  return (
    <PublicSiteHeader
      authSnapshot={{ authReady: true, isAuthenticated: isLoggedIn }}
      position="fixed"
      reloadLanguageAfterSwitch={reloadLanguageAfterSwitch}
      renderLink={renderLink}
      renderLanguageSwitcher={({ reloadAfterSwitch, variant }) => (
        <LanguageSwitcher reloadAfterSwitch={reloadAfterSwitch} variant={variant} />
      )}
      renderUserMenuLink={renderUserMenuLink}
      showLanguageSwitcher={isGlobal}
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
