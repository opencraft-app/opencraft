// Entry Worker of the InstallationCore deployment assembly
// (deploy/cloudflare/wrangler.installation-core.jsonc). It forwards the
// installation's own routes (the shared route table and membership
// administration) to the deployment's single InstallationCore object and
// answers nothing else: static assets, Client DO and WorkspaceHost routing
// belong to the edge Worker, which is not assembled yet
// (cloudflare-deployment §5.4).
import { fetchResponse } from "@opencraft/http-exchange/fetch";
import {
  INSTANCE_ACCESS_PREFIX,
  MISSING,
  installationExchangeReply,
  installationRoute,
} from "../installation-routes.js";
import type { InstallationCoreEnv } from "./bindings.js";
import { INSTALLATION_CORE_OBJECT } from "./installation-core.js";

export { InstallationCore } from "./installation-core.js";

/** Whether the installation's object owns `pathname`. */
export function installationCoreOwns(pathname: string): boolean {
  return installationRoute(pathname) !== null || pathname.startsWith(INSTANCE_ACCESS_PREFIX);
}

export default {
  async fetch(request: Request, env: InstallationCoreEnv): Promise<Response> {
    if (!installationCoreOwns(new URL(request.url).pathname)) return fetchResponse(installationExchangeReply(MISSING));
    return env.INSTALLATION_CORE.get(env.INSTALLATION_CORE.idFromName(INSTALLATION_CORE_OBJECT)).fetch(request);
  },
};
