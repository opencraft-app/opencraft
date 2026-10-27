import type { ExtensionPlatform } from "@opencraft/extension-contract";
import type { ExtensionContributionStore } from "@opencraft/extension-runtime";
import type { PlatformViewRendererRegistry } from "@opencraft/extension-react";
import { isInternalAudienceVisible } from "../internal-developer-mode";

/** Resolve a declared capability, never a product's private page identifier. */
export function createConnectorManagementAction(
  contributions: ExtensionContributionStore,
  renderers: PlatformViewRendererRegistry,
  platform: ExtensionPlatform,
  internalDeveloperMode: boolean,
  openSettings: (pageId: string) => void,
): (() => void) | undefined {
  const eligible = (value: { readonly platforms?: readonly ExtensionPlatform[]; readonly audience?: "public" | "internal" }) =>
    (value.platforms?.includes(platform) ?? true)
    && isInternalAudienceVisible(value.audience, internalDeveloperMode);
  const resolve = () => {
    const snapshot = contributions.getSnapshot();
    const views = snapshot.views.filter(({ contribution }) =>
      contribution.role === "connector-management" && eligible(contribution)
      && renderers.resolve(contribution.viewType) !== null);
    if (views.length !== 1) return undefined;
    const view = views[0]!;
    const pages = snapshot.settingsPages.filter(({ contribution, owner }) =>
      contribution.viewId === view.contribution.id && eligible(contribution)
      && owner.activationId === view.owner.activationId);
    // More than one eligible entry is ambiguous, not an implicit ordering policy.
    return pages.length === 1 ? { view, page: pages[0]! } : undefined;
  };
  const target = resolve();
  if (target === undefined) return undefined;
  return () => {
    // A menu may outlive its render. Retirement/reactivation must not grant an
    // old action authority to navigate to a new owner's page.
    const current = resolve();
    if (current?.view === target.view && current.page === target.page) {
      openSettings(current.page.contribution.id);
    }
  };
}
