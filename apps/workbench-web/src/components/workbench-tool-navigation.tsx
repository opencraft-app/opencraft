import { WorkbenchIcon } from "./ui/workbench-icon";
import { useMemo, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { isWorkbenchToolPage } from "../runtime/workbench-tool-pages";

import type { ExtensionContributionStore } from "@opencraft/extension-runtime";

import { useInternalDeveloperMode } from "../internal-developer-mode";
import { SidebarNavigationItem } from "./sidebar-navigation-item";

export function useWorkbenchToolActions({
  section,
  extensionContributions,
  onSectionChange,
}: {
  readonly section: string | null;
  readonly extensionContributions: ExtensionContributionStore;
  readonly onSectionChange: (section: string) => void;
}) {
  const internalDeveloperMode = useInternalDeveloperMode();
  const intl = useIntl();
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
      .filter(isWorkbenchToolPage)
      .filter((page) => page.platforms?.includes(platform) ?? true)
      .filter((page) => page.audience !== "internal" || internalDeveloperMode)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map(page => ({ ...page, title: page.titleMessage ? intl.formatMessage(page.titleMessage) : page.title,
        shortTitle: page.shortTitleMessage ? intl.formatMessage(page.shortTitleMessage) : undefined })),
    [contributionSnapshot, internalDeveloperMode, platform, intl],
  );

  return pages.map(page => ({ id: page.id, icon: page.icon, title: page.title, shortTitle: page.shortTitle,
    active: section === page.id, onInvoke: () => onSectionChange(page.id) }));
}

export function WorkbenchToolNavigation(props: Parameters<typeof useWorkbenchToolActions>[0]) {
  const actions = useWorkbenchToolActions(props);
  if (actions.length === 0) return null;
  return <nav className="workbench-tool-navigation" aria-label="Work tools">
    <div className="workbench-tool-navigation__items">{actions.map(action => <SidebarNavigationItem
      key={action.id} active={action.active} icon={<WorkbenchIcon name={action.icon} purpose="work" />}
      title={action.title} onInvoke={action.onInvoke} />)}</div>
  </nav>;
}
