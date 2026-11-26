import {
  HttpBodyTooLarge,
  type HttpExchangeHandler,
  type HttpExchangeRequest,
  type HttpExchangeResponse,
} from "@opencraft/http-exchange";
import {
  EnvironmentError,
  type EnvironmentScope,
  type EnvironmentView,
} from "@opencraft/execution-environment/account-environment";
import { AccountEnvironmentHttp } from "@opencraft/execution-environment/account-environment-http";
import type { GitProviderDescriptor } from "../git/contract.js";
import type { AssetEnvironmentProject } from "./actor-settings.js";
import { SandboxConfigurationError } from "./errors.js";

export const ASSET_STATUS_PATH = "/__opencraft_assets/status";
export const ASSET_CONFIGURATIONS_PATH = "/__opencraft_assets/configurations";
export const ASSET_GIT_CONNECTIONS_PATH = "/__opencraft_assets/git-connections";
export const ASSET_ENVIRONMENT_PATH = "/__opencraft_assets/environment";

export interface AssetsExchangeIdentity {
  readonly scope: string;
  readonly origin: string;
  readonly allowCustomEndpoints: boolean;
  readonly canManagePlatform: boolean;
  current(): boolean;
}

export interface AssetsExchangeOptions {
  resolveIdentity(
    request: HttpExchangeRequest<unknown>,
  ): AssetsExchangeIdentity | null | Promise<AssetsExchangeIdentity | null>;
  readonly gitHosts?: readonly string[];
  readonly gitProviders?: readonly GitProviderDescriptor[];
  readonly environment?: boolean;
  configurationsSnapshot(identity: AssetsExchangeIdentity): Promise<unknown>;
  configurationsUpdate(identity: AssetsExchangeIdentity, input: unknown): Promise<unknown>;
  gitSnapshot(identity: AssetsExchangeIdentity): Promise<unknown>;
  gitUpdate(identity: AssetsExchangeIdentity, input: unknown): Promise<unknown>;
  environmentList?(
    identity: AssetsExchangeIdentity,
    scope: EnvironmentScope,
    assertCurrent: () => void,
  ): Promise<EnvironmentView>;
  environmentReplace?(
    identity: AssetsExchangeIdentity,
    scope: EnvironmentScope,
    revision: number,
    input: unknown,
    assertCurrent: () => void,
  ): Promise<EnvironmentView>;
  environmentProjects?(identity: AssetsExchangeIdentity): Promise<readonly AssetEnvironmentProject[]>;
}

const HEADERS = [
  ["content-type", "application/json"],
  ["cache-control", "private, no-store"],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
] as const;

const jsonReply = (status: number, value: unknown): HttpExchangeResponse => ({
  status,
  headers: [...HEADERS],
  body: JSON.stringify(value),
});

function isPinnedRequest(request: HttpExchangeRequest<unknown>, originValue: string | null): boolean {
  if (!originValue) return false;
  try {
    const origin = new URL(originValue);
    return (
      ["http:", "https:"].includes(origin.protocol) &&
      origin.host === request.headers.host &&
      request.headers["sec-fetch-site"] !== "cross-site" &&
      request.headers.authorization === undefined
    );
  } catch {
    return false;
  }
}

async function handleMetadataRoute(
  request: HttpExchangeRequest<unknown>,
  identity: AssetsExchangeIdentity | null,
  read: (identity: AssetsExchangeIdentity) => Promise<unknown>,
  write: (identity: AssetsExchangeIdentity, input: unknown) => Promise<unknown>,
): Promise<HttpExchangeResponse> {
  if (!identity || !identity.current() || !isPinnedRequest(request, identity.origin)) {
    return jsonReply(403, { error: "forbidden" });
  }
  if (request.headers["x-opencraft-account-scope"] !== identity.scope) {
    return jsonReply(409, { error: "account_changed" });
  }
  try {
    if (request.method === "GET") {
      const result = await read(identity);
      if (!identity.current()) return jsonReply(403, { error: "forbidden" });
      return jsonReply(200, result);
    }
    if (request.method !== "POST") return jsonReply(405, { error: "method_not_allowed" });
    if (request.headers.origin !== new URL(identity.origin).origin) {
      return jsonReply(403, { error: "same_origin_required" });
    }
    if (request.headers["content-type"] !== "application/json") {
      return jsonReply(415, { error: "json_required" });
    }
    let bytes: Uint8Array | undefined;
    let input: unknown;
    try {
      bytes = await request.readBody(16384);
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof HttpBodyTooLarge) return jsonReply(413, { error: "too_large" });
      return jsonReply(400, { error: "invalid" });
    } finally {
      bytes?.fill(0);
    }
    if (!identity.current()) return jsonReply(403, { error: "forbidden" });
    const result = await write(identity, input);
    if (!identity.current()) return jsonReply(403, { error: "forbidden" });
    return jsonReply(200, result);
  } catch (error) {
    if (error instanceof SandboxConfigurationError) return jsonReply(error.status, { error: error.code });
    return jsonReply(503, { error: "unavailable" });
  }
}

/**
 * Runtime-neutral HTTP exchange handler for `/__opencraft_assets/*`,
 * usable by both Node gateways and Cloudflare Durable Objects (`@opencraft/http-exchange`).
 */
export function createAssetsHttpExchange(options: AssetsExchangeOptions): HttpExchangeHandler<unknown> {
  if (
    options.environment &&
    (!options.environmentList || !options.environmentReplace || !options.environmentProjects)
  ) {
    throw new Error("Personal ENV settings require environment handlers");
  }

  return async (request) => {
    const pathname = new URL(request.path, "http://assets.invalid").pathname;
    if (
      pathname !== ASSET_STATUS_PATH &&
      pathname !== ASSET_CONFIGURATIONS_PATH &&
      pathname !== ASSET_GIT_CONNECTIONS_PATH &&
      !(options.environment && pathname === ASSET_ENVIRONMENT_PATH)
    ) {
      return null;
    }

    const identity = await options.resolveIdentity(request);

    if (pathname === ASSET_STATUS_PATH) {
      if (request.method !== "GET") return jsonReply(405, { error: "unavailable" });
      if (identity && !isPinnedRequest(request, identity.origin)) {
        return jsonReply(403, { error: "unavailable" });
      }
      return jsonReply(200, {
        version: 1,
        scope: identity?.current() ? identity.scope : null,
        gitHosts: options.gitHosts ?? [],
        gitProviders: options.gitProviders ?? [],
        ...(options.environment ? { environment: true } : {}),
      });
    }

    if (pathname === ASSET_CONFIGURATIONS_PATH) {
      return handleMetadataRoute(
        request,
        identity,
        (id) => options.configurationsSnapshot(id),
        (id, input) => options.configurationsUpdate(id, input),
      );
    }

    if (pathname === ASSET_GIT_CONNECTIONS_PATH) {
      return handleMetadataRoute(
        request,
        identity,
        (id) => options.gitSnapshot(id),
        (id, input) => options.gitUpdate(id, input),
      );
    }

    if (pathname === ASSET_ENVIRONMENT_PATH && options.environment) {
      if (identity && !isPinnedRequest(request, identity.origin)) {
        return jsonReply(403, { error: "forbidden" });
      }
      const call = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          if (error instanceof SandboxConfigurationError) {
            if (error.code === "invalid" || error.code === "reserved" || error.code === "conflict") {
              throw new EnvironmentError(error.code, error.status);
            }
            if (error.code === "forbidden") throw new EnvironmentError("unavailable", 403);
          }
          if (error instanceof EnvironmentError) throw error;
          throw new EnvironmentError("unavailable", 503);
        }
      };
      return new AccountEnvironmentHttp({
        list: (_account, scope, assertCurrent) =>
          call(() => {
            assertCurrent();
            return options.environmentList!(identity!, scope, assertCurrent);
          }),
        replace: (_account, scope, revision, input, assertCurrent) =>
          call(() => {
            assertCurrent();
            return options.environmentReplace!(identity!, scope, revision, input, assertCurrent);
          }),
      }).handleExchange(request, {
        account: identity?.scope ?? "",
        current: () => !!identity && identity.current(),
        projects: () =>
          call(async () => {
            if (!identity) throw new EnvironmentError("unavailable", 401);
            return [...(await options.environmentProjects!(identity))];
          }),
      });
    }

    return null;
  };
}
