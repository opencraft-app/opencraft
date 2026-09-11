import type {
  ConversationActivationCoordinator,
  ConversationScopeRegistry,
  WorkbenchActivatableRuntime,
  WorkbenchLocation,
} from "@opencraft/workbench-runtime";
import {
  draftSubmissionOwnsNavigation,
  equalWorkbenchLocation,
} from "@opencraft/workbench-runtime";
import type { SubmissionReceipt } from "@opencraft/composer-core";

import {
  createBrowserWorkbenchNavigation,
  type BrowserWorkbenchNavigation,
  type BrowserWorkbenchNavigationSnapshot,
} from "./workbench-navigation";

export type WorkbenchHistoryMode = "push" | "replace";

export interface WorkbenchNavigationTransaction<
  TRuntime extends WorkbenchActivatableRuntime,
> {
  getSnapshot(): BrowserWorkbenchNavigationSnapshot;
  subscribe(listener: () => void): () => void;
  navigate(
    location: WorkbenchLocation,
    mode?: WorkbenchHistoryMode,
  ): Promise<boolean>;
  openSettings(slug?: string): void;
  closeSettings(): void;
  openExtensionView(viewId: string, resourceUri?: string | null): void;
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

/** The only Web owner that couples browser History to Conversation activation. */
export function createWorkbenchNavigationTransaction<
  TRuntime extends WorkbenchActivatableRuntime,
>(
  initialLocation: WorkbenchLocation,
  activation: ConversationActivationCoordinator<TRuntime>,
  scopes: ConversationScopeRegistry,
): WorkbenchNavigationTransaction<TRuntime> {
  const navigation: BrowserWorkbenchNavigation =
    createBrowserWorkbenchNavigation(initialLocation);
  const listeners = new Set<() => void>();
  let snapshot = navigation.getSnapshot();
  let committedLocation = initialLocation;
  let committedIndex = navigation.getSnapshot().historyIndex;
  let committedRouteScopeId = navigation.getSnapshot().routeScopeId;
  let disposed = false;
  let handledRevision = -1;
  let restoringHistory = false;
  activation.setViewId(snapshot.routeScopeId);
  const publish = () => {
    snapshot = navigation.getSnapshot();
    for (const listener of listeners) listener();
  };

  const navigationBlocked = () => {
    const draft = scopes.getActiveDraft();
    return draft !== null && draftSubmissionOwnsNavigation(draft.phase);
  };
  const restoreCommittedEntry = (
    attempted: BrowserWorkbenchNavigationSnapshot,
  ) => {
    if (disposed || navigation.getSnapshot().revision !== attempted.revision)
      return;
    const delta = committedIndex - attempted.historyIndex;
    if (delta === 0) {
      navigation.replace(committedLocation, {
        routeScopeId: committedRouteScopeId,
      });
      return;
    }
    restoringHistory = true;
    navigation.go(delta);
  };

  const removeNavigationListener = navigation.subscribe(() => {
    const next = navigation.getSnapshot();
    if (next.action !== "pop" || next.revision === handledRevision) return;
    handledRevision = next.revision;
    if (restoringHistory) {
      restoringHistory = false;
      return;
    }
    if (navigationBlocked()) {
      restoreCommittedEntry(next);
      return;
    }
    if (
      next.applicationRoute.kind !== "conversation" ||
      equalWorkbenchLocation(next.location, committedLocation)
    ) {
      committedIndex = next.historyIndex;
      publish();
      return;
    }
    void activation
      .prepare(next.location)
      .then((prepared) => {
        if (disposed || navigation.getSnapshot().revision !== next.revision)
          return;
        if (prepared === null) {
          restoreCommittedEntry(next);
          return;
        }
        if (!prepared.commit(next.routeScopeId)) {
          restoreCommittedEntry(next);
          return;
        }
        committedLocation = next.location;
        committedIndex = next.historyIndex;
        committedRouteScopeId = next.routeScopeId;
        publish();
      })
      .catch(() => restoreCommittedEntry(next));
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed)
        throw new Error("Workbench navigation transaction is disposed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async navigate(location, mode = "push") {
      if (disposed)
        throw new Error("Workbench navigation transaction is disposed");
      if (navigationBlocked()) {
        throw new Error(
          "The workbench cannot navigate while the first turn is being submitted",
        );
      }
      const prepared = await activation.prepare(location);
      if (prepared === null) return false;
      navigation[mode](location);
      const committed = navigation.getSnapshot();
      if (!prepared.commit(committed.routeScopeId)) {
        restoreCommittedEntry(committed);
        return false;
      }
      committedLocation = location;
      committedIndex = committed.historyIndex;
      committedRouteScopeId = committed.routeScopeId;
      publish();
      return true;
    },
    openSettings(slug = "connections") {
      if (disposed)
        throw new Error("Workbench navigation transaction is disposed");
      if (navigationBlocked()) return;
      navigation.openSettings(slug);
      committedIndex = navigation.getSnapshot().historyIndex;
      publish();
    },
    closeSettings() {
      if (disposed)
        throw new Error("Workbench navigation transaction is disposed");
      if (navigationBlocked()) return;
      const previousRevision = navigation.getSnapshot().revision;
      navigation.closeSettings();
      const next = navigation.getSnapshot();
      if (next.revision === previousRevision) return;
      committedIndex = next.historyIndex;
      publish();
    },
    openExtensionView(viewId, resourceUri = null) {
      if (disposed)
        throw new Error("Workbench navigation transaction is disposed");
      if (navigationBlocked()) return;
      navigation.openExtensionView(viewId, resourceUri);
      committedIndex = navigation.getSnapshot().historyIndex;
      publish();
    },
    replaceExtensionViewResource(viewId, resourceUri) {
      if (disposed)
        throw new Error("Workbench navigation transaction is disposed");
      const previousRevision = navigation.getSnapshot().revision;
      navigation.replaceExtensionViewResource(viewId, resourceUri);
      const next = navigation.getSnapshot();
      if (next.revision === previousRevision) return;
      committedIndex = next.historyIndex;
      publish();
    },
    closeExtensionView() {
      if (disposed)
        throw new Error("Workbench navigation transaction is disposed");
      if (navigationBlocked()) return;
      const previousRevision = navigation.getSnapshot().revision;
      navigation.closeExtensionView();
      const next = navigation.getSnapshot();
      if (next.revision === previousRevision) return;
      committedIndex = next.historyIndex;
      publish();
    },
    async promoteDraft(draftId, receipt) {
      if (disposed)
        throw new Error("Workbench navigation transaction is disposed");
      const prepared = await activation.preparePromotion(draftId, receipt);
      if (prepared === null)
        throw new Error("Draft promotion activation failed");
      const location = prepared.location;
      navigation.replace(location, { preserveView: true });
      const committed = navigation.getSnapshot();
      if (!prepared.commit(committed.routeScopeId)) {
        restoreCommittedEntry(committed);
        throw new Error("Draft promotion activation was superseded");
      }
      committedLocation = location;
      committedIndex = committed.historyIndex;
      committedRouteScopeId = committed.routeScopeId;
      publish();
      return location;
    },
    back() {
      if (!navigationBlocked()) navigation.back();
    },
    forward() {
      if (!navigationBlocked()) navigation.forward();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      removeNavigationListener();
      navigation.dispose();
    },
  };
}
