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

const HISTORY_NAMESPACE = "vela.application.route.v6";

export type ApplicationRoute =
  | { readonly kind: "conversation" }
  | { readonly kind: "settings"; readonly slug: string }
  | {
      readonly kind: "extension-view";
      readonly viewId: string;
      /** Opaque, serializable identity owned by the View implementation. */
      readonly resourceUri: string | null;
    };

const CONVERSATION_ROUTE: ApplicationRoute = { kind: "conversation" };

interface WorkbenchHistoryState {
  readonly namespace: typeof HISTORY_NAMESPACE;
  readonly index: number;
  readonly location: ReturnType<typeof serializeWorkbenchLocation>;
  readonly routeScopeId: string;
  readonly applicationRoute: ApplicationRoute;
  readonly applicationReturnIndex: number | null;
}

export interface BrowserWorkbenchNavigationSnapshot {
  readonly revision: number;
  readonly location: WorkbenchLocation;
  readonly action: "initial" | "push" | "replace" | "pop";
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly historyIndex: number;
  readonly routeScopeId: RouteScopeId;
  readonly applicationRoute: ApplicationRoute;
}

export interface BrowserWorkbenchNavigation {
  getSnapshot(): BrowserWorkbenchNavigationSnapshot;
  subscribe(listener: () => void): () => void;
  push(location: WorkbenchLocation): void;
  openSettings(slug?: string): void;
  openExtensionView(viewId: string, resourceUri?: string | null): void;
  replaceExtensionViewResource(viewId: string, resourceUri: string): void;
  closeSettings(): void;
  closeExtensionView(): void;
  replace(
    location: WorkbenchLocation,
    options?: {
      readonly preserveView?: boolean;
      readonly routeScopeId?: RouteScopeId;
    },
  ): void;
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
    candidate.namespace === HISTORY_NAMESPACE &&
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

function createRouteScopeId(): RouteScopeId {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return asRouteScopeId(`web-route:${uuid}`);
}

function stateFor(
  location: WorkbenchLocation,
  index: number,
  routeScopeId: RouteScopeId,
  applicationRoute: ApplicationRoute,
  applicationReturnIndex: number | null,
): WorkbenchHistoryState {
  return {
    namespace: HISTORY_NAMESPACE,
    index,
    location: serializeWorkbenchLocation(location),
    routeScopeId,
    applicationRoute,
    applicationReturnIndex,
  };
}

export function createBrowserWorkbenchNavigation(
  initialLocation: WorkbenchLocation,
): BrowserWorkbenchNavigation {
  const listeners = new Set<() => void>();
  const existingState = isWorkbenchHistoryState(window.history.state)
    ? window.history.state
    : null;
  const urlLocation = parseWorkbenchLocationUrl(new URL(window.location.href));
  const urlApplicationRoute = parseApplicationRouteUrl(
    new URL(window.location.href),
  );
  let currentIndex = existingState?.index ?? 0;
  let maximumIndex = currentIndex;
  let location =
    existingState === null
      ? (urlLocation ?? initialLocation)
      : (parseWorkbenchLocation(existingState.location) ??
        urlLocation ??
        initialLocation);
  let applicationRoute =
    urlApplicationRoute.kind !== "conversation"
      ? urlApplicationRoute
      : (existingState?.applicationRoute ?? CONVERSATION_ROUTE);
  let applicationReturnIndex = existingState?.applicationReturnIndex ?? null;
  let revision = 0;
  let action: BrowserWorkbenchNavigationSnapshot["action"] = "initial";
  let routeScopeId =
    existingState === null
      ? createRouteScopeId()
      : asRouteScopeId(existingState.routeScopeId);
  let disposed = false;
  let snapshot: BrowserWorkbenchNavigationSnapshot;

  const createSnapshot = (): BrowserWorkbenchNavigationSnapshot => ({
    revision,
    location,
    action,
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex < maximumIndex,
    historyIndex: currentIndex,
    routeScopeId,
    applicationRoute,
  });
  snapshot = createSnapshot();

  const publish = () => {
    revision += 1;
    snapshot = createSnapshot();
    for (const listener of listeners) listener();
  };

  if (existingState === null) {
    window.history.replaceState(
      stateFor(
        location,
        currentIndex,
        routeScopeId,
        applicationRoute,
        applicationReturnIndex,
      ),
      "",
      workbenchLocationUrl(location, applicationRoute),
    );
  }

  const handlePopState = (event: PopStateEvent) => {
    if (disposed) return;
    const state = isWorkbenchHistoryState(event.state) ? event.state : null;
    const nextLocation =
      state === null
        ? parseWorkbenchLocationUrl(new URL(window.location.href))
        : parseWorkbenchLocation(state.location);
    const nextApplicationRoute =
      state?.applicationRoute ??
      parseApplicationRouteUrl(new URL(window.location.href));
    if (nextLocation === null && nextApplicationRoute.kind === "conversation")
      return;
    currentIndex = state?.index ?? 0;
    routeScopeId =
      state === null
        ? createRouteScopeId()
        : asRouteScopeId(state.routeScopeId);
    maximumIndex = Math.max(maximumIndex, currentIndex);
    if (nextLocation !== null) location = nextLocation;
    applicationRoute = nextApplicationRoute;
    applicationReturnIndex = state?.applicationReturnIndex ?? null;
    action = "pop";
    publish();
  };
  window.addEventListener("popstate", handlePopState);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) throw new Error("Workbench navigation is disposed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(nextLocation) {
      if (disposed) throw new Error("Workbench navigation is disposed");
      if (
        applicationRoute.kind === "conversation" &&
        equalWorkbenchLocation(location, nextLocation)
      )
        return;
      currentIndex += 1;
      maximumIndex = currentIndex;
      location = nextLocation;
      applicationRoute = CONVERSATION_ROUTE;
      applicationReturnIndex = null;
      routeScopeId = createRouteScopeId();
      action = "push";
      window.history.pushState(
        stateFor(
          location,
          currentIndex,
          routeScopeId,
          applicationRoute,
          applicationReturnIndex,
        ),
        "",
        workbenchLocationUrl(location, applicationRoute),
      );
      publish();
    },
    openSettings(slug = "connections") {
      if (disposed) throw new Error("Workbench navigation is disposed");
      if (
        applicationRoute.kind === "settings" &&
        applicationRoute.slug === slug
      )
        return;
      if (applicationRoute.kind === "settings") {
        applicationRoute = { kind: "settings", slug };
        action = "replace";
        window.history.replaceState(
          stateFor(
            location,
            currentIndex,
            routeScopeId,
            applicationRoute,
            applicationReturnIndex,
          ),
          "",
          workbenchLocationUrl(location, applicationRoute),
        );
        publish();
        return;
      }
      const enteringApplicationRoute = applicationRoute.kind === "conversation";
      if (enteringApplicationRoute) {
        applicationReturnIndex = currentIndex;
        currentIndex += 1;
        maximumIndex = currentIndex;
      }
      applicationRoute = { kind: "settings", slug };
      action = enteringApplicationRoute ? "push" : "replace";
      const state = stateFor(location, currentIndex, routeScopeId, applicationRoute, applicationReturnIndex);
      if (enteringApplicationRoute) {
        window.history.pushState(state, "", workbenchLocationUrl(location, applicationRoute));
      } else {
        window.history.replaceState(state, "", workbenchLocationUrl(location, applicationRoute));
      }
      publish();
    },
    closeSettings() {
      if (disposed) throw new Error("Workbench navigation is disposed");
      if (applicationRoute.kind !== "settings") return;
      if (
        applicationReturnIndex !== null &&
        applicationReturnIndex < currentIndex
      ) {
        window.history.go(applicationReturnIndex - currentIndex);
        return;
      }
      applicationRoute = CONVERSATION_ROUTE;
      applicationReturnIndex = null;
      action = "replace";
      window.history.replaceState(
        stateFor(
          location,
          currentIndex,
          routeScopeId,
          applicationRoute,
          applicationReturnIndex,
        ),
        "",
        workbenchLocationUrl(location, applicationRoute),
      );
      publish();
    },
    openExtensionView(viewId, resourceUri = null) {
      if (disposed) throw new Error("Workbench navigation is disposed");
      const normalizedViewId = viewId.trim();
      if (normalizedViewId.length === 0) throw new RangeError("Extension View ID must not be empty");
      const normalizedResourceUri = resourceUri?.trim() || null;
      if (
        applicationRoute.kind === "extension-view" &&
        applicationRoute.viewId === normalizedViewId &&
        applicationRoute.resourceUri === normalizedResourceUri
      ) return;
      if (applicationRoute.kind === "conversation") {
        applicationReturnIndex = currentIndex;
        currentIndex += 1;
        maximumIndex = currentIndex;
        action = "push";
      } else {
        action = "replace";
      }
      applicationRoute = {
        kind: "extension-view",
        viewId: normalizedViewId,
        resourceUri: normalizedResourceUri,
      };
      const state = stateFor(
        location,
        currentIndex,
        routeScopeId,
        applicationRoute,
        applicationReturnIndex,
      );
      if (action === "push") {
        window.history.pushState(state, "", workbenchLocationUrl(location, applicationRoute));
      } else {
        window.history.replaceState(state, "", workbenchLocationUrl(location, applicationRoute));
      }
      publish();
    },
    replaceExtensionViewResource(viewId, resourceUri) {
      if (disposed) throw new Error("Workbench navigation is disposed");
      const normalizedViewId = viewId.trim();
      const normalizedResourceUri = resourceUri.trim();
      if (normalizedViewId.length === 0)
        throw new RangeError("Extension View ID must not be empty");
      if (normalizedResourceUri.length === 0)
        throw new RangeError("Extension View resource URI must not be empty");
      if (
        applicationRoute.kind !== "extension-view" ||
        applicationRoute.viewId !== normalizedViewId
      ) return;
      if (applicationRoute.resourceUri === normalizedResourceUri) return;
      applicationRoute = {
        kind: "extension-view",
        viewId: normalizedViewId,
        resourceUri: normalizedResourceUri,
      };
      action = "replace";
      window.history.replaceState(
        stateFor(location, currentIndex, routeScopeId, applicationRoute, applicationReturnIndex),
        "",
        workbenchLocationUrl(location, applicationRoute),
      );
      publish();
    },
    closeExtensionView() {
      if (disposed) throw new Error("Workbench navigation is disposed");
      if (applicationRoute.kind !== "extension-view") return;
      if (
        applicationReturnIndex !== null &&
        applicationReturnIndex < currentIndex
      ) {
        window.history.go(applicationReturnIndex - currentIndex);
        return;
      }
      applicationRoute = CONVERSATION_ROUTE;
      applicationReturnIndex = null;
      action = "replace";
      window.history.replaceState(
        stateFor(location, currentIndex, routeScopeId, applicationRoute, applicationReturnIndex),
        "",
        workbenchLocationUrl(location, applicationRoute),
      );
      publish();
    },
    replace(nextLocation, options = {}) {
      if (disposed) throw new Error("Workbench navigation is disposed");
      const changed = !equalWorkbenchLocation(location, nextLocation);
      location = nextLocation;
      applicationRoute = CONVERSATION_ROUTE;
      applicationReturnIndex = null;
      routeScopeId =
        options.routeScopeId ??
        (options.preserveView || !changed
          ? routeScopeId
          : createRouteScopeId());
      action = "replace";
      window.history.replaceState(
        stateFor(
          location,
          currentIndex,
          routeScopeId,
          applicationRoute,
          applicationReturnIndex,
        ),
        "",
        workbenchLocationUrl(location, applicationRoute),
      );
      if (changed) publish();
    },
    back() {
      if (!disposed && currentIndex > 0) window.history.back();
    },
    forward() {
      if (!disposed && currentIndex < maximumIndex) window.history.forward();
    },
    go(delta) {
      if (!disposed && Number.isInteger(delta) && delta !== 0)
        window.history.go(delta);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("popstate", handlePopState);
      listeners.clear();
    },
  };
}
