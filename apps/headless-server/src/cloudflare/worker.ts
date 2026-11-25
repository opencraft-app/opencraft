// Entry Worker of the installation's Cloudflare deployment assembly
// (deploy/cloudflare/wrangler.installation-core.jsonc). It forwards the
// installation's own routes (the shared route table and membership
// administration) to the deployment's single InstallationCore object, the
// account routes to AccountCore and workspace operator routes to WorkspaceHost
// after InstallationCore confirms an administrator. Optional Client and Assets
// bindings serve App Host upgrades and the Workbench through installation
// admission. Object-internal routes remain private.
import { fetchResponse } from "@opencraft/http-exchange/fetch";
import { accountRoute } from "../account-routes.js";
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
import type { DeploymentEnv, DeploymentRoutingEnv, InstallationCoreEnv } from "./bindings.js";
import { serveEdgeAssets, type EdgeFetchBinding } from "./edge-assets.js";
import { APP_HOST_PATH, forwardClientSocket, type ClientSocketNamespace } from "./client-attachment.js";
import { ACCOUNT_CORE_OBJECT } from "./account-core.js";
import { INSTALLATION_CORE_OBJECT } from "./installation-core.js";

export { InstallationCore } from "./installation-core.js";
export { AccountCore } from "./account-core.js";
export { ClientDO } from "./client-do.js";
export { WorkspaceHost } from "./workspace-host.js";

/** Whether the installation's object owns `pathname`. */
export function installationCoreOwns(pathname: string): boolean {
  return installationRoute(pathname) !== null || pathname.startsWith(INSTANCE_ACCESS_PREFIX);
}

/** Whether the account's object owns `pathname`. */
export function accountCoreOwns(pathname: string): boolean {
  return accountRoute(pathname) !== null;
}

/** Optional routes are enabled by the corresponding deployment bindings. */
type EntryEnv = InstallationCoreEnv &
  Partial<Pick<DeploymentEnv, "ACCOUNT_CORE">> &
  Partial<Pick<DeploymentRoutingEnv, "WORKSPACE_HOST">> & {
    readonly ASSETS?: EdgeFetchBinding;
    readonly CLIENT?: ClientSocketNamespace;
  };

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
    const account = env.ACCOUNT_CORE;
    if (account && accountCoreOwns(pathname)) return account.get(account.idFromName(ACCOUNT_CORE_OBJECT)).fetch(request);
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
    if (pathname === APP_HOST_PATH && env.CLIENT)
      return forwardClientSocket(request, installation(env), env.CLIENT);
    if (env.ASSETS) return serveEdgeAssets(request, env.ASSETS, installation(env));
    return fetchResponse(installationExchangeReply(MISSING));
  },
};
