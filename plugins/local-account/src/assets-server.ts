import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActorStore } from "@opencraft/access-control/actors";
import type { InstanceAccess } from "@opencraft/access-control";
import type { HumanAuth } from "@opencraft/access-control/human-auth";
import { openAssetConfigurations } from "@opencraft/plugin-assets/server";
import {
  assetConfigurationsHttp,
  assetMetadataHttp,
  type AssetRequestAuthority,
} from "@opencraft/plugin-assets/server/http";

export const ASSET_STATUS_PATH = "/__opencraft_assets/status";
/** Compose the resource with existing Human/login/member owners. This provides
 * no identity provider, implicit membership or execution grant. One per host. */
export async function openHumanAssets(options: {
  directory: string;
  auth: HumanAuth;
  actors: ActorStore;
  access: InstanceAccess;
  /** Trusted compiled composition only; never taken from HTTP/configuration JSON. */
  openStorage?: typeof openAssetConfigurations;
}) {
  const owner = await (options.openStorage ?? openAssetConfigurations)(options.directory);
  let closed = false;
  const pending = new Set<() => void>();
  const resolve = (request: IncomingMessage): AssetRequestAuthority | null => {
    if (closed || request.headers.authorization !== undefined) return null;
    const login = options.auth.currentLogin(request);
    if (!login || options.actors.get(login.context.actorId)?.kind !== "human") return null;
    const role = options.access.role(login.principal);
    if (!role || !options.access.admitsActor(login.context.actorId)) return null;
    const current = () => {
      try {
        const latest = !closed && options.auth.currentLogin(request);
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
    };
    return {
      scope: `actor:${login.context.actorId}`,
      origin: options.auth.configuration.origin,
      expiresAt: Math.min(login.context.expiresAt, login.principal.expiresAt),
      canManagePlatform: role === "admin",
      allowCustomEndpoints: role === "admin",
      current,
      subscribe(listener) {
        pending.add(listener);
        const disposers = [
          options.actors.onAuthorityChanged(listener),
          options.access.store.onAuthorityChanged(listener),
          options.auth.accounts.onAuthorityChanged(listener),
        ];
        return () => {
          pending.delete(listener);
          for (const dispose of disposers) dispose();
        };
      },
    };
  };
  const configurations = assetConfigurationsHttp(owner.store, resolve);
  const git = assetMetadataHttp(
    { snapshot: owner.store.gitSnapshot, update: owner.store.gitUpdate },
    resolve,
    "/__opencraft_assets/git-connections",
  );
  return {
    outcome: owner.outcome,
    async handle(request: IncomingMessage, response: ServerResponse) {
      const path = new URL(request.url ?? "/", "http://assets.invalid").pathname;
      if (path !== ASSET_STATUS_PATH)
        return (await git(request, response)) || (await configurations(request, response));
      const origin = options.auth.configuration.origin;
      const pinned =
        !!origin &&
        new URL(origin).host === request.headers.host &&
        request.headers["sec-fetch-site"] !== "cross-site" &&
        request.headers.authorization === undefined;
      const access = pinned ? resolve(request) : null;
      const status = closed ? 503 : !pinned ? 403 : request.method !== "GET" ? 405 : 200;
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(
        JSON.stringify(
          status === 200
            ? { version: 1, scope: access?.current() ? access.scope : null, gitHosts: owner.gitHosts }
            : { error: "unavailable" },
        ),
      );
      return true;
    },
    async close() {
      if (!closed) {
        closed = true;
        for (const revoke of pending) revoke();
      }
      await owner.close();
    },
  };
}
