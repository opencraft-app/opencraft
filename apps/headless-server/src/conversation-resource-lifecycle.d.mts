import type { OwnerWake } from "@opencraft/owner-wake";
import type {
  ConversationResourceRow,
  ConversationResourceMethods,
} from "@opencraft/storage-node/server-conversation-resources";

type OwnerCalls = {
  [Method in keyof ConversationResourceMethods]: (
    ...args: Parameters<ConversationResourceMethods[Method]>
  ) => Promise<ReturnType<ConversationResourceMethods[Method]>>;
};

type Storage = { call: OwnerCalls; onUnavailable?(listener: () => void): () => void };
type Owners = Record<string, (row: ConversationResourceRow) => unknown>;
type LifecycleOptions = {
  wake?: OwnerWake;
  retryMs?: number;
  diagnose?: (value: unknown) => void;
  dependencies?: Record<string, readonly string[]>;
};

export class ConversationResourceLifecycle {
  static open(
    storage: Storage,
    owners: Owners,
    options?: LifecycleOptions & { replayOwners?: readonly string[] },
  ): Promise<ConversationResourceLifecycle>;
  constructor(
    storage: Storage | null,
    owners: Owners,
    options?: LifecycleOptions & { saved?: readonly ConversationResourceRow[] },
  );
  assertActive(hostId: string, threadId: string): void;
  observedState(hostId: string, threadId: string): ConversationResourceRow["state"] | null;
  observe(hostId: string, threadId: string, state: ConversationResourceRow["state"]): Promise<void>;
  reconcileArchived(
    hostId: string,
    list: (cursor: string | null) => Promise<{
      data: readonly { id: string; ephemeral?: boolean }[];
      nextCursor?: string | null;
    }>,
  ): Promise<boolean | undefined>;
  invalidateHost(hostId: string): void;
  hostRevision(hostId: string): number;
  resourceLinked(hostId: string, threadId: string): void;
  retry(): void;
  settleCurrentCleanup(): Promise<void>;
  close(): Promise<void>;
}
