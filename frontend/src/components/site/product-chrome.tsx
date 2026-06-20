import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { BrandMark } from "@/components/site/brand-mark";
import { LanguageSwitcher } from "@/components/site/language-switcher";
import { LegalFooter } from "@/components/site/legal-footer";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";
import { cn } from "@/lib/utils";

type ProductHeaderPosition = "fixed" | "absolute" | "sticky";
type ProductHeaderAppearance = "solid" | "immersive";

interface ProductHeaderShellProps {
  actions: ReactNode;
  appearance?: ProductHeaderAppearance;
  center?: ReactNode;
  className?: string;
  position?: ProductHeaderPosition;
}

const headerPositionClass: Record<ProductHeaderPosition, string> = {
  fixed: "lw-fixed-top fixed inset-x-0 z-50",
  absolute: "absolute left-0 top-0 z-20 w-full",
  sticky: "sticky top-0 z-40",
};

const headerAppearanceClass: Record<ProductHeaderAppearance, string> = {
  solid: "border-b border-black/5 bg-white/90 backdrop-blur-[20px]",
  immersive: "border-b border-transparent bg-transparent",
};

const productChromeCriticalCss = `
.lv-product-shell {
  width: min(1440px, calc(100vw - 48px));
  margin-left: auto;
  margin-right: auto;
}

@media (min-width: 768px) {
  .lv-product-shell {
    width: min(1440px, calc(100vw - 160px));
  }
}
`;

export function ProductHeaderShell({
  actions,
  appearance = "solid",
  center,
  className,
  position = "fixed",
}: ProductHeaderShellProps) {
  return (
    <header
      className={cn(
        headerPositionClass[position],
        headerAppearanceClass[appearance],
        className,
      )}
    >
      <style>{productChromeCriticalCss}</style>
      <div className="lv-product-shell lw-settings-shell relative flex h-[60px] items-center justify-between">
        <BrandMark to="/" />
        {center}
        <div className="flex shrink-0 items-center gap-3">
          {actions}
        </div>
      </div>
    </header>
  );
}

type ProductHeaderButtonVariant = "primary" | "secondary";

interface ProductHeaderButtonBaseProps {
  children: ReactNode;
  className?: string;
  variant?: ProductHeaderButtonVariant;
}

type ProductHeaderButtonProps = ProductHeaderButtonBaseProps & (
  | {
      to: string;
      onClick?: never;
      type?: never;
    }
  | {
      onClick?: () => void;
      to?: never;
      type?: "button" | "submit";
    }
);

const productHeaderButtonClass = {
  primary: "border border-black/90 bg-black/90 text-white hover:-translate-y-[1px] hover:shadow-lg",
  secondary: "border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5",
} satisfies Record<ProductHeaderButtonVariant, string>;

export function ProductHeaderButton({
  children,
  className,
  variant = "secondary",
  ...props
}: ProductHeaderButtonProps) {
  const buttonClassName = cn(
    "inline-flex h-[36px] items-center justify-center whitespace-nowrap rounded-[100px] px-5 font-heading text-sm font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-all",
    productHeaderButtonClass[variant],
    className,
  );

  if ("to" in props && props.to) {
    return (
      <Link to={props.to} className={buttonClassName}>
        {children}
      </Link>
    );
  }

  return (
    <button type={props.type ?? "button"} onClick={props.onClick} className={buttonClassName}>
      {children}
    </button>
  );
}

interface ProductReturnHomeHeaderProps {
  reloadLanguageAfterSwitch?: boolean;
}

export function ProductReturnHomeHeader({ reloadLanguageAfterSwitch = false }: ProductReturnHomeHeaderProps) {
  const { isAuthenticated: isLoggedIn } = useSession();
  const t = useT();

  return (
    <ProductHeaderShell
      actions={(
        <>
          {isGlobal && <LanguageSwitcher reloadAfterSwitch={reloadLanguageAfterSwitch} />}
          <ProductHeaderButton to="/">
            {t("返回首页")}
          </ProductHeaderButton>
          {isLoggedIn && <UserAvatarMenu />}
        </>
      )}
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
