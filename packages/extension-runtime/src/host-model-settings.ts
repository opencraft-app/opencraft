import type { ExtensionPlatform, SettingsPageContribution } from "@opencraft/extension-contract";

/** Select only an explicitly declared, visible configuration destination for this Host. */
export function resolveHostModelSettingsPage(
  pages: readonly SettingsPageContribution[],
  hostId: string,
  platform: ExtensionPlatform,
  internalDeveloperMode = false,
): SettingsPageContribution | undefined {
  return pages.filter(page => page.modelConfiguration === true && page.targetHostId === hostId
    && (page.platforms?.includes(platform) ?? true)
    && (page.audience !== "internal" || internalDeveloperMode))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))[0];
}
