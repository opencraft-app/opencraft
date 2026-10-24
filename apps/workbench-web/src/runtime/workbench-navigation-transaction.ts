import { beginObservedOperation } from "./observability";
import { FULL_WORKBENCH_PRESENTATION, type WorkbenchPresentationPolicy } from "../workbench-presentation-policy";
import type {
  ConversationActivationCoordinator,
  ConversationScopeRegistry,
  PreparedConversationActivation,
  RouteScopeId,
  WorkbenchActivatableRuntime,
  WorkbenchLocation,
} from "@opencraft/workbench-runtime";
import {
  draftSubmissionOwnsNavigation,
  encodeWorkbenchLocation,
  equalWorkbenchLocation,
  type WorkbenchDraftLocation,
} from "@opencraft/workbench-runtime";
import type { SubmissionReceipt } from "@opencraft/composer-core";

import {
  createApplicationNavigation,
  createRouteScopeId,
  type ApplicationRouterOptions,
  type ApplicationNavigationSnapshot,
} from "./workbench-navigation";

export type WorkbenchHistoryMode = "push" | "replace";

export interface WorkbenchNavigationTransactionOptions extends ApplicationRouterOptions {
  readonly presentation?: WorkbenchPresentationPolicy;
  /** Resolve promotion aliases within the current Application/account. */
  readonly resolveCanonicalLocation?: (location: WorkbenchLocation) => WorkbenchLocation;
  /** A cached View or its independently retained draft owner may restore this slot. */
  readonly isRetainedView?: (location: WorkbenchLocation, viewId: RouteScopeId) => boolean;
  readonly maxPreferredViews?: number;
}

export interface WorkbenchNavigationTransaction<
  TRuntime extends WorkbenchActivatableRuntime,
> {
  getSnapshot(): ApplicationNavigationSnapshot;
  subscribe(listener: () => void): () => void;
  navigate(
    location: WorkbenchLocation,
    mode?: WorkbenchHistoryMode,
  ): Promise<boolean>;
  /** Select an existing conversation, reusing its retained View when possible. */
  selectConversation(location: WorkbenchLocation): Promise<boolean>;
  navigateToHome(
    location: WorkbenchDraftLocation,
    mode?: WorkbenchHistoryMode,
  ): boolean;
  openSettings(slug?: string, mode?: WorkbenchHistoryMode): void;
  openChat(): Promise<boolean>;
  closeSettings(): void;
  openExtensionView(viewId: string, resourceUri?: string | null): void;
  pushExtensionViewResource(viewId: string, resourceUri: string): void;
  replaceExtensionViewResource(viewId: string, resourceUri: string): void;
  closeExtensionView(): void;
  promoteDraft(
    draftId: string,
    receipt: SubmissionReceipt,
  ): Promise<WorkbenchLocation>;
  back(): void;
  forward(): void;
  /** Revoke all preferred-conversation references to an evicted owner slot. */
  forgetView(viewId: string): void;
  /** Account changes revoke both remembered Views and pending navigation. */
  clearPreferredViews(): void;
  dispose(): void;
}

/** Route intent fences asynchronous resource activation; Router owns every route commit. */
export function createWorkbenchNavigationTransaction<TRuntime extends WorkbenchActivatableRuntime>(
  initialLocation: WorkbenchLocation,
  activation: ConversationActivationCoordinator<TRuntime>,
  scopes: ConversationScopeRegistry,
  routerOptions: WorkbenchNavigationTransactionOptions = {},
): WorkbenchNavigationTransaction<TRuntime> {
  const presentation = routerOptions.presentation ?? FULL_WORKBENCH_PRESENTATION;
  const maxPreferredViews = routerOptions.maxPreferredViews ?? 75;
  if (!Number.isInteger(maxPreferredViews) || maxPreferredViews < 1) {
    throw new RangeError("Preferred View capacity must be a positive integer");
  }
  const navigation = createApplicationNavigation(initialLocation, routerOptions);
  const listeners = new Set<() => void>();
  const preferredViews = new Map<string, { location: WorkbenchLocation; viewId: RouteScopeId }>();
  let snapshot = navigation.getSnapshot();
  let committed = snapshot;
  let activeLocation = initialLocation;
  let activeScope = snapshot.routeScopeId;
  let intent = 0;
  let disposed = false;
  let restoring = false;
  let committingRoute = false;
  let pendingNavigation: {
    location: WorkbenchLocation;
    viewId: typeof activeScope;
    promise: Promise<boolean>;
  } | null = null;
  activation.setViewId(activeScope);
  const canonicalLocation = (location: WorkbenchLocation): WorkbenchLocation =>
    routerOptions.resolveCanonicalLocation?.(location)
      ?? preferredViews.get(encodeWorkbenchLocation(location))?.location
      ?? location;
  const forgetView = (viewId: string) => {
    for (const [key, entry] of preferredViews) {
      if (entry.viewId === viewId) preferredViews.delete(key);
    }
  };
  const rememberPresentedView = (location: WorkbenchLocation, viewId: RouteScopeId,
    previousLocation?: WorkbenchLocation) => {
    if (routerOptions.isRetainedView !== undefined) {
      for (const [key, previous] of preferredViews) {
        if (!routerOptions.isRetainedView(canonicalLocation(previous.location), previous.viewId)) {
          preferredViews.delete(key);
        }
      }
    }
    const canonical = canonicalLocation(location);
    const entry = { location: canonical, viewId };
    // A promoted Draft alias follows later successful presentations of its Thread.
    for (const [key, previous] of preferredViews) {
      if (equalWorkbenchLocation(previous.location, canonical)) preferredViews.set(key, entry);
    }
    const rememberKey = (key: string) => {
      preferredViews.delete(key);
      preferredViews.set(key, entry);
    };
    rememberKey(encodeWorkbenchLocation(canonical));
    if (!equalWorkbenchLocation(location, canonical)) rememberKey(encodeWorkbenchLocation(location));
    if (previousLocation !== undefined) {
      const previousKey = encodeWorkbenchLocation(previousLocation);
      if (routerOptions.resolveCanonicalLocation !== undefined
        && equalWorkbenchLocation(canonicalLocation(previousLocation), canonical)) {
        // The binding owner resolves this alias; it need not occupy another
        // preferred slot after a successful promotion.
        if (previousKey !== encodeWorkbenchLocation(canonical)) preferredViews.delete(previousKey);
      } else rememberKey(previousKey);
    }
    while (preferredViews.size > maxPreferredViews) {
      preferredViews.delete(preferredViews.keys().next().value!);
    }
  };
  const isRetainedView = (location: WorkbenchLocation, viewId: RouteScopeId) =>
    routerOptions.isRetainedView?.(location, viewId) ?? true;
  const preferredView = (location: WorkbenchLocation): RouteScopeId | undefined => {
    const canonical = canonicalLocation(location);
    const preferred = preferredViews.get(encodeWorkbenchLocation(canonical))
      ?? preferredViews.get(encodeWorkbenchLocation(location));
    if (preferred === undefined) return undefined;
    if (!isRetainedView(canonical, preferred.viewId)) {
      forgetView(preferred.viewId);
      return undefined;
    }
    return preferred.viewId;
  };
  rememberPresentedView(initialLocation, activeScope);
  const publish = () => {
    snapshot = navigation.getSnapshot();
    for (const listener of listeners) listener();
  };
  const remember = () => { committed = navigation.getSnapshot(); publish(); };
  const commitRoute = (action: () => void, presented?: () => void) => {
    committingRoute = true;
    try { action(); } finally { committingRoute = false; }
    presented?.();
    remember();
  };
  const blocked = () => {
    const draft = scopes.getActiveDraft();
    return draft !== null && draftSubmissionOwnsNavigation(draft.phase);
  };
  const ensureOpen = () => {
    if (disposed) throw new Error("Workbench navigation transaction is disposed");
  };
  const rejectClosed = () => Promise.reject<boolean>(new Error("Workbench navigation transaction is disposed"));
  const beginIntent = () => {
    pendingNavigation = null;
    const epoch = ++intent;
    activation.cancelPending();
    return epoch;
  };
  const ownsIntent = (epoch: number, entry: ApplicationNavigationSnapshot) =>
    !disposed && intent === epoch && navigation.getSnapshot().revision === entry.revision;
  const accept = (prepared: PreparedConversationActivation | null, viewId: typeof activeScope) => {
    try {
      if (prepared?.commit(viewId)) return true;
    } catch (error) {
      prepared?.cancel();
      throw error;
    }
    prepared?.cancel();
    return false;
  };
  const resumeReadiness = (target: ApplicationNavigationSnapshot, epoch: number) => {
    if (!ownsIntent(epoch, target)) return;
    // Restoring a retained View is local presentation, not a network gate.
    void activation.prepare(target.location).then(prepared => {
      if (!ownsIntent(epoch, target)) { prepared?.cancel(); return; }
      accept(prepared, target.routeScopeId);
    }).catch(() => undefined);
  };
  const rollbackPop = (attempt: ApplicationNavigationSnapshot) => {
    if (disposed || navigation.getSnapshot().revision !== attempt.revision) return;
    const delta = committed.historyIndex - attempt.historyIndex;
    if (delta !== 0) { restoring = true; navigation.go(delta); }
    else { commitRoute(() => navigation.restore(committed)); }
  };
  const stopNavigation = navigation.subscribe(() => {
    if (committingRoute) return;
    const next = navigation.getSnapshot();
    // Unsolicited commits include POP and the Router's REPLACE of an invalid
    // entry. Both must restore the effective resource/View, not only the URL.
    const epoch = beginIntent();
    if (restoring) { restoring = false; remember(); return; }
    if (blocked()) { rollbackPop(next); return; }
    if (next.applicationRoute.kind !== "conversation") {
      remember(); return;
    }
    if (equalWorkbenchLocation(next.location, activeLocation) && next.routeScopeId === activeScope) {
      rememberPresentedView(next.location, next.routeScopeId);
      remember(); resumeReadiness(next, epoch); return;
    }
    void activation.prepare(next.location).then(prepared => {
      if (!ownsIntent(epoch, next)) {
        prepared?.cancel(); return;
      }
      if (!accept(prepared, next.routeScopeId)) {
        rollbackPop(next); return;
      }
      activeLocation = next.location; activeScope = next.routeScopeId;
      rememberPresentedView(next.location, next.routeScopeId);
      remember();
    }).catch(() => { if (ownsIntent(epoch, next)) rollbackPop(next); });
  });
  const prepareNavigation = async (location: WorkbenchLocation, mode: WorkbenchHistoryMode,
    viewId: typeof activeScope, epoch: number, origin: ApplicationNavigationSnapshot) => {
    let prepared;
    try { prepared = await activation.prepare(location); }
    catch (error) { if (!ownsIntent(epoch, origin)) return false; throw error; }
    if (!ownsIntent(epoch, origin)) { prepared?.cancel(); return false; }
    // A rejected preparation must not write a route and then attempt a lossy rollback.
    if (!accept(prepared, viewId)) return false;
    activeLocation = location; activeScope = viewId;
    commitRoute(() => navigation[mode](location, { routeScopeId: viewId }),
      () => rememberPresentedView(location, viewId));
    return true;
  };
  const navigate = (location: WorkbenchLocation, mode: WorkbenchHistoryMode = "push", scope?: typeof activeScope) => {
    if (disposed) return rejectClosed();
    if (blocked()) return Promise.resolve(false);
    const origin = navigation.getSnapshot();
    const viewId = scope ?? createRouteScopeId();
    const epoch = beginIntent();
    const isWarm = scope !== undefined || preferredView(location) !== undefined || isRetainedView(canonicalLocation(location), viewId);
    const finish = beginObservedOperation("thread_open", { cache: isWarm ? "warm" : "cold" });
    const promise = prepareNavigation(location, mode, viewId, epoch, origin).then(result => {finish(result?"ok":"aborted");return result;},error=>{finish("failed");throw error;});
    const operation = { location, viewId, promise };
    pendingNavigation = operation;
    const clear = () => { if (pendingNavigation === operation) pendingNavigation = null; };
    void operation.promise.then(clear, clear);
    return operation.promise;
  };
  const returnToView = (location: WorkbenchLocation, scope: typeof activeScope) => {
    if (pendingNavigation?.viewId === scope && equalWorkbenchLocation(pendingNavigation.location, location)) {
      return pendingNavigation.promise;
    }
    if (equalWorkbenchLocation(location, activeLocation) && scope === activeScope) {
      const fastFinish = beginObservedOperation("thread_open", { cache: "warm" });
      fastFinish("ok");
      const epoch = beginIntent();
      commitRoute(() => navigation.push(location, { routeScopeId: scope }),
        () => rememberPresentedView(location, scope));
      // Settings may have canceled bootstrap readiness, while the local View
      // itself remained presentable. Resume readiness without delaying Chat.
      resumeReadiness(navigation.getSnapshot(), epoch);
      return Promise.resolve(true);
    }
    return navigate(location, "push", scope);
  };
  const openChat = () => {
    if (disposed) return rejectClosed();
    if (blocked()) return Promise.resolve(false);
    const target = navigation.getSnapshot();
    return returnToView(target.location, target.routeScopeId);
  };
  const selectConversation = (location: WorkbenchLocation) => {
    if (disposed) return rejectClosed();
    if (blocked()) return Promise.resolve(false);
    location = canonicalLocation(location);
    const current = navigation.getSnapshot();
    const retainedScope = equalWorkbenchLocation(current.location, location) && isRetainedView(location, current.routeScopeId)
      ? current.routeScopeId
      : equalWorkbenchLocation(activeLocation, location) && isRetainedView(location, activeScope)
        ? activeScope : preferredView(location);
    // Coalesce a destination only when it also matches the requested View.
    if (pendingNavigation && equalWorkbenchLocation(pendingNavigation.location, location)
      && (retainedScope === undefined || pendingNavigation.viewId === retainedScope)) {
      return pendingNavigation.promise;
    }
    if (retainedScope !== undefined) {
      if (current.applicationRoute.kind === "conversation" && pendingNavigation === null
        && equalWorkbenchLocation(current.location, location)
        && equalWorkbenchLocation(activeLocation, location) && retainedScope === activeScope) {
        const fastFinish = beginObservedOperation("thread_open", { cache: "warm" });
        fastFinish("ok");
        return Promise.resolve(true);
      }
      return returnToView(location, retainedScope);
    }
    return navigate(location);
  };
  const leaveSurface = () => {
    // Resource failures remain owned by the activation coordinator. Never create
    // an unhandled rejection from a fire-and-forget Shell close action.
    void openChat().catch(() => undefined);
  };
  const routeAction = (action: () => void) => {
    ensureOpen();
    if (blocked()) return;
    beginIntent(); commitRoute(action);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    navigate,
    selectConversation,
    openChat,
    navigateToHome(location, mode = "push") {
      ensureOpen();
      if (blocked()) return false;
      const epoch = beginIntent(), scope = createRouteScopeId();
      activation.presentLocalDraft(location, scope);
      activeLocation = location; activeScope = scope;
      commitRoute(() => navigation[mode](location, { routeScopeId: scope }),
        () => rememberPresentedView(location, scope));
      resumeReadiness(navigation.getSnapshot(), epoch);
      return true;
    },
    openSettings(slug = "appearance", mode = "push") { if (!presentation.machineManagement) return; routeAction(() => navigation.openSettings(slug, mode)); },
    closeSettings: leaveSurface,
    openExtensionView(viewId, resourceUri = null) { if (!presentation.shellNavigation) return; routeAction(() => navigation.openExtensionView(viewId, resourceUri)); },
    pushExtensionViewResource(viewId, resourceUri) { if (!presentation.shellNavigation) return; routeAction(() => navigation.pushExtensionViewResource(viewId, resourceUri)); },
    replaceExtensionViewResource(viewId, resourceUri) { if (!presentation.shellNavigation) return; routeAction(() => navigation.replaceExtensionViewResource(viewId, resourceUri)); },
    closeExtensionView: leaveSurface,
    async promoteDraft(draftId, receipt) {
      ensureOpen();
      if (activeLocation.kind !== "draft" || activeLocation.draftId !== draftId) {
        throw new Error("Draft promotion no longer owns the active conversation");
      }
      const origin = navigation.getSnapshot(), scope = activeScope, epoch = beginIntent();
      const prepared = await activation.preparePromotion(draftId, receipt);
      if (!ownsIntent(epoch, origin)) {
        prepared?.cancel(); throw new Error("Draft promotion navigation was superseded");
      }
      if (!prepared || !accept(prepared, scope)) throw new Error("Draft promotion activation failed");
      const previousLocation = activeLocation;
      activeLocation = prepared.location;
      commitRoute(() => navigation.replace(prepared.location, { preserveView: true, routeScopeId: scope }),
        () => rememberPresentedView(prepared.location, scope, previousLocation));
      return prepared.location;
    },
    back() { ensureOpen(); if (!blocked()) { beginIntent(); navigation.back(); } },
    forward() { ensureOpen(); if (!blocked()) { beginIntent(); navigation.forward(); } },
    forgetView,
    clearPreferredViews() {
      beginIntent(); preferredViews.clear();
      const attempt = navigation.getSnapshot();
      if (!restoring && attempt.revision !== committed.revision) rollbackPop(attempt);
    },
    dispose() { disposed = true; beginIntent(); preferredViews.clear(); stopNavigation(); navigation.dispose(); listeners.clear(); },
  };
}
