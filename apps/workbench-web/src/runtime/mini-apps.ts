import type { ExtensionPlatform, MiniAppContribution } from "@opencraft/extension-contract";
import type { ExtensionContributionSnapshot } from "@opencraft/extension-runtime";

export const OVERHOME_VIEW_ID = "opencraft.overhome.view";

/** The extension registry owns installation and retirement; this is only a projection. */
export function projectMiniApps(snapshot: ExtensionContributionSnapshot, platform: ExtensionPlatform,
  internal: boolean, canRender: (viewType: string) => boolean): readonly MiniAppContribution[] {
  const visible = (value: { readonly platforms?: readonly ExtensionPlatform[]; readonly audience?: "public" | "internal" }) =>
    (value.platforms?.includes(platform) ?? true) && (value.audience !== "internal" || internal);
  const views = new Set(snapshot.views.map(entry => entry.contribution)
    .filter(view => visible(view) && canRender(view.viewType)).map(view => view.id));
  const pages = new Set(snapshot.settingsPages.map(entry => entry.contribution)
    .filter(page => visible(page) && views.has(page.viewId)).map(page => page.id));
  return snapshot.navigation.map(entry => entry.contribution)
    .filter((app): app is MiniAppContribution => app.surface === "applications" && visible(app)
      && (app.target.kind === "view" ? views.has(app.target.viewId)
        : app.target.kind === "settings" && pages.has(app.target.pageId)))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
}
