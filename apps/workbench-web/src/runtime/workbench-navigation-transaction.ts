import { createThreadHistoryFirstPaintObserver, type HistoryPaintAttempt } from "./thread-history-first-paint";
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

export type NavigationTransition = {
  readonly id: number;
  readonly location: WorkbenchLocation;
  /** A peer-list return restores content without selecting/dismissing the drawer. */
  readonly sidebar?: 'preserve';
} & (
  | { readonly phase: 'preparing' | 'failed' | 'cancelled'; readonly viewId?: RouteScopeId }
  | { readonly phase: 'committed' | 'presented'; readonly viewId: RouteScopeId }
);
export interface NavigationPresentation {
  getTransition(): NavigationTransition | null;
  subscribeTransition(listener: () => void): () => void;
  attachDeparture(driver: (id: number, prepared: Promise<void>) => Promise<void>): () => void;
}

export type WorkbenchHistoryMode = "push" | "replace";

export interface ChatReturnOptions {
  /** Preserve the current Shell allocation while returning to the remembered View. */
  readonly sidebar?: 'preserve';
}

export interface WorkbenchNavigationTransactionOptions extends ApplicationRouterOptions {
  readonly presentation?: WorkbenchPresentationPolicy;
  /** Resolve promotion aliases within the current Application/account. */
  readonly resolveCanonicalLocation?: (location: WorkbenchLocation) => WorkbenchLocation;
  /** A cached View or its independently retained draft owner may restore this slot. */
  readonly isRetainedView?: (location: WorkbenchLocation, viewId: RouteScopeId) => boolean;
  readonly maxPreferredViews?: number;
  readonly restoreViewId?: (location: WorkbenchLocation) => Promise<RouteScopeId | undefined>;
}

export interface WorkbenchNavigationTransaction<
  TRuntime extends WorkbenchActivatableRuntime,
> extends NavigationPresentation {
  acknowledgePresented(id: number, viewId: string): void;
  readonly historyFirstPaint: ReturnType<typeof createThreadHistoryFirstPaintObserver>;
  registerNavigationGuard(shouldBlock: () => boolean, onBlocked: (attempt: { proceed(): void; cancel(): void }) => void): () => void;
  getSnapshot(): ApplicationNavigationSnapshot;
  subscribe(listener: () => void): () => void;
  /** Accepted navigation intent, including local View restoration before activation. */
  getPendingLocation(): WorkbenchLocation | null;
  subscribePendingLocation(listener: () => void): () => void;
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
  openChat(options?: ChatReturnOptions): Promise<boolean>;
  closeSettings(): void;
  openExtensionView(viewId: string, resourceUri?: string | null): void;
  pushExtensionViewResource(viewId: string, resourceUri: string): void;
  replaceExtensionViewResource(viewId: string, resourceUri: string): void;
  closeExtensionView(): void;
  promoteDraft(
    draftId: string,
    receipt: SubmissionReceipt,
  ): Promise<WorkbenchLocation>;
  returnToParent(): boolean;
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
  const historyFirstPaint = createThreadHistoryFirstPaintObserver();
  const navigation = createApplicationNavigation(initialLocation, routerOptions);
  const listeners = new Set<() => void>();
  const transitionListeners = new Set<() => void>();
  let transition: NavigationTransition | null = null;
  let departureDriver: ((id: number, prepared: Promise<void>) => Promise<void>) | undefined;
  let departure: { id: number; promise: Promise<void>; ready(): void; release(): void } | undefined;
  const publishTransition = (next: NavigationTransition) => {
    transition = next;
    for (const listener of transitionListeners) listener();
  };
  const pendingListeners = new Set<() => void>();
  let pendingLocation: WorkbenchLocation | null = null;
  const publishPending = (location: WorkbenchLocation | null) => {
    if (pendingLocation === location) return;
    pendingLocation = location;
    for (const listener of pendingListeners) listener();
  };
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
    const epoch = intent;
    committingRoute = true;
    try { action(); } finally { committingRoute = false; }
    presented?.();
    remember();
    if (intent === epoch) {
      if (transition?.id === epoch && transition.phase === 'preparing')
        publishTransition({ ...transition, phase: 'committed', viewId: activeScope });
      if (intent === epoch) publishPending(null);
    }
  };
  const blocked = () => {
    const draft = scopes.getActiveDraft();
    return draft !== null && draftSubmissionOwnsNavigation(draft.phase);
  };
  const ensureOpen = () => {
    if (disposed) throw new Error("Workbench navigation transaction is disposed");
  };
  const rejectClosed = () => Promise.reject<boolean>(new Error("Workbench navigation transaction is disposed"));
  const beginIntent = (preservePaint?: HistoryPaintAttempt, location: WorkbenchLocation | null = null, options?: ChatReturnOptions) => {
    if (!preservePaint || historyFirstPaint.getSnapshot()?.finish !== preservePaint.finish) historyFirstPaint.abort();
    pendingNavigation = null;
    const epoch = ++intent;
    departure?.release(); departure = undefined;
    activation.cancelPending();
    if (intent === epoch) {
      if (location) publishTransition({ id: epoch, location, phase: 'preparing', ...(options?.sidebar ? { sidebar: options.sidebar } : {}) });
      else if (transition) publishTransition({ ...transition, phase: 'cancelled' });
      if (intent === epoch) publishPending(location);
      if (intent === epoch && location && departureDriver) {
        let release!: () => void;
        const promise = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const prepared = new Promise<void>(resolve => { ready = resolve; });
        departure = { id: epoch, promise, ready, release: () => { ready(); release(); } };
        try { void departureDriver(epoch, prepared).then(release, release); } catch { release(); }
      }
    }
    return epoch;
  };
  const finishIntent = (epoch: number) => {
    if (intent !== epoch) return;
    if (transition?.id === epoch && transition.phase === 'preparing')
      publishTransition({ ...transition, phase: 'failed' });
    if (intent === epoch) publishPending(null);
  };
  const awaitDeparture = (epoch: number) => {
    if (departure?.id !== epoch) return undefined;
    // Preparation and visual feedback start together. Only a prepared target
    // authorizes the driver to finish hiding the still-current content.
    departure.ready();
    return departure.promise;
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
    if (next.contextOnly) { committed = { ...committed, navigationPath: next.navigationPath, canReturn: next.canReturn }; publish(); return; }
    // Unsolicited commits include POP and the Router's REPLACE of an invalid
    // entry. Both must restore the effective resource/View, not only the URL.
    if (restoring) { restoring = false; remember(); return; }
    const epoch = beginIntent(undefined, next.applicationRoute.kind === "conversation" ? next.location : null);
    if (blocked()) {
      if (transition?.id === epoch) publishTransition({ ...transition, phase: 'cancelled' });
      if (intent === epoch) publishPending(null);
      rollbackPop(next); return;
    }
    if (next.applicationRoute.kind !== "conversation") {
      remember(); return;
    }
    const sameView = equalWorkbenchLocation(next.location, activeLocation) && next.routeScopeId === activeScope;
    if (next.location.kind === 'thread') historyFirstPaint.begin(next.routeScopeId, 'warm', next.location.key);
    const finishPop = () => {
      if (!ownsIntent(epoch, next)) return;
      activeLocation = next.location; activeScope = next.routeScopeId;
      rememberPresentedView(next.location, next.routeScopeId);
      remember();
      if (transition?.id === epoch) publishTransition({ ...transition, phase: 'committed', viewId: activeScope });
      if (intent === epoch) publishPending(null);
    };
    if (sameView || routerOptions.isRetainedView?.(next.location, next.routeScopeId)) {
      const present = () => {
        if (!ownsIntent(epoch, next)) return;
        try {
          if (!sameView) activation.mountRestored(next.location, next.routeScopeId);
          finishPop(); resumeReadiness(next, epoch);
        } catch {
          if (ownsIntent(epoch, next)) { finishIntent(epoch); rollbackPop(next); }
        }
      };
      const wait = awaitDeparture(epoch);
      if (wait) void wait.then(present).catch(() => { if (ownsIntent(epoch, next)) { finishIntent(epoch); rollbackPop(next); } });
      else present();
      return;
    }
    void activation.prepare(next.location).then(async prepared => {
      await awaitDeparture(epoch);
      if (!ownsIntent(epoch, next)) {
        prepared?.cancel(); return;
      }
      if (!accept(prepared, next.routeScopeId)) {
        finishIntent(epoch); rollbackPop(next); return;
      }
      finishPop();
    }).catch(() => { if (ownsIntent(epoch, next)) { finishIntent(epoch); rollbackPop(next); } });
  });
  const prepareNavigation = async (location: WorkbenchLocation, mode: WorkbenchHistoryMode,
    viewId: typeof activeScope, epoch: number, origin: ApplicationNavigationSnapshot) => {
    let prepared;
    try { prepared = await activation.prepare(location); }
    catch (error) { if (!ownsIntent(epoch, origin)) return false; throw error; }
    if (!ownsIntent(epoch, origin)) { prepared?.cancel(); return false; }
    await awaitDeparture(epoch);
    if (!ownsIntent(epoch, origin)) { prepared?.cancel(); return false; }
    // A rejected preparation must not write a route and then attempt a lossy rollback.
    if (!accept(prepared, viewId)) return false;
    activeLocation = location; activeScope = viewId;
    commitRoute(() => navigation[mode](location, { routeScopeId: viewId }),
      () => rememberPresentedView(location, viewId));
    return true;
  };
  const navigate = (location: WorkbenchLocation, mode: WorkbenchHistoryMode = "push", scope?: typeof activeScope, existingPaint?: HistoryPaintAttempt, options?: ChatReturnOptions) => {
    if (disposed) return rejectClosed();
    if (blocked()) return Promise.resolve(false);
    const origin = navigation.getSnapshot();
    const viewId = scope ?? createRouteScopeId();
    const epoch = beginIntent(existingPaint, location, options);
    if (!ownsIntent(epoch, origin)) return Promise.resolve(false);
    const isWarm = scope !== undefined || preferredView(location) !== undefined || isRetainedView(canonicalLocation(location), viewId);
    const finish = beginObservedOperation("thread_open", { cache: isWarm ? "warm" : "cold" });
    const paint = existingPaint
      ? historyFirstPaint.bindView(existingPaint, viewId, isWarm ? "warm" : "cold")
      : location.kind === "thread" ? historyFirstPaint.begin(viewId, isWarm ? "warm" : "cold", location.key) : null;
    const promise = prepareNavigation(location, mode, viewId, epoch, origin).then(result => {
      finish(result ? "ok" : "aborted");
      if (!result && paint) historyFirstPaint.settle(paint, ownsIntent(epoch, origin) ? "failed" : "aborted");
      return result;
    }, error => {
      finish("failed");
      if (paint) historyFirstPaint.settle(paint, "failed");
      throw error;
    });
    const operation = { location, viewId, promise };
    if (intent === epoch) pendingNavigation = operation;
    const clear = () => { if (pendingNavigation === operation) pendingNavigation = null; finishIntent(epoch); };
    void operation.promise.then(clear, clear);
    return operation.promise;
  };
  const returnToView = (location: WorkbenchLocation, scope: typeof activeScope, options?: ChatReturnOptions) => {
    if (pendingNavigation?.viewId === scope && equalWorkbenchLocation(pendingNavigation.location, location)
      && transition?.sidebar === options?.sidebar) {
      return pendingNavigation.promise;
    }
    const alreadyPresented = equalWorkbenchLocation(location, activeLocation) && scope === activeScope;
    // Only the retention owner can prove a different View is locally presentable.
    // A preferred-history entry by itself is not that proof.
    if (alreadyPresented || routerOptions.isRetainedView?.(location, scope)) {
      const fastFinish = beginObservedOperation("thread_open", { cache: "warm" });
      fastFinish("ok");
      const epoch = beginIntent(undefined, location, options);
      if (intent !== epoch) return Promise.resolve(false);
      if (location.kind === "thread") historyFirstPaint.begin(scope, "warm", location.key);
      const present = () => {
        if (intent !== epoch || disposed) return false;
        if (!alreadyPresented) {
          try { activation.mountRestored(location, scope); }
          catch (error) { finishIntent(epoch); historyFirstPaint.abort(); return Promise.reject(error); }
          activeLocation = location; activeScope = scope;
        }
        commitRoute(() => navigation.push(location, { routeScopeId: scope }),
          () => rememberPresentedView(location, scope));
        // Settings may have canceled bootstrap readiness, while the local View
        // itself remained presentable. Resume readiness without delaying Chat.
        resumeReadiness(navigation.getSnapshot(), epoch);
        return true;
      };
      const waiting = awaitDeparture(epoch);
      if (!waiting) return Promise.resolve(present());
      const promise = waiting.then(present);
      const operation = { location, viewId: scope, promise };
      if (intent === epoch) pendingNavigation = operation;
      const clear = () => { if (pendingNavigation === operation) pendingNavigation = null; finishIntent(epoch); };
      void promise.then(clear, clear);
      return promise;
    }
    return navigate(location, "push", scope, undefined, options);
  };
  const openChat = (options?: ChatReturnOptions) => {
    if (disposed) return rejectClosed();
    if (blocked()) return Promise.resolve(false);
    const target = navigation.getSnapshot();
    return returnToView(target.location, target.routeScopeId, options);
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
    if (pendingNavigation && transition?.sidebar !== 'preserve' && equalWorkbenchLocation(pendingNavigation.location, location)
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
    if (routerOptions.restoreViewId) {
      const epoch = beginIntent(undefined, location), origin = navigation.getSnapshot();
      if (!ownsIntent(epoch, origin)) return Promise.resolve(false);
      const pendingViewId = createRouteScopeId();
      const paint = location.kind === "thread" ? historyFirstPaint.begin(pendingViewId, "cold", location.key) : undefined;
      const promise = Promise.resolve().then(() => routerOptions.restoreViewId!(location)).catch(error => {
        // Fence the local lookup. Cold preparation keeps the same accepted intent.
        if (!ownsIntent(epoch, origin)) return undefined;
        throw error;
      }).then(async viewId => {
        if (!ownsIntent(epoch, origin)) return false;
        if (viewId === undefined) return prepareNavigation(location, 'push', pendingViewId, epoch, origin);
        await awaitDeparture(epoch);
        if (!ownsIntent(epoch, origin)) return false;
        if (viewId !== undefined) {
          if (paint) historyFirstPaint.bindView(paint, viewId, "warm");
          activation.mountRestored(location, viewId);
          activeLocation = location; activeScope = viewId;
          commitRoute(() => navigation.push(location, { routeScopeId: viewId }),
            () => rememberPresentedView(location, viewId));
          resumeReadiness(navigation.getSnapshot(), epoch);
          return true;
        }
        return false;
      }).catch(error => {
        if (paint) historyFirstPaint.settle(paint, "failed");
        throw error;
      });
      const operation = {location, viewId: pendingViewId, promise};
      if (intent === epoch) pendingNavigation = operation;
      const clear = () => { if (pendingNavigation === operation) pendingNavigation = null; finishIntent(epoch); };
      void promise.then(clear, clear);
      return promise;
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
    registerNavigationGuard: navigation.registerNavigationGuard,
    historyFirstPaint,
    getTransition: () => transition,
    subscribeTransition(listener) { transitionListeners.add(listener); return () => { transitionListeners.delete(listener); }; },
    attachDeparture(driver) {
      departureDriver = driver;
      return () => { if (departureDriver === driver) { departureDriver = undefined; departure?.release(); } };
    },
    acknowledgePresented(id, viewId) {
      if (transition?.id === id && transition.phase === 'committed' && transition.viewId === viewId)
        publishTransition({ ...transition, phase: 'presented' });
    },
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getPendingLocation: () => pendingLocation,
    subscribePendingLocation(listener) { pendingListeners.add(listener); return () => { pendingListeners.delete(listener); }; },
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
    returnToParent() { ensureOpen(); if (blocked()) return false; beginIntent(); return navigation.returnToParent(); },
    back() { ensureOpen(); if (!blocked()) { beginIntent(); navigation.back(); } },
    forward() { ensureOpen(); if (!blocked()) { beginIntent(); navigation.forward(); } },
    forgetView,
    clearPreferredViews() {
      beginIntent(); preferredViews.clear();
      const attempt = navigation.getSnapshot();
      if (!restoring && attempt.revision !== committed.revision) rollbackPop(attempt);
    },
    dispose() { disposed = true; beginIntent(); preferredViews.clear(); stopNavigation(); navigation.dispose(); listeners.clear(); pendingListeners.clear(); transitionListeners.clear(); },
  };
}
