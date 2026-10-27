import type { SettingsPageContribution } from "@opencraft/extension-contract";

/** Semantic declaration only; the platform shell owns the physical surface. */
export function isWorkbenchToolPage(page: SettingsPageContribution | null | undefined): boolean {
  return page?.management?.entryPoint === "workbench";
}
