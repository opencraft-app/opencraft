import { Suspense, lazy, type ComponentType, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { SiteHeader } from "@/components/site/site-header";
import { useSession } from "@/contexts/session-context";

function RouteFallback() {
  return null;
}

function SiteRouteFallback() {
  const navigate = useNavigate();
  const { isAuthenticated } = useSession();

  return (
    <div className="min-h-dvh bg-white text-[var(--text-primary)]" aria-busy="true">
      <SiteHeader fixed isLoggedIn={isAuthenticated} onLoginClick={() => navigate("/auth/sign-in")} />
      <main className="pt-[60px]" />
    </div>
  );
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
  { fallback = <RouteFallback /> }: { fallback?: ReactElement } = {},
): ReactElement {
  return (
    <Suspense fallback={fallback}>
      <Component />
    </Suspense>
  );
}

export function lazySiteRoute(Component: ComponentType): ReactElement {
  return lazyRoute(Component, { fallback: <SiteRouteFallback /> });
}
