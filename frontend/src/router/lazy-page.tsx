import { Suspense, lazy, type ComponentType, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { ProductPageShell } from "@/components/site/product-chrome";
import { SiteHeader } from "@/components/site/site-header";

type RouteChrome = "none" | "product" | "site";

function RouteFallback() {
  return null;
}

function SiteRouteFallback() {
  const navigate = useNavigate();

  return (
    <div className="min-h-dvh bg-white text-[var(--text-primary)]" aria-busy="true">
      <SiteHeader fixed onLoginClick={() => navigate("/auth/sign-in")} />
      <main className="pt-[60px]" />
    </div>
  );
}

function ProductRouteFallback() {
  return (
    <ProductPageShell>
      <main className="relative z-10 flex flex-grow items-center justify-center pt-[60px]" />
    </ProductPageShell>
  );
}

function fallbackForChrome(chrome: RouteChrome): ReactElement {
  switch (chrome) {
    case "product":
      return <ProductRouteFallback />;
    case "site":
      return <SiteRouteFallback />;
    case "none":
      return <RouteFallback />;
    default:
      return <RouteFallback />;
  }
}

export function lazyNamed<T extends string>(
  loader: () => Promise<Record<T, ComponentType>>,
  exportName: T,
) {
  return lazy(async () => {
    const module = await loader();
    return { default: module[exportName] };
  });
}

export function lazyRoute(
  Component: ComponentType,
  { chrome = "none", fallback }: { chrome?: RouteChrome; fallback?: ReactElement } = {},
): ReactElement {
  return (
    <Suspense fallback={fallback ?? fallbackForChrome(chrome)}>
      <Component />
    </Suspense>
  );
}
