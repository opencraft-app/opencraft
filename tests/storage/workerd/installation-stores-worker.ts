// InstallationCore stores (gateway-split.md §4.2 storage row) on Durable Object
// SQL: one SQLite-backed object migrates the Server core composition with the
// runtime-neutral ledger runner and runs the unchanged access-control domain
// modules over `durableObjectSqlDatabase`. Bundled with esbuild and driven
// through Miniflare by tests/storage/installation-stores-workerd.test.ts.
// nodejs_compat is only for the migration runner's SHA-256 (the owner's
// primitive); the domain modules themselves bundle without node:* modules.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import { installationScenario, migrateInstallation, primitives } from "./installation-stores-domain.js";

interface Env {
  readonly STORES: {
    idFromName(name: string): unknown;
    get(id: unknown): InstallationStoresObject;
  };
}
type Method = "scenario" | "primitives";

const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class InstallationStoresObject extends DurableObject<Env> {
  async call(method: Method): Promise<unknown> {
    if (method === "primitives") return primitives();
    const database = durableObjectSqlDatabase(this.ctx.storage as unknown as DurableObjectStorage);
    const handle = migrateInstallation(database, (name) => name.startsWith("_cf_"));
    return installationScenario(handle.database, handle);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { object, method } = (await request.json()) as { object: string; method: Method };
    try {
      const stub = env.STORES.get(env.STORES.idFromName(object));
      return Response.json({ ok: true, value: await stub.call(method) });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
