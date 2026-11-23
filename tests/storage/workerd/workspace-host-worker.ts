// WorkspaceHost store prototype on Durable Object SQL (workspace-host-split.md
// §3.1, §4.1). One SQLite-backed object per (workspace, store): each store keeps
// its own published migration chain and `schema_migrations` ledger, so they
// cannot share one object's database until the §4.1 merge migration exists.
// The object migrates through the runtime-neutral ledger runner and runs the
// unchanged domain stores over `durableObjectSqlDatabase`. Bundled with esbuild
// (nodejs_compat) and driven through Miniflare by
// tests/storage/workspace-host-workerd.test.ts. Test-only: no WorkspaceHost
// assembly, alarm wake port, sandbox endpoint or recovery timers yet.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import { ledger, migrate, scenario, schema, type WorkspaceHostStore } from "./workspace-host-domain.js";

interface Env {
  readonly STORE: {
    idFromName(name: string): unknown;
    get(id: unknown): WorkspaceHostStoreObject;
  };
}
type Method = "migrate" | "ledger" | "schema" | "scenario" | "tamperLedger";

const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class WorkspaceHostStoreObject extends DurableObject<Env> {
  get #database() {
    return durableObjectSqlDatabase(this.ctx.storage as unknown as DurableObjectStorage);
  }
  async call(method: Method, store: WorkspaceHostStore, limit?: number): Promise<unknown> {
    const database = this.#database;
    switch (method) {
      case "migrate":
        return migrate(database, store, limit);
      case "ledger":
        return ledger(database);
      case "schema":
        return schema(database);
      case "scenario":
        migrate(database, store);
        return scenario(database, store);
      case "tamperLedger":
        return Number(database.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run("0".repeat(64)).changes);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { object, method, store, limit } = (await request.json()) as { object: string; method: Method; store: WorkspaceHostStore; limit?: number };
    try {
      const stub = env.STORE.get(env.STORE.idFromName(object));
      return Response.json({ ok: true, value: await stub.call(method, store, limit) });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
