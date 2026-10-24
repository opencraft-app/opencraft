import { serverPath, serverUrl, serverStorageKey, browserServerContext } from "./server-context";
import {
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  equalWorkbenchLocation,
  parseWorkbenchLocation,
  serializeWorkbenchLocation,
  type WorkbenchLocation,
  asRouteScopeId,
  type RouteScopeId,
} from "@opencraft/workbench-runtime";
import { createBrowserRouter, createMemoryRouter } from "react-router";

// Read-only input from the former Router. All current entries use v8 below.
const LEGACY_HISTORY_NAMESPACE = "vela.application.route.v7";

export type ApplicationRoute =
  | { readonly kind: "conversation" }
  | { readonly kind: "settings"; readonly slug: string }
  | {
      readonly kind: "extension-view";
      readonly viewId: string;
      /** Opaque, serializable identity owned by the View implementation. */
      readonly resourceUri: string | null;
    };

function equalApplicationRoute(left: ApplicationRoute, right: ApplicationRoute): boolean {
  if (left.kind === "settings" && right.kind === "settings") return left.slug === right.slug;
  if (left.kind === "extension-view" && right.kind === "extension-view") return left.viewId === right.viewId && left.resourceUri === right.resourceUri;
  return left.kind === "conversation" && right.kind === "conversation";
}

const CONVERSATION_ROUTE: ApplicationRoute = { kind: "conversation" };

interface WorkbenchHistoryState {
  readonly namespace: typeof LEGACY_HISTORY_NAMESPACE;
  readonly index: number;
  readonly location: ReturnType<typeof serializeWorkbenchLocation>;
  readonly routeScopeId: string;
  readonly applicationRoute: ApplicationRoute;
  readonly applicationReturnIndex: number | null;
}

export interface ApplicationNavigationSnapshot<TLocation extends WorkbenchLocation | null = WorkbenchLocation> {
  readonly url: string;
  readonly revision: number;
  readonly location: TLocation;
  readonly action: "initial" | "push" | "replace" | "pop";
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly historyIndex: number;
  readonly routeScopeId: RouteScopeId;
  readonly applicationRoute: ApplicationRoute;
}

export interface ApplicationNavigation<TLocation extends WorkbenchLocation | null = WorkbenchLocation> {
  getSnapshot(): ApplicationNavigationSnapshot<TLocation>;
  subscribe(listener: () => void): () => void;
  push(location: TLocation, options?: { readonly routeScopeId?: RouteScopeId }): void;
  openSettings(slug?: string, mode?: "push" | "replace"): void;
  openChat(): void;
  openExtensionView(viewId: string, resourceUri?: string | null): void;
  pushExtensionViewResource(viewId: string, resourceUri: string): void;
  replaceExtensionViewResource(viewId: string, resourceUri: string): void;
  closeSettings(): void;
  closeExtensionView(): void;
  replace(
    location: TLocation,
    options?: {
      readonly preserveView?: boolean;
      readonly routeScopeId?: RouteScopeId;
    },
  ): void;
  restore(snapshot: ApplicationNavigationSnapshot<TLocation>): void;
  back(): void;
  forward(): void;
  go(delta: number): void;
  dispose(): void;
}

function isWorkbenchHistoryState(
  value: unknown,
): value is WorkbenchHistoryState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkbenchHistoryState>;
  return (
    candidate.namespace === LEGACY_HISTORY_NAMESPACE &&
    typeof candidate.index === "number" &&
    Number.isInteger(candidate.index) &&
    candidate.index >= 0 &&
    typeof candidate.routeScopeId === "string" &&
    candidate.routeScopeId.length > 0 &&
    (candidate.applicationReturnIndex === null ||
      (typeof candidate.applicationReturnIndex === "number" &&
        Number.isInteger(candidate.applicationReturnIndex) &&
        candidate.applicationReturnIndex >= 0)) &&
    (candidate.applicationRoute?.kind === "conversation" ||
      (candidate.applicationRoute?.kind === "settings" &&
        typeof candidate.applicationRoute.slug === "string" &&
        candidate.applicationRoute.slug.length > 0) ||
      (candidate.applicationRoute?.kind === "extension-view" &&
        typeof candidate.applicationRoute.viewId === "string" &&
        candidate.applicationRoute.viewId.length > 0 &&
        (candidate.applicationRoute.resourceUri === null ||
          typeof candidate.applicationRoute.resourceUri === "string"))) &&
    parseWorkbenchLocation(candidate.location) !== null
  );
}

export function parseApplicationRouteUrl(url: URL): ApplicationRoute {
  url = new URL(url); url.pathname = serverPath(url.pathname);
  if (url.pathname === "/environments" || url.pathname === "/environments/") {
    const formerSection = url.searchParams.get("section");
    return {
      kind: "settings",
      slug: formerSection !== null && formerSection !== "overview" && formerSection !== "connections"
        ? formerSection
        : "appearance",
    };
  }
  const settingsMatch = /^\/settings\/([^/]+)\/?$/u.exec(url.pathname);
  if (settingsMatch !== null) try {
    const slug = decodeURIComponent(settingsMatch[1]!);
    return slug.length > 0 ? { kind: "settings", slug } : CONVERSATION_ROUTE;
  } catch {
    return CONVERSATION_ROUTE;
  }
  const viewMatch = /^\/views\/([^/]+)\/?$/u.exec(url.pathname);
  if (viewMatch !== null) try {
    const viewId = decodeURIComponent(viewMatch[1]!);
    return viewId.length > 0
      ? {
          kind: "extension-view",
          viewId,
          resourceUri: url.searchParams.get("resource"),
        }
      : CONVERSATION_ROUTE;
  } catch {
    return CONVERSATION_ROUTE;
  }
  return CONVERSATION_ROUTE;
}

export function parseWorkbenchLocationUrl(url: URL): WorkbenchLocation | null {
  url = new URL(url); url.pathname = serverPath(url.pathname);
  const hostId = url.searchParams.get("hostId");
  if (hostId === null || hostId.trim().length === 0) return null;
  const localMatch = /^\/local\/([^/]+)\/?$/u.exec(url.pathname);
  if (localMatch !== null) {
    try {
      return createWorkbenchThreadLocation(
        hostId,
        decodeURIComponent(localMatch[1]!),
      );
    } catch {
      return null;
    }
  }
  const draftId = url.searchParams.get("draftId");
  if (url.pathname === "/" && draftId !== null) {
    try {
      return createWorkbenchDraftLocation(hostId, draftId);
    } catch {
      return null;
    }
  }
  return null;
}

export function workbenchLocationUrl(
  location: WorkbenchLocation,
  applicationRoute: ApplicationRoute = CONVERSATION_ROUTE,
): string {
  if (applicationRoute.kind === "settings")
    return `/settings/${encodeURIComponent(applicationRoute.slug)}`;
  if (applicationRoute.kind === "extension-view") {
    const path = `/views/${encodeURIComponent(applicationRoute.viewId)}`;
    if (applicationRoute.resourceUri === null) return path;
    const parameters = new URLSearchParams({ resource: applicationRoute.resourceUri });
    return `${path}?${parameters}`;
  }
  const parameters = new URLSearchParams();
  if (location.kind === "thread") {
    parameters.set("hostId", location.key.hostId);
    return `/local/${encodeURIComponent(location.key.threadId)}?${parameters}`;
  }
  parameters.set("hostId", location.hostId);
  parameters.set("draftId", location.draftId);
  return `/?${parameters}`;
}

export function createRouteScopeId(): RouteScopeId {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return asRouteScopeId(`web-route:${uuid}`);
}

export interface ApplicationRouterOptions {
  /** The composition may idempotently canonicalize its own historical Settings/View IDs. */
  readonly resolveApplicationRoute?: (route: ApplicationRoute) => ApplicationRoute;
  /** Deployment compatibility applied to URLs and remembered POP locations. */
  readonly resolveLocation?: (location: WorkbenchLocation | null) => WorkbenchLocation | null;
  readonly mode?: "memory" | "browser";
  readonly initialEntries?: string[];
  readonly initialIndex?: number;
  /** Resource owners validate references; Router owns any necessary REPLACE. */
  readonly resolveRestoredEntry?: (entry: RestoredWorkbenchEntry) => RestoredWorkbenchEntry;
}

export interface RestoredWorkbenchEntry {
  readonly location: WorkbenchLocation;
  readonly routeScopeId: RouteScopeId;
}

/** Read a bootstrap candidate without creating a second Router or route writer. */
export function readWorkbenchBootstrapLocation(
  url: URL,
  historyState: unknown,
  mode?: ApplicationRouterOptions["mode"],
): WorkbenchLocation | null {
  // Embedded memory navigation does not own the containing page's history.
  if (mode === "memory") return null;
  const direct = parseWorkbenchLocationUrl(url);
  if (direct !== null) return direct;
  if (typeof historyState !== "object" || historyState === null) return null;
  const state = historyState as { usr?: { namespace?: unknown; location?: unknown } };
  if (state.usr?.namespace === "opencraft.application-route.v8") {
    return parseWorkbenchLocation(state.usr.location);
  }
  return isWorkbenchHistoryState(historyState) ? parseWorkbenchLocation(historyState.location) : null;
}

/** One application route authority. The platform only chooses the Router history adapter. */
export function createApplicationNavigation<TLocation extends WorkbenchLocation | null>(
  initialLocation: TLocation,
  options: ApplicationRouterOptions = {},
): ApplicationNavigation<TLocation> {
  const browserWindow = typeof window === "undefined" ? undefined : window;
  const mode = options.mode ?? ((globalThis as any).opencraftDesktop?.kind === "electron"
    || !browserWindow?.document ? "memory" : "browser");
  const initialUrl = browserWindow?.location.href ?? "http://opencraft.invalid/";
  const explicitEntry = options.initialEntries?.[options.initialIndex ?? options.initialEntries.length - 1];
  const url = new URL(explicitEntry ?? initialUrl, initialUrl);
  const legacy = explicitEntry === undefined && isWorkbenchHistoryState(browserWindow?.history.state)
    ? browserWindow.history.state : null;
  const resolveLocation = options.resolveLocation ?? ((location: WorkbenchLocation | null) => location);
  const parseUrlLocation = (target: URL) => resolveLocation(parseWorkbenchLocationUrl(target));
  const firstLocation = initialLocation === null ? null : (parseUrlLocation(url)
    ?? resolveLocation(legacy ? parseWorkbenchLocation(legacy.location) : null) ?? initialLocation);
  const firstRoute = parseApplicationRouteUrl(url);
  const bootUrl = serverPath(url.pathname).replace(/\/$/, "") === "/environments" && firstRoute.kind === "settings"
    ? new URL(serverUrl("/settings/" + encodeURIComponent(firstRoute.slug)), initialUrl) : url;
  const firstScope = legacy ? asRouteScopeId(legacy.routeScopeId) : createRouteScopeId();
  const entry = (location: TLocation, routeScopeId: RouteScopeId) => ({
    namespace: "opencraft.application-route.v8",
    location: location === null ? null : serializeWorkbenchLocation(location),
    routeScopeId,
  });
  const routes = [{ id: "application", path: "*" }];
  const memoryEntries = options.initialEntries?.map(path => {
    const target = new URL(path, initialUrl);
    return { pathname: target.pathname, search: target.search, hash: target.hash,
      key: createRouteScopeId(), state: entry((initialLocation === null ? null
        : parseUrlLocation(target) ?? firstLocation) as TLocation, createRouteScopeId()) };
  });
  const router = mode === "memory"
    ? createMemoryRouter(routes, { initialEntries: memoryEntries ?? [{
        pathname: bootUrl.pathname, search: bootUrl.search, hash: bootUrl.hash,
        state: entry(firstLocation as TLocation, firstScope),
      }], initialIndex: options.initialIndex })
    : createBrowserRouter(routes, { window: browserWindow, basename: browserServerContext()?.basePath ?? "/" });
  const listeners = new Set<() => void>();
  const scopes = new Map<string, RouteScopeId>();
  let disposed = false;
  let revision = 0;
  let keys = mode === "memory" && memoryEntries ? memoryEntries.map(entry => entry.key) : [router.state.location.key];
  let index = Math.max(0, keys.indexOf(router.state.location.key));
  const receiptKey = serverStorageKey("opencraft.application-history-keys.v8");
  // This is only a known-history projection for the buttons. Router still owns
  // the actual entries/location. Desktop memory history is window-lifetime only.
  if (mode === "browser") try {
    const saved = JSON.parse(browserWindow!.sessionStorage.getItem(receiptKey) ?? "null");
    if (Array.isArray(saved) && saved.every((key: unknown) => typeof key === "string")
      && saved.includes(router.state.location.key)) {
      keys = saved; index = keys.indexOf(router.state.location.key);
    }
  } catch { /* unavailable session storage does not prevent navigation */ }
  let lastRouterLocation = router.state.location;
  const read = (action: ApplicationNavigationSnapshot["action"]): ApplicationNavigationSnapshot<TLocation> => {
    const current = router.state.location;
    const routeUrl = new URL(current.pathname + current.search + current.hash, initialUrl);
    const state = current.state;
    const remembered = state?.namespace === "opencraft.application-route.v8"
      ? resolveLocation(parseWorkbenchLocation(state.location)) : null;
    let scope = state?.namespace === "opencraft.application-route.v8" && typeof state.routeScopeId === "string"
      ? asRouteScopeId(state.routeScopeId) : scopes.get(current.key);
    if (!scope) { scope = createRouteScopeId(); scopes.set(current.key, scope); }
    return {
      url: current.pathname + current.search + current.hash,
      revision, action, historyIndex: index,
      location: (initialLocation === null ? null : parseUrlLocation(routeUrl) ?? remembered ?? firstLocation) as TLocation,
      applicationRoute: parseApplicationRouteUrl(routeUrl),
      routeScopeId: scope,
      canGoBack: index > 0, canGoForward: index < keys.length - 1,
    };
  };
  let snapshot = read("initial");
  const resolveEntry = (target: ApplicationNavigationSnapshot<TLocation>) => {
    const applicationRoute = options.resolveApplicationRoute?.(target.applicationRoute) ?? target.applicationRoute;
    const routed = equalApplicationRoute(applicationRoute, target.applicationRoute) ? target : { ...target, applicationRoute };
    if (target.location === null || !options.resolveRestoredEntry) return routed;
    const resolved = options.resolveRestoredEntry({ location: target.location, routeScopeId: target.routeScopeId });
    if (equalWorkbenchLocation(target.location, resolved.location) && target.routeScopeId === resolved.routeScopeId) return routed;
    return { ...routed, location: resolved.location as TLocation, routeScopeId: resolved.routeScopeId };
  };
  const unsubscribe = router.subscribe(state => {
    if (disposed || state.location === lastRouterLocation) return;
    lastRouterLocation = state.location;
    if (state.historyAction === "PUSH") {
      keys = [...keys.slice(0, index + 1), state.location.key]; index++;
    } else if (state.historyAction === "REPLACE") {
      keys = keys.slice(); keys[index] = state.location.key;
    } else {
      const found = keys.indexOf(state.location.key);
      if (found >= 0) index = found;
      else { keys = [state.location.key]; index = 0; }
    }
    if (mode === "browser") try {
      browserWindow!.sessionStorage.setItem(receiptKey, JSON.stringify(keys));
    } catch { /* optional button-history receipt */ }
    revision++;
    const next = read(state.historyAction.toLowerCase() as ApplicationNavigationSnapshot["action"]);
    const resolved = resolveEntry(next);
    if (resolved !== next) {
      // Canonicalize owned bookmarks and their Chat return reference through
      // Router REPLACE, retaining the entry's scope and history position.
      restore(resolved);
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  });
  const pathFor = (location: TLocation, route: ApplicationRoute) =>
    location === null && route.kind === "conversation" ? "/"
      : route.kind === "settings" ? "/settings/" + encodeURIComponent(route.slug)
      : route.kind === "extension-view" ? "/views/" + encodeURIComponent(route.viewId)
        + (route.resourceUri === null ? "" : "?" + new URLSearchParams({ resource: route.resourceUri }))
      : workbenchLocationUrl(location!);
  const navigate = (location: TLocation, route: ApplicationRoute, replace: boolean, scope: RouteScopeId) => {
    if (disposed) throw new Error("Workbench navigation is disposed");
    // No loaders/actions are attached to the application router: route commits
    // are synchronous. Conversation hydration is a separate cancellable consumer.
    void router.navigate(pathFor(location, options.resolveApplicationRoute?.(route) ?? route), { replace, state: entry(location, scope) });
  };
  const sameLocation = (left: TLocation, right: TLocation) =>
    left === null || right === null ? left === right : equalWorkbenchLocation(left, right);
  const openChat = () => {
    if (snapshot.applicationRoute.kind === "conversation") return;
    navigate(snapshot.location, CONVERSATION_ROUTE, false, snapshot.routeScopeId);
  };
  const restore = (target: ApplicationNavigationSnapshot<TLocation>) =>
    navigate(target.location, target.applicationRoute, true, target.routeScopeId);
  const resolvedInitial = resolveEntry(snapshot);
  if (resolvedInitial !== snapshot || (mode === "browser" && (bootUrl.href !== url.href
    || (parseWorkbenchLocationUrl(url) !== null && firstLocation !== null
      && !equalWorkbenchLocation(parseWorkbenchLocationUrl(url)!, firstLocation))
    || router.state.location.state?.namespace !== "opencraft.application-route.v8"))) restore(resolvedInitial);
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push(location, options = {}) {
      if (snapshot.applicationRoute.kind === "conversation" && sameLocation(snapshot.location, location)
        && (!options.routeScopeId || options.routeScopeId === snapshot.routeScopeId)) return;
      navigate(location, CONVERSATION_ROUTE, false, options.routeScopeId ?? createRouteScopeId());
    },
    replace(location, options = {}) {
      const scope = options.routeScopeId ?? (options.preserveView || sameLocation(snapshot.location, location)
        ? snapshot.routeScopeId : createRouteScopeId());
      navigate(location, CONVERSATION_ROUTE, true, scope);
    },
    openChat,
    openSettings(slug = "appearance", mode = "push") {
      const input: ApplicationRoute = { kind: "settings", slug };
      const route = options.resolveApplicationRoute?.(input) ?? input;
      if (equalApplicationRoute(snapshot.applicationRoute, route)) return;
      navigate(snapshot.location, route, mode === "replace", snapshot.routeScopeId);
    },
    closeSettings: openChat,
    openExtensionView(viewId, resourceUri = null) {
      if (!viewId.trim()) throw new RangeError("Extension View ID must not be empty");
      const input: ApplicationRoute = { kind: "extension-view", viewId: viewId.trim(), resourceUri: resourceUri?.trim() || null };
      const route = options.resolveApplicationRoute?.(input) ?? input;
      if (pathFor(snapshot.location, route) === pathFor(snapshot.location, snapshot.applicationRoute)) return;
      navigate(snapshot.location, route, false, snapshot.routeScopeId);
    },
    pushExtensionViewResource(viewId, resourceUri) {
      if (snapshot.applicationRoute.kind !== "extension-view" || snapshot.applicationRoute.viewId !== viewId)
        throw new Error("Only the active Extension View can push one of its resources");
      if (!resourceUri.trim()) throw new RangeError("Extension View resource URI must not be empty");
      if (snapshot.applicationRoute.resourceUri === resourceUri.trim()) return;
      navigate(snapshot.location, { kind: "extension-view", viewId, resourceUri: resourceUri.trim() }, false, snapshot.routeScopeId);
    },
    replaceExtensionViewResource(viewId, resourceUri) {
      if (snapshot.applicationRoute.kind !== "extension-view" || snapshot.applicationRoute.viewId !== viewId) return;
      if (!resourceUri.trim()) throw new RangeError("Extension View resource URI must not be empty");
      if (snapshot.applicationRoute.resourceUri === resourceUri.trim()) return;
      navigate(snapshot.location, { kind: "extension-view", viewId, resourceUri: resourceUri.trim() }, true, snapshot.routeScopeId);
    },
    closeExtensionView: openChat,
    restore,
    back() { if (!disposed && snapshot.canGoBack) void router.navigate(-1); },
    forward() { if (!disposed && snapshot.canGoForward) void router.navigate(1); },
    go(delta) { if (!disposed && Number.isInteger(delta) && delta !== 0) void router.navigate(delta); },
    dispose() { disposed = true; unsubscribe(); router.dispose(); listeners.clear(); },
  };
}
