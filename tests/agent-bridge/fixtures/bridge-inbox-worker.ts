import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { applySqlMigrations, hashSqlMigrations } from "@opencraft/sql/migrations";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import {
  BridgeInboxRefusal, createBridgeInboxStore, createWorkspaceBridgeInboxStore, WORKSPACE_BRIDGE_INBOX_MIGRATIONS,
} from "../../../apps/agent-bridge-host/src/inbox-store.js";
import { migrations } from "../../../apps/agent-bridge-host/src/migrations.js";
import type { OutboxEvent } from "../../../apps/agent-bridge-host/src/types.js";

interface Env {
  readonly INBOX: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const published = hashSqlMigrations(migrations, digest);
const workspaceMigrations = hashSqlMigrations(WORKSPACE_BRIDGE_INBOX_MIGRATIONS, digest);
const route = '["server","thread"]';
const first = { seq: 1, route, generation: "g1", payload: { method: "first" } };
const fence = { outboxId: "1".repeat(32), acknowledged: 0, high: 2 };
const largeResult = () => "界".repeat(6 * 1024 * 1024);
const large = () => ({
  ...first, seq: 2, payload: { kind: "canonical", event: {
    kind: "item.completed", turnId: "public-turn", item: {
      nativeKey: "native-item", itemId: "public-item",
      shape: { kind: "appServerItem", item: { type: "imageGeneration", status: "completed", result: largeResult() } },
    },
  } },
});

export class TestBridgeInbox extends DurableObject<Env> {
  #store?: ReturnType<typeof createBridgeInboxStore>;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/evict")) {
      this.ctx.abort("test eviction");
      return new Response();
    }
    if (path.startsWith("/workspace/")) {
      const database = durableObjectSqlDatabase(this.ctx.storage as unknown as DurableObjectStorage);
      if (path === "/workspace/v3") {
        applySqlMigrations(database, workspaceMigrations.slice(0, 3));
        return Response.json(createBridgeInboxStore(database, "workspace").apply([first], fence).cursor);
      }
      applySqlMigrations(database, workspaceMigrations);
      const store = createWorkspaceBridgeInboxStore(database);
      store.adoptPlacement("container-1");
      if (path === "/workspace/select-approvals") {
        const text = "界".repeat(700 * 1024);
        const approval = (seq: number, interactionId: string) => ({
          ...first, seq, payload: { method: "interaction/request", params: { interactionId, text } },
        });
        store.apply("container-1", undefined, 0, [
          { ...first, payload: { event: { kind: "turn.started", nativeTurnId: "native", turnId: "public" } } },
          approval(2, "settled"),
          approval(3, "pending"),
          approval(4, "later"),
        ], { ...fence, high: 4 });
        // Missing data for a settled request must have no effect on a scoped read.
        const removed = database.prepare("DELETE FROM bridge_inbox_chunks WHERE placement='' AND seq=2").run().changes;
        const history = store.readIdentities(route, 0, 4);
        const pendingIds = ["pending", "later"];
        const selected = store.readPendingInteractions(route, 0, 4, pendingIds);
        const next = store.readPendingInteractions(route, selected[0]!.seq, 4, pendingIds);
        return Response.json({
          removed,
          history,
          selected: selected.map(row => row.seq),
          next: next.map(row => row.seq),
          pendingMatches: selected[0]?.id === "pending" && selected[0].params.text === text,
          laterMatches: next[0]?.id === "later" && next[0].params.text === text,
          cursor: store.cursor(),
        });
      }
      if (path === "/workspace/apply")
        return Response.json(store.apply("container-1", undefined, 1, [large()], { ...fence, acknowledged: 1 }).cursor);
      if (path === "/workspace/restore") {
        store.apply("container-2", "snapshot", 1, [], { ...fence, acknowledged: 1, high: 1 });
        return Response.json({
          cursor: store.cursor(),
          archived: database.prepare("SELECT count(*) AS count FROM bridge_inbox_chunks WHERE placement=?").get("container-1")!.count,
          live: database.prepare("SELECT count(*) AS count FROM bridge_inbox_chunks WHERE placement=''").get()!.count,
        });
      }
      const entries = store.read();
      const event = store.read(1)[0]!;
      return Response.json({
        cursor: store.cursor(),
        entries: entries.map(row => row.seq),
        matches: (event.payload as ReturnType<typeof large>["payload"]).event.item.shape.item.result === largeResult(),
        identities: store.readIdentities(route, 0, 2),
      });
    }
    if (!this.#store) {
      const database = durableObjectSqlDatabase(this.ctx.storage as unknown as DurableObjectStorage);
      applySqlMigrations(database, published);
      this.#store = createBridgeInboxStore(database);
    }
    if (path === "/apply") {
      try {
        return Response.json(this.#store.apply((await request.json()) as OutboxEvent[]));
      } catch (error) {
        if (!(error instanceof BridgeInboxRefusal)) throw error;
        return Response.json({ error: error.message }, { status: 409 });
      }
    }
    return Response.json({ cursor: this.#store.cursor(), rows: this.#store.read() });
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const namespace = new URL(request.url).pathname.startsWith("/workspace/") ? "workspace" : "gateway";
    return env.INBOX.get(env.INBOX.idFromName(namespace)).fetch(request);
  },
};
