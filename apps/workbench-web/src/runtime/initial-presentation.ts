import type { ApplicationRoute } from "./workbench-navigation";

/** Only a surface owned by the landing route may block its first paint.
 * Authentication and connection providers do not use this presentation policy. */
export function requiresInitialPresentation(
  route: ApplicationRoute,
  viewIds: readonly string[],
  settingsIds: readonly string[] = [],
): boolean {
  return route.kind === "extension-view"
    ? viewIds.includes(route.viewId)
    : route.kind === "settings" && settingsIds.includes(route.slug);
}
