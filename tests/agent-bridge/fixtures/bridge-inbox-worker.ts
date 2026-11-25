import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { applySqlMigrations, hashSqlMigrations } from "@opencraft/sql/migrations";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { BridgeInboxRefusal, createBridgeInboxStore } from "../../../apps/agent-bridge-host/src/inbox-store.js";
import { migrations } from "../../../apps/agent-bridge-host/src/migrations.js";
import type { OutboxEvent } from "../../../apps/agent-bridge-host/src/types.js";

interface Env {
  readonly INBOX: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

const published = hashSqlMigrations(migrations, (text) => createHash("sha256").update(text).digest("hex"));

export class TestBridgeInbox extends DurableObject<Env> {
  #store?: ReturnType<typeof createBridgeInboxStore>;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/evict") {
      this.ctx.abort("test eviction");
      return new Response();
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
    return env.INBOX.get(env.INBOX.idFromName("gateway")).fetch(request);
  },
};
