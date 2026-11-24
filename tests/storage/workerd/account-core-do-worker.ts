// The production deployment assembly (apps/headless-server/src/cloudflare/worker.ts)
// with test-only controls on both objects, for
// tests/storage/account-core-do-workerd.test.ts and the real-Cloudflare
// rehearsal. The subclasses add routes under `/__test/` and change nothing
// else: every other request reaches the production entry and objects unchanged.
import entry, { AccountCore } from "../../../apps/headless-server/src/cloudflare/worker.ts";
import type {
  AccountCoreEnv,
  AccountCoreState,
  DeploymentEnv,
} from "../../../apps/headless-server/src/cloudflare/bindings.ts";
import { runAccountOperation, type AccountOperation } from "./account-core-operations.ts";
import {
  fixtureRenewalExecutor,
  runAccountPoolOperation,
  type AccountPoolOperation,
  type FixtureRenewalExecutor,
} from "./account-pool-operations.ts";

export { TestInstallationCore } from "./installation-core-do-worker.ts";

export class TestAccountCore extends AccountCore {
  // The maintenance executor does not exist yet: its binding is the fixture (per object instance).
  readonly #executor: FixtureRenewalExecutor;

  constructor(ctx: AccountCoreState, env: AccountCoreEnv) {
    const executor = fixtureRenewalExecutor();
    super(ctx, { ...env, ACCOUNT_MAINTENANCE: executor });
    this.#executor = executor;
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__test/account/")) return super.fetch(request);
    switch (path) {
      // The account pool's operations, as the Node side calls them on its own pool core.
      case "/__test/account/pool":
        return Response.json(
          await runAccountPoolOperation(this.services().pool, (await request.json()) as AccountPoolOperation),
        );
      // Accounts the maintenance executor was asked to renew by this object instance.
      case "/__test/account/renewals":
        return Response.json(this.#executor.calls);
      // Raw SQL against the object's database: shapes earlier or damaged histories for open tests.
      case "/__test/account/sql": {
        const storage = this.ctx.storage as unknown as {
          sql: { exec(query: string): { toArray(): Record<string, unknown>[] } };
        };
        const { statements } = (await request.json()) as { statements: string[] };
        return Response.json(statements.map((statement) => storage.sql.exec(statement).toArray()));
      }
      // Drops the object's memory without any event, as platform eviction does.
      case "/__test/account/evict":
        this.ctx.abort("evicted for test");
        return Response.json(null);
      // The account module's storage operations, as the Node side calls them.
      case "/__test/account/op":
        return Response.json(
          await runAccountOperation(this.services().account, (await request.json()) as AccountOperation),
        );
      // Every value the object stores (its KV entries and the policy tables), for plaintext checks.
      case "/__test/account/storage": {
        const storage = this.ctx.storage as unknown as {
          kv: { list(): Iterable<[string, unknown]> };
          sql: { exec(query: string): { toArray(): Record<string, unknown>[] } };
        };
        return Response.json({
          kv: [...storage.kv.list()].map(([key, value]) => [key, typeof value === "string" ? value : String(value)]),
          sql: [
            "model_usage_policy",
            "model_usage_audit",
            "schema_migrations",
            "schema_ledgers",
            "pool_accounts",
            "pool_quota",
            "pool_affinity",
            "account_credential_records",
          ].map((table) => storage.sql.exec(`SELECT * FROM ${table}`).toArray()),
        });
      }
    }
    return Response.json({ error: "missing" }, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: DeploymentEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__test/account/"))
      return env.ACCOUNT_CORE.get(env.ACCOUNT_CORE.idFromName("account")).fetch(request);
    if (path.startsWith("/__test/"))
      return env.INSTALLATION_CORE.get(env.INSTALLATION_CORE.idFromName("installation")).fetch(request);
    return entry.fetch(request, env);
  },
};
