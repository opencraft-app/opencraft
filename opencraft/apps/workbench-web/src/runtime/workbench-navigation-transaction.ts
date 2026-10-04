import type {
  ConversationActivationCoordinator,
  ConversationScopeRegistry,
  PreparedConversationActivation,
  WorkbenchActivatableRuntime,
  WorkbenchLocation,
} from "@opencraft/workbench-runtime";
import {
  draftSubmissionOwnsNavigation,
  equalWorkbenchLocation,
  type WorkbenchDraftLocation,
} from "@opencraft/workbench-runtime";
import type { SubmissionReceipt } from "@opencraft/composer-core";

import {
  createApplicationNavigation,
  createRouteScopeId,
  type ApplicationRouterOptions,
  type ApplicationNavigation,
  type ApplicationNavigationSnapshot,
} from "./workbench-navigation";

export type WorkbenchHistoryMode = "push" | "replace";

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
  dispose(): void;
}

/** Route intent fences asynchronous resource activation; Router owns every route commit. */
export function createWorkbenchNavigationTransaction<TRuntime extends WorkbenchActivatableRuntime>(
  initialLocation: WorkbenchLocation,
  activation: ConversationActivationCoordinator<TRuntime>,
  scopes: ConversationScopeRegistry,
  routerOptions: ApplicationRouterOptions = {},
): WorkbenchNavigationTransaction<TRuntime> {
  const navigation = createApplicationNavigation(initialLocation, routerOptions);
  const listeners = new Set<() => void>();
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
  const publish = () => {
    snapshot = navigation.getSnapshot();
    for (const listener of listeners) listener();
  };
  const remember = () => { committed = navigation.getSnapshot(); publish(); };
  const commitRoute = (action: () => void) => {
    committingRoute = true;
    try { action(); } finally { committingRoute = false; }
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
    commitRoute(() => navigation[mode](location, { routeScopeId: viewId }));
    return true;
  };
  const navigate = (location: WorkbenchLocation, mode: WorkbenchHistoryMode = "push", scope?: typeof activeScope) => {
    if (disposed) return rejectClosed();
    if (blocked()) return Promise.resolve(false);
    const origin = navigation.getSnapshot();
    const viewId = scope ?? (origin.applicationRoute.kind === "conversation"
      && equalWorkbenchLocation(origin.location, location) ? origin.routeScopeId : createRouteScopeId());
    const epoch = beginIntent();
    const operation = { location, viewId, promise: prepareNavigation(location, mode, viewId, epoch, origin) };
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
      const epoch = beginIntent();
      commitRoute(() => navigation.push(location, { routeScopeId: scope }));
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
    const current = navigation.getSnapshot();
    const retainedScope = equalWorkbenchLocation(current.location, location) ? current.routeScopeId
      : equalWorkbenchLocation(activeLocation, location) ? activeScope : undefined;
    // Coalesce a destination only when it also matches the requested View.
    if (pendingNavigation && equalWorkbenchLocation(pendingNavigation.location, location)
      && (retainedScope === undefined || pendingNavigation.viewId === retainedScope)) {
      return pendingNavigation.promise;
    }
    if (retainedScope !== undefined) {
      if (current.applicationRoute.kind === "conversation" && pendingNavigation === null
        && equalWorkbenchLocation(current.location, location)
        && equalWorkbenchLocation(activeLocation, location) && retainedScope === activeScope) {
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
      commitRoute(() => navigation[mode](location, { routeScopeId: scope }));
      resumeReadiness(navigation.getSnapshot(), epoch);
      return true;
    },
    openSettings(slug = "appearance", mode = "push") { routeAction(() => navigation.openSettings(slug, mode)); },
    closeSettings: leaveSurface,
    openExtensionView(viewId, resourceUri = null) { routeAction(() => navigation.openExtensionView(viewId, resourceUri)); },
    pushExtensionViewResource(viewId, resourceUri) { routeAction(() => navigation.pushExtensionViewResource(viewId, resourceUri)); },
    replaceExtensionViewResource(viewId, resourceUri) { routeAction(() => navigation.replaceExtensionViewResource(viewId, resourceUri)); },
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
      activeLocation = prepared.location;
      commitRoute(() => navigation.replace(prepared.location, { preserveView: true, routeScopeId: scope }));
      return prepared.location;
    },
    back() { ensureOpen(); if (!blocked()) { beginIntent(); navigation.back(); } },
    forward() { ensureOpen(); if (!blocked()) { beginIntent(); navigation.forward(); } },
    dispose() { disposed = true; beginIntent(); stopNavigation(); navigation.dispose(); listeners.clear(); },
  };
}
