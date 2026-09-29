import type {
  ConversationActivationCoordinator,
  ConversationScopeRegistry,
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
  activation.setViewId(activeScope);
  const publish = () => {
    snapshot = navigation.getSnapshot();
    for (const listener of listeners) listener();
  };
  const remember = () => { committed = navigation.getSnapshot(); publish(); };
  const blocked = () => {
    const draft = scopes.getActiveDraft();
    return draft !== null && draftSubmissionOwnsNavigation(draft.phase);
  };
  const rollbackPop = (attempt: ApplicationNavigationSnapshot) => {
    if (disposed || navigation.getSnapshot().revision !== attempt.revision) return;
    const delta = committed.historyIndex - attempt.historyIndex;
    if (delta !== 0) { restoring = true; navigation.go(delta); }
    else { navigation.restore(committed); remember(); }
  };
  const stopNavigation = navigation.subscribe(() => {
    const next = navigation.getSnapshot();
    if (next.action !== "pop") return;
    const epoch = ++intent;
    activation.cancelPending();
    if (restoring) { restoring = false; remember(); return; }
    if (blocked()) { rollbackPop(next); return; }
    if (next.applicationRoute.kind !== "conversation"
      || (equalWorkbenchLocation(next.location, activeLocation) && next.routeScopeId === activeScope)) {
      remember(); return;
    }
    void activation.prepare(next.location).then(prepared => {
      if (disposed || intent !== epoch || navigation.getSnapshot().revision !== next.revision) {
        prepared?.cancel(); return;
      }
      if (!prepared || !prepared.commit(next.routeScopeId)) {
        prepared?.cancel(); rollbackPop(next); return;
      }
      activeLocation = next.location; activeScope = next.routeScopeId;
      remember();
    }).catch(() => { if (intent === epoch) rollbackPop(next); });
  });
  const navigate = async (location: WorkbenchLocation, mode: WorkbenchHistoryMode = "push", scope?: typeof activeScope) => {
    if (disposed) throw new Error("Workbench navigation transaction is disposed");
    if (blocked()) return false;
    const epoch = ++intent;
    let prepared;
    try { prepared = await activation.prepare(location); }
    catch (error) { if (disposed || intent !== epoch) return false; throw error; }
    if (disposed || intent !== epoch) { prepared?.cancel(); return false; }
    if (!prepared) return false;
    const viewId = scope ?? (snapshot.applicationRoute.kind === "conversation"
      && equalWorkbenchLocation(snapshot.location, location) ? snapshot.routeScopeId : createRouteScopeId());
    // A rejected preparation must not write a route and then attempt a lossy rollback.
    if (!prepared.commit(viewId)) { prepared.cancel(); return false; }
    navigation[mode](location, { routeScopeId: viewId });
    activeLocation = location; activeScope = viewId;
    remember();
    return true;
  };
  const openChat = async () => {
    if (disposed) throw new Error("Workbench navigation transaction is disposed");
    if (blocked()) return false;
    const target = navigation.getSnapshot();
    if (equalWorkbenchLocation(target.location, activeLocation) && target.routeScopeId === activeScope) {
      const epoch = ++intent;
      activation.cancelPending(); navigation.openChat(); remember();
      // Settings may have canceled bootstrap readiness, while the local View
      // itself remained presentable. Resume readiness without delaying Chat.
      void activation.prepare(target.location).then(prepared => {
        if (disposed || intent !== epoch) { prepared?.cancel(); return; }
        if (prepared && !prepared.commit(target.routeScopeId)) prepared.cancel();
      }).catch(() => undefined);
      return true;
    }
    return navigate(target.location, "push", target.routeScopeId);
  };
  const leaveSurface = () => {
    // Resource failures remain owned by the activation coordinator. Never create
    // an unhandled rejection from a fire-and-forget Shell close action.
    void openChat().catch(() => undefined);
  };
  const routeAction = (action: () => void) => {
    if (disposed) throw new Error("Workbench navigation transaction is disposed");
    if (blocked()) return;
    ++intent; activation.cancelPending(); action(); remember();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    navigate,
    openChat,
    navigateToHome(location, mode = "push") {
      if (disposed) throw new Error("Workbench navigation transaction is disposed");
      if (blocked()) return false;
      const epoch = ++intent, scope = createRouteScopeId();
      activation.presentLocalDraft(location, scope);
      navigation[mode](location, { routeScopeId: scope });
      activeLocation = location; activeScope = scope;
      remember();
      void activation.prepare(location).then(prepared => {
        if (disposed || intent !== epoch) { prepared?.cancel(); return; }
        if (prepared && !prepared.commit(scope)) prepared.cancel();
      }).catch(() => undefined);
      return true;
    },
    openSettings(slug = "appearance", mode = "push") { routeAction(() => navigation.openSettings(slug, mode)); },
    closeSettings: leaveSurface,
    openExtensionView(viewId, resourceUri = null) { routeAction(() => navigation.openExtensionView(viewId, resourceUri)); },
    pushExtensionViewResource(viewId, resourceUri) { routeAction(() => navigation.pushExtensionViewResource(viewId, resourceUri)); },
    replaceExtensionViewResource(viewId, resourceUri) { routeAction(() => navigation.replaceExtensionViewResource(viewId, resourceUri)); },
    closeExtensionView: leaveSurface,
    async promoteDraft(draftId, receipt) {
      const epoch = ++intent;
      const prepared = await activation.preparePromotion(draftId, receipt);
      if (disposed || intent !== epoch) {
        prepared?.cancel(); throw new Error("Draft promotion navigation was superseded");
      }
      if (!prepared || !prepared.commit(activeScope)) throw new Error("Draft promotion activation failed");
      navigation.replace(prepared.location, { preserveView: true, routeScopeId: activeScope });
      activeLocation = prepared.location; remember(); return prepared.location;
    },
    back() { if (!blocked()) { ++intent; navigation.back(); } },
    forward() { if (!blocked()) { ++intent; navigation.forward(); } },
    dispose() { disposed = true; ++intent; activation.cancelPending(); stopNavigation(); navigation.dispose(); listeners.clear(); },
  };
}
