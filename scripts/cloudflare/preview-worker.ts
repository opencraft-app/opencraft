import edge, {
  AccountCore as ProductionAccountCore,
  WorkspaceHost as ProductionWorkspaceHost,
} from "../../apps/headless-server/src/cloudflare/deployment-worker.mjs";
import { runAccountOperation } from "../../tests/storage/workerd/account-core-operations.ts";
export {
  InstallationCore,
  ClientDO,
  WorkspaceCodexModelEgress,
} from "../../apps/headless-server/src/cloudflare/deployment-worker.mjs";

export class AccountCore extends ProductionAccountCore {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__preview/setup-provider") return super.fetch(request);
    return Response.json(await runAccountOperation(this.services().account, await request.json()));
  }
}

export class WorkspaceHost extends ProductionWorkspaceHost {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    if (response.status === 503) {
      try {
        this.services();
      } catch (error) {
        console.warn("OC_PREVIEW_WORKSPACE " + String(error).slice(0, 280));
      }
    }
    return response;
  }
}

export default {
  fetch: edge.fetch,
  async queue(batch, env) {
    let stage = "configure";
    const origin = env.PREVIEW_ORIGIN;
    try {
      const account = env.ACCOUNT_CORE.get(env.ACCOUNT_CORE.idFromName("account"));
      const configure = async (body: unknown) => {
        const response = await account.fetch(
          new Request("https://account.invalid/__preview/setup-provider", {
            method: "POST",
            body: JSON.stringify(body),
          }),
        );
        if (!response.ok || !("ok" in (await response.json()))) throw new Error("Preview model setup refused");
      };
      await configure({
        op: "config.update",
        revision: 0,
        providers: [
          {
            id: "cloud-smoke",
            name: "Workers AI GPT-OSS 20B",
            enabled: true,
            protocol: "openai-responses",
            baseUrl: env.PREVIEW_PROVIDER + "/v1",
            credentialRef: "PREVIEW_FIXTURE",
            models: [{ id: "gpt-oss-20b", enabled: true, customToolCalls: true }],
          },
        ],
      });
      await configure({ op: "credentials.set", ref: "PREVIEW_FIXTURE", value: env.PROVIDER_PROOF });
      stage = "account";
      const username = "preview";
      const password = env.PREVIEW_PASSWORD;
      const requestHeaders = { origin, "content-type": "application/json" };
      const setup = await edge.fetch(
        new Request(origin + "/__opencraft_account/setup", {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ proof: env.OPENCRAFT_SETUP_TOKEN, mode: "web", username, password }),
        }),
        env,
      );
      await setup.body?.cancel();
      if (!setup.ok) throw Error("Preview account setup refused " + setup.status);

      stage = "login";
      const login = await edge.fetch(
        new Request(origin + "/__opencraft_auth/local", {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ mode: "login", username, password }),
        }),
        env,
      );
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      await login.body?.cancel();
      if (!login.ok || !cookie) throw Error("Preview login refused " + login.status);
      const headers = { cookie };
      stage = "workbench";
      const home = await edge.fetch(new Request(origin, { headers: { ...headers, accept: "text/html" } }), env);
      if (!home.ok || !(await home.text()).includes('id="opencraft-deployment-config"'))
        throw Error("Authenticated Workbench shell unavailable");

      stage = "model-stream";
      const response = await fetch(env.PREVIEW_PROVIDER + "/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(45_000),
        headers: { authorization: "Bearer " + env.PROVIDER_PROOF, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-oss-20b",
          stream: true,
          input: [{ type: "message", role: "user", content: "Reply with one word: ready." }],
        }),
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel();
        throw Error("GPT-OSS 20B did not open a stream");
      }
      const stream = await response.text();
      if (!stream.includes("event: response.output_text.delta") || !stream.includes("event: response.completed"))
        throw Error("GPT-OSS 20B did not complete the streaming reply");
      console.log('OC_PREVIEW_RESULT {"phase":"verified"}');
    } catch (error) {
      console.log(
        "OC_PREVIEW_RESULT " +
          JSON.stringify({
            phase: "failed",
            stage,
            error: error instanceof Error ? error.message.slice(0, 160) : undefined,
          }),
      );
    } finally {
      batch.ackAll();
    }
  },
};
