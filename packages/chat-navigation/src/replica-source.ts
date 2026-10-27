import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import type { ReplicaClient, ReplicaSource } from "@opencraft/appserver-replica";

import type {
  ConversationNavigationAnchor,
  ConversationNavigationPreview,
  ConversationNavigationTarget,
  ConversationNavigationSnapshot,
  ConversationNavigationSource,
} from "./types";
import { conversationNavigationTargetVersion } from "./types";

export const THREAD_NAVIGATION_ENTITY_KIND = "thread-navigation-anchor";

export type ThreadNavigationReplicaEntity = {
  readonly kind: typeof THREAD_NAVIGATION_ENTITY_KIND;
  readonly anchorId: string;
  readonly timelineSeq: number;
  readonly turnId: string;
  readonly itemId: string | null;
  readonly timestamp: string | null;
  readonly promptPreview: string;
  readonly isHeartbeat?: boolean;
};

export function threadNavigationReplicaScope(hostId: string, threadId: string): string {
  return `thread-navigation:${hostId}:${threadId}`;
}

function isRecord(value: ReplicaJsonValue): value is { readonly [key: string]: ReplicaJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntity(value: ReplicaJsonValue): ThreadNavigationReplicaEntity | null {
  if (!isRecord(value) || value.kind !== THREAD_NAVIGATION_ENTITY_KIND) return null;
  if (
    typeof value.anchorId !== "string"
    || typeof value.timelineSeq !== "number"
    || !Number.isSafeInteger(value.timelineSeq)
    || typeof value.turnId !== "string"
    || !(typeof value.itemId === "string" || value.itemId === null)
    || !(typeof value.timestamp === "string" || value.timestamp === null)
    || typeof value.promptPreview !== "string"
    || !(value.isHeartbeat === undefined || typeof value.isHeartbeat === "boolean")
  ) return null;
  return {
    kind: THREAD_NAVIGATION_ENTITY_KIND,
    anchorId: value.anchorId,
    timelineSeq: value.timelineSeq,
    turnId: value.turnId,
    itemId: value.itemId,
    timestamp: value.timestamp,
    promptPreview: value.promptPreview,
    ...(value.isHeartbeat === undefined ? {} : { isHeartbeat: value.isHeartbeat }),
  };
}

export interface ReplicaConversationNavigationSourceConfig {
  readonly replica: ReplicaClient<ReplicaJsonValue>;
  readonly source: ReplicaSource<ReplicaJsonValue>;
  readonly isLoaded?: (anchor: ThreadNavigationReplicaEntity) => boolean;
  readonly loadPreview?: (anchor: ThreadNavigationReplicaEntity) => Promise<ConversationNavigationPreview | null>;
  readonly prepareTarget: (
    anchor: ThreadNavigationReplicaEntity,
    epoch: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ConversationNavigationTarget | null>;
}

/** V4-native Prompt Index. Timeline windows remain owned by the reveal callback. */
export function createReplicaConversationNavigationSource(
  config: ReplicaConversationNavigationSourceConfig,
): ConversationNavigationSource {
  let revision = 0;
  let disposed = false;
  let snapshot: ConversationNavigationSnapshot;
  const listeners = new Set<() => void>();
  /** Indexed by semantic Anchor identity, never by Replica storage identity. */
  const entities = new Map<string, ThreadNavigationReplicaEntity>();

  const rebuild = () => {
    const replicaSnapshot = config.replica.getSnapshot();
    entities.clear();
    let identityError: Error | null = null;
    for (const [entityId, value] of replicaSnapshot.entities) {
      const parsed = parseEntity(value);
      if (parsed === null) continue;
      if (entities.has(parsed.anchorId)) {
        identityError = new Error(`Duplicate navigation anchor identity: ${parsed.anchorId} (${entityId})`);
        break;
      }
      entities.set(parsed.anchorId, parsed);
    }
    if (identityError !== null) entities.clear();
    const anchors: ConversationNavigationAnchor[] = [...entities.values()]
      .sort((left, right) => left.timelineSeq - right.timelineSeq || left.anchorId.localeCompare(right.anchorId))
      .map((entity) => ({
        id: entity.anchorId,
        turnKey: entity.turnId,
        itemId: entity.itemId,
        order: entity.timelineSeq,
        label: entity.promptPreview,
        isLoaded: config.isLoaded?.(entity) ?? false,
        isHeartbeat: entity.isHeartbeat ?? false,
      }));
    revision += 1;
    snapshot = {
      revision,
      phase: identityError !== null
        ? "error"
        : replicaSnapshot.phase === "empty"
        ? "empty"
        : replicaSnapshot.phase === "syncing" || replicaSnapshot.phase === "painted"
          ? "loading"
          : replicaSnapshot.phase === "live"
            ? "ready"
            : replicaSnapshot.phase === "offline"
              ? "offline"
              : "error",
      generation: replicaSnapshot.epoch,
      completeness: identityError === null && replicaSnapshot.authoritative ? "complete" : "partial",
      anchors,
      error: identityError ?? replicaSnapshot.lastError,
    };
  };
  rebuild();
  const unsubscribeReplica = config.replica.subscribe(() => {
    if (disposed) return;
    rebuild();
    for (const listener of listeners) listener();
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prepare() {
      if (disposed) return;
      await config.replica.prepare();
      await config.replica.synchronize(config.source);
    },
    async loadPreview(anchorId) {
      if (disposed) return null;
      const anchor = entities.get(anchorId);
      if (anchor === undefined) return null;
      const preview = await (config.loadPreview?.(anchor) ?? Promise.resolve({
        label: anchor.promptPreview,
        response: "",
        outputs: [],
      }));
      return disposed ? null : preview;
    },
    async prepareTarget(anchorId, options) {
      if (disposed) return null;
      const anchor = entities.get(anchorId);
      const epoch = config.replica.getSnapshot().epoch;
      if (anchor === undefined || epoch === null) return null;
      const target = await config.prepareTarget(anchor, epoch, options);
      if (disposed || target === null || config.replica.getSnapshot().epoch !== epoch) return null;
      const currentAnchor = entities.get(anchorId);
      if (
        currentAnchor === undefined
        || conversationNavigationTargetVersion({
          turnKey: currentAnchor.turnId,
          itemId: currentAnchor.itemId,
        }) !== conversationNavigationTargetVersion(target)
      ) return null;
      return {
        ...target,
        anchorId,
        generation: epoch,
        targetVersion: conversationNavigationTargetVersion(target),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeReplica();
      listeners.clear();
    },
  };
}
