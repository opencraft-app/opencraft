import type { ApplicationNavigationPage, ApplicationRoute, ApplicationNavigationSnapshot } from "./workbench-navigation";

export type RouteFamilies = ReadonlyMap<string, string>;
export function routePresentationKey(page: Pick<ApplicationNavigationPage, "id" | "routeScopeId" | "route">, families?: RouteFamilies): string {
  const family = page.route.kind === "extension-view" ? families?.get(page.route.viewId) : undefined;
  return family === undefined ? JSON.stringify([page.id, page.routeScopeId]) : JSON.stringify(["family", family, page.routeScopeId]);
}
export function currentRoutePresentationKey(route: ApplicationRoute, scope: string, families?: RouteFamilies): string {
  const family = route.kind === "extension-view" ? families?.get(route.viewId) : undefined;
  return family === undefined ? JSON.stringify([route, scope]) : JSON.stringify(["family", family, scope]);
}

/** Motion uses semantic route entries, never globally deduplicated owner keys.
 * Only consecutive updates of the same explicit family can skip page movement. */
export function projectRouteStack(navigation: Pick<ApplicationNavigationSnapshot, "navigationPath" | "applicationRoute" | "routeScopeId">, scope: string, families?: RouteFamilies) {
  const path = (navigation.navigationPath ?? []).map(page => JSON.stringify([page.id, page.routeScopeId]));
  const current = path.at(-1) ?? JSON.stringify([navigation.applicationRoute, navigation.routeScopeId]);
  const route = navigation.applicationRoute;
  const owner = route.kind === "extension-view" && families?.has(route.viewId)
    ? currentRoutePresentationKey(route, navigation.routeScopeId, families) : undefined;
  return { current, path: path.length ? path : [current], scope, owner };
}
