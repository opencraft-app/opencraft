import type {DirectSendIntent} from "../application/app-store";
import {PersistentDirectSendIntentStore} from "./persistent-direct-send-intent-store";

const intent: DirectSendIntent = {
  accountId: "account-1",
  clientRequestId: "message-request-1",
  createdAt: "2026-08-04T08:00:00.000Z",
  idempotencyKey: "conversation-request-1",
  kind: "text",
  mentionedUserIds: [],
  peerMemberId: "member-2",
  phase: "preparing",
  schemaVersion: 1,
  serverId: "server-1",
  text: "继续上次发送",
  updatedAt: "2026-08-04T08:00:00.000Z",
};

class MemoryStorage {
  public readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("PersistentDirectSendIntentStore", () => {
  it("survives a new store instance and preserves both stable request IDs", async () => {
    const storage = new MemoryStorage();
    const first = new PersistentDirectSendIntentStore(storage);
    await first.save("account-1:server-1:member-2", intent);

    const restored = new PersistentDirectSendIntentStore(storage);

    await expect(
      restored.load("account-1:server-1:member-2"),
    ).resolves.toEqual(intent);
  });

  it("drops malformed persisted data instead of blocking chat startup", async () => {
    const storage = new MemoryStorage();
    storage.setItem("raft.client.direct-send-intents.v1", "not-json");
    const store = new PersistentDirectSendIntentStore(storage);

    await expect(store.load("account-1:server-1:member-2")).resolves.toBeNull();
    expect(storage.values.has("raft.client.direct-send-intents.v1")).toBe(false);
  });

  it("removes only the completed member-pair intent", async () => {
    const storage = new MemoryStorage();
    const store = new PersistentDirectSendIntentStore(storage);
    await store.save("account-1:server-1:member-2", intent);
    await store.save("account-1:server-1:member-3", {
      ...intent,
      peerMemberId: "member-3",
    });

    await store.remove("account-1:server-1:member-2");

    await expect(store.load("account-1:server-1:member-2")).resolves.toBeNull();
    await expect(store.load("account-1:server-1:member-3")).resolves.toMatchObject({
      peerMemberId: "member-3",
    });
  });
});
