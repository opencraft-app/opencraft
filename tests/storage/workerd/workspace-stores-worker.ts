// WorkspaceHost-side stores (gateway-split.md §4.2, storage row) on Durable
// Object SQL: one SQLite-backed object per (workspace, store), migrated through
// the runtime-neutral ledger runner, running the unchanged thread directory and
// employee Git vault domains over `durableObjectSqlDatabase`. Bundled with
// esbuild (nodejs_compat supplies node:crypto for the test cipher and digest)
// and driven through Miniflare by tests/storage/workspace-stores-workerd.test.ts.
// Test-only: no WorkspaceHost assembly declares these objects yet.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import {
  ledger,
  migrate,
  scenario,
  schema,
  vaultRead,
  vaultWrite,
  WORKSPACE_SCENARIOS,
  type WorkspaceScenario,
  type WorkspaceStore,
} from "./workspace-stores-domain.js";

interface Env {
  readonly STORE: {
    idFromName(name: string): unknown;
    get(id: unknown): WorkspaceStoreObject;
  };
}
type Method = "migrate" | "ledger" | "schema" | "scenario" | "vaultWrite" | "vaultRead";

const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class WorkspaceStoreObject extends DurableObject<Env> {
  async call(method: Method, target: string): Promise<unknown> {
    const database = durableObjectSqlDatabase(this.ctx.storage as unknown as DurableObjectStorage);
    switch (method) {
      case "migrate":
        return migrate(database, target as WorkspaceStore);
      case "ledger":
        return ledger(database);
      case "schema":
        return schema(database);
      case "scenario":
        migrate(database, WORKSPACE_SCENARIOS[target as WorkspaceScenario]);
        return scenario(database, target as WorkspaceScenario);
      case "vaultWrite":
        migrate(database, "employee-git-vault-store");
        return vaultWrite(database);
      case "vaultRead":
        migrate(database, "employee-git-vault-store");
        return vaultRead(database);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { object, method, target } = (await request.json()) as { object: string; method: Method; target: string };
    try {
      const stub = env.STORE.get(env.STORE.idFromName(object));
      return Response.json({ ok: true, value: await stub.call(method, target) });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
