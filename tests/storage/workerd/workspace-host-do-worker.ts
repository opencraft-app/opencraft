// The production deployment entry (apps/headless-server/src/cloudflare/worker.ts)
// with the WorkspaceHost object over an in-isolate container double and a
// credential lease double, for tests/storage/workspace-host-do-workerd.test.ts.
// The subclass replaces only what the platform or another owner supplies
// (`ctx.container`, the AccountCore lease port) and adds routes under
// `/__test/`; every other path reaches the production object unchanged.
// `/__owner/<workspace>/<operation>` plays an owner-to-owner caller of the
// object's internal operations (the client session or placement owner that is
// not assembled yet).
import entry, { InstallationCore, WorkspaceHost } from "../../../apps/headless-server/src/cloudflare/worker.ts";
import type {
  DeploymentRoutingEnv,
  WorkspaceHostEnv,
  WorkspaceHostState,
} from "../../../apps/headless-server/src/cloudflare/bindings.ts";
import type { WorkspaceCredentialLeases } from "../../../apps/headless-server/src/cloudflare/workspace-host.ts";
import {
  WORKSPACE_HOST_HEADER,
  WORKSPACE_HOST_OBJECT_PREFIX,
  workspaceHostObjectName,
} from "../../../apps/headless-server/src/workspace-host-routes.ts";
import { MIGRATION_FAMILY_LEDGER_TABLE, sqlMigrationFamilyRows } from "@opencraft/sql/families";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { containerDouble } from "./workspace-container-double.ts";

export { InstallationCore };

/** What the lease double was asked, per object; module memory, like the container double. */
const leaseCalls = new Map<string, unknown[]>();
function leaseDouble(objectId: string): WorkspaceCredentialLeases {
  const calls = leaseCalls.get(objectId) ?? [];
  leaseCalls.set(objectId, calls);
  let next = 0;
  return {
    async grant(holder, ttlMs) {
      const id = `lease-${objectId.slice(0, 6)}-${++next}-${crypto.randomUUID().slice(0, 4)}`;
      calls.push({ grant: holder, ttlMs });
      return { id, token: `oc_lease_${crypto.randomUUID()}`, expiresAt: Date.now() + ttlMs };
    },
    async renew(id, ttlMs) {
      calls.push({ renew: id });
      return { id, expiresAt: Date.now() + ttlMs };
    },
    async revokeHolder(match) {
      calls.push({ revokeHolder: match });
      return 0;
    },
  };
}

const objectId = (ctx: WorkspaceHostState) => (ctx as unknown as { id: { toString(): string } }).id.toString();

export class TestWorkspaceHost extends WorkspaceHost {
  constructor(ctx: WorkspaceHostState, env: WorkspaceHostEnv) {
    // A new object instance: exec handles of the previous one are gone, as on the platform.
    containerDouble(objectId(ctx)).resetDurableObject();
    super(ctx, env);
  }
  protected override container() {
    return containerDouble(objectId(this.ctx));
  }
  protected override credentialLeases() {
    return leaseDouble(objectId(this.ctx));
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__test/")) return super.fetch(request);
    const double = containerDouble(objectId(this.ctx));
    const storage = this.ctx.storage;
    switch (url.pathname) {
      // Drops the object's memory without any event, as platform eviction does.
      case "/__test/evict":
        this.ctx.abort("evicted for test");
        return Response.json(null);
      case "/__test/state": {
        const database = durableObjectSqlDatabase(storage);
        const services = (() => {
          try {
            return this.services();
          } catch {
            return undefined;
          }
        })();
        const thread = url.searchParams.get("threadId");
        return Response.json({
          container: {
            running: double.running,
            agent: double.agent ?? null,
            starts: double.starts.map((start) => ({
              instance: start.instance,
              enableInternet: start.enableInternet,
              labels: Object.keys(start.labels ?? {}),
              env: start.env,
            })),
            destroys: double.destroys,
            timeouts: double.timeouts,
            inputs: double.inputs,
            served: double.served,
          },
          families: sqlMigrationFamilyRows(database, MIGRATION_FAMILY_LEDGER_TABLE),
          tables: database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
            )
            .all()
            .map((row) => String(row.name)),
          alarm: await storage.getAlarm(),
          leases: leaseCalls.get(objectId(this.ctx)) ?? [],
          unsettled: services?.leases.unsettledThreads() ?? null,
          recovery: thread && services ? services.recovery.snapshot(thread) : null,
        });
      }
      case "/__test/crash":
        double.crash(Number(url.searchParams.get("code") ?? 137));
        return Response.json(null);
      case "/__test/restart-agent":
        double.restartAgent();
        return Response.json(null);
      case "/__test/complete":
        return Response.json(double.completeTurns());
      case "/__test/tamper":
        storage.sql.exec("UPDATE schema_family_migrations SET checksum=? WHERE family='host-recovery'", "0".repeat(64));
        return Response.json(null);
    }
    return Response.json({ error: "missing" }, { status: 404 });
  }
}

type Env = DeploymentRoutingEnv & WorkspaceHostEnv;
const object = (env: Env, workspace: string) =>
  env.WORKSPACE_HOST.get(env.WORKSPACE_HOST.idFromName(workspaceHostObjectName(workspace)));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, scope, workspace, ...rest] = url.pathname.split("/");
    if (scope === "__test" && workspace) {
      const target = new URL(`/__test/${rest.join("/")}${url.search}`, url);
      return object(env, workspace).fetch(new Request(target, request));
    }
    if (scope === "__owner" && workspace) {
      const target = new URL(`${WORKSPACE_HOST_OBJECT_PREFIX}${rest.join("/")}${url.search}`, url);
      const headers = new Headers(request.headers);
      headers.set(WORKSPACE_HOST_HEADER, workspace);
      return object(env, workspace).fetch(
        new Request(target, {
          method: request.method,
          headers,
          ...(request.method === "GET" ? {} : { body: await request.text() }),
        }),
      );
    }
    return entry.fetch(request, env);
  },
};
