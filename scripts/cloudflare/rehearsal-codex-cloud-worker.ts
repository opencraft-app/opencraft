import production, {
  ClientDO as ProductionClient,
  WorkspaceHost as ProductionWorkspaceHost,
} from "../../apps/headless-server/src/cloudflare/deployment-worker.mjs";
import {
  WORKSPACE_CODEX_READ_OPERATION,
  WORKSPACE_HOST_OBJECT_PREFIX,
  workspaceHostObjectName,
} from "../../apps/headless-server/src/workspace-host-routes.ts";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { WorkerInstance } from "../../tests/cloudflare/worker-runtime.ts";
import { bufferedSocket } from "../../tests/cloudflare/worker-wire.ts";
import { proveCodex, type BrowserIdleProof } from "./rehearsal-codex-proof.ts";
import { rehearsalGuard } from "./rehearsal-guard.ts";

export {
  AccountCore,
  InstallationCore,
  WorkspaceCodexModelEgress,
} from "../../apps/headless-server/src/cloudflare/deployment-worker.mjs";

const guarded = rehearsalGuard(production);
type Env = Parameters<typeof production.fetch>[1] & {
  OPENCRAFT_SETUP_TOKEN: string;
  REHEARSAL_ORIGIN: string;
  REHEARSAL_BRIDGE?: string;
  REHEARSAL_NATIVE_TOOLS?: string;
  REHEARSAL_PROVIDER_DIGEST?: string;
  REHEARSAL_CRASH?: string;
};
const CRASH_PATH = "/__opencraft_rehearsal/crash-container";

export class ClientDO extends ProductionClient {
  readonly #instance = crypto.randomUUID();

  override webSocketMessage(...[socket, message]: Parameters<ProductionClient["webSocketMessage"]>) {
    if (message === "__opencraft_rehearsal_client_instance") {
      socket.send(JSON.stringify({ type: "rehearsal/client-instance", result: this.#instance }));
      return;
    }
    return super.webSocketMessage(socket, message);
  }
}

/** The verifier can stop only its own disposable binding. The public router never forwards this path. */
export class WorkspaceHost extends ProductionWorkspaceHost {
  constructor(
    ctx: ConstructorParameters<typeof ProductionWorkspaceHost>[0],
    private readonly rehearsal: Env,
  ) {
    super(ctx, rehearsal);
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.rehearsal.REHEARSAL_CRASH !== "1") return super.fetch(request);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === CRASH_PATH) {
      const container = this.container();
      if (!container?.running) return new Response(null, { status: 409 });
      await container.destroy();
      return new Response(null, { status: 204 });
    }
    const response = await super.fetch(request);
    if (!response.ok && path === WORKSPACE_HOST_OBJECT_PREFIX + WORKSPACE_CODEX_READ_OPERATION)
      await this.#diagnoseBridgeFence().catch(() => {});
    return response;
  }

  async #diagnoseBridgeFence() {
    const bridge = this.services().bridge;
    if (!bridge) return;
    const snapshot = await bridge.request("/snapshot");
    if (!snapshot.ok) return void (await snapshot.body?.cancel());
    const { ack } = (await snapshot.json()) as { ack?: unknown };
    if (typeof ack !== "number") return;
    const response = await bridge.request(`/events?cursor=${ack}&fenced=1`);
    if (!response.ok) return void (await response.body?.cancel());
    const fence = (await response.json()) as { acknowledged: number; high: number; outboxId: string };
    const database = durableObjectSqlDatabase(this.ctx.storage);
    const inbox = database.prepare("SELECT value FROM bridge_inbox_meta WHERE key=?");
    console.log(
      "OC_NATIVE_SCENARIO_BRIDGE_FENCE " +
        JSON.stringify({
          inbox: Number(inbox.get("ack")?.value),
          producerAcknowledged: fence.acknowledged,
          producerHigh: fence.high,
          sameSource: inbox.get("inbox-source")?.value === fence.outboxId,
        }),
    );
  }
}

export async function runCloudRehearsal<E extends Env>(
  batch: { ackAll(): void },
  env: E,
  verifyBrowserAtRest?: (input: BrowserIdleProof, bindings: E) => Promise<void>,
) {
  const origin = env.REHEARSAL_ORIGIN;
  const instance: WorkerInstance = {
    origin,
    fetch: (url, options) => production.fetch(new Request(url, options), env),
    async upgrade(url, headers) {
      const request = new Request(url, { headers: { ...headers, upgrade: "websocket" } });
      const response = await production.fetch(request, env);
      if (!response.webSocket) return { status: response.status, text: await response.text() };
      const socket = bufferedSocket(response.webSocket);
      response.webSocket.accept();
      return { status: 101, socket };
    },
  };
  const checks: string[] = [];
  console.log("OC_NATIVE_CODEX_START");
  try {
    const credentialDigest = env.REHEARSAL_PROVIDER_DIGEST;
    const crash =
      env.REHEARSAL_CRASH === "1"
        ? async (workspace: string) => {
            const hosts = env.WORKSPACE_HOST!;
            const host = hosts.get(hosts.idFromName(workspaceHostObjectName(workspace)));
            const response = await host.fetch(
              new Request(`https://workspace.invalid${CRASH_PATH}`, { method: "POST" }),
            );
            await response.body?.cancel();
            if (response.status !== 204) throw new Error(`Rehearsal container stop returned HTTP ${response.status}`);
          }
        : undefined;
    await proveCodex(
      instance,
      env.OPENCRAFT_SETUP_TOKEN,
      checks,
      AbortSignal.timeout(510_000),
      "gpt-oss-20b",
      true,
      env.REHEARSAL_BRIDGE === "1",
      credentialDigest ? undefined : (env.REHEARSAL_NATIVE_TOOLS?.split(",").filter(Boolean) ?? []),
      credentialDigest
        ? {
            credentialDigest,
            crash,
            proveClientHibernation: true,
            ...(verifyBrowserAtRest
              ? { verifyBrowserAtRest: (input: BrowserIdleProof) => verifyBrowserAtRest(input, env) }
              : {}),
          }
        : undefined,
    );
    console.log("OC_NATIVE_CODEX_PROOF " + JSON.stringify({ ok: true, checks }));
  } catch (error) {
    console.log("OC_NATIVE_CODEX_PROOF " + JSON.stringify({ ok: false, checks, error: String(error).slice(0, 2200) }));
  } finally {
    batch.ackAll();
  }
}

export default { ...guarded, queue: (batch: { ackAll(): void }, env: Env) => runCloudRehearsal(batch, env) };
