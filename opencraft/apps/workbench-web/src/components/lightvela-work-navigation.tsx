import { Cloud, Sparkles } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";

import type { ExtensionContributionStore } from "@opencraft/extension-runtime";

import { useInternalDeveloperMode } from "../internal-developer-mode";
import { SidebarNavigationItem } from "./sidebar-navigation-item";

const LIGHTVELA_WORK_PAGE_IDS = new Set([
  "lightvela.hermes.skills",
  "lightvela.hermes.storage",
]);

function pageIcon(pageId: string) {
  return pageId.endsWith(".skills")
    ? <Sparkles size={15} />
    : <Cloud size={15} />;
}

export function LightVelaWorkNavigation({
  section,
  extensionContributions,
  onSectionChange,
}: {
  readonly section: string | null;
  readonly extensionContributions: ExtensionContributionStore;
  readonly onSectionChange: (section: string) => void;
}) {
  const internalDeveloperMode = useInternalDeveloperMode();
  const contributionSnapshot = useSyncExternalStore(
    extensionContributions.subscribe,
    extensionContributions.getSnapshot,
    extensionContributions.getSnapshot,
  );
  const platform: "web" | "electron" = (globalThis as typeof globalThis & {
    opencraftDesktop?: { readonly kind?: string };
  }).opencraftDesktop?.kind === "electron" ? "electron" : "web";
  const pages = useMemo(
    () => contributionSnapshot.settingsPages
      .map(({ contribution }) => contribution)
      .filter((page) => LIGHTVELA_WORK_PAGE_IDS.has(page.id))
      .filter((page) => page.platforms?.includes(platform) ?? true)
      .filter((page) => page.audience !== "internal" || internalDeveloperMode)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
    [contributionSnapshot, internalDeveloperMode, platform],
  );

  if (pages.length === 0) return null;

  return (
    <nav className="lightvela-work-navigation" aria-label="LightVela work tools">
      <div className="lightvela-work-navigation__items">
        {pages.map((page) => (
          <SidebarNavigationItem
            key={page.id}
            active={section === page.id}
            icon={pageIcon(page.id)}
            title={page.title}
            onInvoke={() => onSectionChange(page.id)}
          />
        ))}
      </div>
    </nav>
  );
}
