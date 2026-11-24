// Plugin and extension stores (storage-ports.md §3.7) on Durable Object SQL:
// one SQLite-backed object per (deployment, store), migrated through the
// runtime-neutral ledger runner, running the unchanged runtime-neutral store
// modules over `durableObjectSqlDatabase`. Bundled with esbuild (nodejs_compat
// supplies node:crypto for the test's SHA-256 primitive) and driven through
// Miniflare by tests/storage/extension-stores-workerd.test.ts. Test-only: no
// Cloudflare assembly declares these services yet.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import { ledger, migrate, readBack, scenario, schema, seed, type ExtensionStore } from "./extension-stores-domain.js";

interface Env {
  readonly STORE: {
    idFromName(name: string): unknown;
    get(id: unknown): ExtensionStoreObject;
  };
}
type Method = "migrate" | "ledger" | "schema" | "scenario" | "seed" | "readBack";

const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class ExtensionStoreObject extends DurableObject<Env> {
  call(method: Method, store: ExtensionStore): unknown {
    const database = durableObjectSqlDatabase(this.ctx.storage as unknown as DurableObjectStorage);
    switch (method) {
      case "migrate":
        return migrate(database, store);
      case "ledger":
        return ledger(database);
      case "schema":
        return schema(database);
      case "scenario":
        migrate(database, store);
        return scenario(database, store);
      case "seed":
        migrate(database, store);
        return seed(database, store);
      case "readBack":
        return readBack(database, store);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { object, method, store } = (await request.json()) as {
      object: string;
      method: Method;
      store: ExtensionStore;
    };
    try {
      const stub = env.STORE.get(env.STORE.idFromName(object));
      return Response.json({ ok: true, value: await stub.call(method, store) });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
