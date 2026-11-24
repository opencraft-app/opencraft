// Entry Worker of the installation's Cloudflare deployment assembly
// (deploy/cloudflare/wrangler.installation-core.jsonc). It forwards the
// installation's own routes (the shared route table and membership
// administration) to the deployment's single InstallationCore object, the
// account's routes (account-routes.ts) to its single AccountCore object, and
// answers nothing else: static assets, Client DO and WorkspaceHost routing
// belong to the edge Worker, which is not assembled yet
// (cloudflare-deployment §5.4). Internal object-to-object paths (the account
// authority exchange) are never forwarded.
import { fetchResponse } from "@opencraft/http-exchange/fetch";
import { accountRoute } from "../account-routes.js";
import {
  INSTANCE_ACCESS_PREFIX,
  MISSING,
  installationExchangeReply,
  installationRoute,
} from "../installation-routes.js";
import type { DeploymentEnv } from "./bindings.js";
import { ACCOUNT_CORE_OBJECT } from "./account-core.js";
import { INSTALLATION_CORE_OBJECT } from "./installation-core.js";

export { InstallationCore } from "./installation-core.js";
export { AccountCore } from "./account-core.js";

/** Whether the installation's object owns `pathname`. */
export function installationCoreOwns(pathname: string): boolean {
  return installationRoute(pathname) !== null || pathname.startsWith(INSTANCE_ACCESS_PREFIX);
}

/** Whether the account's object owns `pathname`. */
export function accountCoreOwns(pathname: string): boolean {
  return accountRoute(pathname) !== null;
}

export default {
  async fetch(request: Request, env: DeploymentEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (installationCoreOwns(pathname))
      return env.INSTALLATION_CORE.get(env.INSTALLATION_CORE.idFromName(INSTALLATION_CORE_OBJECT)).fetch(request);
    if (accountCoreOwns(pathname))
      return env.ACCOUNT_CORE.get(env.ACCOUNT_CORE.idFromName(ACCOUNT_CORE_OBJECT)).fetch(request);
    return fetchResponse(installationExchangeReply(MISSING));
  },
};
