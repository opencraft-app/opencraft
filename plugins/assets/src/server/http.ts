import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssetConfigurationPort } from "./worker.js";
import { SandboxConfigurationError } from "./errors.js";

export const ASSET_CONFIGURATIONS_PATH = "/__opencraft_assets/configurations";
/** Supplied only by verified Human/session + membership owners. Subscribe must
 * notify on every change that can make current() false, including role loss.
 * Provider/connection names, browser scope headers and saved catalog data grant
 * no access. Expiry is enforced independently in the Worker as well. */
export interface AssetRequestAuthority {
  readonly scope: string;
  readonly origin: string;
  readonly expiresAt: number;
  readonly allowCustomEndpoints: boolean;
  readonly canManagePlatform: boolean;
  current(): boolean;
  subscribe(invalidated: () => void): () => void;
}
export function assetConfigurationsHttp(
  store: AssetConfigurationPort,
  authority: (request: IncomingMessage) => AssetRequestAuthority | null,
  path = ASSET_CONFIGURATIONS_PATH,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (new URL(request.url ?? "/", "http://assets.invalid").pathname !== path) return false;
    const reply = (status: number, value: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      response.end(JSON.stringify(value));
    };
    const permit = new Int32Array(new SharedArrayBuffer(4));
    const revoke = () => {
      Atomics.store(permit, 0, 0);
    };
    let unsubscribe: (() => void) | undefined;
    try {
      const access = authority(request);
      if (!access) throw new SandboxConfigurationError("forbidden", 403);
      const current = () => access.current() && access.expiresAt > Date.now();
      Atomics.store(permit, 0, 1);
      unsubscribe = access.subscribe(() => {
        if (!current()) revoke();
      });
      response.once("close", revoke);
      if (!current() || Atomics.load(permit, 0) !== 1) throw new SandboxConfigurationError("forbidden", 403);
      if (request.headers["x-opencraft-account-scope"] !== access.scope)
        throw new SandboxConfigurationError("account_changed", 409);
      // Even GET is host-pinned; POST additionally requires the verified origin.
      const origin = new URL(access.origin);
      if (
        origin.origin !== access.origin ||
        !["http:", "https:"].includes(origin.protocol) ||
        request.headers.host !== origin.host ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new SandboxConfigurationError("same_origin_required", 403);
      const admission = {
        scope: access.scope,
        expiresAt: access.expiresAt,
        allowCustomEndpoints: access.allowCustomEndpoints,
        canManagePlatform: access.canManagePlatform,
        permit,
      };
      let result;
      if (request.method === "GET") result = await store.snapshot(admission);
      else if (request.method === "POST") {
        if (request.headers.origin !== access.origin) throw new SandboxConfigurationError("same_origin_required", 403);
        if (request.headers["content-type"] !== "application/json")
          throw new SandboxConfigurationError("json_required", 415);
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const data = Buffer.from(chunk);
          size += data.length;
          if (size > 16384) throw new SandboxConfigurationError("too_large", 413);
          chunks.push(data);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new SandboxConfigurationError("invalid", 400);
        }
        if (!current() || Atomics.load(permit, 0) !== 1) throw new SandboxConfigurationError("forbidden", 403);
        result = await store.update(admission, input);
      } else throw new SandboxConfigurationError("method_not_allowed", 405);
      if (!current() || Atomics.load(permit, 0) !== 1) throw new SandboxConfigurationError("forbidden", 403);
      reply(200, result);
    } catch (error) {
      reply(error instanceof SandboxConfigurationError ? error.status : 503, {
        error: error instanceof SandboxConfigurationError ? error.code : "unavailable",
      });
    } finally {
      revoke();
      response.removeListener("close", revoke);
      unsubscribe?.();
    }
    return true;
  };
}
