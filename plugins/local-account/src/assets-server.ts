import type { ActorStore } from "@opencraft/access-control/actors";
import type { InstanceAccess } from "@opencraft/access-control";
import type { HumanAuth } from "@opencraft/access-control/human-auth";
import { openAssetConfigurations } from "@opencraft/plugin-assets/server";
import { ASSET_STATUS_PATH, openIdentityAssets } from "@opencraft/plugin-assets/server/identity-assets";

export { ASSET_STATUS_PATH };
/** Compose the resource with existing Human/login/member owners. This provides
 * no identity provider, implicit membership or execution grant. One per host.
 * The HumanAuth login is one composition of `openIdentityAssets`, the same
 * implementation an identity product with its own provider uses. */
export async function openHumanAssets(options: {
  directory: string;
  auth: HumanAuth;
  actors: ActorStore;
  access: InstanceAccess;
  /** Trusted compiled composition only; never taken from HTTP/configuration JSON. */
  openStorage?: typeof openAssetConfigurations;
}) {
  const owner = await (options.openStorage ?? openAssetConfigurations)(options.directory);
  let service: ReturnType<typeof openIdentityAssets>;
  try {
    service = openIdentityAssets({
      port: owner.store,
      origin: () => options.auth.configuration.origin,
      actors: options.actors,
      membership: options.access.store,
      access: options.access,
      gitHosts: owner.gitHosts,
      gitProviders: owner.gitProviders,
      environment: owner.environmentSettings,
      resolveRequest(request) {
        const login = options.auth.currentLogin(request);
        if (!login || options.actors.get(login.context.actorId)?.kind !== "human") return null;
        const role = options.access.role(login.principal);
        if (!role || !options.access.admitsActor(login.context.actorId)) return null;
        return {
          principal: {
            provider: login.principal.provider,
            subject: login.principal.subject,
            expiresAt: Math.min(login.context.expiresAt, login.principal.expiresAt),
          },
          actorId: login.context.actorId,
          // A role change withdraws the request too; the Worker rechecks the
          // committed role before it decides any role-dependent rule.
          current() {
            try {
              const latest = options.auth.currentLogin(request);
              return (
                !!latest &&
                latest.digest === login.digest &&
                latest.context.actorId === login.context.actorId &&
                latest.context.generation === login.context.generation &&
                options.actors.isCurrent(login.context) &&
                options.access.admitsActor(login.context.actorId) &&
                options.access.role(latest.principal) === role
              );
            } catch {
              return false;
            }
          },
          subscribe(listener) {
            const disposers = [
              options.actors.onAuthorityChanged(listener),
              options.access.store.onAuthorityChanged(listener),
              options.auth.accounts.onAuthorityChanged(listener),
            ];
            return () => {
              for (const dispose of disposers) dispose();
            };
          },
        };
      },
    });
  } catch (error) {
    await owner.close();
    throw error;
  }
  return {
    outcome: owner.outcome,
    gitAuthority: owner.gitAuthority,
    gitHosts: owner.gitHosts,
    executionGitGrant: owner.store.executionGitGrant,
    executionGitReservation: owner.store.executionGitReservation,
    handle: service.handle,
    async close() {
      service.close();
      await owner.close();
    },
  };
}
