// The edge egress for model requests (cloudflare-deployment §2.1): a Worker
// that receives an engine's provider request carrying its credential lease
// token, redeems the token with the deployment's AccountCore object over the
// lease exchange, and streams the request to the provider with the credential
// in the token's place (`@opencraft/account-pool-host/credential-egress`). It
// holds no storage and no state; the credential lives in one request's memory.
//
// Minimal on purpose: no metering, no protocol conversion, and no route from
// the deployment's public entry (worker.ts). Containers' outbound traffic
// reaching it is the WorkspaceHost deployment's job (C2), which does not exist
// yet; until then it is exercised by the workerd tests only.
import { credentialEgress } from "@opencraft/account-pool-host/credential-egress";
import { credentialLeaseExchangeClient } from "@opencraft/account-pool-host/credential-lease-exchange";
import { fetchResponse } from "@opencraft/http-exchange/fetch";
import { MISSING, installationExchangeReply } from "../installation-routes.js";
import type { AccountCoreNamespace } from "./bindings.js";

/** The deployment's AccountCore object name (account-core.ts ACCOUNT_CORE_OBJECT). */
const ACCOUNT_OBJECT = "account";

/** What the egress Worker is bound to: only the account's object. */
export interface EgressEnv {
  readonly ACCOUNT_CORE: AccountCoreNamespace;
}

/** The egress handler over the account's object and the runtime's outbound fetch. */
export function egressHandler(
  env: EgressEnv,
  outbound: (request: Request) => Promise<Response> = (request) => fetch(request),
) {
  const serve = credentialEgress({
    // A stub per redemption: a stub to an object that was reset stays broken.
    leases: credentialLeaseExchangeClient(() => env.ACCOUNT_CORE.get(env.ACCOUNT_CORE.idFromName(ACCOUNT_OBJECT))),
    fetch: outbound,
  });
  return async (request: Request): Promise<Response> =>
    (await serve(request)) ?? fetchResponse(installationExchangeReply(MISSING));
}

export default {
  fetch(request: Request, env: EgressEnv): Promise<Response> {
    return egressHandler(env)(request);
  },
};
