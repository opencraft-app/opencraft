import { canonicalServerConnectionSettingsId, canonicalServerConnectionViewId } from "@opencraft/plugin-builtin-agents/server-connection-identity";
import type { ApplicationRoute } from "./workbench-navigation";

/** The Web composition owns built-in bookmark compatibility, not the Router. */
export function resolveServerConnectionRoute(route: ApplicationRoute): ApplicationRoute {
  if (route.kind === "settings") {
    const slug = canonicalServerConnectionSettingsId(route.slug);
    return slug === route.slug ? route : { ...route, slug };
  }
  if (route.kind === "extension-view") {
    const viewId = canonicalServerConnectionViewId(route.viewId);
    return viewId === route.viewId ? route : { ...route, viewId };
  }
  return route;
}
