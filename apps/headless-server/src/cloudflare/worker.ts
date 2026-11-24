// Entry Worker of the installation's Cloudflare deployment assembly
// (deploy/cloudflare/wrangler.installation-core.jsonc). It forwards the
// installation's own routes (the shared route table and membership
// administration) to the deployment's single InstallationCore object, and a
// workspace's operator operations (workspace-host-routes.ts) to that
// workspace's WorkspaceHost object, addressed by its id, once the installation
// confirms an administrator. It answers nothing else: static assets, the Client
// DO and client sessions to a workspace belong to the edge Worker, which is not
// assembled yet (cloudflare-deployment §5.4, §5.7). Object-to-object paths are
// never forwarded.
import { fetchResponse } from "@opencraft/http-exchange/fetch";
import {
  INSTANCE_ACCESS_PREFIX,
  MISSING,
  installationExchangeReply,
  installationRoute,
} from "../installation-routes.js";
import {
  WORKSPACE_HOST_HEADER,
  WORKSPACE_HOST_OBJECT_PREFIX,
  WORKSPACE_HOST_OPERATIONS,
  workspaceHostObjectName,
  workspaceHostRoute,
} from "../workspace-host-routes.js";
import type { DeploymentRoutingEnv, InstallationCoreEnv } from "./bindings.js";
import { INSTALLATION_CORE_OBJECT } from "./installation-core.js";

export { InstallationCore } from "./installation-core.js";
export { WorkspaceHost } from "./workspace-host.js";

/** Whether the installation's object owns `pathname`. */
export function installationCoreOwns(pathname: string): boolean {
  return installationRoute(pathname) !== null || pathname.startsWith(INSTANCE_ACCESS_PREFIX);
}

/** A deployment without the workspace binding routes no workspace. */
type EntryEnv = InstallationCoreEnv & Partial<Pick<DeploymentRoutingEnv, "WORKSPACE_HOST">>;

const installation = (env: InstallationCoreEnv) =>
  env.INSTALLATION_CORE.get(env.INSTALLATION_CORE.idFromName(INSTALLATION_CORE_OBJECT));

/**
 * The installation's answer for the request's own credentials: an administrator's
 * session, or the refusal the installation gave. Only credentials travel; the
 * request body never reaches the installation.
 */
async function administrator(request: Request, env: InstallationCoreEnv): Promise<Response | null> {
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "authorization", "cf-connecting-ip"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const answer = await installation(env).fetch(
    new Request(new URL(`${INSTANCE_ACCESS_PREFIX}session`, request.url), { headers }),
  );
  if (answer.status !== 200) return answer.status === 401 || answer.status === 403 ? answer : refusal(503);
  const session = (await answer.json().catch(() => null)) as { role?: unknown } | null;
  return session?.role === "admin" ? null : refusal(403);
}

const refusal = (status: number) =>
  new Response(JSON.stringify({ error: status === 403 ? "administrator_required" : "workspace_unavailable" }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request: Request, env: EntryEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (installationCoreOwns(pathname)) return installation(env).fetch(request);
    const route = workspaceHostRoute(pathname);
    const workspaces = env.WORKSPACE_HOST;
    if (route && workspaces && request.method === WORKSPACE_HOST_OPERATIONS[route.operation]) {
      const refused = await administrator(request, env);
      if (refused) return refused;
      const target = new URL(WORKSPACE_HOST_OBJECT_PREFIX + route.operation, request.url);
      return workspaces.get(workspaces.idFromName(workspaceHostObjectName(route.workspace))).fetch(
        new Request(target, { method: request.method, headers: { [WORKSPACE_HOST_HEADER]: route.workspace } }),
      );
    }
    return fetchResponse(installationExchangeReply(MISSING));
  },
};
