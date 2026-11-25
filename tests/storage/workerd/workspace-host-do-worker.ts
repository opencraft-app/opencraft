// The production deployment entry (apps/headless-server/src/cloudflare/worker.ts)
// with the WorkspaceHost object over an in-isolate container double and a
// credential lease double, for tests/storage/workspace-host-do-workerd.test.ts.
// The subclass replaces only what the platform or another owner supplies
// (`ctx.container`, the AccountCore lease port) and adds routes under
// `/__test/`; every other path reaches the production object unchanged.
// `/__owner/<workspace>/<operation>` plays an owner-to-owner caller of the
// object's internal operations (the client session or placement owner that is
// not assembled yet).
import entry, { ClientDO as ProductionClient, InstallationCore as ProductionInstallation, WorkspaceHost } from "../../../apps/headless-server/src/cloudflare/worker.ts";
import type {
  DeploymentRoutingEnv,
  WorkspaceHostEnv,
  WorkspaceHostState,
} from "../../../apps/headless-server/src/cloudflare/bindings.ts";
import type { WorkspaceCredentialLeases } from "../../../apps/headless-server/src/cloudflare/workspace-host.ts";
import {
  WORKSPACE_HOST_HEADER,
  WORKSPACE_HOST_OBJECT_PREFIX,
  WORKSPACE_TERMINAL_OPERATION,
  workspaceHostObjectName,
} from "../../../apps/headless-server/src/workspace-host-routes.ts";
import { MIGRATION_FAMILY_LEDGER_TABLE, sqlMigrationFamilyRows } from "@opencraft/sql/families";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { TestAccountCore } from "./account-core-do-worker.ts";
import { containerDouble } from "./workspace-container-double.ts";
import { INSTALLATION_CORE_OBJECT } from "../../../apps/headless-server/src/cloudflare/installation-core.ts";
import { WORKSPACE_THREAD_RESOURCES_PATH } from "../../../apps/headless-server/src/cloudflare/terminal-authority.ts";
import {
  CLIENT_ADMISSION_PATH,
  parseClientAttachment,
} from "../../../apps/headless-server/src/cloudflare/client-attachment.ts";
import {
  THREAD_PLACEMENT_LOOKUP_PATH,
  THREAD_PLACEMENT_PUBLISH_PATH,
  parseThreadPlacementKey,
} from "../../../apps/headless-server/src/cloudflare/thread-placement.ts";

export { TestAccountCore };
export { WorkspaceCodexModelEgress } from "../../../apps/headless-server/src/cloudflare/deployment-worker.mjs";

/** Miniflare does not naturally hibernate. Replace only JS state on the live socket. */
export class ClientDO {
  private client: ProductionClient;
  constructor(...[ctx, env]: ConstructorParameters<typeof ProductionClient>) {
    this.client = new ProductionClient(ctx, env);
    this.reconstruct = () => { this.client = new ProductionClient(ctx, env); };
  }
  private readonly reconstruct: () => void;
  fetch(request: Request) { return this.client.fetch(request); }
  webSocketMessage(...[socket, message]: Parameters<ProductionClient["webSocketMessage"]>) {
    if (message === "__test_drop_idle_client_memory") {
      this.reconstruct();
      socket.send(JSON.stringify({ type: "test/hibernated" }));
      return;
    }
    return this.client.webSocketMessage(socket, message);
  }
  webSocketClose(...args: Parameters<ProductionClient["webSocketClose"]>) { this.client.webSocketClose(...args); }
  webSocketError(...args: Parameters<ProductionClient["webSocketError"]>) { this.client.webSocketError(...args); }
}

export class InstallationCore extends ProductionInstallation {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__installation/codex-server") {
      return Response.json(this.services().codexServerId);
    }
    if (pathname === "/__installation/resource-state") {
      const { core } = this.services();
      return Response.json({
        rows: await core.call.openConversationResources({ owners: ["terminal"] }),
        alarm: await this.ctx.storage.getAlarm(),
      });
    }
    if (pathname === "/__installation/evict") {
      this.ctx.abort("evicted for test");
      return new Response(null, { status: 204 });
    }
    if (pathname === "/__installation/resource-observation") {
      this.ctx.storage.kv.put("test:resource-observation-unavailable", await request.json());
      await this.ctx.storage.sync();
      return new Response(null, { status: 204 });
    }
    if (pathname === WORKSPACE_THREAD_RESOURCES_PATH && this.ctx.storage.kv.get("test:resource-observation-unavailable") === true)
      return new Response(null, { status: 503 });
    if (pathname === "/__installation/share-default-space") {
      const body = (await request.json()) as { owner?: unknown; member?: unknown };
      const { admission, spaces } = this.services();
      const login = (value: unknown) => {
        const attachment = parseClientAttachment(value);
        return attachment && admission.humanAccounts?.byDigest(attachment.loginDigest)?.context;
      };
      if (!spaces || !login(body.owner) || !login(body.member)) return new Response(null, { status: 400 });
      const invitation = await spaces.serverSpaces.command(login(body.owner)!, { action: "invite", spaceId: "myself" });
      await spaces.serverSpaces.command(login(body.member)!, { action: "join", code: invitation.code });
      return new Response(null, { status: 204 });
    }
    if (pathname !== "/__installation/assign") return super.fetch(request);
    const query = (await request.json()) as { thread?: unknown; attachment?: unknown; assign?: boolean; private?: boolean };
    const thread = parseThreadPlacementKey(query.thread);
    const attachment = parseClientAttachment(query.attachment);
    const { admission, spaces } = this.services();
    const login = attachment && admission.humanAccounts?.byDigest(attachment.loginDigest);
    if (!thread || !login || !spaces) return new Response(null, { status: 400 });
    await spaces.serverSpaces.bootstrap(login.context.actorId);
    spaces.threadAccess.created(thread.serverId, thread.threadId, login.context, query.private ? "private" : "shared");
    if (query.assign) await spaces.serverSpaces.assign(login.context, thread.serverId, thread.threadId, "myself");
    return new Response(null, { status: 204 });
  }
}

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
  #terminalEventUpgrades = 0;
  constructor(ctx: WorkspaceHostState, private readonly env: WorkspaceHostEnv) {
    // A new object instance: exec handles of the previous one are gone, as on the platform.
    containerDouble(objectId(ctx)).resetDurableObject();
    super(ctx, env);
  }
  protected override container() {
    return containerDouble(objectId(this.ctx));
  }
  protected override credentialLeases() {
    return this.env.OPENCRAFT_WORKSPACE_CODEX_TURNS === "true"
      ? super.credentialLeases() : leaseDouble(objectId(this.ctx));
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === WORKSPACE_HOST_OBJECT_PREFIX + WORKSPACE_TERMINAL_OPERATION &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket") this.#terminalEventUpgrades++;
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
              ...(start.containerSnapshot ? { restored: true } : {}),
            })),
            destroys: double.destroys,
            timeouts: double.timeouts,
            modelIntercepts: double.modelIntercepts,
            inputs: double.inputs,
            served: double.served,
          },
          families: sqlMigrationFamilyRows(database, MIGRATION_FAMILY_LEDGER_TABLE),
          bridgeCursor: services ? Number(database.prepare("SELECT value FROM bridge_inbox_meta WHERE key='ack'").get()?.value) : null,
          bridgeArchive: services ? database.prepare("SELECT seq,payload FROM bridge_inbox_archive ORDER BY seq").all() : [],
          tables: database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
            )
            .all()
            .map((row) => String(row.name)),
          alarm: await storage.getAlarm(),
          terminalEventUpgrades: this.#terminalEventUpgrades,
          leases: leaseCalls.get(objectId(this.ctx)) ?? [],
          unsettled: services?.leases.unsettledThreads() ?? null,
          recovery: thread && services ? services.recovery.snapshot(thread) : null,
        });
      }
      case "/__test/crash":
        double.crash(Number(url.searchParams.get("code") ?? 137));
        if (url.searchParams.get("evict") === "true") this.ctx.abort("evicted before processing container exit");
        return Response.json(null);
      case "/__test/reject-next-snapshot":
        double.rejectNextSnapshot = true;
        return Response.json(null);
      case "/__test/publish-bridge-title":
        double.publishBridgeTitle(url.searchParams.get("title") ?? "");
        return Response.json(null);
      case "/__test/terminal-cleanup":
        double.terminalCleanupUnavailable = url.searchParams.get("unavailable") === "true";
        return Response.json(null);
      case "/__test/oversized-next-codex-page":
        double.oversizedNextCodexPage = true;
        return Response.json(null);
      case "/__test/restart-agent":
        double.restartAgent();
        return Response.json(null);
      case "/__test/complete":
        return Response.json(double.completeTurns());
      case "/__test/pause-codex-starts":
        double.pauseCodexStarts();
        return Response.json(null);
      case "/__test/release-codex-starts":
        double.releaseCodexStarts();
        return Response.json(null);
      case "/__test/drop-codex-start-reply":
        double.dropNextCodexStartReply = true;
        return Response.json(null);
      case "/__test/hold-codex-turn-reply":
        double.holdNextCodexTurnReply = true;
        return Response.json(null);
      case "/__test/reject-codex-initialize":
        double.rejectNextCodexInitialize = true;
        return Response.json(null);
      case "/__test/model-catalog":
        return double.modelRequest("GET", "models");
      case "/__test/model-response":
        return double.modelRequest("POST", "responses");
      case "/__test/pause-codex-reads":
        double.pauseCodexReads();
        return Response.json(null);
      case "/__test/release-codex-reads":
        double.releaseCodexReads();
        return Response.json(null);
      case "/__test/tamper":
        storage.sql.exec("UPDATE schema_family_migrations SET checksum=? WHERE family='host-recovery'", "0".repeat(64));
        return Response.json(null);
      case "/__test/legacy-invalid-machine":
        storage.kv.put("workspace-host/identity", JSON.stringify({ workspace: url.searchParams.get("workspace"), machine: "legacy-host-name" }));
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
    if (url.pathname === "/__test/account/op" && env.ACCOUNT_CORE)
      return env.ACCOUNT_CORE.get(env.ACCOUNT_CORE.idFromName("account")).fetch(request);
    if (scope === "__installation") {
      const target = workspace === "admission" ? CLIENT_ADMISSION_PATH
        : workspace === "lookup" ? THREAD_PLACEMENT_LOOKUP_PATH
          : workspace === "publish" ? THREAD_PLACEMENT_PUBLISH_PATH
            : url.pathname;
      url.pathname = target;
      const installation = env.INSTALLATION_CORE.get(env.INSTALLATION_CORE.idFromName(INSTALLATION_CORE_OBJECT));
      return installation.fetch(new Request(url, request));
    }
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
