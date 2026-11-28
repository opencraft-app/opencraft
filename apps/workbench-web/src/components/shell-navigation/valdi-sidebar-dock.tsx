import { lazy, Suspense, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useValdiTouchDensity } from "../../runtime/valdi-touch-density";
import { useIntl } from "@opencraft/i18n/react";
import { useAppearanceTheme } from "../../appearance-theme";
import { requestMobileHaptic } from "../../runtime/mobile-valdi-bridge";
import { shellNavigationLabels } from "./navigation-labels";
import type { ShellNavigationConfig } from "./navigation-content";
import "../valdi-surfaces.scss";

export { useValdiTouchDensity };

function mapActionIcon(name: string | undefined): import("@opencraft/design-system-web/valdi").IconName {
  switch (name) {
    case "home":
      return "home";
    case "applications":
    case "grid":
      return "grid";
    case "search":
      return "search";
    case "bot":
      return "bot";
    case "tasks":
      return "list";
    case "sparkles":
      return "sparkle";
    case "terminal":
      return "terminal";
    case "desktop":
    case "monitor":
    case "laptop":
      return "laptop";
    case "server":
      return "server";
    case "settings":
      return "gear";
    case "updates":
    case "refresh":
      return "refresh";
    case "user":
    case "user-round":
      return "user";
    default:
      return "grid";
  }
}

const LazyValdiDockMount = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function DockMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").SidebarDockProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.SidebarDockSurface}
        viewModel={viewModel}
        className="valdi-sidebar-dock-surface"
        data-testid="valdi-sidebar-dock-surface"
      />
    );
  }
  return { default: DockMount };
});

const LazyValdiOrbMount = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function OrbMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").SidebarOrbProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.SidebarOrbSurface}
        viewModel={viewModel}
        className="valdi-sidebar-orb-surface"
        data-testid="valdi-sidebar-orb-surface"
      />
    );
  }
  return { default: OrbMount };
});

export function ValdiSidebarTabDock({
  config,
  onInvoke,
  fallback,
}: {
  readonly config: ShellNavigationConfig;
  readonly onInvoke: (action: () => void) => void;
  readonly fallback: ReactNode;
}) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();

  useEffect(() => {
    const preload = () => {
      void import("@opencraft/design-system-web/valdi").catch(() => {});
    };
    const w =
      typeof window !== "undefined"
        ? (window as Window & {
            requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
            cancelIdleCallback?: (id: number) => void;
          })
        : undefined;
    if (w?.requestIdleCallback) {
      const id = w.requestIdleCallback(preload, { timeout: 1200 });
      return () => w.cancelIdleCallback?.(id);
    }
    const timer = setTimeout(preload, 800);
    return () => clearTimeout(timer);
  }, []);

  const items = useMemo(
    () =>
      config.actions.map((action) => ({
        id: action.id,
        title: shellNavigationLabels(action, intl).full,
        icon: mapActionIcon(action.icon),
        badge: action.badge,
      })),
    [config.actions, intl],
  );

  const activeId = useMemo(() => config.actions.find((action) => action.active)?.id ?? null, [config.actions]);

  const handleSelect = useCallback(
    (id: string) => {
      const target = config.actions.find((action) => action.id === id);
      if (target) onInvoke(target.onInvoke);
    },
    [config.actions, onInvoke],
  );

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").SidebarDockProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      label: intl.formatMessage({ id: "navigation.applications", defaultMessage: "Applications" }),
      items,
      activeId,
      onSelect: handleSelect,
      onHaptic: (style: string) => {
        requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
      },
    }),
    [activeId, appearance.resolvedTheme, handleSelect, intl, items, touch],
  );

  return (
    <Suspense fallback={fallback}>
      <LazyValdiDockMount viewModel={viewModel} />
    </Suspense>
  );
}

export function ValdiSidebarOrb({
  icon,
  active = false,
  chromeless = false,
  badgeDot = false,
  fallback,
}: {
  readonly icon: string;
  readonly active?: boolean;
  readonly chromeless?: boolean;
  readonly badgeDot?: boolean;
  readonly fallback: ReactNode;
}) {
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").SidebarOrbProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      chromeless,
      icon: mapActionIcon(icon),
      active,
      badgeDot,
    }),
    [active, appearance.resolvedTheme, badgeDot, chromeless, icon, touch],
  );

  return (
    <span
      className={chromeless ? "valdi-sidebar-orb-host valdi-sidebar-orb-host--chromeless" : "valdi-sidebar-orb-host"}
      aria-hidden="true"
    >
      <Suspense fallback={fallback}>
        <LazyValdiOrbMount viewModel={viewModel} />
      </Suspense>
    </span>
  );
}
