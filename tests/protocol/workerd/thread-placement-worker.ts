// Local fixture using the real InstallationCore storage and access policy.
// Each test WorkspaceHost persists its own receipts. Only this fixture has
// routes that simulate publishing a native Thread result.
import { DurableObject } from "cloudflare:workers";
import { ThreadAccessStore } from "@opencraft/access-control/thread-access";
import type {
  DeploymentEnv,
  InstallationCoreEnv,
  InstallationCoreNamespace,
} from "../../../apps/headless-server/src/cloudflare/bindings.ts";
import { parseClientAttachment } from "../../../apps/headless-server/src/cloudflare/client-attachment.ts";
import {
  THREAD_PLACEMENT_LOOKUP_PATH,
  THREAD_PLACEMENT_PUBLISH_PATH,
  parseThreadPlacementKey,
  parseThreadPlacementReceipt,
  type ThreadPlacementAuthority,
  type ThreadPlacementKey,
} from "../../../apps/headless-server/src/cloudflare/thread-placement.ts";
import production, {
  InstallationCore as ProductionInstallation,
} from "../../../apps/headless-server/src/cloudflare/worker.ts";
import { CLIENT_ADMISSION_PATH } from "../../../apps/headless-server/src/cloudflare/client-attachment.ts";

type Env = DeploymentEnv & {
  TEST_WORKSPACE_RECEIPTS: InstallationCoreNamespace;
  TEST_ENABLE_PLACEMENT?: string;
};
const privateRequest = (path: string, value: unknown) =>
  new Request(new URL(path, "https://test-placement.internal"), { method: "POST", body: JSON.stringify(value) });

const refKey = (ref: ThreadPlacementKey): string => JSON.stringify([ref.serverId, ref.threadId]);

export class PlacementFixture extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json();
    const workspaceId = this.ctx.id.name;
    if (url.pathname === "/commit") {
      const receipt = parseThreadPlacementReceipt(body);
      if (!receipt || receipt.workspaceId !== workspaceId) return new Response(null, { status: 400 });
      await this.ctx.storage.put(refKey(receipt), receipt);
      return new Response(null, { status: 204 });
    }
    const key = parseThreadPlacementKey(body);
    if (url.pathname !== "/read" || !key) return new Response(null, { status: 400 });
    return Response.json((await this.ctx.storage.get(refKey(key))) ?? null);
  }
}

export class TestPlacementInstallation extends ProductionInstallation {
  #policy: ThreadAccessStore | undefined;

  #threadPolicy(): ThreadAccessStore {
    const { core, actorStore } = this.services();
    return (this.#policy ??= new ThreadAccessStore(core, actorStore, { projection: false }));
  }

  protected override threadPlacementAuthority(value: InstallationCoreEnv): ThreadPlacementAuthority | null {
    const env = value as Env;
    if (env.TEST_ENABLE_PLACEMENT !== "true") return null;
    return {
      workspace: (workspaceId) => {
        const namespace = env.TEST_WORKSPACE_RECEIPTS;
        const binding = namespace.get(namespace.idFromName(workspaceId));
        return {
          async readCommitted(key) {
            const result = await binding.fetch(privateRequest("/read", key));
            if (result.status !== 200) throw new Error("Test workspace unavailable");
            return parseThreadPlacementReceipt(await result.json());
          },
        };
      },
      allows: (actor, key) => this.#threadPolicy().allows(key.serverId, key.threadId, actor),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__test/private-thread") return super.fetch(request);
    const value = (await request.json()) as { thread?: unknown; attachment?: unknown };
    const key = parseThreadPlacementKey(value.thread);
    const attachment = parseClientAttachment(value.attachment);
    const login = attachment && this.services().admission.humanAccounts?.byDigest(attachment.loginDigest);
    if (!key || !login) return new Response(null, { status: 400 });
    this.#threadPolicy().created(key.serverId, key.threadId, login.context, "private");
    return new Response(null, { status: 204 });
  }
}

export { AccountCore } from "../../../apps/headless-server/src/cloudflare/worker.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const installation = env.INSTALLATION_CORE.get(env.INSTALLATION_CORE.idFromName("installation"));
    switch (url.pathname) {
      case "/__test/commit": {
        const receipt = parseThreadPlacementReceipt(await request.json());
        if (!receipt) return new Response(null, { status: 400 });
        const namespace = env.TEST_WORKSPACE_RECEIPTS;
        return namespace.get(namespace.idFromName(receipt.workspaceId)).fetch(privateRequest("/commit", receipt));
      }
      case "/__test/admission":
        url.pathname = CLIENT_ADMISSION_PATH;
        return installation.fetch(new Request(url, request));
      case "/__test/publish":
        url.pathname = THREAD_PLACEMENT_PUBLISH_PATH;
        return installation.fetch(new Request(url, request));
      case "/__test/lookup":
        url.pathname = THREAD_PLACEMENT_LOOKUP_PATH;
        return installation.fetch(new Request(url, request));
      case "/__test/private-thread":
        return installation.fetch(request);
      default:
        return production.fetch(request, env);
    }
  },
};
