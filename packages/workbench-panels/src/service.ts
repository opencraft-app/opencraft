import { Context, Service } from "@deepseek-ai/cordis";

import {
  createConversationPanelState,
  reduceConversationPanelState,
  type PanelAction,
  type PanelTabDescriptor,
  type ConversationPanelState,
} from "./model";

export interface PanelTypeDefinition<TParams extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly kind: string;
  readonly initialTab?: {
    readonly order: number;
    readonly params: TParams;
  };
  /** Rebuilds cached panel chrome from an application-owned resource directory. */
  restoreTabs?(ownerId: string): readonly PanelTabDescriptor[];
  /** Restore Host resources after connection without selecting or opening a panel. */
  hydrateTabs?(ownerId: string): Promise<readonly PanelTabDescriptor[]>;
  /** Complete, synchronous directory of this owner's panel attachments, not all
   * background resources. Missing entries detach chrome without disposing resources. */
  readonly tabDirectory?: {
    read(ownerId: string): readonly PanelTabDescriptor[];
    subscribe(ownerId: string, changed: () => void): () => void;
  };
  createTab(params: TParams): PanelTabDescriptor;
  /** Releases the logical resource represented by a tab. Renderers never own it. */
  disposeTab?(tab: PanelTabDescriptor, ownerId: string, reason: PanelDisposeReason): void;
}

export interface PanelToolbarActionContext {
  readonly workspaceFileThreadId?: string;
  readonly threadId?: string | null;
  readonly projectId?: string | null;
  readonly ownerId: string;
  readonly resourceOwnerId: string;
  readonly hostId: string;
  readonly cwd: string | null;
}

export interface PanelToolbarActionDefinition {
  readonly id: string;
  readonly region: "right" | "bottom";
  readonly order: number;
  readonly label: string;
  readonly icon: string;
  /** Opt in to both the new-tab picker and empty-panel launcher. */
  readonly creationLabel?: string;
  isAvailable?(context: PanelToolbarActionContext): boolean;
  run(context: PanelToolbarActionContext): void | Promise<void>;
}

export type PanelDisposeReason = "close" | "owner-release" | "definition-unregister" | "replace";

export interface WorkbenchPanelServiceConfig {
  readonly defaultRightPanelOpen?: boolean;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    workbenchPanels: WorkbenchPanelService;
  }
}

export class WorkbenchPanelService extends Service {
  private readonly defaultRightPanelOpen: boolean;
  private readonly definitions = new Map<string, PanelTypeDefinition>();
  private readonly toolbarActions = new Map<string, PanelToolbarActionDefinition>();
  private readonly ownerStates = new Map<string, ConversationPanelState>();
  private readonly ownerListeners = new Map<string, Set<() => void>>();
  private readonly initializedOwners = new Set<string>();
  private readonly hydrationTokens = new Map<string, object>();
  private readonly directorySubscriptions = new Map<string, Map<string, () => void>>();
  private readonly closedTabs = new Map<string, Set<string>>();
  private readonly registryListeners = new Set<() => void>();
  private registrySnapshot: readonly PanelTypeDefinition[] = [];
  private toolbarActionSnapshot: readonly PanelToolbarActionDefinition[] = [];

  constructor(ctx: Context, config: WorkbenchPanelServiceConfig = {}) {
    super(ctx, "workbenchPanels");
    this.defaultRightPanelOpen = config.defaultRightPanelOpen ?? false;
    ctx.effect(() => () => {
      for (const state of this.ownerStates.values()) this.disposeOwnerTabs(state);
      this.definitions.clear();
      this.toolbarActions.clear();
      this.ownerStates.clear();
      this.ownerListeners.clear();
      this.initializedOwners.clear();
      this.hydrationTokens.clear();
      for (const subscriptions of this.directorySubscriptions.values()) for (const stop of subscriptions.values()) stop();
      this.directorySubscriptions.clear();
      this.closedTabs.clear();
      this.registryListeners.clear();
    });
  }

  registerToolbarAction(definition: PanelToolbarActionDefinition): () => void {
    const id = definition.id.trim();
    if (id.length === 0) throw new RangeError("Panel toolbar action ID must not be empty");
    if (this.toolbarActions.has(id))
      throw new Error(`Panel toolbar action ${id} is already registered`);
    this.toolbarActions.set(id, definition);
    this.publishToolbarActions();
    return () => {
      if (this.toolbarActions.get(id) !== definition) return;
      this.toolbarActions.delete(id);
      this.publishToolbarActions();
    };
  }

  register<TParams extends Readonly<Record<string, unknown>>>(
    definition: PanelTypeDefinition<TParams>,
  ): () => void {
    if (definition.kind.trim().length === 0) throw new RangeError("Panel kind must not be empty");
    if (this.definitions.has(definition.kind)) throw new Error(`Panel kind ${definition.kind} is already registered`);
    this.definitions.set(definition.kind, definition as PanelTypeDefinition);
    this.publishRegistry();
    for (const ownerId of this.initializedOwners) this.observeDirectory(ownerId, definition as PanelTypeDefinition);
    if (definition.hydrateTabs) for (const ownerId of this.initializedOwners) {
      this.hydrationTokens.delete(ownerId);
      this.hydrateOwner(ownerId);
    }
    return () => {
      if (this.definitions.get(definition.kind) !== definition) return;
      for (const subscriptions of this.directorySubscriptions.values()) {
        subscriptions.get(definition.kind)?.();
        subscriptions.delete(definition.kind);
      }
      for (const [ownerId, state] of this.ownerStates) {
        for (const region of ["right", "bottom"] as const) {
          for (const tab of state[region].tabs) {
            if (tab.kind === definition.kind) {
              this.dispatch(ownerId, { type: "force-close-tab", region, tabId: tab.id });
            }
          }
        }
      }
      this.definitions.delete(definition.kind);
      this.publishRegistry();
    };
  }

  open<TParams extends Readonly<Record<string, unknown>>>(
    ownerId: string,
    kind: string,
    params: TParams,
    options: { readonly activate?: boolean } = {},
  ): PanelTabDescriptor {
    const definition = this.definitions.get(kind);
    if (definition === undefined) throw new Error(`Panel kind ${kind} is not registered`);
    const tab = definition.createTab(params);
    if (tab.kind !== kind) throw new Error(`Panel definition ${kind} created tab kind ${tab.kind}`);
    const current = this.ensureOwner(ownerId);
    const existing = [...current.right.tabs, ...current.bottom.tabs].find((candidate) => candidate.id === tab.id);
    if (
      existing !== undefined
      && (
        existing.kind !== tab.kind
        || existing.resource !== tab.resource
        || (kind !== "resource" && JSON.stringify(existing.durableRoute) !== JSON.stringify(tab.durableRoute))
      )
    ) {
      throw new Error(`Panel tab ${tab.id} cannot replace its logical resource identity`);
    }
    const placed = existing ? kind === "resource" ? { ...existing, preview: existing.preview && tab.preview } : { ...tab, region: existing.region } : tab;
    this.dispatch(ownerId, { type: "open-tab", tab: placed, activate: options.activate });
    return placed;
  }

  dispatch(ownerId: string, action: PanelAction): ConversationPanelState {
    const current = this.ensureOwner(ownerId);
    const next = reduceConversationPanelState(current, action);
    if (next === current) return current;
    if (action.type === "close-tab") {
      const closed = this.closedTabs.get(ownerId) ?? new Set<string>();
      closed.add(action.tabId); this.closedTabs.set(ownerId, closed);
    } else if (action.type === "open-tab") this.closedTabs.get(ownerId)?.delete(action.tab.id);
    this.disposeRemovedTabs(
      current,
      next,
      action.type === "close-tab"
        ? "close"
        : action.type === "force-close-tab"
          ? "definition-unregister"
          : "replace",
    );
    this.ownerStates.set(ownerId, next);
    for (const listener of this.ownerListeners.get(ownerId) ?? []) listener();
    return next;
  }

  close(ownerId: string, region: PanelTabDescriptor["region"], tabId: string): ConversationPanelState {
    const current = this.getOwnerSnapshot(ownerId);
    const tab = current[region].tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined || !tab.closable) return current;
    return this.dispatch(ownerId, { type: "close-tab", region, tabId });
  }

  getOwnerSnapshot = (ownerId: string): ConversationPanelState => {
    const existing = this.ownerStates.get(ownerId);
    if (existing !== undefined) return existing;
    const created = createConversationPanelState({
      ownerId,
      initialTabs: [],
      rightPanelOpen: false,
    });
    this.ownerStates.set(ownerId, created);
    return created;
  };

  /** Explicit resource creation boundary; snapshot reads remain side-effect free. */
  ensureOwner(ownerId: string): ConversationPanelState {
    const current = this.getOwnerSnapshot(ownerId);
    if (this.initializedOwners.has(ownerId)) { this.hydrateOwner(ownerId); return current; }
    const initialTabs = [...this.definitions.values()]
      .filter((definition) => definition.initialTab !== undefined)
      .sort((left, right) => (left.initialTab?.order ?? 0) - (right.initialTab?.order ?? 0))
      .map((definition) => definition.createTab(definition.initialTab!.params));
    const restoredTabs = [...this.definitions.values()].flatMap((definition) =>
      definition.restoreTabs?.(ownerId) ?? []);
    const tabsById = new Map<string, PanelTabDescriptor>();
    for (const tab of [...initialTabs, ...restoredTabs]) {
      const existing = tabsById.get(tab.id);
      if (
        existing !== undefined
        && (existing.kind !== tab.kind || existing.resource !== tab.resource)
      ) {
        throw new Error(`Panel restore produced conflicting tab ${tab.id}`);
      }
      tabsById.set(tab.id, tab);
    }
    const initialized = createConversationPanelState({
      ownerId,
      initialTabs: [...tabsById.values()],
      rightPanelOpen: this.defaultRightPanelOpen,
    });
    this.initializedOwners.add(ownerId);
    this.ownerStates.set(ownerId, initialized);
    for (const definition of this.definitions.values()) this.observeDirectory(ownerId, definition);
    this.hydrateOwner(ownerId);
    for (const listener of this.ownerListeners.get(ownerId) ?? []) listener();
    return initialized;
  }

  /** Host readiness can retry pending resource recovery without recreating panel chrome. */
  refreshOwnerResources(ownerId: string): void {
    if (!this.initializedOwners.has(ownerId)) return;
    for (const definition of this.definitions.values()) if (definition.tabDirectory) this.reconcileDirectory(ownerId, definition);
    this.hydrationTokens.delete(ownerId);
    this.hydrateOwner(ownerId);
  }

  private hydrateOwner(ownerId: string): void {
    if (this.hydrationTokens.has(ownerId)) return;
    const token = {};
    this.hydrationTokens.set(ownerId, token);
    for (const definition of this.definitions.values()) {
      if (!definition.hydrateTabs) continue;
      void Promise.resolve().then(() => definition.hydrateTabs!(ownerId)).then((tabs) => {
        if (this.hydrationTokens.get(ownerId) !== token || this.definitions.get(definition.kind) !== definition) return;
        if (definition.tabDirectory) {
          this.reconcileDirectory(ownerId, definition);
          return;
        }
        for (const tab of tabs) {
          const state = this.ownerStates.get(ownerId);
          if (!state || this.closedTabs.get(ownerId)?.has(tab.id) || tab.kind !== definition.kind || [...state.right.tabs, ...state.bottom.tabs].some((existing) => existing.id === tab.id)) continue;
          this.dispatch(ownerId, { type: "open-tab", tab, activate: false });
        }
      }).catch(() => {
        // Connection failure remains owned by the Host. Re-entering the owner retries restoration.
        if (this.hydrationTokens.get(ownerId) === token) this.hydrationTokens.delete(ownerId);
      });
    }
  }

  subscribeOwner = (ownerId: string, listener: () => void): (() => void) => {
    const listeners = this.ownerListeners.get(ownerId) ?? new Set<() => void>();
    listeners.add(listener);
    this.ownerListeners.set(ownerId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.ownerListeners.delete(ownerId);
    };
  };

  private observeDirectory(ownerId: string, definition: PanelTypeDefinition): void {
    const directory = definition.tabDirectory;
    if (!directory) return;
    const subscriptions = this.directorySubscriptions.get(ownerId) ?? new Map<string, () => void>();
    if (subscriptions.has(definition.kind)) return;
    this.directorySubscriptions.set(ownerId, subscriptions);
    let disposed = false, queued = false;
    const changed = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed && this.definitions.get(definition.kind) === definition && this.initializedOwners.has(ownerId))
          this.reconcileDirectory(ownerId, definition);
      });
    };
    const stop = directory.subscribe(ownerId, changed);
    subscriptions.set(definition.kind, () => { disposed = true; stop(); });
    changed(); // Subscribe first, then read: a change during setup cannot be lost.
  }

  private reconcileDirectory(ownerId: string, definition: PanelTypeDefinition): void {
    let tabs: readonly PanelTabDescriptor[];
    try { tabs = definition.tabDirectory!.read(ownerId); } catch { return; } // Unavailable is not empty.
    const current = this.ownerStates.get(ownerId);
    if (!current) return;
    const existingById = new Map([...current.right.tabs, ...current.bottom.tabs].map((tab) => [tab.id, tab]));
    const incoming = new Map<string, PanelTabDescriptor>();
    for (const tab of tabs) {
      if (tab.kind !== definition.kind || incoming.has(tab.id)) return;
      const existing = existingById.get(tab.id);
      if (existing && (existing.kind !== tab.kind || existing.resource !== tab.resource)) return;
      incoming.set(tab.id, tab);
    }
    let next = current;
    for (const region of ["right", "bottom"] as const) for (const tab of current[region].tabs) {
      if (tab.kind === definition.kind && !incoming.has(tab.id))
        next = reduceConversationPanelState(next, { type: "force-close-tab", region, tabId: tab.id });
    }
    for (const tab of incoming.values()) {
      if (this.closedTabs.get(ownerId)?.has(tab.id)) continue;
      const existing = existingById.get(tab.id);
      next = existing ? reduceConversationPanelState(next, { type: "update-tab", region: existing.region, tabId: tab.id,
        patch: { title: tab.title, icon: tab.icon, closable: tab.closable } })
        : reduceConversationPanelState(next, { type: "open-tab", tab, activate: false });
    }
    if (next === current) return;
    this.ownerStates.set(ownerId, next);
    // Reconciliation is projection only. Never call disposeTab or feed a resource close back to its owner.
    for (const listener of this.ownerListeners.get(ownerId) ?? []) listener();
  }

  /** Forget a logical panel owner, not a navigation entry. Not a user close. */
  releaseOwner(ownerId: string): void {
    for (const stop of this.directorySubscriptions.get(ownerId)?.values() ?? []) stop();
    this.directorySubscriptions.delete(ownerId);
    const state = this.ownerStates.get(ownerId);
    if (state !== undefined) this.disposeOwnerTabs(state, "owner-release");
    this.ownerStates.delete(ownerId);
    this.hydrationTokens.delete(ownerId);
    this.closedTabs.delete(ownerId);
    this.initializedOwners.delete(ownerId);
    this.ownerListeners.delete(ownerId);
  }

  getRegistrySnapshot = (): readonly PanelTypeDefinition[] => this.registrySnapshot;

  subscribeRegistry = (listener: () => void): (() => void) => {
    this.registryListeners.add(listener);
    return () => this.registryListeners.delete(listener);
  };

  getToolbarActionSnapshot = (): readonly PanelToolbarActionDefinition[] =>
    this.toolbarActionSnapshot;

  subscribeToolbarActions = (listener: () => void): (() => void) => {
    this.registryListeners.add(listener);
    return () => this.registryListeners.delete(listener);
  };

  private publishRegistry(): void {
    this.registrySnapshot = [...this.definitions.values()];
    for (const listener of this.registryListeners) listener();
  }

  private publishToolbarActions(): void {
    this.toolbarActionSnapshot = Object.freeze(
      [...this.toolbarActions.values()].sort((left, right) =>
        left.order - right.order || left.id.localeCompare(right.id)),
    );
    for (const listener of this.registryListeners) listener();
  }

  private disposeOwnerTabs(
    state: ConversationPanelState,
    reason: PanelDisposeReason = "owner-release",
  ): void {
    for (const tab of [...state.right.tabs, ...state.bottom.tabs]) {
      this.definitions.get(tab.kind)?.disposeTab?.(tab, state.ownerId, reason);
    }
  }

  private disposeRemovedTabs(
    previous: ConversationPanelState,
    next: ConversationPanelState,
    reason: PanelDisposeReason,
  ): void {
    const retained = new Set([
      ...next.right.tabs.map((tab) => tab.id),
      ...next.bottom.tabs.map((tab) => tab.id),
    ]);
    for (const tab of [...previous.right.tabs, ...previous.bottom.tabs]) {
      if (!retained.has(tab.id)) {
        this.definitions.get(tab.kind)?.disposeTab?.(tab, previous.ownerId, reason);
      }
    }
  }
}
