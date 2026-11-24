// Deployment-level stores (gateway-split.md §5.1 G3) on Durable Object SQL: one
// SQLite-backed object per (deployment, store), migrated through the
// runtime-neutral ledger runner, running the unchanged runtime-neutral stores
// over `durableObjectSqlDatabase`. Bundled with esbuild (nodejs_compat supplies
// node:crypto for the test's SHA-256 primitive) and driven through Miniflare by
// tests/storage/deployment-stores-workerd.test.ts. Test-only: no Cloudflare
// assembly declares these services yet.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import { ledger, migrate, scenario, schema, type DeploymentStore } from "./deployment-stores-domain.js";

interface Env {
  readonly STORE: {
    idFromName(name: string): unknown;
    get(id: unknown): DeploymentStoreObject;
  };
}
type Method = "migrate" | "ledger" | "schema" | "scenario" | "sql" | "tamperLedger";

const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class DeploymentStoreObject extends DurableObject<Env> {
  call(method: Method, store: DeploymentStore, limit?: number, text?: string): unknown {
    const database = durableObjectSqlDatabase(this.ctx.storage as unknown as DurableObjectStorage);
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
      // Test probe: one statement without parameters.
      case "sql": {
        const statement = database.prepare(text!);
        return /^\s*SELECT/i.test(text!) ? statement.all() : Number(statement.run().changes);
      }
      case "tamperLedger":
        return Number(
          database.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run("0".repeat(64)).changes,
        );
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { object, method, store, limit, text } = (await request.json()) as {
      object: string;
      method: Method;
      store: DeploymentStore;
      limit?: number;
      text?: string;
    };
    try {
      const stub = env.STORE.get(env.STORE.idFromName(object));
      return Response.json({ ok: true, value: await stub.call(method, store, limit, text) });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
