import type {
  DirectSendIntent,
  DirectSendIntentStore,
} from "../application/app-store";

interface PersistentStorageLike {
  getItem(key: string): Promise<string | null> | string | null;
  removeItem(key: string): Promise<void> | void;
  setItem(key: string, value: string): Promise<void> | void;
}

interface DirectSendIntentEnvelope {
  intents: Record<string, DirectSendIntent>;
  schemaVersion: 1;
}

export class PersistentDirectSendIntentStore
  implements DirectSendIntentStore
{
  private static readonly storageKey = "raft.client.direct-send-intents.v1";
  private exclusiveTail: Promise<void> = Promise.resolve();

  public constructor(private readonly storage: PersistentStorageLike) {}

  public load(key: string): Promise<DirectSendIntent | null> {
    return this.runExclusive(async () => {
      const envelope = await this.readEnvelope();
      return envelope?.intents[key] ?? null;
    });
  }

  public remove(key: string): Promise<void> {
    return this.runExclusive(async () => {
      const envelope = await this.readEnvelope();
      if (!envelope?.intents[key]) return;
      const intents = {...envelope.intents};
      delete intents[key];
      if (Object.keys(intents).length === 0) {
        await this.storage.removeItem(PersistentDirectSendIntentStore.storageKey);
        return;
      }
      await this.writeEnvelope({intents, schemaVersion: 1});
    });
  }

  public save(key: string, intent: DirectSendIntent): Promise<void> {
    return this.runExclusive(async () => {
      if (!isDirectSendIntent(intent)) {
        throw new Error("私信发送意图无效");
      }
      const envelope = await this.readEnvelope();
      await this.writeEnvelope({
        intents: {
          ...(envelope?.intents ?? {}),
          [key]: intent,
        },
        schemaVersion: 1,
      });
    });
  }

  private async readEnvelope(): Promise<DirectSendIntentEnvelope | null> {
    const raw = await this.storage.getItem(
      PersistentDirectSendIntentStore.storageKey,
    );
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error("unsupported schema");
      }
      if (!isRecord(value.intents)) {
        throw new Error("invalid intents");
      }
      const intents = Object.fromEntries(
        Object.entries(value.intents).filter(
          (entry): entry is [string, DirectSendIntent] =>
            isDirectSendIntent(entry[1]),
        ),
      );
      return {intents, schemaVersion: 1};
    } catch {
      await this.storage.removeItem(PersistentDirectSendIntentStore.storageKey);
      return null;
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async writeEnvelope(
    envelope: DirectSendIntentEnvelope,
  ): Promise<void> {
    await this.storage.setItem(
      PersistentDirectSendIntentStore.storageKey,
      JSON.stringify(envelope),
    );
  }
}

function isDirectSendIntent(value: unknown): value is DirectSendIntent {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    value.kind === "text" &&
    (value.phase === "preparing" ||
      value.phase === "sending" ||
      value.phase === "uncertain") &&
    nonEmptyString(value.accountId) &&
    nonEmptyString(value.clientRequestId) &&
    nonEmptyString(value.createdAt) &&
    nonEmptyString(value.idempotencyKey) &&
    nonEmptyString(value.peerMemberId) &&
    nonEmptyString(value.serverId) &&
    typeof value.text === "string" &&
    nonEmptyString(value.updatedAt) &&
    Array.isArray(value.mentionedUserIds) &&
    value.mentionedUserIds.every(nonEmptyString) &&
    (value.directConversationId === undefined ||
      nonEmptyString(value.directConversationId))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
