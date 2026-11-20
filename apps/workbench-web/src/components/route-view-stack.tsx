import { Activity, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ApplicationNavigationSnapshot } from "../runtime/workbench-navigation";
import { currentRoutePresentationKey, routePresentationKey, type RouteFamilies } from "../runtime/route-presentation-key";

interface RetainedPage { readonly key: string; node: ReactNode; scrollTop: number; }
function Page({ entry, active }: { entry: RetainedPage; active: boolean }) {
  const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!active || !element.current) return;
    element.current.scrollTop = entry.scrollTop;
  }, [active, entry]);
  return <section ref={element} className="extension-view-route" onScroll={event => { entry.scrollTop = event.currentTarget.scrollTop; }}>{entry.node}</section>;
}

/** Presentation retention only. Router supplies the path; hidden ancestors stop effects.
 * Never mount an unseen direct-link parent or retain unrelated application roots.
 */
export function RouteViewStack({ navigation, routeFamilies, children }: { navigation: Pick<ApplicationNavigationSnapshot, "navigationPath" | "applicationRoute" | "routeScopeId">; routeFamilies?: RouteFamilies; children: ReactNode }) {
  const retained = useRef(new Map<string, RetainedPage>());
  const path = navigation.navigationPath ?? [];
  const keys = path.filter(page => page.route.kind === "extension-view").map(page => routePresentationKey(page, routeFamilies));
  const current = keys.at(-1) ?? currentRoutePresentationKey(navigation.applicationRoute, navigation.routeScopeId, routeFamilies);
  const wanted = new Set([...keys, current]);
  for (const key of retained.current.keys()) if (!wanted.has(key)) retained.current.delete(key);
  const entry = retained.current.get(current) ?? { key: current, node: children, scrollTop: 0 };
  entry.node = children; retained.current.set(current, entry);
  return <>{[...retained.current.values()].map(page => <Activity key={page.key} mode={page.key === current ? "visible" : "hidden"}><Page entry={page} active={page.key === current} /></Activity>)}</>;
}
