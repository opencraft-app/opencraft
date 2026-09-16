export const SIDEBAR_LAYOUT_SCHEMA_VERSION = 2;

export type SidebarEntityKind = "bot" | "thread" | "project";

export interface SidebarEntityIdentity {
  readonly kind: SidebarEntityKind;
  readonly hostId: string | null;
  readonly entityId: string;
}

export type SidebarEntityKey = string & { readonly __sidebarEntityKey: unique symbol };

/** Fully-qualified durable identity. Presentation and list position never enter the key. */
export function createSidebarEntityKey(identity: SidebarEntityIdentity): SidebarEntityKey {
  const entityId = identity.entityId.trim();
  const hostId = identity.hostId?.trim() ?? "";
  if (entityId.length === 0) throw new RangeError("Sidebar entity ID must not be empty");
  return ["v1", identity.kind, encodeURIComponent(hostId), encodeURIComponent(entityId)].join(":") as SidebarEntityKey;
}

export function parseSidebarEntityKey(key: string): SidebarEntityIdentity | null {
  const [version, kind, encodedHostId, encodedEntityId, ...rest] = key.split(":");
  if (
    version !== "v1"
    || !["bot", "thread", "project"].includes(kind ?? "")
    || encodedHostId === undefined
    || encodedEntityId === undefined
    || rest.length > 0
  ) return null;
  try {
    const entityId = decodeURIComponent(encodedEntityId);
    const hostId = decodeURIComponent(encodedHostId);
    if (entityId.length === 0) return null;
    return Object.freeze({
      kind: kind as SidebarEntityKind,
      hostId: hostId.length === 0 ? null : hostId,
      entityId,
    });
  } catch {
    return null;
  }
}

export type SidebarDropIntent =
  | { readonly kind: "unpin" }
  | { readonly kind: "append-pin" }
  | {
      readonly kind: "place-pin";
      readonly targetKey: SidebarEntityKey;
      readonly edge: "before" | "after";
    };

export type SidebarDragPresentation = "tile" | "row";

export type SidebarDragSnapshot =
  | {
      readonly phase: "idle";
      readonly activeKey: null;
      readonly presentation: null;
      readonly visiblePinnedKeys: readonly SidebarEntityKey[];
      readonly intent: null;
    }
  | {
      readonly phase: "dragging";
      readonly activeKey: SidebarEntityKey;
      readonly presentation: SidebarDragPresentation;
      readonly visiblePinnedKeys: readonly SidebarEntityKey[];
      readonly intent: SidebarDropIntent | null;
    };

export interface SidebarDragCompletion {
  readonly activeKey: SidebarEntityKey;
  readonly presentation: SidebarDragPresentation;
  readonly visiblePinnedKeys: readonly SidebarEntityKey[];
  readonly intent: SidebarDropIntent | null;
  readonly changed: boolean;
}

export type SidebarEntityAvatar =
  | { readonly kind: "image-url"; readonly url: string; readonly alt?: string }
  | {
      readonly kind: "monogram";
      readonly text: string;
      readonly background: string;
      readonly foreground?: string;
    }
  | { readonly kind: "generated"; readonly seed: string; readonly palette?: string }
  | { readonly kind: "resource"; readonly uri: string };

/** Semantic Sidebar read model. React and AppServer details stay outside it. */
export interface SidebarEntity {
  readonly key: SidebarEntityKey;
  readonly identity: SidebarEntityIdentity;
  readonly title: string;
  readonly subtitle?: string;
  readonly avatar: SidebarEntityAvatar;
  readonly availability: "available" | "connecting" | "unavailable" | "disabled";
  readonly defaultPinned?: boolean;
  readonly order?: number;
  readonly invoke: () => void;
}

export interface SidebarEntityCreationTarget {
  readonly id: string;
  readonly label: string;
}

export interface SidebarEntityCreationReceipt {
  readonly entityKey: SidebarEntityKey;
  readonly invoke: () => void;
}

/** Presentation invokes one semantic command; it never talks to a repository. */
export interface SidebarEntityCreationCommand {
  readonly noun: string;
  /** Optional application-owned creation surface shared with management. */
  readonly open?: () => void;
  readonly targets: readonly SidebarEntityCreationTarget[];
  create(targetId: string, name: string): Promise<SidebarEntityCreationReceipt>;
}

export interface SidebarLayoutDocument {
  readonly schemaVersion: typeof SIDEBAR_LAYOUT_SCHEMA_VERSION;
  readonly pinnedEntityKeys: readonly string[];
  /** Defaults may grow while async entity sources hydrate; a user edit seals them. */
  readonly ownership: "defaults" | "user";
}

export interface SidebarLayoutStorage {
  load(scope: string): Promise<SidebarLayoutDocument | null>;
  save(scope: string, document: SidebarLayoutDocument): Promise<SidebarLayoutDocument>;
  close?(): void | Promise<void>;
}

export interface SidebarLayoutSnapshot extends SidebarLayoutDocument {
  readonly revision: number;
  readonly owned: boolean;
  readonly phase: "ready" | "saving" | "error";
  readonly error: string | null;
}

function uniqueEntityKeys(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return Object.freeze(result);
}

function freezeDocument(document: SidebarLayoutDocument): SidebarLayoutDocument {
  return Object.freeze({
    schemaVersion: SIDEBAR_LAYOUT_SCHEMA_VERSION,
    pinnedEntityKeys: uniqueEntityKeys(document.pinnedEntityKeys),
    ownership: document.ownership,
  });
}

/** Pure transient projection. Pointer movement never mutates durable layout. */
export function projectSidebarDrop(
  currentPinnedKeys: readonly SidebarEntityKey[],
  activeKey: SidebarEntityKey,
  intent: SidebarDropIntent,
): readonly SidebarEntityKey[] {
  const next = currentPinnedKeys.filter((key) => key !== activeKey);
  if (intent.kind === "unpin") return Object.freeze(next);
  if (intent.kind === "append-pin") return Object.freeze([...next, activeKey]);
  const targetIndex = next.indexOf(intent.targetKey);
  if (targetIndex < 0) return Object.freeze(next);
  next.splice(targetIndex + (intent.edge === "after" ? 1 : 0), 0, activeKey);
  return Object.freeze(next);
}

function sameEntityKeyOrder(
  left: readonly SidebarEntityKey[],
  right: readonly SidebarEntityKey[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameDropIntent(
  left: SidebarDropIntent | null,
  right: SidebarDropIntent,
): boolean {
  if (left === null || left.kind !== right.kind) return false;
  if (left.kind !== "place-pin" || right.kind !== "place-pin") return true;
  return left.targetKey === right.targetKey && left.edge === right.edge;
}

function idleDragSnapshot(): SidebarDragSnapshot {
  return Object.freeze({
    phase: "idle",
    activeKey: null,
    presentation: null,
    visiblePinnedKeys: Object.freeze([]),
    intent: null,
  });
}

/**
 * Sole owner of one pointer/keyboard drag transaction. It deliberately owns
 * no DOM geometry and performs no persistence: the View measures source and
 * destination slots, while SidebarLayoutStore commits the completion once.
 */
export class SidebarDragTransaction {
  private originPinnedKeys: readonly SidebarEntityKey[] = Object.freeze([]);
  private snapshot: SidebarDragSnapshot = idleDragSnapshot();

  getSnapshot(): SidebarDragSnapshot {
    return this.snapshot;
  }

  begin(
    visiblePinnedKeys: readonly SidebarEntityKey[],
    activeKey: SidebarEntityKey,
    presentation: SidebarDragPresentation,
  ): SidebarDragSnapshot {
    if (this.snapshot.phase !== "idle") {
      throw new Error(`Sidebar drag ${this.snapshot.activeKey} is already active`);
    }
    this.originPinnedKeys = Object.freeze([...visiblePinnedKeys]);
    this.snapshot = Object.freeze({
      phase: "dragging",
      activeKey,
      presentation,
      visiblePinnedKeys: this.originPinnedKeys,
      intent: null,
    });
    return this.snapshot;
  }

  project(intent: SidebarDropIntent): SidebarDragSnapshot {
    if (this.snapshot.phase !== "dragging") return this.snapshot;
    const visiblePinnedKeys = projectSidebarDrop(
      this.originPinnedKeys,
      this.snapshot.activeKey,
      intent,
    );
    if (
      sameDropIntent(this.snapshot.intent, intent)
      && sameEntityKeyOrder(this.snapshot.visiblePinnedKeys, visiblePinnedKeys)
    ) return this.snapshot;
    this.snapshot = Object.freeze({
      ...this.snapshot,
      // Every pointer position is a projection of the immutable start order.
      // It must not depend on whether React committed the previous frame.
      visiblePinnedKeys,
      intent,
    });
    return this.snapshot;
  }

  complete(): SidebarDragCompletion | null {
    if (this.snapshot.phase !== "dragging") return null;
    const completion = Object.freeze({
      activeKey: this.snapshot.activeKey,
      presentation: this.snapshot.presentation,
      visiblePinnedKeys: this.snapshot.visiblePinnedKeys,
      intent: this.snapshot.intent,
      changed: !sameEntityKeyOrder(
        this.originPinnedKeys,
        this.snapshot.visiblePinnedKeys,
      ),
    });
    this.reset();
    return completion;
  }

  cancel(): SidebarDragSnapshot {
    this.reset();
    return this.snapshot;
  }

  private reset(): void {
    this.originPinnedKeys = Object.freeze([]);
    this.snapshot = idleDragSnapshot();
  }
}

/** Replaces visible slots without discarding temporarily unavailable entities. */
export function mergeVisiblePinnedOrder(
  current: readonly string[],
  visibleEntityKeys: readonly string[],
  visiblePinnedKeys: readonly string[],
): readonly string[] {
  const visible = new Set(visibleEntityKeys);
  const requested = uniqueEntityKeys(visiblePinnedKeys).filter((key) => visible.has(key));
  let cursor = 0;
  const merged: string[] = [];
  for (const key of uniqueEntityKeys(current)) {
    if (!visible.has(key)) {
      merged.push(key);
      continue;
    }
    const replacement = requested[cursor++];
    if (replacement !== undefined) merged.push(replacement);
  }
  while (cursor < requested.length) merged.push(requested[cursor++]!);
  return uniqueEntityKeys(merged);
}

/**
 * Sole durable owner of Sidebar arrangement. Dragging is a transient View
 * projection; only a semantic drop mutates this optimistic, generation-fenced store.
 */
export class SidebarLayoutStore {
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private generation = 0;
  private persistenceTail: Promise<void> = Promise.resolve();
  private closed = false;
  private snapshot: SidebarLayoutSnapshot;

  private constructor(
    private readonly storage: SidebarLayoutStorage,
    private readonly scope: string,
    document: SidebarLayoutDocument | null,
  ) {
    this.snapshot = this.createSnapshot(
      document ?? {
        schemaVersion: SIDEBAR_LAYOUT_SCHEMA_VERSION,
        pinnedEntityKeys: [],
        ownership: "defaults",
      },
      document?.ownership === "user",
      "ready",
      null,
    );
  }

  static async open(
    storage: SidebarLayoutStorage,
    options: { readonly scope?: string } = {},
  ): Promise<SidebarLayoutStore> {
    const scope = options.scope?.trim() || "global";
    const document = await storage.load(scope);
    if (document !== null && document.schemaVersion !== SIDEBAR_LAYOUT_SCHEMA_VERSION) {
      throw new Error(`Unsupported Sidebar layout schema ${document.schemaVersion}`);
    }
    return new SidebarLayoutStore(storage, scope, document === null ? null : freezeDocument(document));
  }

  getSnapshot = (): SidebarLayoutSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  adoptDefaults(entityKeys: readonly string[]): void {
    if (this.snapshot.owned) return;
    const next = uniqueEntityKeys([...this.snapshot.pinnedEntityKeys, ...entityKeys]);
    if (
      next.length === this.snapshot.pinnedEntityKeys.length
      && next.every((key, index) => key === this.snapshot.pinnedEntityKeys[index])
    ) return;
    this.commit(next, "defaults");
  }

  setPinned(entityKey: string, pinned: boolean): void {
    const key = entityKey.trim();
    if (key.length === 0) throw new Error("Sidebar entity key must not be empty");
    const current = this.snapshot.pinnedEntityKeys;
    const exists = current.includes(key);
    if (exists === pinned) return;
    this.commit(
      pinned ? [...current, key] : current.filter((candidate) => candidate !== key),
      "user",
    );
  }

  commitVisibleOrder(
    visibleEntityKeys: readonly string[],
    visiblePinnedKeys: readonly string[],
  ): void {
    this.commit(
      mergeVisiblePinnedOrder(
        this.snapshot.pinnedEntityKeys,
        visibleEntityKeys,
        visiblePinnedKeys,
      ),
      "user",
    );
  }

  async flush(): Promise<void> {
    await this.persistenceTail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.listeners.clear();
    await this.storage.close?.();
  }

  private commit(entityKeys: readonly string[], ownership: SidebarLayoutDocument["ownership"]): void {
    this.ensureOpen();
    const document = freezeDocument({
      schemaVersion: SIDEBAR_LAYOUT_SCHEMA_VERSION,
      pinnedEntityKeys: entityKeys,
      ownership,
    });
    const generation = ++this.generation;
    this.snapshot = this.createSnapshot(document, ownership === "user", "saving", null);
    this.publish();
    this.persistenceTail = this.persistenceTail
      .catch(() => undefined)
      .then(async () => {
        try {
          const saved = freezeDocument(await this.storage.save(this.scope, document));
          if (this.closed || generation !== this.generation) return;
          this.snapshot = this.createSnapshot(saved, saved.ownership === "user", "ready", null);
          this.publish();
        } catch (error) {
          if (this.closed || generation !== this.generation) return;
          const message = error instanceof Error ? error.message : String(error);
          try {
            const recovered = await this.storage.load(this.scope);
            if (this.closed || generation !== this.generation) return;
            this.snapshot = this.createSnapshot(
              recovered ?? {
                schemaVersion: SIDEBAR_LAYOUT_SCHEMA_VERSION,
                pinnedEntityKeys: [],
                ownership: "defaults",
              },
              recovered?.ownership === "user",
              "error",
              message,
            );
          } catch {
            if (this.closed || generation !== this.generation) return;
            this.snapshot = this.createSnapshot(document, document.ownership === "user", "error", message);
          }
          this.publish();
        }
      });
  }

  private createSnapshot(
    document: SidebarLayoutDocument,
    owned: boolean,
    phase: SidebarLayoutSnapshot["phase"],
    error: string | null,
  ): SidebarLayoutSnapshot {
    return Object.freeze({
      ...freezeDocument(document),
      revision: ++this.revision,
      owned,
      phase,
      error,
    });
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Sidebar layout store is closed");
  }
}
